/**
 * Godot runtime resolution and the managed LibGodot install.
 *
 * Resolution order: the configured LibGodot runner and library, the runtime a packaged application ships under
 * `<bundledRoot>/<platform>-<arch>/`, the managed runtime under `<dataRoot>/runtime/<runtimeVersion>/` (each valid
 * only with a `runtime.json` that names `runtimeVersion` and this Host's platform and architecture), a Godot editor
 * executable (the configured one, `godot` or `godot4` on PATH, then `/Applications/Godot*.app` on macOS), else
 * nothing. A configured path that is not a usable file is a configuration failure, never skipped.
 *
 * The install downloads the release manifest, picks the `<platform>-<arch>` artifact, verifies its size and
 * SHA-256 while streaming, extracts it with `tar` into a staging folder, writes `runtime.json`, and renames the
 * folder into place under a file lock, so concurrent Hosts never publish a partial runtime.
 * @module @deepseek-ai/dsh-godot/src/runtime
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { untilAborted } from './abort.ts'
import { describeExit } from './output.ts'
import type { GodotRuntimeInstallProgress, GodotRuntimeView } from './types.ts'

/** Runtime fields of the plugin configuration. */
export interface RuntimeSettings {
  /** Absolute plugin data folder; the managed runtime lives in its `runtime/` folder. */
  readonly dataRoot: string
  /** Folder of the runtimes a packaged application ships, one `<platform>-<arch>` folder each; a source checkout has none. */
  readonly bundledRoot: string
  /** Managed runtime version, the folder name under `runtime/`. */
  readonly runtimeVersion: string
  /** Release manifest URL for {@link GodotRuntimeManager.install}. */
  readonly runtimeManifestUrl: string
  /** Configured LibGodot library; empty when unset. */
  readonly libgodotPath: string
  /** Configured runner executable; empty when unset. */
  readonly runnerPath: string
  /** Configured Godot editor executable; empty when unset. */
  readonly godotExecutable: string
  /** Whether macOS LibGodot runs render without a window. */
  readonly embedded: boolean
}

/** A Godot runtime a run can launch. */
export type ResolvedGodotRuntime =
  | {
    readonly kind: 'libgodot'
    /** Absolute `godot_runner` executable. */
    readonly runner: string
    /** Absolute LibGodot shared library. */
    readonly library: string
    /** Godot version from `runtime.json`; unknown for configured paths. */
    readonly version?: string
  }
  | {
    readonly kind: 'executable'
    /** Absolute Godot editor executable. */
    readonly executable: string
  }

/** Platform facts and effects the runtime manager uses. */
export interface RuntimeHost {
  /** Node platform name. */
  readonly platform: NodeJS.Platform
  /** Node architecture name. */
  readonly arch: string
  /** Folder searched for `Godot*.app` bundles on macOS. */
  readonly applicationsDirectory: string
  /**
   * Find a bare executable name on PATH.
   * @param name - executable name.
   * @param signal - cancellation.
   * @returns the absolute path, or undefined when PATH has none.
   */
  findOnPath(name: string, signal: AbortSignal): Promise<string | undefined>
  /**
   * Fetch one URL.
   * @param url - absolute URL.
   * @param init - cancellation.
   * @returns the response.
   */
  fetch(url: string, init: { readonly signal: AbortSignal }): Promise<Response>
  /**
   * Extract a gzip-compressed tar archive into an existing folder.
   * @param archive - absolute archive path.
   * @param destination - absolute empty folder.
   * @param signal - cancellation.
   */
  extract(archive: string, destination: string, signal: AbortSignal): Promise<void>
}

/** Stable runtime failure codes. */
export type GodotRuntimeErrorCode = 'RUNTIME_CONFIG' | 'RUNTIME_MANIFEST' | 'RUNTIME_PLATFORM' | 'RUNTIME_DOWNLOAD' | 'RUNTIME_INTEGRITY' | 'RUNTIME_ARCHIVE'

/** A runtime configuration or install failure with an actionable message. */
export class GodotRuntimeError extends Error {
  override name = 'GodotRuntimeError'

