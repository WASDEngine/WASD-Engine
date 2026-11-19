/**
 * `run_script` of the Blender server: run one Python file in fresh headless Blender processes, once or several times
 * at once, the way `blender --background --factory-startup --python <file> -- <args>` runs it. Each run is a process of
 * its own that starts from Blender's default scene, or from a .blend file that the call names, and ends with the
 * script, so it shares no state with a Session's worker or with the other runs. Each call keeps its results in a folder
 * of its own in `script-runs/` under `dataRoot`: `summary.json`, and one folder per run with its `output.log` and
 * `files`, the folder that `WASD_OUTPUT_DIR` names. The runs of every call share the server's run slots, as many as
 * the computer's memory and processors allow, and a run starts only while the computer has the memory available that a
 * worker start needs. On POSIX each run leads its own process group, so a run that ends, times out, or is cancelled
 * takes the processes it started with it.
 * @module
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  abortError, listFolderFiles, lowMemoryMessage, memoryShortage, processLimit, signalProcessGroup, type MachineResources,
} from '@deepseek-ai/dsh-app-mcp'
import { BLEND_FILE_VARIABLE, SCRIPT_VARIABLE, USER_RESOURCES_FOLDER, type WorkerLaunch } from './environment.ts'
import type { BlenderServerOptions } from './types.ts'

/** Environment variable that gives a run the absolute path of its `files` folder. */
export const OUTPUT_DIR_VARIABLE = 'WASD_OUTPUT_DIR'

/** Folder under `dataRoot` that holds the folders of the script calls. */
export const SCRIPT_RESULTS_FOLDER = 'script-runs'

/** Most runs one call may ask for. */
export const MAX_SCRIPT_RUNS = 64

/** Most arguments one run may receive. */
export const MAX_SCRIPT_ARGS = 256

/** Longest run name. */
export const MAX_RUN_NAME_CHARS = 60

/** Most files of a run's `files` folder that a report names. */
export const LISTED_RUN_FILES = 50

/** Most characters of output that the report of a call with one run keeps: its last lines. */
export const SCRIPT_OUTPUT_CHARS = 6000

/** Longest last line of output that a report quotes for each run. */
const LAST_LINE_CHARS = 200

/** Name of a call's folder: the UTC time it began to the millisecond, then six random hexadecimal digits. */
const CALL_FOLDER = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/u

/** A request that cannot run, such as one whose script does not exist, with a message for the model. */
export class BlenderScriptError extends Error {
  override readonly name = 'BlenderScriptError'
}

/** One run that a call asks for. */
export interface ScriptRunRequest {
  /** Arguments that the script finds in `sys.argv` after `--`. */
  readonly args: readonly string[]
  /** A name for the run, which its folder carries. */
  readonly name?: string
}

/** What one call runs. */
export interface ScriptCall {
  /** Absolute path of the Python file. */
  readonly script: string
  /** Absolute path of a .blend file that each run opens before the script runs. */
  readonly blend?: string
  /** The runs, at least one. */
  readonly runs: readonly ScriptRunRequest[]
  /** Time limit of each run, in milliseconds. */
  readonly timeoutMs: number
  /**
   * Time limit of the whole call, in milliseconds, counted from its start: a run that has not started by then does not
   * start, and one that still runs then stops.
   */
  readonly callTimeoutMs: number
}

/**
 * How a run ended: `finished` with exit code 0, `failed` with another exit code or by a signal, `timed-out` at its
 * time limit, and `not-started` when it could not start, such as after the call's time ran out or while the computer
 * had too little memory available.
 */
export type ScriptRunStatus = 'finished' | 'failed' | 'timed-out' | 'not-started'

/** The files a run wrote to its `files` folder. */
export interface RunFiles {
  /** Paths relative to the `files` folder, with `/` separators, in name order; at most {@link LISTED_RUN_FILES}. */
  readonly files: readonly string[]
  /** Files in the folder and its subfolders in all. */
  readonly totalFiles: number
}

