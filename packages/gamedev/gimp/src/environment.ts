/**
 * GIMP worker environment, resolved in the MCP server process on the first tool call: find a
 * GIMP 3 `gimp-console` executable, build the worker command line that runs the worker script as
 * a Python batch command, and give GIMP its own profile directory. Every file-system effect goes
 * through a {@link SetupHost}, so resolution is testable without GIMP.
 */
import path from 'node:path'
import { z } from 'zod'
import { AppServerOptionFields, firstExecutable, newestFirst, parseAppServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { AppWorkerDependencies, AppWorkerScope, CommandArgv, JsonObject, SetupHost, WorkerReady } from '@deepseek-ai/dsh-app-mcp'
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
   * @param code - `GIMP_NOT_FOUND` for a missing or misconfigured `gimp-console` executable.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'GIMP_NOT_FOUND', message: string) {
    super(message)
  }
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
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
 * Locate GIMP 3's console executable: `gimpConsolePath`, the `GIMP_CONSOLE` variable, the newest
 * `gimp-console-3*` in a macOS GIMP application bundle, the newest versioned `gimp-console-3*` in
 * the first `PATH` directory that has one, `gimp-console` on `PATH`, then on Windows the GIMP 3
 * installations under Program Files and then the per-user programs folder, newest first.
 * @param options - `gimpConsolePath`, empty to search.
 * @param host - environment and file checks.
 * @returns the console executable, or undefined when GIMP 3 is not installed.
 * @throws GimpSetupError when `gimpConsolePath` or `GIMP_CONSOLE` is set but not executable.
 */
export async function findGimpConsole(options: Pick<GimpServerOptions, 'gimpConsolePath'>, host: SetupHost): Promise<string | undefined> {
  if (options.gimpConsolePath !== '') {
    if (await host.isExecutable(options.gimpConsolePath)) return options.gimpConsolePath
    throw new GimpSetupError('GIMP_NOT_FOUND', `The GIMP plugin setting gimpConsolePath (${options.gimpConsolePath}) is not an executable file. Correct it, or clear it to search the standard locations.`)
  }
  const fromEnvironment = host.env.GIMP_CONSOLE
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    if (await host.isExecutable(fromEnvironment)) return fromEnvironment
    throw new GimpSetupError('GIMP_NOT_FOUND', `The GIMP_CONSOLE environment variable (${fromEnvironment}) is not an executable file. Correct it, or unset it to search the standard locations.`)
  }
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
 * GIMP's bundled Python or the Electron runtime flag, with `GIMP3_DIRECTORY` naming the profile.
 * @param env - the MCP server process environment.
 * @param profile - the GIMP profile directory.
 * @returns a copy safe to pass to the worker.
 */
export function workerEnvironment(env: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !REDIRECTING_VARIABLES.has(name))), GIMP3_DIRECTORY: profile }
}

function installHelp(platform: NodeJS.Platform): string {
  const brew = platform === 'darwin' ? ' (on macOS, `brew install --cask gimp` also works)' : ''
  return `GIMP 3 was not found. Install GIMP 3 from https://www.gimp.org/downloads/${brew}, then call the tool again. `
    + 'The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific gimp-console executable.'
}

/** Dependencies of {@link GimpWorkers}: the server's worker script copy and worker start, and the setup host. */
export interface GimpWorkerDependencies<W extends { readonly ready: WorkerReady }> extends AppWorkerDependencies<W> {
  readonly host: SetupHost
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
   * @throws GimpSetupError with installation instructions when GIMP 3 is not installed.
   */
  async start(signal: AbortSignal, scope: AppWorkerScope): Promise<W> {
    const { host } = this.dependencies
    const gimpConsole = await findGimpConsole(this.options, host)
    if (gimpConsole === undefined) throw new GimpSetupError('GIMP_NOT_FOUND', installHelp(host.platform))
    const profile = gimpProfileDirectory(this.options.dataRoot, host.platform)
    await host.makeDirectory(profile)
    const script = await this.dependencies.workerScript()
    const worker = await this.dependencies.start({
      argv: gimpWorkerArgv(gimpConsole, script), cwd: scope.directory, env: workerEnvironment(host.env, profile),
      readyTimeoutMs: this.options.readyTimeoutMs, logTailBytes: this.options.maxLogBytes,
    }, signal)
    const python = worker.ready.python === undefined ? '' : ` (Python ${worker.ready.python})`
    this.notes.push(`GIMP ${worker.ready.version} started${python} with no images open.`)
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
