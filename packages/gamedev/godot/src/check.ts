/**
 * Static GDScript check: one headless Godot process loads each script through `runtime/wasd_check.gd` and
 * reports the errors logged while it loaded, without running the game.
 * @module @deepseek-ai/dsh-godot/src/check
 */
import { stat } from 'node:fs/promises'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { consoleLines, describeExit, formatSeconds, lastLines } from './output.ts'
import { listProjectFiles, resolveProjectPath, toResPath } from './project.ts'
import { parseGodotJson } from './protocol.ts'
import { FAILURE_OUTPUT_LINES, launcherArgv } from './run.ts'
import type { ResolvedGodotRuntime } from './runtime.ts'

/** Most scripts one check loads. */
export const CHECK_SCRIPT_LIMIT = 400

const MARKER = 'WASD_CHECK '

const CheckLine = z.object({
  path: z.string(),
  loaded: z.boolean(),
  errors: z.array(z.object({
    level: z.enum(['warning', 'error', 'script_error', 'shader_error']),
    message: z.string(),
    file: z.string(),
    line: z.number().int(),
    function: z.string(),
  })),
})

type CheckLine = z.infer<typeof CheckLine>

/** One problem found in a script. */
export interface CheckIssue {
  /** Severity. */
  readonly level: 'warning' | 'error' | 'script_error' | 'shader_error'
  /** `res://` file the problem is in. */
  readonly file: string
  /** 1-based line, when known. */
  readonly line?: number
  /** Engine message. */
  readonly message: string
}

/** The problems of one checked script. */
export interface CheckedScript {
  /** `res://` path of the checked script. */
  readonly path: string
  /** Problems found while loading it; empty when it loaded cleanly. */
  readonly issues: readonly CheckIssue[]
}

/** Parameters of one check process. */
export interface CheckOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Runtime to launch. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute project folder. */
  readonly projectDir: string
  /** Real path of `wasd_check.gd`. */
  readonly checkScript: string
  /** `res://` paths to check. */
  readonly paths: readonly string[]
  /** Host process id for the runner's parent watch. */
  readonly hostPid: number
  /** Deadline of the whole check. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** A static check request as the model gave it. */
export interface CheckRequest {
  /** Project folder relative to the working directory; the running game's project or the nearest one when omitted. */
  readonly project?: string
  /** Files or folders to check; the whole project when omitted. */
  readonly paths?: readonly string[]
}

/** A finished static check. */
export interface CheckReport {
  /** Checked project folder. */
  readonly projectDir: string
  /** Checked scripts in request order. */
  readonly scripts: readonly CheckedScript[]
  /** Scripts the request named, including those beyond {@link CHECK_SCRIPT_LIMIT}. */
  readonly total: number
}

/** The `res://` scripts a check request selects. */
export interface ScriptSelection {
  /** Up to {@link CHECK_SCRIPT_LIMIT} distinct paths in request order. */
  readonly paths: readonly string[]
  /** Scripts the request names. */
  readonly total: number
}

/** The check could not run or ended before reporting every script. */
export class GodotCheckError extends Error {
  override name = 'GodotCheckError'
}

/**
 * Select the scripts a check request names.
 * @param projectDir - absolute project folder.
 * @param workingDirectory - absolute Session working directory, the base of relative paths.
 * @param paths - files or folders as `res://`, absolute, or relative paths; undefined selects the whole project.
 * @param signal - cancellation.
 * @returns the selected `res://` paths and how many scripts the request names.
 * @throws {GodotCheckError} for a path outside the project, a missing path, or a file that is not a `.gd` script.
 */
