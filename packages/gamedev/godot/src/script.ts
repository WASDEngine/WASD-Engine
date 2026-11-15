/**
 * Headless Godot processes outside a game run: the report of an import step for another Host plugin, such as the game
 * add-ons installer, and `godot_script`, which runs a GDScript that extends `SceneTree` or `MainLoop` against the
 * project with `--headless --script`, the way the command-line runners of test add-ons such as GUT and GdUnit4 run, once
 * or several times at once. Each call keeps its results in a folder of its own under the project's data folder: one
 * folder per run with the run's output and the files it wrote to the folder that `WASD_OUTPUT_DIR` names, and, for a
 * call with several runs, `summary.json`. While the call runs, its folder also holds {@link RUNNING_MARKER}, which
 * keeps other calls, also those of other Hosts, from deleting it.
 * @module @deepseek-ai/dsh-godot/src/script
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runGodotCommand } from './command.ts'
import { importFailure, type GodotImportOutcome } from './imports.ts'
import { consoleLines, parseEngineOutput, type EngineOutputLine } from './output.ts'
import { projectDataDirectory } from './project.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'

/** Most characters of output a script result keeps: its last lines, where runners print their summaries. */
export const SCRIPT_OUTPUT_CHARS = 6000

/** Most engine errors a script result or an import report lists. */
export const LISTED_ENGINE_ISSUES = 20

/** Default time limit of one script run, in seconds. */
export const DEFAULT_SCRIPT_SECONDS = 120

/** Longest time limit a script run may ask for, in seconds. */
export const MAX_SCRIPT_SECONDS = 900

/** Most runs one call may ask for. */
export const MAX_SCRIPT_RUNS = 64

/**
 * Longest time, in seconds, that the runs of a call with several runs take together: a run that has not started by
 * then does not start, and one that still runs then stops.
 */
export const MAX_SCRIPT_CALL_SECONDS = 3600

/** Most files of a run's `files` folder that a report names. */
export const LISTED_RUN_FILES = 50

/** Longest run name. */
export const MAX_RUN_NAME_CHARS = 60

/** Most engine errors a report lists for each run of a call with several runs. */
const LISTED_RUN_ISSUES = 5

/** Longest last line of output that a report quotes for each run of a call with several runs. */
const LAST_LINE_CHARS = 200

/** Name of the folder, in the project's data folder, that holds the folders of the script calls. */
export const SCRIPT_RESULTS_FOLDER = 'wasd-script-runs'

/** Environment variable that gives a run the absolute path of its `files` folder. */
export const OUTPUT_DIR_VARIABLE = 'WASD_OUTPUT_DIR'

/** Name of a call's folder: the UTC time it began to the millisecond, then six random hexadecimal digits. */
const CALL_FOLDER = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/u

/** File that a call's folder holds while the call runs: the id of the Host process that runs it. */
export const RUNNING_MARKER = '.running'

/** A script request that cannot run, with a message for the model. */
export class GodotScriptError extends Error {
  override name = 'GodotScriptError'
}

/** Parameters of a script run. */
export interface HeadlessOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Runtime to launch. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute project folder. */
  readonly projectDir: string
  /** Host process id for the runner's parent watch. */
  readonly hostPid: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** One problem the engine logged. */
export interface EngineIssue {
  /** Severity. */
  readonly level: 'warning' | 'error' | 'script_error' | 'shader_error'
  /** Engine message. */
  readonly message: string
  /** `res://` file, when the engine named one. */
  readonly file?: string
  /** 1-based line, when known. */
  readonly line?: number
}

/** What an import step reported. */
export interface GodotImportReport {
  /** Errors and warnings in output order, at most {@link LISTED_ENGINE_ISSUES}. */
  readonly issues: readonly EngineIssue[]
}

/** The files a run wrote to its `files` folder. */
export interface RunFiles {
  /** Paths relative to the `files` folder, with `/` separators, in name order; at most {@link LISTED_RUN_FILES}. */
  readonly files: readonly string[]
  /** Files in the folder and its subfolders in all. */
  readonly totalFiles: number
}

