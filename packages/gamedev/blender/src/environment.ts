/**
 * Blender worker environment, resolved in the MCP server process on the first tool call: find
 * `uv` or a Blender executable, prepare the managed `bpy` virtual environment, and build the
 * worker command line for the selected backend. Every file-system and process effect goes
 * through a {@link BlenderSetupHost}, so resolution is testable without Blender or uv.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AppServerOptionFields, WorkerError, firstExecutable, newestFirst, nodeSetupHost, parseAppServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { AppWorkerDependencies, CommandArgv, JsonObject, SetupHost, WorkerReady } from '@deepseek-ai/dsh-app-mcp'
import type { BlenderServerOptions } from './types.ts'

/** A `bpy` package version such as `5.2.3`. */
export const BPY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** A Python minor version such as `3.13`. */
export const PYTHON_VERSION_PATTERN = /^3\.\d+$/

const ServerOptions = z.strictObject({
  ...AppServerOptionFields,
  backend: z.enum(['auto', 'bpy', 'app']),
  bpyVersion: z.string().regex(BPY_VERSION_PATTERN),
  pythonVersion: z.string().regex(PYTHON_VERSION_PATTERN),
  uvPath: z.string(),
  blenderPath: z.string(),
  startupTimeoutMs: z.int().min(1),
})

/**
 * Validate the options the Host plugin passed across the process boundary.
 * @param value - decoded JSON from the server's argv.
 * @returns typed options.
 * @throws Error naming each missing, invalid, or unknown field.
 */
export function parseServerOptions(value: JsonObject): BlenderServerOptions {
  return parseAppServerOptions('Blender', ServerOptions, value)
}

/** Why the worker environment could not be prepared; messages say how to fix it. */
export class BlenderSetupError extends Error {
  override readonly name = 'BlenderSetupError'

  /**
   * @param code - `UV_NOT_FOUND` and `BLENDER_NOT_FOUND` for missing or misconfigured executables,
   * `BPY_INSTALL_FAILED` when uv could not create the bpy environment or it could not be moved into place.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'UV_NOT_FOUND' | 'BLENDER_NOT_FOUND' | 'BPY_INSTALL_FAILED', message: string) {
    super(message)
  }
}

/** Options for {@link BlenderSetupHost.run}. */
export interface CommandOptions {
  readonly cwd: string
  /** Complete child environment. */
  readonly env: NodeJS.ProcessEnv
  /** Aborting kills the command and rejects with the abort reason. */
  readonly signal: AbortSignal
}

/** Completion of a command started by {@link BlenderSetupHost.run}. */
export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** Interleaved stdout and stderr, keeping the most recent bytes. */
  readonly output: string
}

/** File-system and process effects of environment resolution: the shared setup host plus what installing bpy needs. */
export interface BlenderSetupHost extends SetupHost {
  /**
   * Rename a directory; rejects when the destination exists and is not empty.
   * @param from - existing path.
   * @param to - new path.
   */
  rename(from: string, to: string): Promise<void>
  /**
   * Remove a file or directory tree; succeeds when it is already absent.
   * @param target - absolute path.
   */
  remove(target: string): Promise<void>
  /**
   * Run a command to completion without a shell.
   * @param argv - absolute executable followed by its arguments.
   * @param options - working directory, environment, and cancellation.
   * @returns exit status and the bounded output tail.
   */
  run(argv: CommandArgv, options: CommandOptions): Promise<CommandResult>
}

/**
 * Run a command and keep the tail of its interleaved output.
 * @param argv - executable and arguments.
 * @param options - working directory, environment, and cancellation.
 * @param outputLimit - bytes of output kept from the end.
 * @returns exit status and output tail; rejects when the command cannot start or is aborted.
 */
export function runCommand(argv: CommandArgv, options: CommandOptions, outputLimit: number): Promise<CommandResult> {
  const [command, ...args] = argv
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = Buffer.alloc(0)
    const collect = (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk])
      if (output.length > outputLimit) output = output.subarray(output.length - outputLimit)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', reject)
    child.once('close', (exitCode, signal) => { resolve({ exitCode, signal, output: output.toString('utf8') }) })
  })
}

