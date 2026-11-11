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
  AppServerOptionFields, encodeServerOptions, nodeSetupHost, parseAppServerOptions,
} from '@deepseek-ai/dsh-app-mcp'
import type { AppWorkerDependencies, AppWorkerScope, CommandArgv, JsonObject, SetupHost, WorkerReady } from '@deepseek-ai/dsh-app-mcp'
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
   *   for a shipped runtime that its `runtime.json` does not describe, `SUPERCOLLIDER_NOT_HEADLESS` for a configured sclang
   *   that macOS would show as an open application.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'SUPERCOLLIDER_NOT_FOUND' | 'SUPERCOLLIDER_RUNTIME_INVALID' | 'SUPERCOLLIDER_NOT_HEADLESS', message: string) {
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

/** The scsynth in the folder that holds `sclang`. */
async function scsynthBeside(sclang: string, host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  const scsynth = paths.join(paths.dirname(sclang), executableName('scsynth', host.platform))
  return await host.isExecutable(scsynth) ? scsynth : undefined
}

/**
 * Locate sclang and scsynth: `sclangPath` (with `scsynthPath`, or the scsynth beside it), then the runtime that the
 * Desktop app ships. An installed SuperCollider is never used: its macOS application links sclang against Qt and opens
 * as an app, and the tools run SuperCollider headless only. A non-empty `scsynthPath` replaces the scsynth that
 * resolution found.
 * @param options - `sclangPath` and `scsynthPath`, empty to use the shipped runtime.
 * @param bundledRoot - the package's `runtime` folder.
 * @param host - environment and file checks.
 * @returns the runtime, or undefined when sclangPath is empty and no runtime is shipped for this platform.
 * @throws SuperColliderSetupError when a configured path is not an executable file, when sclangPath has no scsynth beside
 *   it and scsynthPath is empty, when sclangPath is inside a macOS application bundle, or when the shipped runtime is broken.
 */
export async function findSuperCollider(
  options: Pick<SuperColliderServerOptions, 'sclangPath' | 'scsynthPath'>, bundledRoot: string, host: SuperColliderSetupHost,
): Promise<SuperColliderRuntime | undefined> {
  const runtime = await configuredRuntime(options, host) ?? await findBundledRuntime(bundledRoot, host)
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
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', `The SuperCollider plugin setting sclangPath (${options.sclangPath}) is not an executable file. Correct it, or clear it to use the SuperCollider that WASD Engine ships.`)
  }
  if (host.platform === 'darwin' && /\.app\/Contents\//iu.test(options.sclangPath)) {
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_HEADLESS', `The SuperCollider plugin setting sclangPath (${options.sclangPath}) names the sclang of a SuperCollider application, which macOS shows as an open app; WASD Engine runs SuperCollider headless only. Clear it to use the SuperCollider that WASD Engine ships, or name a headless sclang.`)
  }
  const scsynth = options.scsynthPath === '' ? await scsynthBeside(options.sclangPath, host) : options.scsynthPath
  if (scsynth === undefined) {
    throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', `No scsynth was found beside the configured sclang (${options.sclangPath}). Set the SuperCollider plugin setting scsynthPath to the scsynth of the same installation.`)
  }
  return { source: 'configured', sclang: options.sclangPath, scsynth, classLibrary: undefined, plugins: undefined, helpSource: undefined }
}

/** File name of the class library configuration in the worker's directory. */
const CLASS_LIBRARY_CONFIG = 'sclang_conf.yaml'

/** The folders and files a worker uses under the plugin's data directory. */
export interface SuperColliderFolders {
  /** The worker's own directory, which holds the other folders and is the working directory of the bridge and sclang. */
  readonly directory: string
  /** `XDG_CONFIG_HOME` of sclang: its user configuration folder lives inside, apart from the user's own SuperCollider. */
  readonly configHome: string
  /** `XDG_DATA_HOME` of sclang: its user extensions, synthdefs, and quarks folders live inside. */
  readonly dataHome: string
  /** Request parameter files and intermediate render, conversion, and log files. */
  readonly scratch: string
  /** The class library configuration, in {@link directory}, which sclang reads with `-l` by its file name. */
  readonly classLibraryConfig: string
}

/**
 * The folders of one worker, inside the directory that the worker pool gives it.
 * @param directory - the worker's own directory.
 * @param platform - selects the path syntax.
 * @returns the directory itself, and `home/config`, `home/data`, `scratch`, and `sclang_conf.yaml` under it.
 */
