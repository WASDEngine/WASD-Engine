/**
 * SuperCollider worker environment, resolved in the MCP server process on the first tool call: find sclang and
 * scsynth, give sclang its own user folders and a class library configuration that adds the worker class, and start
 * the bridge process that runs sclang behind the worker protocol. Every file-system effect goes through a
 * {@link SuperColliderSetupHost}, so resolution is testable without SuperCollider.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  AppServerOptionFields, encodeServerOptions, firstExecutable, newestFirst, nodeSetupHost, parseAppServerOptions,
} from '@deepseek-ai/dsh-app-mcp'
import type { AppWorkerDependencies, CommandArgv, JsonObject, SetupHost, WorkerReady } from '@deepseek-ai/dsh-app-mcp'
import type { SclangBridgePlan, SuperColliderRuntime, SuperColliderServerOptions } from './types.ts'

/** The argument after the plan that makes the server entry run the bridge process instead of the MCP server. */
export const SCLANG_BRIDGE_ARGUMENT = '--sclang-bridge'

/** IDE name that sclang runs under: any name but `none` turns off readline, so terminal input arrives in ESC-ended chunks. */
const IDE_NAME = 'wasd'

const ServerOptions = z.strictObject({
  ...AppServerOptionFields,
  sclangPath: z.string(),
  scsynthPath: z.string(),
  readyTimeoutMs: z.int().min(1),
})

/**
 * Validate the options the Host plugin passed across the process boundary.
 * @param value - decoded JSON from the server's argv.
 * @returns typed options.
 * @throws Error naming each missing, invalid, or unknown field.
 */
export function parseServerOptions(value: JsonObject): SuperColliderServerOptions {
  return parseAppServerOptions('SuperCollider', ServerOptions, value)
}

/** Why the SuperCollider worker cannot start; the message says how to fix it. */
export class SuperColliderSetupError extends Error {
  override readonly name = 'SuperColliderSetupError'