/** A finished script run of a call with one run. */
export interface GodotScriptReport extends RunFiles {
  /** Absolute project folder. */
  readonly projectDir: string
  /** `res://` path of the script that ran. */
  readonly script: string
  /**
   * Exit code of the runner, or null when a signal or the time limit ended it. LibGodot does not expose the engine's
   * exit code, so the runner exits 0 once the script quits, whatever code it passed to `quit()`, and with another code
   * only when the runner itself fails (see `wasdengine/libgodot/godot_runner.c`).
   */
  readonly exitCode: number | null
  /** Whether the run hit its time limit. */
  readonly timedOut: boolean
  /** Wall time of the run in milliseconds. */
  readonly durationMs: number
  /** The last lines of standard output and standard error together, at most {@link SCRIPT_OUTPUT_CHARS} characters. */
  readonly output: string
  /** Lines of output left out before {@link output}. */
  readonly omittedLines: number
  /** Errors the engine logged, at most {@link LISTED_ENGINE_ISSUES}. */
  readonly issues: readonly EngineIssue[]
  /** Errors the engine logged in all. */
  readonly totalIssues: number
  /** Absolute folder of the run: `stdout.log`, `stderr.log`, and `files`, the folder that `WASD_OUTPUT_DIR` named. */
  readonly folder: string
}

/**
 * How one run of a call with several runs ended: `finished` once the script quit, `timed-out` at its time limit,
 * `ended` when the runner failed or a signal ended it, and `not-started` when it could not start, such as after the
 * call's time ran out or while the computer had too little memory available.
 */
export type ScriptRunStatus = 'finished' | 'timed-out' | 'ended' | 'not-started'

/** One run of a call with several runs, as its report gives it. */
export interface ScriptRunResult extends RunFiles {
  /** The name the request gave the run, if any. */
  readonly name?: string
  /** User arguments the run received after `--`. */
  readonly args: readonly string[]
  /** Absolute folder of the run: `stdout.log`, `stderr.log`, `files`, and `home`, which holds its `user://` folder. */
  readonly folder: string
  /** How the run ended. */
  readonly status: ScriptRunStatus
  /** Exit code of the runner, as {@link GodotScriptReport.exitCode} gives it, for a run that exited. */
  readonly exitCode?: number
  /** Why the run did not start, for `not-started`. */
  readonly reason?: string
  /** Wall time of the run in milliseconds; 0 for a run that did not start. */
  readonly durationMs: number
  /** Errors the engine logged, at most five. */
  readonly issues: readonly EngineIssue[]
  /** Errors the engine logged in all. */
  readonly totalIssues: number
  /** The last line the run printed, shortened to 200 characters. */
  readonly lastLine?: string
}

/** A finished call with several runs. */
export interface GodotScriptRunsReport {
  /** Absolute project folder. */
  readonly projectDir: string
  /** `res://` path of the script that ran. */
  readonly script: string
  /** Absolute folder of the call: `summary.json` and one folder per run. */
  readonly resultsDir: string
  /** The frame rate the runs had fixed, if any. */
  readonly fixedFps?: number
  /** Most runs that could run at once. */
  readonly parallel: number
  /** Wall time of the call's runs in milliseconds. */
  readonly durationMs: number
  /** Errors of the import step before the runs, at most {@link LISTED_ENGINE_ISSUES}. */
  readonly importIssues: readonly EngineIssue[]
  /** The runs in request order. */
  readonly runs: readonly ScriptRunResult[]
}

/** One run of a call. */
export interface ScriptRun {
  /** The name the request gave the run, if any. */
  readonly name?: string
  /** User arguments after `--`, which the script reads with `OS.get_cmdline_user_args()`. */
  readonly args: readonly string[]
  /** Absolute folder of the run, which the run creates. */
  readonly folder: string
  /** Whether the run gets a `user://` folder of its own, in the `home` folder of its folder. */
  readonly ownUserData: boolean
}

/** How the runs of a call take their turns among the other Godot processes of the Host. */
export interface ScriptRunTurns {
  /** Most runs of the call that run at once. */
  readonly parallel: number
  /**
   * Run one task once another script run may start.
   * @param task - the run.
   * @param signal - cancels the wait.
   * @returns the task's result.
   * @throws the abort reason, or why the run may not start, such as too little memory available.
   */
  turn<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T>
}

function isIssue(line: EngineOutputLine): line is EngineOutputLine & { readonly level: EngineIssue['level'] } {
  return line.level === 'warning' || line.level === 'error' || line.level === 'script_error' || line.level === 'shader_error'
}

