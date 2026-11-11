/**
 * GIMP worker environment, resolved in the MCP server process on the first tool call: find a
 * GIMP 3 `gimp-console` executable, which is the runtime that the Desktop app ships unless a setting
 * names another, unpacking that runtime under the data directory first when the app ships its archive,
 * build the worker command line that runs the worker script as a Python batch command, and give GIMP
 * its own profile directory. Every file-system and process effect goes through a {@link GimpSetupHost},
 * so resolution is testable without GIMP.
 */
import path from 'node:path'
import { z } from 'zod'
import {
  AppServerOptionFields, ShippedRuntimeFields, ShippedRuntimePath, WorkerError, firstExecutable, newestFirst, nodeRuntimeUnpackHost,
  parseAppServerOptions, readPackedRuntime, readShippedRuntime, unpackPackedRuntime,
} from '@deepseek-ai/dsh-app-mcp'
import type {
  AppWorkerDependencies, AppWorkerScope, CommandArgv, JsonObject, RuntimeUnpackHost, SetupHost, ShippedRuntimeHost, WorkerReady,
} from '@deepseek-ai/dsh-app-mcp'
import type { GimpServerOptions } from './types.ts'

const ServerOptions = z.strictObject({
  ...AppServerOptionFields,
  gimpConsolePath: z.string(),
  readyTimeoutMs: z.int().min(1),
})

/**
 * Validate the options the Host plugin passed across the process boundary.
 * @param value - decoded JSON from the server's argv.
 * @returns typed options.
 * @throws Error naming each missing, invalid, or unknown field.
 */
export function parseServerOptions(value: JsonObject): GimpServerOptions {
  return parseAppServerOptions('GIMP', ServerOptions, value)
}

/** Why the GIMP worker cannot start; the message says how to fix it. */
export class GimpSetupError extends Error {
  override readonly name = 'GimpSetupError'