  /**
   * @param code - stable failure code.
   * @param message - actionable explanation.
   * @param options - standard Error options.
   */
  constructor(readonly code: GodotRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Locate the runtimes a packaged application ships inside this package. A package inside an Electron `app.asar`
 * archive reads them from the sibling `app.asar.unpacked`, where the application keeps native files on disk.
 * @param packageRoot - folder holding the package manifest.
 * @returns the package's `libgodot` folder.
 */
export function bundledRuntimeRoot(packageRoot: string): string {
  return join(packageRoot.replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked'), 'libgodot')
}

/** Message for a Host where nothing resolves. */
export const RUNTIME_MISSING_MESSAGE = 'No Godot runtime is installed. Install the WASD Engine Godot runtime from the Game panel, or set libgodotPath and runnerPath, or godotExecutable, in the Godot plugin configuration.'

const FileName = z.string().regex(/^[^/\\]+$/u).refine(name => name !== '.' && name !== '..')

const RuntimeRecord = z.object({
  format: z.literal(1),
  version: z.string(),
  godot: z.string(),
  platform: z.string(),
  arch: z.string(),
  runner: FileName,
  library: FileName,
})

type RuntimeRecord = z.infer<typeof RuntimeRecord>

const RuntimeArtifact = z.object({
  url: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  runner: FileName,
  library: FileName,
})

type RuntimeArtifact = z.infer<typeof RuntimeArtifact>

const RuntimeManifest = z.object({
  format: z.literal(1),
  version: z.string(),
  godot: z.string(),
  artifacts: z.record(z.string(), RuntimeArtifact),
})

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!await isFile(path)) return false
  if (platform === 'win32') return true
  try {
    await access(path, constants.X_OK)
  } catch {
    // access() rejects a regular file without execute permission; such a file cannot be launched.
    return false
  }
  return true
}

/**
 * Owns runtime resolution, the shared install operation, and the published runtime view.
 */
export class GodotRuntimeManager {
  private installation: Promise<GodotRuntimeView> | undefined
  private progress: GodotRuntimeInstallProgress | undefined
  private failure: string | undefined
  private published: GodotRuntimeView = { state: 'missing', message: RUNTIME_MISSING_MESSAGE }
  private readonly lifetime = new AbortController()

  /**
   * @param settings - runtime configuration; configured paths must be absolute and LibGodot paths come in pairs.
   * @param host - platform facts and effects.
   * @param publish - receives every changed view, in order.
   */
  constructor(
    private readonly settings: RuntimeSettings,
    private readonly host: RuntimeHost,
    private readonly publish: (view: GodotRuntimeView) => void,
  ) {}

  /**
   * Read the published view without resolving again.
   * @returns the most recently published view.
   */
  latest(): GodotRuntimeView {
    return this.published
  }

  /**
   * Name this Host's manifest artifact.
   * @returns the `<platform>-<arch>` key.
   */
  platformKey(): string {
    return `${this.host.platform}-${this.host.arch}`
  }

  /**
   * Locate the managed runtime.
   * @returns the folder for the configured version.
   */
  managedDirectory(): string {
    return join(this.settings.dataRoot, 'runtime', this.settings.runtimeVersion)
  }

  /**
   * Locate the runtime a packaged application ships for this Host.
   * @returns the `<platform>-<arch>` folder under `bundledRoot`.
   */
  bundledDirectory(): string {
    return join(this.settings.bundledRoot, this.platformKey())
  }

  /**
   * Resolve the runtime a new run would use.
   * @param signal - cancellation.
   * @returns the runtime, or undefined when nothing resolves.
   * @throws {GodotRuntimeError} `RUNTIME_CONFIG` when a configured path is not a usable file.
   */
  async resolve(signal: AbortSignal): Promise<ResolvedGodotRuntime | undefined> {
    const { runnerPath, libgodotPath, godotExecutable } = this.settings
    if (runnerPath !== '') {
      await this.requireFile(runnerPath, 'runnerPath', true)
      await this.requireFile(libgodotPath, 'libgodotPath', false)
      return { kind: 'libgodot', runner: runnerPath, library: libgodotPath }
    }
    const bundled = await this.recorded(this.bundledDirectory())
    if (bundled !== undefined) return bundled
    const managed = await this.managed()
    if (managed !== undefined) return managed
    if (godotExecutable !== '') {
      await this.requireFile(godotExecutable, 'godotExecutable', true)
      return { kind: 'executable', executable: godotExecutable }
    }
    for (const name of ['godot', 'godot4']) {
      const found = await this.host.findOnPath(name, signal)
      if (found !== undefined) return { kind: 'executable', executable: found }
    }
    signal.throwIfAborted()
    return this.host.platform === 'darwin' ? this.application() : undefined
  }

