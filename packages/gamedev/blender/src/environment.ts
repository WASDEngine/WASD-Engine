/**
 * Blender worker environment, resolved in the MCP server process on the first tool call: find
 * the `bpy` runtime that the Desktop app ships, unpacking it when the app ships its archive, `uv`,
 * or a Blender executable, prepare the managed `bpy` virtual environment, and build the worker
 * command line for the selected backend. Every file-system and process effect goes through a
 * {@link BlenderSetupHost}, so resolution is testable without Blender or uv.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import {
  AppServerOptionFields, ShippedRuntimeFields, ShippedRuntimePath, WorkerError, findOnPath, firstExecutable, moveIntoPlace, newestFirst,
  nodeRuntimeUnpackHost, parseAppServerOptions, readPackedRuntime, readShippedRuntime, unpackPackedRuntime,
} from '@deepseek-ai/dsh-app-mcp'
import type {
  AppWorkerDependencies, AppWorkerScope, CommandArgv, CommandOptions, CommandResult, JsonObject, PackedRuntime, RuntimeUnpackHost,
  SetupHost, ShippedRuntimeHost, WorkerReady,
} from '@deepseek-ai/dsh-app-mcp'
import type { BlenderServerOptions } from './types.ts'

/** A `bpy` package version such as `5.2.3`. */
export const BPY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** Environment variable that names the game add-on store to the worker. */
export const ADDON_STORE_VARIABLE = 'WASD_ADDON_STORE'

/**
 * Folder in a worker's own directory that Blender uses as its user resources (`BLENDER_USER_RESOURCES`): the
 * extension cache, the wheels of enabled extensions, extension user data, and what add-ons write to Blender's user
 * folder stay there, apart from the user's own Blender and from other workers, and go when the worker's directory does.
 */
export const USER_RESOURCES_FOLDER = 'blender-user'

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
  addonStore: z.string(),
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
   * `BPY_INSTALL_FAILED` when uv could not create the bpy environment or it could not be moved into place,
   * `BLENDER_RUNTIME_INVALID` for a shipped bpy runtime that its `runtime.json` does not describe.
   * @param message - actionable description for the agent and the user.
   */
  constructor(readonly code: 'UV_NOT_FOUND' | 'BLENDER_NOT_FOUND' | 'BPY_INSTALL_FAILED' | 'BLENDER_RUNTIME_INVALID', message: string) {
    super(message)
  }
}

/**
 * File-system and process effects of environment resolution: the shared runtime unpack host, whose `run` also installs
 * bpy with uv.
 */
export type BlenderSetupHost = RuntimeUnpackHost

/**
 * The real host: the shared `nodeRuntimeUnpackHost`.
 * @param outputLimit - bytes of command output kept for diagnostics.
 * @returns a host bound to the current process environment and architecture.
 */