/** One run of a call, as its report gives it. */
export interface ScriptRunReport extends RunFiles {
  /** The name the request gave the run, if any. */
  readonly name?: string
  /** Arguments the run received after `--`. */
  readonly args: readonly string[]
  /** Absolute folder of the run: `output.log` and `files`. */
  readonly folder: string
  /** How the run ended. */
  readonly status: ScriptRunStatus
  /** Exit code of a run that exited before its time limit. */
  readonly exitCode?: number
  /** Signal that ended a run before its time limit without an exit. */
  readonly signal?: string
  /** Why the run did not start, for `not-started`. */
  readonly reason?: string
  /** Wall time of the run in milliseconds; 0 for a run that did not start. */
  readonly durationMs: number
  /** The last line the run printed, shortened to 200 characters. */
  readonly lastLine?: string
  /** Whether `output.log` reached `scriptLogBytes`, so that it lacks the later output. */
  readonly outputCut?: boolean
}

/** A finished call. */
export interface ScriptCallReport {
  /** Absolute path of the script. */
  readonly script: string
  /** Absolute path of the .blend file that each run opened first, if any. */
  readonly blend?: string
  /** What ran the script: the bpy module that WASD Engine ships, the bpy module that uv installed, or an installed Blender. */
  readonly runtime: string
  /** Absolute folder of the call: `summary.json` and one folder per run. */
  readonly resultsDir: string
  /** Most runs of the call that could run at once. */
  readonly parallel: number
  /** Wall time of the call's runs in milliseconds. */
  readonly durationMs: number
  /** What preparing Blender did first, such as a first-use installation. */
  readonly notes: readonly string[]
  /** The runs in request order. */
  readonly runs: readonly ScriptRunReport[]
  /** For a call with one run that started: the last lines of its output, at most {@link SCRIPT_OUTPUT_CHARS} characters. */
  readonly output?: string
  /** For a call with one run that started: the lines of output left out before {@link output}. */
  readonly omittedLines?: number
}

/** What {@link BlenderScripts} needs from the server process. */
export interface BlenderScriptDependencies {
  /**
   * Prepare Blender and build the command line that runs the worker script, as for a worker start.
   * @param signal - cancels the preparation.
   * @returns the launch; the worker script runs the script that `WASD_BLENDER_SCRIPT` names.
   */
  readonly launch: (signal: AbortSignal) => Promise<WorkerLaunch>
  /** The computer's memory and processors. */
  readonly machine: MachineResources
}

/** How one run's process ended. */
interface RunOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** The end of the output, at most `maxLogBytes`. */
  readonly tail: string
  /** Lines of output in all. */
  readonly lines: number
  /** Whether `output.log` reached its byte limit. */
  readonly cut: boolean
}

/** One run's process. */
interface RunSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly logFile: string
  readonly logBytes: number
  readonly tailBytes: number
}

/**
 * The folder name part of a run's name: its letters, digits, dots, underscores, and dashes, other characters as
 * dashes, at most 40 characters.
 * @param name - the name the request gave.
 * @returns the part, or an empty string when nothing usable remains.
 */
export function runFolderName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|[-.]+$/gu, '').slice(0, 40).replace(/[-.]+$/u, '')
}

/**
 * The status of a run that started.
 * @param outcome - how its process ended.
 * @returns `timed-out`, `finished` for exit code 0, otherwise `failed`.
 */
function statusOf(outcome: RunOutcome): ScriptRunStatus {
  if (outcome.timedOut) return 'timed-out'
  return outcome.exitCode === 0 ? 'finished' : 'failed'
}

/**
 * Run one process to its end, its time limit, or cancellation. Its standard output and standard error go together
 * into the log file, up to `logBytes`, and their end stays in memory. File descriptor 3 is a pipe that the server holds
 * open and never reads, so the worker script notices when the server is gone.
 * @param spec - the command line, environment, time limit, log file, and byte limits.
 * @param signal - cancels the run, which stops its process group.
 * @param processes - the running processes, which the run joins until its process closes.
 * @returns how the process ended and the end of its output.
 * @throws the spawn error when the process cannot start, and the abort reason after cancellation.
 */