function issueOf(line: EngineOutputLine & { readonly level: EngineIssue['level'] }): EngineIssue {
  return {
    level: line.level,
    message: line.message,
    ...line.file === undefined ? {} : { file: line.file },
    ...line.line === undefined ? {} : { line: line.line },
  }
}

/**
 * The errors and warnings of an import step, for the plugin that asked for it.
 * @param outcome - how the step ended.
 * @param timeoutMs - the step's deadline.
 * @returns the note about the Blender importer first, then what the engine logged, then a warning when the step did
 *   not end normally; at most {@link LISTED_ENGINE_ISSUES}.
 */
export function importReport(outcome: GodotImportOutcome, timeoutMs: number): GodotImportReport {
  const issues: EngineIssue[] = [
    ...outcome.blenderNote === undefined ? [] : [{ level: 'warning' as const, message: outcome.blenderNote }],
    ...[...parseEngineOutput(outcome.stdout, 'stdout', false), ...parseEngineOutput(outcome.stderr, 'stderr', false)].filter(isIssue).map(issueOf),
  ]
  const failure = importFailure(outcome, timeoutMs)
  if (failure !== undefined) issues.push({ level: 'warning', message: `The Godot import step ${failure}; imported resources may be incomplete.` })
  return { issues: issues.slice(0, LISTED_ENGINE_ISSUES) }
}

/**
 * The `res://` path of a script a request names.
 * @param projectDir - absolute project folder.
 * @param base - absolute folder that relative paths start from.
 * @param script - `res://` path, or a path relative to `base`, or absolute.
 * @returns the `res://` path of an existing `.gd` file inside the project.
 * @throws {GodotScriptError} for a path outside the project, a missing file, or a file that is not a `.gd` script.
 */