  /**
   * Whether runs of a runtime render without a window.
   * @param runtime - resolved runtime.
   * @returns true for LibGodot on macOS with `embedded` configured.
   */
  windowless(runtime: ResolvedGodotRuntime): boolean {
    return runtime.kind === 'libgodot' && this.host.platform === 'darwin' && this.settings.embedded
  }

  /**
   * Resolve and publish the current view.
   * @param signal - cancellation.
   * @returns the view: installing while an install runs, else ready, failed, or missing.
   */
  async view(signal: AbortSignal): Promise<GodotRuntimeView> {
    if (this.installing()) return this.installingView()
    let view: GodotRuntimeView
    try {
      const runtime = await this.resolve(signal)
      if (runtime !== undefined) view = this.readyView(runtime)
      else view = this.failure === undefined ? { state: 'missing', message: RUNTIME_MISSING_MESSAGE } : { state: 'failed', message: this.failure }
    } catch (error) {
      if (!(error instanceof GodotRuntimeError)) throw error
      view = { state: 'failed', message: error.message }
    }
    // An install that started while this resolution ran owns the published state.
    if (this.installing()) return this.installingView()
    this.update(view)
    return view
  }

  /**
   * Install the managed runtime, or join the install already running.
   * @param signal - stops this caller's wait; the install itself runs until it settles or the manager is disposed.
   * @returns the view after the install settles; a failed install yields `failed` with its message.
   */
  install(signal: AbortSignal): Promise<GodotRuntimeView> {
    this.lifetime.signal.throwIfAborted()
    if (this.installation === undefined) {
      this.progress = undefined
      const installation = this.runInstall(this.lifetime.signal).then(
        () => { this.failure = undefined },
        (error: unknown) => {
          // Install steps fail with Errors: file system, fetch, and GodotRuntimeError.
          this.failure = (error as Error).message
        },
      ).then(async (): Promise<GodotRuntimeView> => {
        this.installation = undefined
        this.progress = undefined
        // A disposed manager resolves nothing more.
        if (this.lifetime.signal.aborted) return { state: 'failed', message: 'The Godot runtime install was cancelled.' }
        return this.view(this.lifetime.signal)
      })
      this.installation = installation
      this.update(this.installingView())
    }
    return untilAborted(this.installation, signal)
  }

  /** Abort a running install; its partial files are removed. */
  dispose(): void {
    this.lifetime.abort(new Error('Godot runtime manager disposed'))
  }

  private installing(): boolean {
    return this.installation !== undefined
  }

  private installingView(): GodotRuntimeView {
    return this.progress === undefined ? { state: 'installing' } : { state: 'installing', progress: this.progress }
  }

  private readyView(runtime: ResolvedGodotRuntime): GodotRuntimeView {
    return {
      state: 'ready',
      kind: runtime.kind,
      ...runtime.kind === 'libgodot' && runtime.version !== undefined ? { version: runtime.version } : {},
      windowless: this.windowless(runtime),
    }
  }

  private update(view: GodotRuntimeView): void {
    if (JSON.stringify(view) === JSON.stringify(this.published)) return
    this.published = view
    this.publish(view)
  }

  private report(progress: GodotRuntimeInstallProgress): void {
    const previous = this.progress
    const percent = (value: GodotRuntimeInstallProgress): number => Math.floor(value.completedBytes * 100 / value.totalBytes)
    if (previous !== undefined && previous.phase === progress.phase && percent(previous) === percent(progress)) return
    this.progress = progress
    this.update(this.installingView())
  }