function runProcess(spec: RunSpec, signal: AbortSignal, processes: Set<ChildProcess>): Promise<RunOutcome> {
  const [command = '', ...args] = spec.argv
  const started = Date.now()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      })
    } catch (error) {
      // spawn throws for invalid arguments, such as a NUL byte in argv.
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    processes.add(child)
    const log = createWriteStream(spec.logFile)
    log.on('error', () => {
      // A log that cannot be written stays short; the report still has the end of the output.
    })
    let logged = 0
    let cut = false
    let tail = Buffer.alloc(0)
    let newlines = 0
    let endsInNewline = true
    let failure: Error | undefined
    let timedOut = false
    const collect = (chunk: Buffer): void => {
      if (!cut) {
        const room = spec.logBytes - logged
        log.write(chunk.length <= room ? chunk : chunk.subarray(0, room))
        logged += Math.min(chunk.length, room)
        cut = chunk.length > room
      }
      tail = Buffer.concat([tail, chunk])
      if (tail.length > spec.tailBytes) tail = tail.subarray(tail.length - spec.tailBytes)
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) newlines += 1
      endsInNewline = chunk.at(-1) === 10
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    // The server's end of the pipe on file descriptor 3 stays open, unread, until the process closes. The run never
    // writes to it, so an error on it, such as a reset after the run exited, loses nothing.
    child.stdio[3]?.on('error', () => {})
    const timer = setTimeout(() => {
      timedOut = true
      signalProcessGroup(child, 'SIGKILL')
    }, spec.timeoutMs)
    const onAbort = (): void => { signalProcessGroup(child, 'SIGKILL') }
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => { failure = error })
    child.once('exit', () => {
      settle()
      // Processes that the script left running belong to the group and would keep the output pipes open.
      /* v8 ignore else -- Windows has no process groups, and a Windows pid is reused too soon to signal it after exit */
      if (process.platform !== 'win32') signalProcessGroup(child, 'SIGKILL')
    })
    // 'close' follows 'exit', or follows 'error' alone when the spawn failed.
    child.once('close', (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      settle()
      processes.delete(child)
      child.stdio[3]?.destroy()
      if (cut) log.write(`\n[WASD Engine left out the output after its first ${String(spec.logBytes)} bytes.]\n`)
      log.end(() => {
        if (failure !== undefined && child.pid === undefined) {
          reject(failure)
          return
        }
        if (signal.aborted) {
          reject(abortError(signal))
          return
        }
        resolve({
          exitCode,
          signal: exitSignal,
          timedOut,
          durationMs: Date.now() - started,
          tail: tail.toString('utf8'),
          lines: newlines + (endsInNewline ? 0 : 1),
          cut,
        })
      })
    })
  })
}

/**
 * The lines of the end of a run's output.
 * @param tail - the end of the output.
 * @returns the lines in output order, without the empty line after a final line break.
 */
function outputLines(tail: string): string[] {
  const lines = tail.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The last lines of a run's output that fit in {@link SCRIPT_OUTPUT_CHARS} characters.
 * @param outcome - how the run ended, with the end of its output.
 * @returns the lines and how many lines of output they leave out before them.
 */
function outputEnd(outcome: RunOutcome): { readonly output: string; readonly omittedLines: number } {
  const lines = outputLines(outcome.tail)
  const kept: string[] = []
  let chars = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    if (chars + line.length + 1 > SCRIPT_OUTPUT_CHARS) break
    kept.unshift(line)
    chars += line.length + 1
  }
  return { output: kept.join('\n'), omittedLines: Math.max(0, outcome.lines - kept.length) }
}

/**
 * Check that a file the call names exists.
 * @param path - absolute path.
 * @param what - the argument, such as `script`.
 * @throws {BlenderScriptError} for a missing path or one that is not a file.
 */
async function requireFile(path: string, what: string): Promise<void> {
  let isFile: boolean
  try {
    isFile = (await stat(path)).isFile()
  } catch {
    throw new BlenderScriptError(`The ${what} ${path} does not exist.`)
  }
  if (!isFile) throw new BlenderScriptError(`The ${what} ${path} is not a file.`)
}

/**
 * What ran a call's script, for its report.
 * @param launch - the call's launch.
 * @returns a phrase such as `the bpy module that WASD Engine ships`.
 */
function runtimeOf(launch: WorkerLaunch): string {
  if (launch.backend === 'app') return `Blender at ${launch.argv[0]}`
  return launch.shipped ? 'the bpy module that WASD Engine ships' : 'the bpy module that uv installed'
}

/** First-come, first-served places for runs; a cancelled wait leaves the queue. */
class RunSlots {
  private running = 0
  private readonly waiting: (() => void)[] = []

  /** @param limit - most runs at once, at least 1. */
  constructor(private readonly limit: number) {}