export function nodeBlenderSetupHost(outputLimit: number): BlenderSetupHost {
  return nodeRuntimeUnpackHost(outputLimit)
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
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

/** `runtime.json` of a shipped bpy runtime, as `wasdengine/blender/runtime.py` writes it. */
const BpyRuntimeRecord = z.object({
  ...ShippedRuntimeFields,
  bpy: z.string().regex(BPY_VERSION_PATTERN),
  python: z.string().regex(/^3\.\d+\.\d+$/u),
  executable: ShippedRuntimePath,
})

/** The fields of a shipped bpy runtime's `runtime.json`. */
export type BpyRuntime = z.infer<typeof BpyRuntimeRecord>

/** The bpy runtime that the Desktop app ships: a Python with the bpy module installed. */
export interface ShippedBpy {
  /** The runtime's folder: `<platform>-<arch>` in the package, or the folder under `dataRoot` it was unpacked into. */
  readonly directory: string
  /** The runtime's Python executable. */
  readonly python: string
  /** Version of its bpy module, such as `5.2.3`. */
  readonly bpy: string
}

/**
 * The bpy runtime that the Desktop app ships for this platform: `<bundledRoot>/<platform>-<arch>/runtime.json` names
 * its Python executable and the version of its bpy module.
 * @param bundledRoot - the package's `runtime` folder, from `shippedRuntimeRoot`.
 * @param host - environment and file checks.
 * @returns the runtime, or undefined when no runtime is shipped for this platform.
 * @throws BlenderSetupError `BLENDER_RUNTIME_INVALID` when `runtime.json` is not JSON, is not a runtime record,
 *   describes another platform, or names a Python that is not an executable file.
 */
export async function findShippedBpy(bundledRoot: string, host: ShippedRuntimeHost): Promise<ShippedBpy | undefined> {
  const runtime = await readShippedRuntime(bundledRoot, host, BpyRuntimeRecord, shippedInvalid)
  if (runtime === undefined) return undefined
  const python = runtime.resolve(runtime.record.executable)
  if (!await host.isExecutable(python)) throw shippedInvalid(runtime.directory, `${python} is not an executable file`)
  return { directory: runtime.directory, python, bpy: runtime.record.bpy }
}

/** The error for a shipped bpy runtime that cannot run, with how to recover. */
function shippedInvalid(directory: string, reason: string): BlenderSetupError {
  return new BlenderSetupError('BLENDER_RUNTIME_INVALID',
    `The bpy runtime shipped in ${directory} cannot run: ${reason}. Reinstall WASD Engine, or set the Blender plugin setting backend to app to use an installed Blender.`)
}

/**
 * The bpy runtime that the Desktop app ships as its archive for this platform: `<bundledRoot>/<platform>-<arch>/archive.json`
 * names the archive beside it and the fields of its `runtime.json`. The Desktop app for Windows ships the archive,
 * because the runtime's deepest files would pass Windows' path length limit below the app's install folder.
 * @param bundledRoot - the package's `runtime` folder, from `shippedRuntimeRoot`.
 * @param host - environment and file reads.
 * @returns the archive, or undefined when no archive is shipped for this platform.
 * @throws BlenderSetupError `BLENDER_RUNTIME_INVALID` when `archive.json` is not JSON, is not an archive record, or
 *   describes another platform.
 */
export async function findPackedBpy(bundledRoot: string, host: ShippedRuntimeHost): Promise<PackedRuntime<BpyRuntime> | undefined> {
  return await readPackedRuntime(bundledRoot, host, BpyRuntimeRecord, shippedInvalid)
}

/** How the shared unpack reports a bpy runtime archive that cannot run or cannot be moved into place. */
const BPY_UNPACK_FAILURES = {
  invalid: shippedInvalid,
  moveFailed: (directory: string, cause: unknown) => installFailure({ directory }, 'bpy runtime', cause),
}

/**
 * Unpack the bpy runtime that the Desktop app ships as its archive into `<dataRoot>/runtime/<version>`, unless that
 * folder already holds it, with app-mcp's `unpackPackedRuntime`.
 * @param packed - the archive and its runtime fields, from {@link findPackedBpy}.
 * @param dataRoot - the plugin's data directory.
 * @param host - file-system and process effects.
 * @param signal - cancels the running tar.
 * @returns the unpacked runtime and whether this call unpacked it.
 * @throws BlenderSetupError `BLENDER_RUNTIME_INVALID` when the archive or tar is missing, tar fails, or the unpacked
 *   `runtime.json` does not describe the archive's runtime; `BPY_INSTALL_FAILED` when the runtime cannot be moved into place.
 */
export async function unpackShippedBpy(
  packed: PackedRuntime<BpyRuntime>, dataRoot: string, host: BlenderSetupHost, signal: AbortSignal,
): Promise<ShippedBpy & { readonly unpacked: boolean }> {
  const runtime = await unpackPackedRuntime(packed, packed.record.executable, dataRoot, host, signal, BPY_UNPACK_FAILURES)
  const python = runtime.resolve(packed.record.executable)
  return { directory: runtime.directory, python, bpy: packed.record.bpy, unpacked: runtime.unpacked }
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

/** How a command ended, as a clause: `exit code 2` or `signal SIGKILL`. */
function exitText(result: CommandResult): string {
  return result.exitCode === null ? `signal ${String(result.signal)}` : `exit code ${String(result.exitCode)}`
}

async function runSetupStep(host: BlenderSetupHost, argv: CommandArgv, options: CommandOptions, action: string): Promise<void> {
  const result = await host.run(argv, options)
  if (result.exitCode === 0) return
  throw new BlenderSetupError('BPY_INSTALL_FAILED', `Could not ${action}: uv ${argv.slice(1, 3).join(' ')} failed with ${exitText(result)}.\n${result.output.trim()}`)
}

function installFailure(target: { readonly directory: string }, what: string, error: unknown): BlenderSetupError {
  const message = error instanceof Error ? error.message : String(error)
  return new BlenderSetupError('BPY_INSTALL_FAILED', `Could not move the new ${what} to ${target.directory}: ${message}. Remove that folder, then call the tool again.`)
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
    await moveIntoPlace(host, partial, { directory: target.directory, program: target.python }, cause => installFailure(target, 'bpy environment', cause))
  } finally {
    await host.remove(partial)
  }
  return { python: target.python, installed: true }
}

/** How to start one worker process. */
export interface WorkerLaunch {
  readonly backend: 'bpy' | 'app'
  /** Whether the launch runs the bpy runtime that the Desktop app ships, packed or not. */
  readonly shipped: boolean
  /** What a bpy module that does not start says to do about its runtime; empty for the app backend. */
  readonly repair: string
  readonly argv: CommandArgv
  readonly env: NodeJS.ProcessEnv
  /** Setup facts to report to the agent with the next tool result. */
  readonly notes: readonly string[]
}

/**
 * Interpreter options of every bpy backend: isolated mode, and the UTF-8 mode that Blender also sets for its own Python.
 * Without UTF-8 mode, Python on Windows writes its output in the ANSI code page and fails on text outside it, such as a
 * path below a user profile with a non-ASCII name, which Blender's glTF exporter prints.
 */
const BPY_PYTHON_OPTIONS = ['-I', '-X', 'utf8'] as const

const SETUP_HELP = 'Install uv (https://docs.astral.sh/uv/getting-started/installation/) so the Blender tools can install the bpy module, '
  + 'or install Blender (https://www.blender.org/download/); then call the tool again. '
  + 'The Blender plugin settings uvPath and blenderPath select specific executables.'

function appLaunch(blender: string, workerScript: string, env: NodeJS.ProcessEnv, notes: readonly string[]): WorkerLaunch {
  return {
    backend: 'app',
    shipped: false,
    repair: '',
    argv: [blender, '--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', workerScript],
    env,
    notes,
  }
}

/**
 * Choose the backend and build the worker command line. `auto` and `bpy` prefer the bpy runtime that the Desktop app
 * ships when its bpy version is `bpyVersion`, unpacking it under `dataRoot` first when the app ships its archive, then
 * the bpy module in the environment that uv manages; `auto` falls back to an installed Blender when uv is missing or
 * the archive or the bpy environment cannot be prepared. Every bpy launch runs Python with {@link BPY_PYTHON_OPTIONS}.
 * The runtime inside the app runs with `-B`, because it lives inside the signed application and writes no bytecode
 * caches there; an unpacked runtime and uv's environment, under `dataRoot`, keep them.
 * @param options - backend selection, executable overrides, and versions.
 * @param workerScript - real path of `wasd_blender_worker.py`.
 * @param bundledRoot - the package's `runtime` folder, from `shippedRuntimeRoot`.
 * @param host - file-system and process effects.
 * @param signal - cancels a running bpy installation or unpack.
 * @returns the worker launch with setup notes.
 * @throws BlenderSetupError with installation instructions when no backend is usable, and the errors of
 *   {@link findShippedBpy} and {@link findPackedBpy}.
 */
export async function resolveWorkerLaunch(
  options: BlenderServerOptions, workerScript: string, bundledRoot: string, host: BlenderSetupHost, signal: AbortSignal,
): Promise<WorkerLaunch> {
  // The worker's `wasd_addons` module finds the game add-on store through this variable.
  const env = { ...childEnvironment(host.env), ...options.addonStore === '' ? {} : { [ADDON_STORE_VARIABLE]: options.addonStore } }
  if (options.backend !== 'app') {
    const shipped = await findShippedBpy(bundledRoot, host)
    if (shipped !== undefined && shipped.bpy === options.bpyVersion) {
      return {
        backend: 'bpy', shipped: true, argv: [shipped.python, ...BPY_PYTHON_OPTIONS, '-B', '-u', workerScript], env, notes: [],
        repair: `If the bpy runtime that WASD Engine ships in ${shipped.directory} is damaged, reinstall WASD Engine.`,
      }
    }
    const packed = await findPackedBpy(bundledRoot, host)
    if (packed !== undefined && packed.record.bpy === options.bpyVersion) {
      try {
        const runtime = await unpackShippedBpy(packed, options.dataRoot, host, signal)
        return {
          backend: 'bpy', shipped: true, argv: [runtime.python, ...BPY_PYTHON_OPTIONS, '-u', workerScript], env,
          notes: runtime.unpacked ? [`Unpacked the bpy runtime that WASD Engine ships into ${runtime.directory} (first use).`] : [],
          repair: `If the bpy runtime that WASD Engine unpacked into ${runtime.directory} is damaged, delete that folder so that the next start unpacks it again.`,
        }
      } catch (error) {
        if (options.backend === 'bpy' || !(error instanceof BlenderSetupError)) throw error
        const blender = await findBlender(options, host)
        if (blender === undefined) throw error
        return appLaunch(blender, workerScript, env, [`The bpy runtime that WASD Engine ships could not be unpacked, so Blender at ${blender} runs the tools instead. ${error.message}`])
      }
    }
    const uv = await findUv(options, host)
    if (uv !== undefined) {
      try {
        const { python, installed } = await prepareBpy(uv, options, host, signal)
        const environment = bpyEnvironment(options, host.platform).directory
        const notes = installed ? [`Installed Python ${options.pythonVersion} and bpy ${options.bpyVersion} into ${environment} (first use).`] : []
        return {
          backend: 'bpy', shipped: false, argv: [python, ...BPY_PYTHON_OPTIONS, '-u', workerScript], env, notes,
          repair: `If the bpy environment at ${environment} is damaged, delete that folder so that the next start installs it again.`,
        }
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

/** Dependencies of {@link BlenderWorkers}: the server's worker script copy and worker start, the setup host, and the shipped runtimes. */
export interface BlenderWorkerDependencies<W extends { readonly ready: WorkerReady }> extends AppWorkerDependencies<W> {
  readonly host: BlenderSetupHost
  /** The package's `runtime` folder, from `shippedRuntimeRoot`. */
  readonly bundledRoot: string
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
   * quotes the failure; otherwise the start failure says how to repair the shipped runtime or
   * reinstall the environment.
   * @param signal - cancels preparation and the ready wait.
   * @param scope - the Session whose worker this is, and its own directory, which is the worker's working directory.
   * @returns the ready worker.
   * @throws WorkerError `WORKER_START_FAILED` when the worker does not start; the errors of {@link resolveWorkerLaunch}.
   */
  async start(signal: AbortSignal, scope: AppWorkerScope): Promise<W> {
    const { host } = this.dependencies
    await host.makeDirectory(this.options.dataRoot)
    const script = await this.dependencies.workerScript()
    const launch = await resolveWorkerLaunch(this.options, script, this.dependencies.bundledRoot, host, signal)
    try {
      return await this.startWorker(launch, scope, signal)
    } catch (error) {
      if (launch.backend === 'app' || !(error instanceof WorkerError) || error.code !== 'WORKER_START_FAILED') throw error
      const blender = this.options.backend === 'auto' ? await findBlender(this.options, host) : undefined
      if (blender === undefined) throw new WorkerError(error.code, `${error.message}. ${launch.repair}`, { logTail: error.logTail, cause: error })
      return await this.startWorker(appLaunch(blender, script, launch.env, [
        ...launch.notes,
        `The bpy module did not start (${error.message}${lastOutputLine(error.logTail)}), so Blender at ${blender} runs the tools instead. ${launch.repair}`,
      ]), scope, signal)
    }
  }

  private async startWorker(launch: WorkerLaunch, scope: AppWorkerScope, signal: AbortSignal): Promise<W> {
    const { host } = this.dependencies
    const userResources = pathsOf(host.platform).join(scope.directory, USER_RESOURCES_FOLDER)
    await host.makeDirectory(userResources)
    const worker = await this.dependencies.start({
      argv: launch.argv, cwd: scope.directory, env: { ...launch.env, BLENDER_USER_RESOURCES: userResources },
      readyTimeoutMs: this.options.startupTimeoutMs, logTailBytes: this.options.maxLogBytes,
    }, signal)
    const runtime = launch.backend === 'app' ? 'Blender app' : launch.shipped ? 'the bpy module that WASD Engine ships' : 'bpy module'
    const python = worker.ready.python === undefined ? '' : `, Python ${worker.ready.python}`
    this.notes.push(...launch.notes, `Blender ${worker.ready.version} started (${runtime}${python}) with its default scene.`)
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