  /**
   * @param code - `GIMP_NOT_FOUND` for a missing or misconfigured `gimp-console` executable, `GIMP_RUNTIME_INVALID` for a
   *   shipped runtime that its `runtime.json` or `archive.json` does not describe, or whose archive cannot be unpacked.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'GIMP_NOT_FOUND' | 'GIMP_RUNTIME_INVALID', message: string) {
    super(message)
  }
}

/**
 * File-system and process effects of environment resolution: the shared runtime unpack host, which also unpacks the
 * runtime that the Desktop app ships as its archive.
 */
export type GimpSetupHost = RuntimeUnpackHost

/**
 * The real host: the shared `nodeRuntimeUnpackHost`.
 * @param outputLimit - bytes of command output kept for diagnostics, such as a failing unpack.
 * @returns a host bound to this process.
 */
export function nodeGimpSetupHost(outputLimit: number): GimpSetupHost {
  return nodeRuntimeUnpackHost(outputLimit)
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** A GIMP 3 to run: its console executable and the variables that its worker environment adds. */
export interface GimpInstallation {
  /** The `gimp-console` executable. */
  readonly console: string
  /** Whether it is the runtime that the Desktop app ships. */
  readonly shipped: boolean
  /** `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR` of the shipped runtime; empty for another GIMP. */
  readonly environment: Readonly<Record<string, string>>
  /** Setup facts to report to the agent with the next tool result, such as a first-use unpack. */
  readonly notes: readonly string[]
  /** What to do when this GIMP does not start; empty when there is nothing to repair. */
  readonly repair: string
}

/** `runtime.json` of a shipped runtime, as `wasdengine/gimp/runtime.py` writes it. */
const GimpRuntimeRecord = z.object({
  ...ShippedRuntimeFields,
  gimp: z.string().min(1),
  console: ShippedRuntimePath,
  dataDir: ShippedRuntimePath,
  localeDir: ShippedRuntimePath,
  sysconfDir: ShippedRuntimePath,
})

/** The fields of a shipped GIMP runtime's `runtime.json`. */
type GimpRuntime = z.infer<typeof GimpRuntimeRecord>

/** The error for a shipped runtime that cannot run, with how to recover. */
function shippedInvalid(directory: string, reason: string): GimpSetupError {
  return new GimpSetupError('GIMP_RUNTIME_INVALID',
    `The GIMP runtime shipped in ${directory} cannot run: ${reason}. Reinstall WASD Engine, or set the GIMP plugin setting gimpConsolePath to an installed gimp-console.`)
}

/** How the shared unpack reports a GIMP runtime archive that cannot run or cannot be moved into place. */
const GIMP_UNPACK_FAILURES = {
  invalid: shippedInvalid,
  moveFailed: (directory: string, cause: unknown) => new GimpSetupError('GIMP_RUNTIME_INVALID',
    `Could not move the unpacked GIMP runtime to ${directory}: ${cause instanceof Error ? cause.message : String(cause)}. Remove that folder, then call the tool again.`),
}

/** A shipped runtime's installation: its console and the folders that GIMP reads from its variables. */
function runtimeInstallation(
  record: GimpRuntime, resolve: (relative: string) => string, notes: readonly string[], repair: string,
): GimpInstallation {
  return {
    console: resolve(record.console),
    shipped: true,
    environment: {
      GIMP3_DATADIR: resolve(record.dataDir), GIMP3_LOCALEDIR: resolve(record.localeDir), GIMP3_SYSCONFDIR: resolve(record.sysconfDir),
    },
    notes,
    repair,
  }
}

/**
 * The runtime that the Desktop app ships for this platform: `<bundledRoot>/<platform>-<arch>/runtime.json` names its
 * console and the folders that GIMP reads from `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR`. GIMP's Python
 * plug-ins on macOS run from a nested `Python.app` and find GIMP's folders only through those variables.
 * @param bundledRoot - the package's `runtime` folder, from `shippedRuntimeRoot`.
 * @param host - environment and file checks.
 * @returns the runtime, or undefined when no runtime is shipped for this platform.
 * @throws GimpSetupError `GIMP_RUNTIME_INVALID` when `runtime.json` is unreadable, describes another platform, or names a
 *   console that is not an executable file.
 */
export async function findShippedGimp(bundledRoot: string, host: ShippedRuntimeHost): Promise<GimpInstallation | undefined> {
  const runtime = await readShippedRuntime(bundledRoot, host, GimpRuntimeRecord, shippedInvalid)
  if (runtime === undefined) return undefined
  const installation = runtimeInstallation(runtime.record, relative => runtime.resolve(relative), [], '')
  if (!await host.isExecutable(installation.console)) throw shippedInvalid(runtime.directory, `${installation.console} is not an executable file`)
  return installation
}

/**
 * The runtime that the Desktop app ships as its archive for this platform, unpacked into `<dataRoot>/runtime/<version>`
 * on first use. The Desktop app for Windows ships the archive, because the runtime's deepest files would pass Windows'
 * path length limit below the app's install folder.
 * @param bundledRoot - the package's `runtime` folder, from `shippedRuntimeRoot`.
 * @param dataRoot - the plugin's data directory.
 * @param host - file-system and process effects.
 * @param signal - cancels the running unpack.
 * @returns the unpacked runtime, or undefined when no archive is shipped for this platform.
 * @throws GimpSetupError `GIMP_RUNTIME_INVALID` when `archive.json` does not describe the archive for this platform, or
 *   when the archive or tar is missing, tar fails, the archive holds another runtime, or the runtime cannot be moved
 *   into place.
 */
export async function findPackedGimp(
  bundledRoot: string, dataRoot: string, host: GimpSetupHost, signal: AbortSignal,
): Promise<GimpInstallation | undefined> {
  const packed = await readPackedRuntime(bundledRoot, host, GimpRuntimeRecord, shippedInvalid)
  if (packed === undefined) return undefined
  const runtime = await unpackPackedRuntime(packed, packed.record.console, dataRoot, host, signal, GIMP_UNPACK_FAILURES)
  return runtimeInstallation(packed.record, relative => runtime.resolve(relative),
    runtime.unpacked ? [`Unpacked the GIMP runtime that WASD Engine ships into ${runtime.directory} (first use).`] : [],
    `If the GIMP runtime that WASD Engine unpacked into ${runtime.directory} is damaged, delete that folder so that the next start unpacks it again.`)
}

/** Versioned GIMP 3 console executable names: `gimp-console-3`, `gimp-console-3.2`, and `.exe` forms on Windows. */
function consoleNames(entries: readonly string[], platform: NodeJS.Platform): string[] {
  const pattern = platform === 'win32' ? /^gimp-console-3(\.\d+)*\.exe$/i : /^gimp-console-3(\.\d+)*$/
  return entries.filter(entry => pattern.test(entry)).sort(newestFirst)
}

/** The newest executable versioned console in each directory, directories in order. */
async function newestConsole(directories: readonly string[], host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  for (const directory of directories) {
    const names = consoleNames(await host.listDirectory(directory), host.platform)
    const found = await firstExecutable(names.map(name => paths.join(directory, name)), host)
    if (found !== undefined) return found
  }
  return undefined
}

/** The newest console across GIMP application bundles in `/Applications` and `~/Applications`. */
async function newestBundleConsole(host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  const candidates: string[] = []
  for (const root of ['/Applications', paths.join(host.homeDirectory, 'Applications')]) {
    for (const bundle of (await host.listDirectory(root)).filter(name => /^gimp.*\.app$/i.test(name))) {
      const directory = paths.join(root, bundle, 'Contents', 'MacOS')
      candidates.push(...consoleNames(await host.listDirectory(directory), host.platform).map(name => paths.join(directory, name)))
    }
  }
  // Stable sort: equal versions keep /Applications before ~/Applications.
  return await firstExecutable(candidates.sort((left, right) => newestFirst(paths.basename(left), paths.basename(right))), host)
}

/** The `bin` directories of GIMP 3 installations under Program Files and the per-user program folder. */
async function windowsInstallDirectories(host: SetupHost): Promise<string[]> {
  const paths = pathsOf(host.platform)
  const roots = [host.env.ProgramFiles ?? 'C:\\Program Files']
  if (host.env.LOCALAPPDATA !== undefined && host.env.LOCALAPPDATA !== '') roots.push(paths.join(host.env.LOCALAPPDATA, 'Programs'))
  const directories: string[] = []
  for (const root of roots) {
    const installs = (await host.listDirectory(root)).filter(name => /^gimp 3/i.test(name)).sort(newestFirst)
    directories.push(...installs.map(name => paths.join(root, name, 'bin')))
  }
  return directories
}

/**
 * Locate GIMP 3: `gimpConsolePath`, the `GIMP_CONSOLE` variable, the runtime that the Desktop app ships, unpacking it
 * under `dataRoot` first when the app ships its archive, the newest `gimp-console-3*` in a macOS GIMP application
 * bundle, the newest versioned `gimp-console-3*` in the first `PATH` directory that has one, `gimp-console` on `PATH`,
 * then on Windows the GIMP 3 installations under Program Files and then the per-user programs folder, newest first.
 * @param options - `gimpConsolePath`, empty to search, and the data directory that a packed runtime unpacks into.
 * @param bundledRoot - the package's `runtime` folder.
 * @param host - file-system and process effects.
 * @param signal - cancels a running unpack.
 * @returns the GIMP to run, or undefined when no runtime is shipped and GIMP 3 is not installed.
 * @throws GimpSetupError `GIMP_NOT_FOUND` when `gimpConsolePath` or `GIMP_CONSOLE` is set but not executable, and the
 *   errors of {@link findShippedGimp} and {@link findPackedGimp}.
 */
export async function findGimp(
  options: Pick<GimpServerOptions, 'gimpConsolePath' | 'dataRoot'>, bundledRoot: string, host: GimpSetupHost, signal: AbortSignal,
): Promise<GimpInstallation | undefined> {
  const configured = await configuredConsole(options, host)
  if (configured !== undefined) return otherGimp(configured)
  const shipped = await findShippedGimp(bundledRoot, host) ?? await findPackedGimp(bundledRoot, options.dataRoot, host, signal)
  if (shipped !== undefined) return shipped
  const installed = await installedConsole(host)
  return installed === undefined ? undefined : otherGimp(installed)
}

/** A GIMP that WASD Engine does not ship: a configured or installed console, run with its own folders. */
function otherGimp(console: string): GimpInstallation {
  return { console, shipped: false, environment: {}, notes: [], repair: '' }
}

/** `gimpConsolePath`, then `GIMP_CONSOLE`; undefined when neither is set. */
async function configuredConsole(options: Pick<GimpServerOptions, 'gimpConsolePath'>, host: SetupHost): Promise<string | undefined> {
  if (options.gimpConsolePath !== '') {
    if (await host.isExecutable(options.gimpConsolePath)) return options.gimpConsolePath
    throw new GimpSetupError('GIMP_NOT_FOUND', `The GIMP plugin setting gimpConsolePath (${options.gimpConsolePath}) is not an executable file. Correct it, or clear it to search the standard locations.`)
  }
  const fromEnvironment = host.env.GIMP_CONSOLE
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    if (await host.isExecutable(fromEnvironment)) return fromEnvironment
    throw new GimpSetupError('GIMP_NOT_FOUND', `The GIMP_CONSOLE environment variable (${fromEnvironment}) is not an executable file. Correct it, or unset it to search the standard locations.`)
  }
  return undefined
}

/** The console of an installed GIMP 3, in the order that {@link findGimp} documents. */
async function installedConsole(host: SetupHost): Promise<string | undefined> {
  if (host.platform === 'darwin') {
    const bundled = await newestBundleConsole(host)
    if (bundled !== undefined) return bundled
  }
  const paths = pathsOf(host.platform)
  const pathDirectories = (host.env.PATH ?? host.env.Path ?? '').split(paths.delimiter).filter(directory => paths.isAbsolute(directory))
  const versioned = await newestConsole(pathDirectories, host)
  if (versioned !== undefined) return versioned
  const plainName = host.platform === 'win32' ? 'gimp-console.exe' : 'gimp-console'
  const plain = await firstExecutable(pathDirectories.map(directory => paths.join(directory, plainName)), host)
  if (plain !== undefined || host.platform !== 'win32') return plain
  return await newestConsole(await windowsInstallDirectories(host), host)
}

/**
 * The GIMP profile every worker uses, kept apart from the user's own GIMP settings. Workers share it, because GIMP takes
 * about 15 s to fill a new profile; worker starts never overlap, so the first start fills it alone.
 * @param dataRoot - the plugin's data directory.
 * @param platform - selects the path syntax.
 * @returns `<dataRoot>/profile`.
 */
export function gimpProfileDirectory(dataRoot: string, platform: NodeJS.Platform): string {
  return pathsOf(platform).join(dataRoot, 'profile')
}

/**
 * The worker command line: a new `gimp-console` instance (`-n`) without a splash screen (`-s`)
 * and with messages on the console (`-c`), running the worker script as a python-fu-eval batch
 * command, then quitting once the script returns.
 * @param gimpConsole - the console executable.
 * @param workerScript - real path of `wasd_gimp_worker.py`.
 * @returns the argv.
 */
export function gimpWorkerArgv(gimpConsole: string, workerScript: string): CommandArgv {
  // A JSON string literal is also a valid Python string literal.
  const batch = `import runpy; runpy.run_path(${JSON.stringify(workerScript)}, run_name="__main__")`
  return [gimpConsole, '-n', '-s', '-c', '--batch-interpreter=python-fu-eval', '-b', batch, '--quit']
}

const REDIRECTING_VARIABLES = new Set(['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE'])

/**
 * The worker environment: the server's own environment without variables that would redirect
 * GIMP's bundled Python or the Electron runtime flag, with the installation's variables and
 * `GIMP3_DIRECTORY` naming the profile.
 * @param env - the MCP server process environment.
 * @param profile - the GIMP profile directory.
 * @param installation - variables of the GIMP that runs, such as the shipped runtime's folders.
 * @returns a copy safe to pass to the worker.
 */
export function workerEnvironment(
  env: NodeJS.ProcessEnv, profile: string, installation: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !REDIRECTING_VARIABLES.has(name))),
    ...installation,
    GIMP3_DIRECTORY: profile,
  }
}