export async function selectScripts(
  projectDir: string,
  workingDirectory: string,
  paths: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<ScriptSelection> {
  if (paths === undefined) {
    const listed = await listProjectFiles(projectDir, '.gd', CHECK_SCRIPT_LIMIT, signal)
    return { paths: listed.files.map(file => toResPath(projectDir, file)), total: listed.total }
  }
  const selected = new Set<string>()
  let total = 0
  for (const path of paths) {
    const absolute = resolveProjectPath(projectDir, workingDirectory, path)
    if (absolute === undefined) throw new GodotCheckError(`${path} is outside the project ${projectDir}.`)
    let directory: boolean
    try {
      directory = (await stat(absolute)).isDirectory()
    } catch (error) {
      throw new GodotCheckError(`${path} does not exist in the project ${projectDir}.`, { cause: error })
    }
    if (directory) {
      const listed = await listProjectFiles(absolute, '.gd', CHECK_SCRIPT_LIMIT, signal)
      total += listed.total
      for (const file of listed.files) selected.add(toResPath(projectDir, file))
    } else {
      if (!absolute.endsWith('.gd')) throw new GodotCheckError(`${path} is not a .gd script.`)
      total += 1
      selected.add(toResPath(projectDir, absolute))
    }
  }
  return { paths: [...selected].slice(0, CHECK_SCRIPT_LIMIT), total }
}

/**
 * Select the problems a script's author can act on: those located in `res://` files, else the first engine
 * error (for example a missing file), attributed to the script.
 * @param path - checked script.
 * @param errors - errors logged while it loaded.
 * @returns the issues.
 */
function issuesOf(path: string, errors: CheckLine['errors']): CheckIssue[] {
  const located = errors.filter(error => error.file.startsWith('res://'))
  if (located.length > 0) {
    return located.map(error => ({
      level: error.level, file: error.file, ...error.line > 0 ? { line: error.line } : {}, message: error.message,
    }))
  }
  const first = errors.find(error => error.level !== 'warning')
  return first === undefined ? [] : [{ level: first.level, file: path, message: first.message }]
}

function parseLine(text: string): CheckLine | undefined {
  let value: unknown
  try {
    value = parseGodotJson(text)
  } catch {
    // Output cut by a crash or by the collection limit cannot be a complete report line; its script counts as unchecked.
    return undefined
  }
  const parsed = CheckLine.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Check scripts in one headless process.
 * @param options - process parameters and scripts.
 * @returns every checked script in request order.
 * @throws {GodotCheckError} when the process ends or times out before reporting a script.
 */
export async function checkScripts(options: CheckOptions): Promise<CheckedScript[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const handle = options.subprocess.spawn({
    argv: launcherArgv(options.runtime, options.hostPid, ['--headless', '--path', options.projectDir, '--script', options.checkScript, '--', ...options.paths]),
    cwd: options.projectDir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: options.outputBytes }, stderr: { maxBytes: options.outputBytes } },
    graceMs: options.graceMs,
    signal: AbortSignal.any([options.signal, timeout]),
    env: { ELECTRON_RUN_AS_NODE: undefined },
  })
  const outcome = await handle.done
  options.signal.throwIfAborted()
  const stdout = (handle.collected.stdout as SubprocessOutputReader).readFrom(0).text
  const stderr = (handle.collected.stderr as SubprocessOutputReader).readFrom(0).text
  const reported = new Map<string, CheckedScript>()
  for (const line of consoleLines(stdout)) {
    const parsed = line.startsWith(MARKER) ? parseLine(line.slice(MARKER.length)) : undefined
    if (parsed !== undefined) reported.set(parsed.path, { path: parsed.path, issues: issuesOf(parsed.path, parsed.errors) })
  }
  const missing = options.paths.filter(path => !reported.has(path))
  if (missing.length > 0) {
    const cause = timeout.aborted ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome)})`
    const others = missing.length > 1 ? ` and ${missing.length - 1} more scripts` : ''
    const tail = lastLines(stderr, FAILURE_OUTPUT_LINES) || lastLines(stdout, FAILURE_OUTPUT_LINES)
    throw new GodotCheckError(`The Godot check ${cause} before checking ${missing[0] as string}${others}.${tail === '' ? '' : `\nLast output:\n${tail}`}`)
  }
  return options.paths.map(path => reported.get(path) as CheckedScript)
}
