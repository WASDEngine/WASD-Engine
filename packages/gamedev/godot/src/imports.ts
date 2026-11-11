/**
 * Godot's import of a project: the headless `--import` step that renews the project's import data (imported assets,
 * the `uid://` cache, and the cache of the classes that scripts declare with `class_name`), the per-project order of
 * the steps and checks that write or read that data, and whether the data may be older than the project's files.
 * @module @deepseek-ai/dsh-godot/src/imports
 */
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { untilAborted } from './abort.ts'
import { turnOffBlenderImport } from './blender-import.ts'
import { runGodotCommand, type GodotCommandOutcome } from './command.ts'
import { crashSummary, describeExit, formatSeconds } from './output.ts'
import { isFile, projectDataDirectory, readDirectory } from './project.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'

/** The file in the project's data folder that lists the classes the project's scripts declare with `class_name`. */
export const CLASS_CACHE_FILE = 'global_script_class_cache.cfg'

/** Errors of `stat` that leave a file out of the change test: it was deleted during the walk, or Godot cannot read it either. */
const UNREADABLE_FILE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'])

/** The files that the import writes beside each file it imports. */
const IMPORT_SIDECAR = /\.(?:import|uid)$/u

/** Parameters of one import step. */
export interface ImportOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Runtime to launch. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute project folder. */
  readonly projectDir: string
  /** Host process id for the runner's parent watch. */
  readonly hostPid: number
  /** Deadline of the step. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation; it stops the import process. */
  readonly signal: AbortSignal
}

/** How an import step ended. */
export interface GodotImportOutcome extends GodotCommandOutcome {
  /** A note for the agent when the step first turned off Godot's Blender importer in `project.godot`. */
  readonly blenderNote?: string
}

/**
 * Build the argv of an import step.
 * @param runtime - resolved runtime.
 * @param hostPid - Host process id for the runner's parent watch.
 * @param projectDir - absolute project folder.
 * @returns the argv of a headless `--import`.
 */
export function importArgv(runtime: ResolvedGodotRuntime, hostPid: number, projectDir: string): string[] {
  return launcherArgv(runtime, hostPid, ['--headless', '--path', projectDir, '--import'])
}

/**
 * Describe an import step that did not end normally.
 * @param outcome - how the step ended.
 * @param timeoutMs - the step's deadline.
 * @returns `did not finish within <seconds>` or `ended abnormally (<exit>[: <crash summary>])`, or undefined for a step
 * that exited with code 0 before its deadline.
 */
export function importFailure(outcome: GodotCommandOutcome, timeoutMs: number): string | undefined {
  if (outcome.timedOut) return `did not finish within ${formatSeconds(timeoutMs)}`
  if (outcome.exit.exitCode === 0 && outcome.exit.signal === null) return undefined
  const crash = crashSummary(outcome.stderr) ?? crashSummary(outcome.stdout)
  return `ended abnormally (${describeExit(outcome.exit)}${crash === undefined ? '' : `: ${crash}`})`
}

/**
 * Whether a file changed after a time: its modification or status change time is later. A rename changes the
 * status change time, so a file moved into the project with an older modification time counts as changed.
 * @param path - absolute file path.
 * @param time - milliseconds since the epoch.
 * @returns false for a folder, and for a path that is gone or unreadable.
 */
