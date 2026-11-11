/**
 * Headless Godot processes outside a game run: the report of an import step for another Host plugin, such as the game
 * add-ons installer, and `godot_script`, which runs a GDScript that extends `SceneTree` or `MainLoop` against the
 * project with `--headless --script`, the way the command-line runners of test add-ons such as GUT and GdUnit4 run.
 * @module @deepseek-ai/dsh-godot/src/script
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runGodotCommand } from './command.ts'
import { importFailure, type GodotImportOutcome } from './imports.ts'
import { consoleLines, parseEngineOutput, type EngineOutputLine } from './output.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'

/** Most characters of output a script result keeps: its last lines, where runners print their summaries. */
export const SCRIPT_OUTPUT_CHARS = 6000

/** Most engine errors a script result or an import report lists. */
export const LISTED_ENGINE_ISSUES = 20

/** Default time limit of one script run, in seconds. */
export const DEFAULT_SCRIPT_SECONDS = 120

/** Longest time limit a script run may ask for, in seconds. */
export const MAX_SCRIPT_SECONDS = 900

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

/** A finished script run. */
export interface GodotScriptReport {
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
 * Run a script against the project headless and collect what it printed.
 * @param options - process parameters.
 * @param script - `res://` path from {@link resolveScript}.
 * @param args - user arguments after `--`, which the script reads with `OS.get_cmdline_user_args()`.
 * @param timeoutMs - deadline of the run.
 * @returns the exit code, the end of the output, and the engine errors.
 * @throws {GodotScriptError} when the process cannot start.
 */
export async function runScript(
  options: HeadlessOptions,
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GodotScriptReport> {
  const started = Date.now()
  let outcome
  try {
    outcome = await runGodotCommand({
      subprocess: options.subprocess,
      argv: launcherArgv(options.runtime, options.hostPid, ['--headless', '--path', options.projectDir, '--script', script, ...args.length === 0 ? [] : ['--', ...args]]),
      cwd: options.projectDir,
      timeoutMs,
      graceMs: options.graceMs,
      outputBytes: options.outputBytes,
      signal: options.signal,
    })
  } catch (error) {
    options.signal.throwIfAborted()
    throw new GodotScriptError(`The Godot script could not start: ${(error as Error).message}`)
  }
  options.signal.throwIfAborted()
  const { stdout, stderr, timedOut } = outcome
  const issues = [...parseEngineOutput(stdout, 'stdout', false), ...parseEngineOutput(stderr, 'stderr', false)]
    .filter(isIssue).filter(line => line.level !== 'warning').map(issueOf)
  const lines = [...consoleLines(stdout), ...consoleLines(stderr)].filter(line => line.trim() !== '')
  const kept: string[] = []
  let chars = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    if (chars + line.length + 1 > SCRIPT_OUTPUT_CHARS) break
    kept.unshift(line)
    chars += line.length + 1
  }
  return {
    projectDir: options.projectDir,
    script,
    exitCode: timedOut ? null : outcome.exit.exitCode,
    timedOut,
    durationMs: Date.now() - started,
    output: kept.join('\n'),
    omittedLines: lines.length - kept.length,
    issues: issues.slice(0, LISTED_ENGINE_ISSUES),
    totalIssues: issues.length,
  }
}