/**
 * The real host: the shared `nodeSetupHost`, plus `node:fs` renames and removals and
 * `node:child_process` commands on this machine.
 * @param outputLimit - bytes of command output kept for diagnostics.
 * @returns a host bound to the current process environment.
 */
export function nodeBlenderSetupHost(outputLimit: number): BlenderSetupHost {
  return {
    ...nodeSetupHost(),
    async rename(from, to) { await rename(from, to) },
    async remove(target) { await rm(target, { recursive: true, force: true }) },
    run: async (argv, options) => await runCommand(argv, options, outputLimit),
  }
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Find an executable in the absolute `PATH` entries (`name.exe` on Windows).
 * @param name - executable name without extension.
 * @param host - environment and file checks.
 * @returns the first match, or undefined.
 */
export async function findOnPath(name: string, host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  const file = host.platform === 'win32' ? `${name}.exe` : name
  for (const directory of (host.env.PATH ?? host.env.Path ?? '').split(paths.delimiter)) {
    if (!paths.isAbsolute(directory)) continue
    const candidate = paths.join(directory, file)
    if (await host.isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate uv: the configured `uvPath`, then `PATH`, then the installers' default locations.
 * @param options - `uvPath`, empty to search.
 * @param host - environment and file checks.
 * @returns the uv executable, or undefined when it is not installed.
 * @throws BlenderSetupError when `uvPath` is set but not executable.
 */
export async function findUv(options: Pick<BlenderServerOptions, 'uvPath'>, host: SetupHost): Promise<string | undefined> {
  if (options.uvPath !== '') {
    if (await host.isExecutable(options.uvPath)) return options.uvPath
    throw new BlenderSetupError('UV_NOT_FOUND', `The Blender plugin setting uvPath (${options.uvPath}) is not an executable file. Correct it, or clear it to search PATH.`)
  }
  const paths = pathsOf(host.platform)
  const defaults = host.platform === 'win32'
    ? [paths.join(host.homeDirectory, '.local', 'bin', 'uv.exe')]
    : [paths.join(host.homeDirectory, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']
  return await findOnPath('uv', host) ?? await firstExecutable(defaults, host)
}

/**
 * Locate a Blender executable: `blenderPath`, the `BLENDER_PATH` variable, the macOS
 * application bundle, `blender` on `PATH`, then the newest Windows installation.
 * @param options - `blenderPath`, empty to search.
 * @param host - environment and file checks.
 * @returns the Blender executable, or undefined when none is installed.
 * @throws BlenderSetupError when `blenderPath` or `BLENDER_PATH` is set but not executable.
 */
export async function findBlender(options: Pick<BlenderServerOptions, 'blenderPath'>, host: SetupHost): Promise<string | undefined> {
  if (options.blenderPath !== '') {
    if (await host.isExecutable(options.blenderPath)) return options.blenderPath
    throw new BlenderSetupError('BLENDER_NOT_FOUND', `The Blender plugin setting blenderPath (${options.blenderPath}) is not an executable file. Correct it, or clear it to search the standard locations.`)
  }
  const fromEnvironment = host.env.BLENDER_PATH
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    if (await host.isExecutable(fromEnvironment)) return fromEnvironment
    throw new BlenderSetupError('BLENDER_NOT_FOUND', `The BLENDER_PATH environment variable (${fromEnvironment}) is not an executable file. Correct it, or unset it to search the standard locations.`)
  }
  const paths = pathsOf(host.platform)
  if (host.platform === 'darwin') {
    const bundles = ['/Applications', paths.join(host.homeDirectory, 'Applications')]
      .map(root => paths.join(root, 'Blender.app', 'Contents', 'MacOS', 'Blender'))
    const bundle = await firstExecutable(bundles, host)
    if (bundle !== undefined) return bundle
  }
  const onPath = await findOnPath('blender', host)
  if (onPath !== undefined || host.platform !== 'win32') return onPath
  const root = paths.join(host.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')
  const installs = (await host.listDirectory(root)).filter(name => /^blender/i.test(name)).sort(newestFirst)
  return await firstExecutable(installs.map(name => paths.join(root, name, 'blender.exe')), host)
}

/**
 * The managed bpy environment for this configuration.
 * @param options - data root and pinned versions.
 * @param platform - selects the virtual environment layout.
 * @returns the environment directory and its Python executable.
 */
export function bpyEnvironment(options: Pick<BlenderServerOptions, 'dataRoot' | 'pythonVersion' | 'bpyVersion'>, platform: NodeJS.Platform): { directory: string; python: string } {
  const paths = pathsOf(platform)
  const directory = paths.join(options.dataRoot, `venv-py${options.pythonVersion}-bpy${options.bpyVersion}`)
  return { directory, python: venvPython(directory, platform) }
}

function venvPython(directory: string, platform: NodeJS.Platform): string {
  const paths = pathsOf(platform)
  return platform === 'win32' ? paths.join(directory, 'Scripts', 'python.exe') : paths.join(directory, 'bin', 'python')
}

const REDIRECTING_VARIABLES = new Set(['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE'])

/**
 * The environment for uv and the worker: the server's own environment without variables that
 * would redirect Python's module search or the Electron runtime flag.
 * @param env - the MCP server process environment.
 * @returns a copy safe to pass to child processes.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !REDIRECTING_VARIABLES.has(name)))
}

async function runSetupStep(host: BlenderSetupHost, argv: CommandArgv, options: CommandOptions, action: string): Promise<void> {
  const result = await host.run(argv, options)
  if (result.exitCode === 0) return
  const status = result.exitCode === null ? `signal ${String(result.signal)}` : `exit code ${String(result.exitCode)}`
  throw new BlenderSetupError('BPY_INSTALL_FAILED', `Could not ${action}: uv ${argv.slice(1, 3).join(' ')} failed with ${status}.\n${result.output.trim()}`)
}

function installFailure(target: { readonly directory: string }, error: unknown): BlenderSetupError {
  const message = error instanceof Error ? error.message : String(error)
  return new BlenderSetupError('BPY_INSTALL_FAILED', `Could not move the new bpy environment to ${target.directory}: ${message}. Remove that folder, then call the tool again.`)
}

/**
 * Move a built environment to its final path. A directory already there whose Python is not
 * executable, such as one whose managed Python was removed, is moved aside and deleted; a working
 * environment that a concurrent installer moved there first is accepted.
 * @throws BlenderSetupError `BPY_INSTALL_FAILED` when the environment cannot be moved into place.
 */
async function moveIntoPlace(
  host: BlenderSetupHost, built: string, target: { readonly directory: string; readonly python: string },
): Promise<void> {
  try {
    await host.rename(built, target.directory)
    return
  } catch (error) {
    if (await host.isExecutable(target.python)) return
    const stale = `${target.directory}.stale-${randomUUID()}`
    try {
      await host.rename(target.directory, stale)
    } catch {
      // Nothing could be moved aside, so the failure of the first rename is the cause.
      throw installFailure(target, error)
    }
    try {
      await host.rename(built, target.directory)
    } catch (retryError) {
      if (!await host.isExecutable(target.python)) throw installFailure(target, retryError)
    } finally {
      await host.remove(stale)
    }
  }
}

/**
 * Create the managed bpy environment unless it already exists. The environment is built in a
 * uniquely named sibling directory and renamed into place, so an interrupted install never
 * leaves a half-built environment at the final path. A concurrent installer that wins the rename
 * is accepted, and a directory at the final path whose Python is not executable is replaced.
 * @param uv - the uv executable.
 * @param options - data root and pinned versions.
 * @param host - file-system and process effects.
 * @param signal - cancels the running uv command.
 * @returns the environment's Python and whether this call installed it.
 * @throws BlenderSetupError when uv fails or the environment cannot be moved into place.
 */
export async function prepareBpy(
  uv: string, options: BlenderServerOptions, host: BlenderSetupHost, signal: AbortSignal,
): Promise<{ python: string; installed: boolean }> {
  const target = bpyEnvironment(options, host.platform)
  if (await host.isExecutable(target.python)) return { python: target.python, installed: false }
  await host.makeDirectory(options.dataRoot)
  const partial = `${target.directory}.partial-${randomUUID()}`
  const commandOptions: CommandOptions = {
    cwd: options.dataRoot,
    env: { ...childEnvironment(host.env), UV_PYTHON_INSTALL_DIR: pathsOf(host.platform).join(options.dataRoot, 'uv-python') },
    signal,
  }
  try {
    await runSetupStep(host, [uv, 'venv', '--managed-python', '--no-progress', '--python', options.pythonVersion, partial], commandOptions,
      `create a Python ${options.pythonVersion} environment`)
    await runSetupStep(host, [uv, 'pip', 'install', '--no-progress', '--python', venvPython(partial, host.platform), `bpy==${options.bpyVersion}`],
      commandOptions, `install bpy ${options.bpyVersion}`)
    await moveIntoPlace(host, partial, target)
  } finally {
    await host.remove(partial)
  }
  return { python: target.python, installed: true }
}

/** How to start one worker process. */
export interface WorkerLaunch {
  readonly backend: 'bpy' | 'app'
  readonly argv: CommandArgv
  readonly env: NodeJS.ProcessEnv
  /** Setup facts to report to the agent with the next tool result. */
  readonly notes: readonly string[]
}

const SETUP_HELP = 'Install uv (https://docs.astral.sh/uv/getting-started/installation/) so the Blender tools can install the bpy module, '
  + 'or install Blender (https://www.blender.org/download/); then call the tool again. '
  + 'The Blender plugin settings uvPath and blenderPath select specific executables.'

function appLaunch(blender: string, workerScript: string, env: NodeJS.ProcessEnv, notes: readonly string[]): WorkerLaunch {
  return {
    backend: 'app',
    argv: [blender, '--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', workerScript],
    env,
    notes,
  }
}

/**
 * Choose the backend and build the worker command line. `auto` prefers the bpy module when uv is
 * available and falls back to an installed Blender when the bpy environment cannot be prepared.
 * @param options - backend selection, executable overrides, and versions.
 * @param workerScript - real path of `wasd_blender_worker.py`.
 * @param host - file-system and process effects.
 * @param signal - cancels a running bpy installation.
 * @returns the worker launch with setup notes.
 * @throws BlenderSetupError with installation instructions when no backend is usable.
 */
export async function resolveWorkerLaunch(
  options: BlenderServerOptions, workerScript: string, host: BlenderSetupHost, signal: AbortSignal,
): Promise<WorkerLaunch> {
  const env = childEnvironment(host.env)
  if (options.backend !== 'app') {
    const uv = await findUv(options, host)
    if (uv !== undefined) {
      try {
        const { python, installed } = await prepareBpy(uv, options, host, signal)
        const notes = installed
          ? [`Installed Python ${options.pythonVersion} and bpy ${options.bpyVersion} into ${bpyEnvironment(options, host.platform).directory} (first use).`]
          : []
        return { backend: 'bpy', argv: [python, '-I', '-u', workerScript], env, notes }
      } catch (error) {
        if (options.backend === 'bpy' || !(error instanceof BlenderSetupError)) throw error
        const blender = await findBlender(options, host)
        if (blender === undefined) throw new BlenderSetupError(error.code, `${error.message}\n${SETUP_HELP}`)
        return appLaunch(blender, workerScript, env, [`The bpy module could not be installed, so Blender at ${blender} runs the tools instead. ${error.message}`])
      }
    }
    if (options.backend === 'bpy') {
      throw new BlenderSetupError('UV_NOT_FOUND', 'The Blender plugin is set to the bpy backend, which needs uv. Install uv (https://docs.astral.sh/uv/getting-started/installation/) or set uvPath, then call the tool again.')
    }
  }
  const blender = await findBlender(options, host)
  if (blender === undefined) {
    throw new BlenderSetupError('BLENDER_NOT_FOUND', options.backend === 'app'
      ? 'The Blender plugin is set to the app backend, but no Blender installation was found. Install Blender (https://www.blender.org/download/) or set blenderPath, then call the tool again.'
      : `Neither uv nor Blender was found. ${SETUP_HELP}`)
  }
  return appLaunch(blender, workerScript, env, [])
}

/** Dependencies of {@link BlenderWorkers}: the server's worker script copy and worker start, and the setup host. */
export interface BlenderWorkerDependencies<W extends { readonly ready: WorkerReady }> extends AppWorkerDependencies<W> {
  readonly host: BlenderSetupHost
}

/** Characters of the last line of worker output that a setup note quotes. */
const QUOTED_LINE_CHARS = 300

/** The last line of worker output, cut to {@link QUOTED_LINE_CHARS}, as a clause for a setup note; empty without output. */
function lastOutputLine(logTail: string | undefined): string {
  const output = (logTail ?? '').trimEnd()
  const line = output.slice(output.lastIndexOf('\n') + 1).trim()
  return line === '' ? '' : `; its last output line was: ${line.slice(0, QUOTED_LINE_CHARS)}`
}

/**
 * Starts Blender workers for the worker supervisor and keeps setup notes until the next tool
 * result reports them to the agent.
 */
export class BlenderWorkers<W extends { readonly ready: WorkerReady }> {
  private notes: string[] = []

  /**
   * @param options - validated server options.
   * @param dependencies - host effects, worker script resolution, and process start.
   */
  constructor(private readonly options: BlenderServerOptions, private readonly dependencies: BlenderWorkerDependencies<W>) {}

  /**
   * Prepare the environment and start one worker. When the `bpy` module does not start, such as
   * from a damaged environment, the `auto` backend starts an installed Blender instead and a note
   * quotes the failure; otherwise the start failure says how to reinstall the environment.
   * @param signal - cancels preparation and the ready wait.
   * @returns the ready worker.
   * @throws WorkerError `WORKER_START_FAILED` when the worker does not start; the errors of {@link resolveWorkerLaunch}.
   */
  async start(signal: AbortSignal): Promise<W> {
    const { host } = this.dependencies
    await host.makeDirectory(this.options.dataRoot)
    const script = await this.dependencies.workerScript()
    const launch = await resolveWorkerLaunch(this.options, script, host, signal)
    try {
      return await this.startWorker(launch, signal)
    } catch (error) {
      if (launch.backend === 'app' || !(error instanceof WorkerError) || error.code !== 'WORKER_START_FAILED') throw error
      const environment = bpyEnvironment(this.options, host.platform).directory
      const reinstall = `If the bpy environment at ${environment} is damaged, delete that folder so that the next start installs it again.`
      const blender = this.options.backend === 'auto' ? await findBlender(this.options, host) : undefined
      if (blender === undefined) throw new WorkerError(error.code, `${error.message}. ${reinstall}`, { logTail: error.logTail, cause: error })
      return await this.startWorker(appLaunch(blender, script, launch.env, [
        ...launch.notes,
        `The bpy module did not start (${error.message}${lastOutputLine(error.logTail)}), so Blender at ${blender} runs the tools instead. ${reinstall}`,
      ]), signal)
    }
  }

  private async startWorker(launch: WorkerLaunch, signal: AbortSignal): Promise<W> {
    const worker = await this.dependencies.start({
      argv: launch.argv, cwd: this.options.dataRoot, env: launch.env,
      readyTimeoutMs: this.options.startupTimeoutMs, logTailBytes: this.options.maxLogBytes,
    }, signal)
    const runtime = launch.backend === 'bpy' ? 'bpy module' : 'Blender app'
    this.notes.push(...launch.notes, `Blender ${worker.ready.version} started (${runtime}, Python ${worker.ready.python}) with its default scene.`)
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