async function changedAfter(path: string, time: number): Promise<boolean> {
  let info: Stats
  try {
    info = await stat(path)
  } catch (error) {
    // A file deleted during the walk, a broken link, or a file that Godot cannot read either has nothing to import.
    if (UNREADABLE_FILE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
  return info.isFile() && Math.max(info.mtimeMs, info.ctimeMs) > time
}

/**
 * Whether a file that Godot's import reads changed after a time. The walk skips what the import skips: hidden files
 * and folders, the project's data folder, and folders that hold a `.gdignore` file or another project's
 * `project.godot`. It also skips the `.import` and `.uid` files that the import writes beside the files it imports.
 * Symbolic links to folders are not followed.
 * @param projectDir - absolute project folder.
 * @param dataDirectory - name of the project's data folder.
 * @param time - milliseconds since the epoch.
 * @param signal - cancellation.
 * @returns whether such a file changed after `time`.
 */
async function changedSince(projectDir: string, dataDirectory: string, time: number, signal: AbortSignal): Promise<boolean> {
  const walk = async (directory: string): Promise<boolean> => {
    signal.throwIfAborted()
    const entries = await readDirectory(directory)
    const top = directory === projectDir
    if (!top && entries.some(entry => !entry.isDirectory() && (entry.name === '.gdignore' || entry.name === 'project.godot'))) return false
    for (const entry of entries) {
      if (entry.name.startsWith('.') || (top && entry.name === dataDirectory)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (await walk(path)) return true
      } else if (!IMPORT_SIDECAR.test(entry.name) && await changedAfter(path, time)) {
        return true
      }
    }
    return false
  }
  return await walk(projectDir)
}

/**
 * The import steps of the plugin's projects. The operations on one project, its import steps and its script checks,
 * run one at a time, so two Godot processes never write its import data at once and a check never reads that data
 * while an import writes it. The plugin remembers, while it is loaded, when each project's last import step that
 * exited with code 0 began.
 */
export class ProjectImports {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly imported = new Map<string, number>()

  /**
   * Run an operation on a project after the operations that began earlier on the same project ended.
   * @param projectDir - absolute project folder.
   * @param operation - work that may import the project or read its import data.
   * @param signal - cancels the wait; the operation handles cancellation once it runs.
   * @returns the operation's result.
   */
  async exclusive<T>(projectDir: string, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const key = resolve(projectDir)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const turn = Promise.withResolvers<void>()
    const tail = previous.then(() => turn.promise)
    this.queues.set(key, tail)
    try {
      await untilAborted(previous, signal)
      return await operation()
    } finally {
      turn.resolve()
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }

  /**
   * Run Godot's headless import of a project; call it within {@link ProjectImports.exclusive}. A project whose
   * editor scan reaches a `.blend` file first gets Godot's Blender importer turned off, without which the headless
   * import imports none of its files. A step that exits with code 0 before its deadline makes the project's import data
   * current as of the step's start.
   * @param options - process parameters.
   * @returns how the step ended, with a note when it turned the Blender importer off; after cancellation the outcome
   *   describes the stopped process.
   * @throws the subprocess service's error when the process cannot start.
   */
  async import(options: ImportOptions): Promise<GodotImportOutcome> {
    const blenderNote = await turnOffBlenderImport(options.projectDir, options.signal)
    const started = Date.now()
    const argv = importArgv(options.runtime, options.hostPid, options.projectDir)
    const outcome = await runGodotCommand({ ...options, argv, cwd: options.projectDir })
    if (!options.signal.aborted && importFailure(outcome, options.timeoutMs) === undefined) {
      this.imported.set(resolve(options.projectDir), started)
    }
    return blenderNote === undefined ? outcome : { ...outcome, blenderNote }
  }

  /**
   * Whether a project's import data may be older than its files: no import step of the project exited with code 0
   * since the plugin loaded, the class cache is missing, or a file that Godot's import reads changed after the last
   * such step began.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation.
   * @returns whether the project needs an import before its scripts load as they do in the game.
   */
  async outdated(projectDir: string, signal: AbortSignal): Promise<boolean> {
    const since = this.imported.get(resolve(projectDir))
    if (since === undefined) return true
    const dataDirectory = projectDataDirectory(await readFile(join(projectDir, 'project.godot'), 'utf8'))
    if (!await isFile(join(projectDir, dataDirectory, CLASS_CACHE_FILE))) return true
    return await changedSince(projectDir, dataDirectory, since, signal)
  }
}