export function superColliderFolders(directory: string, platform: NodeJS.Platform): SuperColliderFolders {
  const paths = pathsOf(platform)
  return {
    directory,
    configHome: paths.join(directory, 'home', 'config'),
    dataHome: paths.join(directory, 'home', 'data'),
    scratch: paths.join(directory, 'scratch'),
    classLibraryConfig: paths.join(directory, CLASS_LIBRARY_CONFIG),
  }
}

/**
 * The class library configuration: the worker class's folder, and for a shipped runtime its class library in place of
 * the default paths. A configured sclang keeps its default paths, which hold its class library and the system-wide
 * extensions; the user's own extensions stay out, because `XDG_DATA_HOME` moves the user extension folder.
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
 * The bridge's plan: sclang in its IDE mode with the class library configuration, user folders in the worker's
 * directory, Qt's offscreen platform, the worker's directory as working directory, and the boot parameters of the worker
 * class. sclang on Windows ignores `XDG_CONFIG_HOME` and `XDG_DATA_HOME` and uses the user's own SuperCollider folder,
 * whose startup file the worker class skips. The shipped runtime has no Qt and ignores the platform; a configured
 * sclang built with Qt either runs off screen or fails to start, so no build opens a window or an application.
 * @param runtime - the resolved runtime.
 * @param folders - the worker's folders.
 * @param options - the shutdown grace.
 * @returns the plan.
 */
export function sclangBridgePlan(
  runtime: SuperColliderRuntime, folders: SuperColliderFolders, options: Pick<SuperColliderServerOptions, 'graceMs'>,
): SclangBridgePlan {
  return {
    // Relative to the working directory, which holds it: sclang on Windows reads its arguments in the ANSI code page,
    // which cannot hold every character of a user's folder name.
    sclang: [runtime.sclang, '-i', IDE_NAME, '-l', CLASS_LIBRARY_CONFIG],
    // The bridge needs ELECTRON_RUN_AS_NODE to run under the Desktop app's executable; sclang and its shells do not.
    env: { set: { XDG_CONFIG_HOME: folders.configHome, XDG_DATA_HOME: folders.dataHome, QT_QPA_PLATFORM: 'offscreen' }, unset: ['ELECTRON_RUN_AS_NODE'] },
    cwd: folders.directory,
    requestDirectory: folders.scratch,
    boot: { scsynth: runtime.scsynth, plugins: runtime.plugins ?? null, scratch: folders.scratch, helpSource: runtime.helpSource ?? null },
    graceMs: options.graceMs,
  }
}

function describeRuntime(runtime: SuperColliderRuntime): string {
  switch (runtime.source) {
    case 'bundled': return 'the runtime that WASD Engine ships'
    case 'configured': return `sclang at ${runtime.sclang}`
  }
}

/**
 * Why no SuperCollider is available, and how the user gets the headless runtime.
 * @param host - the platform and architecture that have no runtime.
 * @returns the message.
 */
function runtimeMissing(host: Pick<SuperColliderSetupHost, 'platform' | 'arch'>): string {
  return `WASD Engine's headless SuperCollider is not installed for ${host.platform}-${host.arch}. The WASD Engine desktop app ships it for macOS `
    + 'on Apple silicon and for Windows x64; a source checkout installs it with `wasdengine/supercollider/build.sh --out <folder> --install '
    + 'packages/gamedev/supercollider/runtime`. WASD Engine does not start an installed SuperCollider, whose application opens '
    + 'as an app. The SuperCollider plugin settings sclangPath and scsynthPath can name another headless build.'
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
   * @param scope - the Session whose worker this is, and its own directory.
   * @returns the ready worker.
   * @throws SuperColliderSetupError with instructions when the headless runtime is missing or a setting is wrong.
   */
  async start(signal: AbortSignal, scope: AppWorkerScope): Promise<W> {
    const { host } = this.dependencies
    const runtime = await findSuperCollider(this.options, this.dependencies.bundledRoot, host)
    if (runtime === undefined) throw new SuperColliderSetupError('SUPERCOLLIDER_NOT_FOUND', runtimeMissing(host))
    const folders = superColliderFolders(scope.directory, host.platform)
    for (const directory of [folders.configHome, folders.dataHome, folders.scratch]) await host.makeDirectory(directory)
    const workerClass = await this.dependencies.workerScript()
    await host.writeTextFile(folders.classLibraryConfig, classLibraryConfig(runtime, pathsOf(host.platform).dirname(workerClass)))
    const plan = sclangBridgePlan(runtime, folders, this.options)
    const worker = await this.dependencies.start({
      argv: [...this.dependencies.bridge, encodeServerOptions(plan), SCLANG_BRIDGE_ARGUMENT], cwd: folders.directory, env: host.env,
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