export async function resolveScript(projectDir: string, base: string, script: string): Promise<string> {
  const absolute = script.startsWith('res://') ? resolve(projectDir, script.slice('res://'.length)) : resolve(base, script)
  const inside = relative(projectDir, absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new GodotScriptError(`${script} is outside the project ${projectDir}.`)
  if (!absolute.endsWith('.gd')) throw new GodotScriptError(`${script} is not a .gd script.`)
  try {
    if (!(await stat(absolute)).isFile()) throw new GodotScriptError(`${script} is not a file.`)
  } catch (error) {
    if (error instanceof GodotScriptError) throw error
    throw new GodotScriptError(`${script} does not exist in ${projectDir}.`)
  }
  return `res://${inside.split(sep).join('/')}`
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
 * Create the folder of a new call under the project's data folder, marked as running until
 * {@link finishCallFolder}, and delete the oldest call folders there beyond `kept`, the new one included, except those
 * of calls that still run: folders whose {@link RUNNING_MARKER} names a process that exists.
 * @param projectDir - absolute project folder.
 * @param kept - call folders to keep, at least 1.
 * @param now - the time the call began, which names the folder.
 * @returns the absolute folder.
 */
export async function createCallFolder(projectDir: string, kept: number, now: Date): Promise<string> {
  const dataDirectory = projectDataDirectory(await readFile(join(projectDir, 'project.godot'), 'utf8'))
  const root = join(projectDir, dataDirectory, SCRIPT_RESULTS_FOLDER)
  const stamp = now.toISOString().replace(/[-:.]/gu, '')
  const dir = join(root, `${stamp}-${randomBytes(3).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, RUNNING_MARKER), String(process.pid))
  const calls = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && CALL_FOLDER.test(entry.name))
    .map(entry => entry.name)
    .sort()
  for (const stale of calls.slice(0, Math.max(0, calls.length - kept))) {
    if (!await callRunning(join(root, stale))) await rm(join(root, stale), { recursive: true, force: true })
  }
  return dir
}

/**
 * Mark a call's folder as finished, so that later calls may delete it.
 * @param dir - the folder that {@link createCallFolder} created.
 */
export async function finishCallFolder(dir: string): Promise<void> {
  await rm(join(dir, RUNNING_MARKER), { force: true })
}

/**
 * Whether a call folder belongs to a call that still runs: its {@link RUNNING_MARKER} names a process that exists. A
 * folder whose Host ended without finishing it counts as finished.
 */
async function callRunning(dir: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(dir, RUNNING_MARKER), 'utf8')
  } catch (error) {
    // ENOENT: the call finished, or began before calls marked their folders.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch {
    // ESRCH: no process has the id; EPERM: one of another user does, which no Host of this user is.
    return false
  }
  return true
}

/**
 * The environment that gives a run its own `user://` folder inside `home`: Godot derives the folder from `HOME` on
 * macOS, from `XDG_DATA_HOME` on Linux, and from `APPDATA` on Windows.
 * @param home - absolute folder.
 * @returns the environment entries.
 */
export function ownUserDataEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  }
}

/**
 * List the files in a folder and its subfolders.
 * @param root - absolute folder.
 * @returns at most {@link LISTED_RUN_FILES} paths relative to `root` in name order, and how many files it holds.
 */
async function listRunFiles(root: string): Promise<RunFiles> {
  let entries
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (error) {
    // A script may delete the folder it was given; the run then wrote no files that remain.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], totalFiles: 0 }
    throw error
  }
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
  return { files: files.slice(0, LISTED_RUN_FILES), totalFiles: files.length }
}

/** The output of a run after it ended. */
interface RunOutput {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly lines: readonly string[]
  readonly issues: readonly EngineIssue[]
}

/**
 * Start one run of a script headless and keep its output in its folder.
 * @param options - process parameters.
 * @param script - `res://` path from {@link resolveScript}.
 * @param fixedFps - frame rate to fix with `--fixed-fps`, or undefined for real time.
 * @param run - the run's arguments and folder.
 * @param timeoutMs - deadline of the run.
 * @returns how the run ended, its non-empty output lines, and the engine errors it logged.
 * @throws {GodotScriptError} when the process cannot start.
 */
async function startRun(
  options: HeadlessOptions,
  script: string,
  fixedFps: number | undefined,
  run: ScriptRun,
  timeoutMs: number,
): Promise<RunOutput> {
  const filesDir = join(run.folder, 'files')
  await mkdir(filesDir, { recursive: true })
  const home = join(run.folder, 'home')
  if (run.ownUserData) await mkdir(home, { recursive: true })
  const started = Date.now()
  let outcome
  try {
    outcome = await runGodotCommand({
      subprocess: options.subprocess,
      argv: launcherArgv(options.runtime, options.hostPid, [
        '--headless', '--path', options.projectDir,
        ...fixedFps === undefined ? [] : ['--fixed-fps', String(fixedFps)],
        '--script', script,
        ...run.args.length === 0 ? [] : ['--', ...run.args],
      ]),
      cwd: options.projectDir,
      timeoutMs,
      graceMs: options.graceMs,
      outputBytes: options.outputBytes,
      signal: options.signal,
      env: { [OUTPUT_DIR_VARIABLE]: filesDir, ...run.ownUserData ? ownUserDataEnvironment(home) : {} },
    })
  } catch (error) {
    options.signal.throwIfAborted()
    throw new GodotScriptError(`The Godot script could not start: ${(error as Error).message}`)
  }
  options.signal.throwIfAborted()
  const { stdout, stderr, timedOut } = outcome
  await Promise.all([writeFile(join(run.folder, 'stdout.log'), stdout), writeFile(join(run.folder, 'stderr.log'), stderr)])
  const issues = [...parseEngineOutput(stdout, 'stdout', false), ...parseEngineOutput(stderr, 'stderr', false)]
    .filter(isIssue).filter(line => line.level !== 'warning').map(issueOf)
  return {
    exitCode: timedOut ? null : outcome.exit.exitCode,
    timedOut,
    durationMs: Date.now() - started,
    lines: [...consoleLines(stdout), ...consoleLines(stderr)].filter(line => line.trim() !== ''),
    issues,
  }
}

/**
 * Run a script once against the project headless and collect what it printed.
 * @param options - process parameters.
 * @param script - `res://` path from {@link resolveScript}.
 * @param fixedFps - frame rate to fix with `--fixed-fps`, or undefined for real time.
 * @param run - the run's arguments and folder.
 * @param timeoutMs - deadline of the run.
 * @returns the exit code, the end of the output, the engine errors, and the files the script wrote to its folder.
 * @throws {GodotScriptError} when the process cannot start.
 */
export async function runScript(
  options: HeadlessOptions,
  script: string,
  fixedFps: number | undefined,
  run: ScriptRun,
  timeoutMs: number,
): Promise<GodotScriptReport> {
  const output = await startRun(options, script, fixedFps, run, timeoutMs)
  const kept: string[] = []
  let chars = 0
  for (let index = output.lines.length - 1; index >= 0; index -= 1) {
    const line = output.lines[index] as string
    if (chars + line.length + 1 > SCRIPT_OUTPUT_CHARS) break
    kept.unshift(line)
    chars += line.length + 1
  }
  return {
    projectDir: options.projectDir,
    script,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    durationMs: output.durationMs,
    output: kept.join('\n'),
    omittedLines: output.lines.length - kept.length,
    issues: output.issues.slice(0, LISTED_ENGINE_ISSUES),
    totalIssues: output.issues.length,
    folder: run.folder,
    ...await listRunFiles(join(run.folder, 'files')),
  }
}

/** The status of a run that exited or was stopped. */
function statusOf(output: RunOutput): ScriptRunStatus {
  if (output.timedOut) return 'timed-out'
  return output.exitCode === 0 ? 'finished' : 'ended'
}

/**
 * Run every run of a call, as many at once as `turns` allows, each within its time limit and within the call's
 * deadline, and write `summary.json` into the call's folder.
 * @param options - process parameters.
 * @param call - the script, the fixed frame rate, the runs, each run's time limit, the call's deadline, and its folder.
 * @param turns - how the runs take their turns.
 * @returns the runs in request order; a run that could not start says why.
 * @throws the abort reason when the call is cancelled.
 */
export async function runScriptRuns(
  options: HeadlessOptions,
  call: {
    readonly script: string
    readonly fixedFps?: number
    readonly runs: readonly ScriptRun[]
    readonly timeoutMs: number
    readonly deadline: number
    readonly resultsDir: string
    readonly importIssues: readonly EngineIssue[]
  },
  turns: ScriptRunTurns,
): Promise<GodotScriptRunsReport> {
  const started = Date.now()
  const results: ScriptRunResult[] = Array.from({ length: call.runs.length })
  let next = 0
  const notStarted = (run: ScriptRun, reason: string): ScriptRunResult => ({
    ...run.name === undefined ? {} : { name: run.name },
    args: run.args, folder: run.folder, status: 'not-started', reason, durationMs: 0, files: [], totalFiles: 0, issues: [], totalIssues: 0,
  })
  const worker = async (): Promise<void> => {
    for (let index = next; index < call.runs.length; index = next) {
      next += 1
      const run = call.runs[index] as ScriptRun
      try {
        results[index] = await turns.turn(async () => {
          const remaining = call.deadline - Date.now()
          if (remaining <= 0) return notStarted(run, `The call's ${String(MAX_SCRIPT_CALL_SECONDS)} seconds ran out before the run could start.`)
          const output = await startRun(options, call.script, call.fixedFps, run, Math.min(call.timeoutMs, remaining))
          const lastLine = output.lines.at(-1)
          return {
            ...run.name === undefined ? {} : { name: run.name },
            args: run.args,
            folder: run.folder,
            status: statusOf(output),
            ...output.exitCode === null ? {} : { exitCode: output.exitCode },
            durationMs: output.durationMs,
            issues: output.issues.slice(0, LISTED_RUN_ISSUES),
            totalIssues: output.issues.length,
            ...lastLine === undefined ? {} : { lastLine: lastLine.length > LAST_LINE_CHARS ? `${lastLine.slice(0, LAST_LINE_CHARS)}…` : lastLine },
            ...await listRunFiles(join(run.folder, 'files')),
          }
        }, options.signal)
      } catch (error) {
        options.signal.throwIfAborted()
        results[index] = notStarted(run, (error as Error).message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(turns.parallel, call.runs.length)) }, worker))
  const report: GodotScriptRunsReport = {
    projectDir: options.projectDir,
    script: call.script,
    resultsDir: call.resultsDir,
    ...call.fixedFps === undefined ? {} : { fixedFps: call.fixedFps },
    parallel: Math.max(1, Math.min(turns.parallel, call.runs.length)),
    durationMs: Date.now() - started,
    importIssues: call.importIssues,
    runs: results,
  }
  await writeFile(join(call.resultsDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