/** Why no GIMP is available on this machine, and how the user gets one. */
function installHelp(host: Pick<ShippedRuntimeHost, 'platform' | 'arch'>): string {
  const brew = host.platform === 'darwin' ? ' (on macOS, `brew install --cask gimp` also works)' : ''
  return `GIMP 3 was not found: this installation of WASD Engine has no GIMP runtime for ${host.platform}-${host.arch}, and no GIMP 3 is installed. `
    + `Install GIMP 3 from https://www.gimp.org/downloads/${brew}, then call the tool again. `
    + 'The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific gimp-console executable.'
}

/** Dependencies of {@link GimpWorkers}: the server's worker script copy and worker start, the setup host, and the shipped runtimes. */
export interface GimpWorkerDependencies<W extends { readonly ready: WorkerReady }> extends AppWorkerDependencies<W> {
  readonly host: GimpSetupHost
  /** The package's `runtime` folder, from `shippedRuntimeRoot`. */
  readonly bundledRoot: string
}

/**
 * Starts GIMP workers for the worker supervisor and keeps setup notes until the next tool
 * result reports them to the agent.
 */
export class GimpWorkers<W extends { readonly ready: WorkerReady }> {
  private notes: string[] = []

  /**
   * @param options - validated server options.
   * @param dependencies - host effects, worker script resolution, and process start.
   */
  constructor(private readonly options: GimpServerOptions, private readonly dependencies: GimpWorkerDependencies<W>) {}