  /**
   * @param code - `SUPERCOLLIDER_NOT_FOUND` for a missing or misconfigured sclang or scsynth, `SUPERCOLLIDER_RUNTIME_INVALID`
   *   for a shipped runtime that its `runtime.json` does not describe.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'SUPERCOLLIDER_NOT_FOUND' | 'SUPERCOLLIDER_RUNTIME_INVALID', message: string) {
    super(message)
  }
}

/** The setup host plus the processor architecture and the text files that resolution reads and writes. */
export interface SuperColliderSetupHost extends SetupHost {
  /** Processor architecture in Node's names, such as `arm64`; selects the shipped runtime. */
  readonly arch: string
  /**
   * Read a UTF-8 text file.
   * @param file - absolute path.
   * @returns the text, or undefined when the file does not exist.
   */
  readTextFile(file: string): Promise<string | undefined>
  /**
   * Write a UTF-8 text file, replacing it.
   * @param file - absolute path in an existing directory.
   * @param text - the content.
   */
  writeTextFile(file: string, text: string): Promise<void>
}

/**
 * The real host: `node:fs` on this machine, the current process environment, and its architecture.
 * @returns a host bound to this process.
 */
export function nodeSuperColliderSetupHost(): SuperColliderSetupHost {
  return {
    ...nodeSetupHost(),
    arch: process.arch,
    async readTextFile(file) {
      try {
        return await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async writeTextFile(file, text) { await writeFile(file, text, 'utf8') },
  }
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

/**
 * Locate the runtimes a packaged application ships inside this package. A package inside an Electron `app.asar`
 * archive reads them from the sibling `app.asar.unpacked`, where the application keeps native files on disk.
 * @param packageRoot - folder holding the package manifest.
 * @returns the package's `runtime` folder, which holds one `<platform>-<arch>` folder per shipped runtime.
 */
export function bundledRuntimeRoot(packageRoot: string): string {
  return path.join(packageRoot.replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked'), 'runtime')
}

/** A path inside the runtime folder: relative, with `/` separators, and without `.` or `..` parts. */
const RuntimePath = z.string().min(1).refine(
  value => !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\\')),
  'must be a relative path inside the runtime folder',
)

/** `runtime.json` of a shipped runtime, as `wasdengine/supercollider/runtime.py` writes it. */
const RuntimeRecord = z.object({
  format: z.literal(1),
  version: z.string().min(1),
  supercollider: z.string().min(1),
  platform: z.string(),
  arch: z.string(),
  sclang: RuntimePath,
  scsynth: RuntimePath,
  plugins: RuntimePath,
  classLibrary: RuntimePath,
  helpSource: RuntimePath,
})

/**
 * The runtime that the Desktop app ships for this platform: `<bundledRoot>/<platform>-<arch>/runtime.json` names its
 * programs and folders.
 * @param bundledRoot - the package's `runtime` folder.
 * @param host - environment and file checks.
 * @returns the runtime, or undefined when no runtime is shipped for this platform.
 * @throws SuperColliderSetupError when `runtime.json` is unreadable, describes another platform, or names a missing program.
 */
export async function findBundledRuntime(bundledRoot: string, host: SuperColliderSetupHost): Promise<SuperColliderRuntime | undefined> {
  const paths = pathsOf(host.platform)
  const directory = paths.join(bundledRoot, `${host.platform}-${host.arch}`)
  const recordFile = paths.join(directory, 'runtime.json')
  const text = await host.readTextFile(recordFile)
  if (text === undefined) return undefined
  const invalid = (reason: string): SuperColliderSetupError => new SuperColliderSetupError('SUPERCOLLIDER_RUNTIME_INVALID',
    `The SuperCollider runtime shipped in ${directory} cannot run: ${reason}. Reinstall WASD Engine, or set the SuperCollider plugin setting sclangPath to an installed sclang.`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // SyntaxError: the file is not JSON, which the runtime record must be.
    throw invalid(`${recordFile} is not JSON`)
  }
  const parsed = RuntimeRecord.safeParse(json)
  if (!parsed.success) throw invalid(`${recordFile} is not a format 1 runtime record: ${z.prettifyError(parsed.error)}`)
  const record = parsed.data
  if (record.platform !== host.platform || record.arch !== host.arch) {
    throw invalid(`its runtime.json describes ${record.platform}-${record.arch}`)
  }
  const resolve = (relative: string): string => paths.join(directory, ...relative.split('/'))
  const runtime: SuperColliderRuntime = {
    source: 'bundled', sclang: resolve(record.sclang), scsynth: resolve(record.scsynth), classLibrary: resolve(record.classLibrary),
    plugins: resolve(record.plugins), helpSource: resolve(record.helpSource),
  }
  for (const program of [runtime.sclang, runtime.scsynth]) if (!await host.isExecutable(program)) throw invalid(`${program} is not an executable file`)
  return runtime
}

/** The scsynth of the installation that holds `sclang`: beside it, or in the Resources folder of a macOS application bundle. */
async function scsynthBeside(sclang: string, host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  const directory = paths.dirname(sclang)
  const name = executableName('scsynth', host.platform)
  return await firstExecutable([paths.join(directory, name), paths.join(directory, '..', 'Resources', name)], host)
}

/** An installation found from its sclang, or undefined without a scsynth beside it. */
async function installation(sclang: string, host: SetupHost): Promise<SuperColliderRuntime | undefined> {
  const scsynth = await scsynthBeside(sclang, host)
  return scsynth === undefined ? undefined : { source: 'installed', sclang, scsynth, classLibrary: undefined, plugins: undefined, helpSource: undefined }
}

/** The newest SuperCollider application bundle in `/Applications` and `~/Applications` that holds sclang and scsynth. */
async function newestBundle(host: SetupHost): Promise<SuperColliderRuntime | undefined> {
  const paths = pathsOf(host.platform)
  const bundles: string[] = []
  for (const root of ['/Applications', paths.join(host.homeDirectory, 'Applications')]) {
    for (const name of await host.listDirectory(root)) if (/^supercollider.*\.app$/iu.test(name)) bundles.push(paths.join(root, name))
  }
  // Stable sort: equal versions keep /Applications before ~/Applications.
  bundles.sort((left, right) => newestFirst(paths.basename(left), paths.basename(right)))
  for (const bundle of bundles) {
    const sclang = paths.join(bundle, 'Contents', 'MacOS', 'sclang')
    if (await host.isExecutable(sclang)) {
      const found = await installation(sclang, host)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** The first `PATH` directory, then on Windows the newest `SuperCollider*` folder under Program Files, that holds sclang and scsynth. */
async function installedOnPathOrProgramFiles(host: SetupHost): Promise<SuperColliderRuntime | undefined> {
  const paths = pathsOf(host.platform)
  const directories = (host.env.PATH ?? host.env.Path ?? '').split(paths.delimiter).filter(directory => paths.isAbsolute(directory))
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files'
    const installs = (await host.listDirectory(programFiles)).filter(name => /^supercollider/iu.test(name)).sort(newestFirst)
    directories.push(...installs.map(name => paths.join(programFiles, name)))
  }
  const sclangName = executableName('sclang', host.platform)
  for (const directory of directories) {
    const sclang = paths.join(directory, sclangName)
    if (!await host.isExecutable(sclang)) continue
    const found = await installation(sclang, host)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Locate sclang and scsynth: `sclangPath` (with `scsynthPath`, or the scsynth beside it), the runtime that the Desktop
 * app ships, then an installed SuperCollider: on macOS the newest `SuperCollider*.app` in `/Applications` or
 * `~/Applications`, then the first `PATH` directory that holds both programs, then on Windows the newest
 * `SuperCollider*` folder under Program Files. A non-empty `scsynthPath` replaces the scsynth that resolution found.
 * @param options - `sclangPath` and `scsynthPath`, empty to search.
 * @param bundledRoot - the package's `runtime` folder.
 * @param host - environment and file checks.
 * @returns the runtime, or undefined when SuperCollider is neither shipped nor installed.
 * @throws SuperColliderSetupError when a configured path is not an executable file, when sclangPath has no scsynth beside
 *   it and scsynthPath is empty, or when the shipped runtime is broken.
 */
export async function findSuperCollider(
  options: Pick<SuperColliderServerOptions, 'sclangPath' | 'scsynthPath'>, bundledRoot: string, host: SuperColliderSetupHost,
): Promise<SuperColliderRuntime | undefined> {
  const runtime = await configuredRuntime(options, host) ?? await findBundledRuntime(bundledRoot, host)
    ?? (host.platform === 'darwin' ? await newestBundle(host) : undefined) ?? await installedOnPathOrProgramFiles(host)
  if (runtime === undefined || options.scsynthPath === '') return runtime
  if (!await host.isExecutable(options.scsynthPath)) {
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', `The SuperCollider plugin setting scsynthPath (${options.scsynthPath}) is not an executable file. Correct it, or clear it to use the scsynth that comes with sclang.`)
  }
  return { ...runtime, scsynth: options.scsynthPath }
}

async function configuredRuntime(
  options: Pick<SuperColliderServerOptions, 'sclangPath' | 'scsynthPath'>, host: SetupHost,
): Promise<SuperColliderRuntime | undefined> {
  if (options.sclangPath === '') return undefined
  if (!await host.isExecutable(options.sclangPath)) {
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', `The SuperCollider plugin setting sclangPath (${options.sclangPath}) is not an executable file. Correct it, or clear it to use the SuperCollider that WASD Engine ships or an installed one.`)
  }
  const scsynth = options.scsynthPath === '' ? await scsynthBeside(options.sclangPath, host) : options.scsynthPath
  if (scsynth === undefined) {
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', `No scsynth was found beside the configured sclang (${options.sclangPath}). Set the SuperCollider plugin setting scsynthPath to the scsynth of the same installation.`)
  }
  return { source: 'configured', sclang: options.sclangPath, scsynth, classLibrary: undefined, plugins: undefined, helpSource: undefined }
}

/** The folders and files a worker uses under the plugin's data directory. */
export interface SuperColliderFolders {
  /** `XDG_CONFIG_HOME` of sclang: its user configuration folder lives inside, apart from the user's own SuperCollider. */
  readonly configHome: string
  /** `XDG_DATA_HOME` of sclang: its user extensions, synthdefs, and quarks folders live inside. */
  readonly dataHome: string
  /** Request parameter files and intermediate render, conversion, and log files. */
  readonly scratch: string
  /** The class library configuration that sclang reads with `-l`. */
  readonly classLibraryConfig: string
}

/**
 * The worker's folders under the data directory.
 * @param dataRoot - the plugin's data directory.
 * @param platform - selects the path syntax.
 * @returns `home/config`, `home/data`, `scratch`, and `sclang_conf.yaml` under `dataRoot`.
 */
export function superColliderFolders(dataRoot: string, platform: NodeJS.Platform): SuperColliderFolders {
  const paths = pathsOf(platform)
  return {
    configHome: paths.join(dataRoot, 'home', 'config'),
    dataHome: paths.join(dataRoot, 'home', 'data'),
    scratch: paths.join(dataRoot, 'scratch'),
    classLibraryConfig: paths.join(dataRoot, 'sclang_conf.yaml'),
  }
}

/**
 * The class library configuration: the worker class's folder, and for a shipped runtime its class library in place of
 * the default paths. An installed SuperCollider keeps its default paths, which hold its class library and the
 * system-wide extensions; the user's own extensions stay out, because `XDG_DATA_HOME` moves the user extension folder.
 * @param runtime - the resolved runtime.
 * @param workerClassDirectory - the folder that holds the copy of `WasdWorker.sc`.
 * @returns YAML text for `sclang -l`.
 */
export function classLibraryConfig(runtime: SuperColliderRuntime, workerClassDirectory: string): string {
  const include = runtime.classLibrary === undefined ? [workerClassDirectory] : [runtime.classLibrary, workerClassDirectory]
  // A JSON string literal is also a YAML double-quoted scalar.
  return [
    'includePaths:', ...include.map(directory => `  - ${JSON.stringify(directory)}`),
    'excludePaths: []',
    'postInlineWarnings: false',
    `excludeDefaultPaths: ${String(runtime.classLibrary !== undefined)}`,
    '',
  ].join('\n')
}

/**
 * The bridge's plan: sclang in its IDE mode with the class library configuration, user folders under the data
 * directory, the data directory as working directory, and the boot parameters of the worker class.
 * @param runtime - the resolved runtime.
 * @param folders - the worker's folders.
 * @param options - the data directory and the shutdown grace.
 * @returns the plan.
 */
export function sclangBridgePlan(
  runtime: SuperColliderRuntime, folders: SuperColliderFolders, options: Pick<SuperColliderServerOptions, 'dataRoot' | 'graceMs'>,
): SclangBridgePlan {
  return {
    sclang: [runtime.sclang, '-i', IDE_NAME, '-l', folders.classLibraryConfig],
    // The bridge needs ELECTRON_RUN_AS_NODE to run under the Desktop app's executable; sclang and its shells do not.
    env: { set: { XDG_CONFIG_HOME: folders.configHome, XDG_DATA_HOME: folders.dataHome }, unset: ['ELECTRON_RUN_AS_NODE'] },
    cwd: options.dataRoot,
    requestDirectory: folders.scratch,
    boot: { scsynth: runtime.scsynth, plugins: runtime.plugins ?? null, scratch: folders.scratch, helpSource: runtime.helpSource ?? null },
    graceMs: options.graceMs,
  }
}

function describeRuntime(runtime: SuperColliderRuntime): string {
  switch (runtime.source) {
    case 'bundled': return 'the runtime that WASD Engine ships'
    case 'configured': return `sclang at ${runtime.sclang}`
    case 'installed': return `installed at ${runtime.sclang}`
  }
}

function installHelp(platform: NodeJS.Platform): string {
  const brew = platform === 'darwin' ? ' (on macOS, `brew install --cask supercollider` also works)' : ''
  return `SuperCollider was not found. The WASD Engine desktop app ships it; elsewhere, install SuperCollider 3.13 or newer from https://supercollider.github.io/downloads${brew}, then call the tool again. `
    + 'The SuperCollider plugin settings sclangPath and scsynthPath select specific executables.'
}

/** Dependencies of {@link SuperColliderWorkers}: the server's worker class copy and worker start, the setup host, and the bridge. */
export interface SuperColliderWorkerDependencies<W extends { readonly ready: WorkerReady }> extends AppWorkerDependencies<W> {
  readonly host: SuperColliderSetupHost
  /** The package's `runtime` folder, where the Desktop app ships SuperCollider. */
  readonly bundledRoot: string
  /** Executable and arguments that run the server entry; the plan and {@link SCLANG_BRIDGE_ARGUMENT} follow them. */
  readonly bridge: CommandArgv
}

/**
 * Starts SuperCollider workers for the worker supervisor and keeps setup notes until the next tool result reports
 * them to the agent.
 */
export class SuperColliderWorkers<W extends { readonly ready: WorkerReady }> {
  private notes: string[] = []

  /**
   * @param options - validated server options.
   * @param dependencies - host effects, the worker class copy, the bridge command, and process start.
   */
  constructor(private readonly options: SuperColliderServerOptions, private readonly dependencies: SuperColliderWorkerDependencies<W>) {}

  /**
   * Find SuperCollider, prepare the worker's folders and class library configuration, and start one bridge.
   * @param signal - cancels the ready wait.
   * @returns the ready worker.
   * @throws SuperColliderSetupError with installation instructions when SuperCollider is missing or misconfigured.
   */
  async start(signal: AbortSignal): Promise<W> {
    const { host } = this.dependencies
    const runtime = await findSuperCollider(this.options, this.dependencies.bundledRoot, host)
    if (runtime === undefined) throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', installHelp(host.platform))
    const folders = superColliderFolders(this.options.dataRoot, host.platform)
    for (const directory of [folders.configHome, folders.dataHome, folders.scratch]) await host.makeDirectory(directory)
    const workerClass = await this.dependencies.workerScript()
    await host.writeTextFile(folders.classLibraryConfig, classLibraryConfig(runtime, pathsOf(host.platform).dirname(workerClass)))
    const plan = sclangBridgePlan(runtime, folders, this.options)
    const worker = await this.dependencies.start({
      argv: [...this.dependencies.bridge, encodeServerOptions(plan), SCLANG_BRIDGE_ARGUMENT], cwd: this.options.dataRoot, env: host.env,
      readyTimeoutMs: this.options.readyTimeoutMs, logTailBytes: this.options.maxLogBytes,
    }, signal)
    this.notes.push(`SuperCollider ${worker.ready.version} started (${describeRuntime(runtime)}) with no SynthDefs or variables defined.`)
    return worker
  }

  /**
   * Hand over the notes gathered since the previous call.
   * @returns the notes, oldest first.
   */
  takeNotes(): readonly string[] {
    const notes = this.notes
    this.notes = []
    return notes
  }
}