  private async requireFile(path: string, field: string, executable: boolean): Promise<void> {
    if (await (executable ? isExecutableFile(path, this.host.platform) : isFile(path))) return
    throw new GodotRuntimeError('RUNTIME_CONFIG', `The Godot plugin's ${field} ${path} is not ${executable ? 'an executable file' : 'a file'}; fix or clear it in the plugin configuration.`)
  }

  private managed(): Promise<ResolvedGodotRuntime | undefined> {
    return this.recorded(this.managedDirectory())
  }

  /** The runtime a folder holds when its `runtime.json` names the configured version and this Host, else undefined. */
  private async recorded(directory: string): Promise<ResolvedGodotRuntime | undefined> {
    let record: RuntimeRecord
    try {
      const parsed = RuntimeRecord.safeParse(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')))
      if (!parsed.success) return undefined
      record = parsed.data
    } catch (error) {
      // A missing or unreadable record means the folder holds no runtime; install replaces the managed folder.
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (record.version !== this.settings.runtimeVersion || record.platform !== this.host.platform || record.arch !== this.host.arch) {
      return undefined
    }
    const runner = join(directory, record.runner)
    const library = join(directory, record.library)
    if (!await isExecutableFile(runner, this.host.platform) || !await isFile(library)) return undefined
    return { kind: 'libgodot', runner, library, version: record.godot }
  }

  private async application(): Promise<ResolvedGodotRuntime | undefined> {
    let names: string[]
    try {
      names = await readdir(this.host.applicationsDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const bundles = names.filter(name => /^Godot.*\.app$/u.test(name)).sort().reverse()
    for (const bundle of bundles) {
      const executable = join(this.host.applicationsDirectory, bundle, 'Contents', 'MacOS', 'Godot')
      if (await isExecutableFile(executable, this.host.platform)) return { kind: 'executable', executable }
    }
    return undefined
  }

  private async runInstall(signal: AbortSignal): Promise<void> {
    const root = join(this.settings.dataRoot, 'runtime')
    await mkdir(root, { recursive: true })
    if (await this.managed() !== undefined) return
    const manifest = await this.fetchManifest(signal)
    const artifact = manifest.artifacts[this.platformKey()]
    if (artifact === undefined) {
      throw new GodotRuntimeError('RUNTIME_PLATFORM', `The Godot runtime ${manifest.version} has no build for ${this.platformKey()}; set godotExecutable to an installed Godot editor instead.`)
    }
    const id = randomUUID()
    const archive = join(root, `.download-${id}.tar.gz`)
    const staging = join(root, `.staging-${id}`)
    try {
      await this.download(new URL(artifact.url, this.settings.runtimeManifestUrl).href, archive, artifact, signal)
      this.report({ phase: 'extracting', completedBytes: artifact.bytes, totalBytes: artifact.bytes })
      await mkdir(staging)
      await this.host.extract(archive, staging, signal)
      const runner = join(staging, artifact.runner)
      if (!await isFile(runner) || !await isFile(join(staging, artifact.library))) {
        throw new GodotRuntimeError('RUNTIME_ARCHIVE', `The Godot runtime archive does not contain ${artifact.runner} and ${artifact.library}.`)
      }
      if (this.host.platform !== 'win32') await chmod(runner, 0o755)
      const record: RuntimeRecord = {
        format: 1, version: manifest.version, godot: manifest.godot, platform: this.host.platform, arch: this.host.arch,
        runner: artifact.runner, library: artifact.library,
      }
      await writeFile(join(staging, 'runtime.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
      signal.throwIfAborted()
      const destination = this.managedDirectory()
      await withFileLock(destination, async () => {
        // Another Host may have published a complete runtime while this one downloaded.
        if (await this.managed() !== undefined) return
        await rm(destination, { recursive: true, force: true })
        await rename(staging, destination)
      }, { signal })
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async fetchManifest(signal: AbortSignal): Promise<z.infer<typeof RuntimeManifest>> {
    const url = this.settings.runtimeManifestUrl
    const response = await this.request(url, signal)
    if (!response.ok) {
      await response.body?.cancel()
      throw new GodotRuntimeError('RUNTIME_MANIFEST', `Fetching the Godot runtime manifest ${url} failed with HTTP ${response.status}.`)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch (error) {
      throw new GodotRuntimeError('RUNTIME_MANIFEST', `The Godot runtime manifest ${url} is not JSON.`, { cause: error })
    }
    const parsed = RuntimeManifest.safeParse(value)
    if (!parsed.success) throw new GodotRuntimeError('RUNTIME_MANIFEST', `The Godot runtime manifest ${url} is invalid: ${parsed.error.message}`)
    if (parsed.data.version !== this.settings.runtimeVersion) {
      throw new GodotRuntimeError('RUNTIME_MANIFEST', `The Godot runtime manifest ${url} describes version ${parsed.data.version}, not the configured ${this.settings.runtimeVersion}.`)
    }
    return parsed.data
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.host.fetch(url, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new GodotRuntimeError('RUNTIME_DOWNLOAD', `Cannot reach ${url}: ${(error as Error).message}`, { cause: error })
    }
  }

  private async download(url: string, destination: string, artifact: RuntimeArtifact, signal: AbortSignal): Promise<void> {
    const response = await this.request(url, signal)
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new GodotRuntimeError('RUNTIME_DOWNLOAD', `Downloading the Godot runtime from ${url} failed with HTTP ${response.status}.`)
    }
    const digest = createHash('sha256')
    let completedBytes = 0
    this.report({ phase: 'downloading', completedBytes, totalBytes: artifact.bytes })
    const report = (completed: number): void => { this.report({ phase: 'downloading', completedBytes: completed, totalBytes: artifact.bytes }) }
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        completedBytes += chunk.length
        if (completedBytes > artifact.bytes) {
          callback(new GodotRuntimeError('RUNTIME_INTEGRITY', `The Godot runtime download is larger than the ${artifact.bytes} bytes its manifest declares.`))
          return
        }
        digest.update(chunk)
        report(completedBytes)
        callback(null, chunk)
      },
    })
    await pipeline(response.body, hashing, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
    this.report({ phase: 'verifying', completedBytes, totalBytes: artifact.bytes })
    if (completedBytes !== artifact.bytes) {
      throw new GodotRuntimeError('RUNTIME_INTEGRITY', `The Godot runtime download has ${completedBytes} bytes; its manifest declares ${artifact.bytes}.`)
    }
    if (digest.digest('hex') !== artifact.sha256) {
      throw new GodotRuntimeError('RUNTIME_INTEGRITY', 'The Godot runtime download does not match the SHA-256 its manifest declares.')
    }
  }
}

/**
 * Build the runtime host of a Host process: PATH lookup and `tar` extraction through the subprocess service.
 * @param subprocess - Host subprocess service.
 * @param options - collected output cap and termination grace for `tar`.
 * @returns the runtime host.
 */
export function createRuntimeHost(
  subprocess: SubprocessRuntime,
  options: { readonly outputBytes: number; readonly graceMs: number },
): RuntimeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    applicationsDirectory: '/Applications',
    async findOnPath(name, signal) {
      try {
        return await subprocess.resolveExecutable(name, undefined, signal)
      } catch (error) {
        // An absent executable means "try the next location"; every other lookup failure is reported. The error
        // name, unlike its class, is the same in every installed copy of the subprocess package.
        if (error instanceof Error && error.name === 'SubprocessExecutableNotFoundError') return undefined
        throw error
      }
    },
    fetch: (url, init) => fetch(url, { signal: init.signal }),
    async extract(archive, destination, signal) {
      const tar = await subprocess.resolveExecutable('tar', undefined, signal)
      const handle = subprocess.spawn({
        argv: [tar, '-xzf', archive, '-C', destination],
        cwd: destination,
        stdio: { stdin: 'ignore', stdout: { maxBytes: options.outputBytes }, stderr: { maxBytes: options.outputBytes } },
        graceMs: options.graceMs,
        signal,
      })
      const outcome = await handle.done
      signal.throwIfAborted()
      if (outcome.exitCode !== 0) {
        const detail = (handle.collected.stderr as SubprocessOutputReader).readFrom(0).text.trim()
        throw new GodotRuntimeError('RUNTIME_ARCHIVE', `Extracting the Godot runtime failed (tar ${describeExit(outcome)}): ${detail}`)
      }
    },
  }
}