  /**
   * Find GIMP and start one worker with the plugin's own GIMP profile.
   * @param signal - cancels the ready wait.
   * @param scope - the Session whose worker this is, and its own directory, which is GIMP's working directory.
   * @returns the ready worker.
   * @throws GimpSetupError with installation instructions when no runtime is shipped and GIMP 3 is not installed, and
   *   the errors of {@link findGimp}; WorkerError `WORKER_START_FAILED` when the worker does not start, which for an
   *   unpacked runtime says how to unpack it again.
   */
  async start(signal: AbortSignal, scope: AppWorkerScope): Promise<W> {
    const { host } = this.dependencies
    const gimp = await findGimp(this.options, this.dependencies.bundledRoot, host, signal)
    if (gimp === undefined) throw new GimpSetupError('GIMP_NOT_FOUND', installHelp(host))
    const profile = gimpProfileDirectory(this.options.dataRoot, host.platform)
    await host.makeDirectory(profile)
    const script = await this.dependencies.workerScript()
    let worker: W
    try {
      worker = await this.dependencies.start({
        argv: gimpWorkerArgv(gimp.console, script), cwd: scope.directory, env: workerEnvironment(host.env, profile, gimp.environment),
        readyTimeoutMs: this.options.readyTimeoutMs, logTailBytes: this.options.maxLogBytes,
      }, signal)
    } catch (error) {
      if (gimp.repair === '' || !(error instanceof WorkerError) || error.code !== 'WORKER_START_FAILED') throw error
      throw new WorkerError(error.code, `${error.message}. ${gimp.repair}`, { logTail: error.logTail, cause: error })
    }
    const details = [
      ...gimp.shipped ? ['the runtime that WASD Engine ships'] : [],
      ...worker.ready.python === undefined ? [] : [`Python ${worker.ready.python}`],
    ]
    this.notes.push(...gimp.notes, `GIMP ${worker.ready.version} started${details.length === 0 ? '' : ` (${details.join(', ')})`} with no images open.`)
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