  /**
   * Run a task once a place is free, after the tasks that asked earlier.
   * @param signal - cancels the wait.
   * @param task - the work that holds the place.
   * @returns the task's result.
   */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.running -= 1
      this.waiting.shift()?.()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    if (this.running < this.limit && this.waiting.length === 0) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        this.running += 1
        resolve()
      }
      const onAbort = (): void => {
        this.waiting.splice(this.waiting.indexOf(grant), 1)
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(grant)
    })
  }
}

/** The script runs of one Blender server; see the module documentation. */
export class BlenderScripts {
  /** Most runs that run at once on this computer: `processLimit` of `maxScripts`, `scriptMemoryBytes`, and `scriptCores`. */
  readonly limit: number
  private readonly slots: RunSlots
  /** Folders of the calls that run, which pruning keeps. */
  private readonly calls = new Set<string>()
  private readonly processes = new Set<ChildProcess>()
  private closed = false

  /**
   * @param options - the server options: `dataRoot`, the run limits, `keptScriptResults`, `scriptLogBytes`,
   *   `maxLogBytes`, and `minAvailableMemoryBytes`.
   * @param dependencies - the launch and the computer's resources.
   */
  constructor(private readonly options: BlenderServerOptions, private readonly dependencies: BlenderScriptDependencies) {
    const sizing = { max: options.maxScripts, memoryBytes: options.scriptMemoryBytes, cores: options.scriptCores }
    this.limit = processLimit(sizing, dependencies.machine)
    this.slots = new RunSlots(this.limit)
  }

  /**
   * Run every run of a call, as many at once as the server's places allow, each within its time limit and within the
   * call's, and write `summary.json` into the call's folder.
   * @param call - the script, the .blend file, the runs, and the time limits.
   * @param signal - cancels the call and stops its runs.
   * @returns the runs in request order; a run that could not start says why.
   * @throws {BlenderScriptError} when the script or the .blend file is missing, or the server shuts down; the errors of
   *   the launch, such as a failed first-use installation; the abort reason after cancellation.
   */
  async run(call: ScriptCall, signal: AbortSignal): Promise<ScriptCallReport> {
    if (this.closed) throw new BlenderScriptError('The Blender server is shutting down.')
    const started = Date.now()
    const deadline = started + call.callTimeoutMs
    await requireFile(call.script, 'script')
    if (call.blend !== undefined) await requireFile(call.blend, '.blend file')
    const launch = await this.dependencies.launch(signal)
    const resultsDir = await this.createCallFolder(new Date(started))
    try {
      const parallel = Math.max(1, Math.min(this.limit, call.runs.length))
      const runs: ScriptRunReport[] = Array.from({ length: call.runs.length })
      let single: RunOutcome | undefined
      let next = 0
      const lane = async (): Promise<void> => {
        for (let index = next; index < call.runs.length; index = next) {
          next += 1
          const { report, outcome } = await this.runOne(call, launch, resultsDir, index, deadline, signal)
          runs[index] = report
          if (call.runs.length === 1) single = outcome
        }
      }
      await Promise.all(Array.from({ length: parallel }, lane))
      const report: ScriptCallReport = {
        script: call.script,
        ...call.blend === undefined ? {} : { blend: call.blend },
        runtime: runtimeOf(launch),
        resultsDir,
        parallel,
        durationMs: Date.now() - started,
        notes: launch.notes,
        runs,
        ...single === undefined ? {} : outputEnd(single),
      }
      await writeFile(join(resultsDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
      return report
    } finally {
      this.calls.delete(resultsDir)
    }
  }

  /** Stop every running run and refuse new calls; a stopped run's call reports it as failed. */
  close(): void {
    this.closed = true
    for (const child of this.processes) signalProcessGroup(child, 'SIGKILL')
  }

  /**
   * Run one run of a call once a place is free. The wait for a place ends at the call's deadline, so a run that other
   * calls keep waiting reports that it did not start instead of holding up the call's report.
   * @returns the run's report, and how its process ended when it started.
   * @throws the abort reason after cancellation.
   */
  private async runOne(
    call: ScriptCall, launch: WorkerLaunch, resultsDir: string, index: number, deadline: number, signal: AbortSignal,
  ): Promise<{ readonly report: ScriptRunReport; readonly outcome?: RunOutcome }> {
    const request = call.runs[index] as ScriptRunRequest
    const named = request.name === undefined ? '' : runFolderName(request.name)
    const folder = join(resultsDir, named === '' ? String(index + 1) : `${String(index + 1)}-${named}`)
    const base = { ...request.name === undefined ? {} : { name: request.name }, args: request.args, folder }
    const notStarted = (reason: string): { readonly report: ScriptRunReport } => ({
      report: { ...base, status: 'not-started', reason, durationMs: 0, files: [], totalFiles: 0 },
    })
    const timeRanOut = `The call's ${String(Math.round(call.callTimeoutMs / 1000))} seconds ran out before the run could start.`
    // The deadline ends the wait for a place, never a run that holds one: a started run stops at its own time limit.
    const deadlineReached = new AbortController()
    const timer = setTimeout(() => { deadlineReached.abort(new BlenderScriptError(timeRanOut)) }, Math.max(0, deadline - Date.now()))
    try {
      return await this.slots.run(AbortSignal.any([signal, deadlineReached.signal]), async () => {
        clearTimeout(timer)
        const remaining = deadline - Date.now()
        if (remaining <= 0) return notStarted(timeRanOut)
        if (this.closed) return notStarted('The Blender server shut down before the run could start.')
        const shortage = memoryShortage(this.options.minAvailableMemoryBytes, this.dependencies.machine.availableMemoryBytes)
        if (shortage !== undefined) return notStarted(lowMemoryMessage('a Blender script run', shortage))
        const outcome = await this.startRun(call, launch, request, folder, Math.min(call.timeoutMs, remaining), signal)
        const lastLine = outputLines(outcome.tail).findLast(line => line.trim() !== '')
        const report: ScriptRunReport = {
          ...base,
          status: statusOf(outcome),
          ...outcome.timedOut || outcome.exitCode === null ? {} : { exitCode: outcome.exitCode },
          ...outcome.timedOut || outcome.signal === null ? {} : { signal: outcome.signal },
          durationMs: outcome.durationMs,
          ...lastLine === undefined ? {} : { lastLine: lastLine.length > LAST_LINE_CHARS ? `${lastLine.slice(0, LAST_LINE_CHARS)}…` : lastLine },
          ...outcome.cut ? { outputCut: true } : {},
          ...await listFolderFiles(join(folder, 'files'), LISTED_RUN_FILES),
        }
        return { report, outcome }
      })
    } catch (error) {
      signal.throwIfAborted()
      if (error === deadlineReached.signal.reason) return notStarted(timeRanOut)
      return notStarted(`The run could not start: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Start one run's process in its folder, and delete its Blender user folder once it ends. */
  private async startRun(
    call: ScriptCall, launch: WorkerLaunch, request: ScriptRunRequest, folder: string, timeoutMs: number, signal: AbortSignal,
  ): Promise<RunOutcome> {
    const files = join(folder, 'files')
    const user = join(folder, USER_RESOURCES_FOLDER)
    await mkdir(files, { recursive: true })
    await mkdir(user, { recursive: true })
    try {
      return await runProcess({
        argv: [...launch.argv, '--', ...request.args],
        cwd: dirname(call.script),
        env: {
          ...launch.env,
          [SCRIPT_VARIABLE]: call.script,
          ...call.blend === undefined ? {} : { [BLEND_FILE_VARIABLE]: call.blend },
          [OUTPUT_DIR_VARIABLE]: files,
          BLENDER_USER_RESOURCES: user,
        },
        timeoutMs,
        logFile: join(folder, 'output.log'),
        logBytes: this.options.scriptLogBytes,
        tailBytes: this.options.maxLogBytes,
      }, signal, this.processes)
    } finally {
      await rm(user, { recursive: true, force: true })
    }
  }

  /**
   * Create the folder of a new call, and delete the oldest call folders beyond `keptScriptResults`, the new one
   * included, except those of calls that still run.
   * @param now - the time the call began, which names the folder.
   * @returns the absolute folder.
   */
  private async createCallFolder(now: Date): Promise<string> {
    const root = join(this.options.dataRoot, SCRIPT_RESULTS_FOLDER)
    const dir = join(root, `${now.toISOString().replace(/[-:.]/gu, '')}-${randomBytes(3).toString('hex')}`)
    await mkdir(dir, { recursive: true })
    this.calls.add(dir)
    const calls = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && CALL_FOLDER.test(entry.name))
      .map(entry => entry.name)
      .sort()
    for (const stale of calls.slice(0, Math.max(0, calls.length - this.options.keptScriptResults))) {
      if (!this.calls.has(join(root, stale))) await rm(join(root, stale), { recursive: true, force: true })
    }
    return dir
  }
}
