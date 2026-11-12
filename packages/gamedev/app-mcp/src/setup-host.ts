/**
 * File-system effects that a server uses to find its application before the
 * first worker starts, and the setup commands, such as an unpack, that it runs
 * to completion. A server reaches the machine only through a
 * {@link SetupHost}, so its search order is testable without the application.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { access, constants, mkdir, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

/** An absolute executable followed by its arguments. */
export type CommandArgv = readonly [string, ...string[]]

/** Options of a setup command that {@link runCommand} runs. */
export interface CommandOptions {
  readonly cwd: string
  /** Complete child environment. */
  readonly env: NodeJS.ProcessEnv
  /** Aborting kills the command and rejects with the abort reason. */
  readonly signal: AbortSignal
  /** A file that the command reads as its standard input; without one, its standard input is empty. */
  readonly stdinFile?: string
}

/** Completion of a setup command that {@link runCommand} ran. */
export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** Interleaved stdout and stderr, keeping the most recent bytes. */
  readonly output: string
}

/**
 * Run a setup command to completion without a shell or a window, and keep the tail of its interleaved output.
 * @param argv - executable and arguments.
 * @param options - working directory, environment, cancellation, and standard input.
 * @param outputLimit - bytes of output kept from the end.
 * @returns exit status and output tail; rejects when the command cannot start, its standard input file cannot be opened,
 *   or it is aborted.
 */
export async function runCommand(argv: CommandArgv, options: CommandOptions, outputLimit: number): Promise<CommandResult> {
  const [command, ...args] = argv
  const input = options.stdinFile === undefined ? undefined : await open(options.stdinFile, 'r')
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd, env: options.env, signal: options.signal, stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let output = Buffer.alloc(0)
      const collect = (chunk: Buffer): void => {
        output = Buffer.concat([output, chunk])
        if (output.length > outputLimit) output = output.subarray(output.length - outputLimit)
      }
      // A file descriptor as standard input leaves Node's types without the output pipes that 'pipe' always creates.
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('error', reject)
      child.once('close', (exitCode, signal) => { resolve({ exitCode, signal, output: output.toString('utf8') }) })
    })
  } finally {
    await input?.close()
  }
}

/** File-system effects and facts of the machine that runs the server. */
export interface SetupHost {
  /** Operating system; selects path syntax and the install locations to search. */
  readonly platform: NodeJS.Platform
  /** Environment of the server process. */
  readonly env: NodeJS.ProcessEnv
  /** Home directory of the user that runs the server. */
  readonly homeDirectory: string
  /**
   * Check that a path is a regular file the current user may execute.
   * @param file - absolute path.
   * @returns whether the check passed; false for a missing or inaccessible path.
   */
  isExecutable(file: string): Promise<boolean>
  /**
   * List a directory.
   * @param directory - absolute path.
   * @returns entry names, or an empty list when the directory is missing or inaccessible.
   */
  listDirectory(directory: string): Promise<readonly string[]>
  /**
   * Create a directory and its missing parents.
   * @param directory - absolute path.
   */
  makeDirectory(directory: string): Promise<void>
}

/** Error codes of a path that holds no usable file: absent, under a non-directory, or not accessible. */
const UNUSABLE_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

function isUnusablePath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && UNUSABLE_PATH_CODES.has(String(error.code))
}

/**
 * The real host: `node:fs` on this machine and the current process environment.
 * @returns a host bound to `process.platform`, `process.env`, and the user's home directory.
 */
export function nodeSetupHost(): SetupHost {
  return {
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
    async isExecutable(file) {
      try {
        if (!(await stat(file)).isFile()) return false
        await access(file, constants.X_OK)
        return true
      } catch (error) {
        if (isUnusablePath(error)) return false
        throw error
      }
    },
    async listDirectory(directory) {
      try {
        return await readdir(directory)
      } catch (error) {
        if (isUnusablePath(error)) return []
        throw error
      }
    },
    async makeDirectory(directory) { await mkdir(directory, { recursive: true }) },
  }
}

/**
 * The first candidate that is an executable file.
 * @param candidates - absolute paths, in order of preference.
 * @param host - file checks.
 * @returns the first executable candidate, or undefined when there is none.
 */
export async function firstExecutable(candidates: readonly string[], host: SetupHost): Promise<string | undefined> {
  for (const candidate of candidates) if (await host.isExecutable(candidate)) return candidate
  return undefined
}

function versionKey(name: string): number[] {
  return Array.from(name.matchAll(/\d+/g), match => Number(match[0]))
}

/**
 * Order names by the numbers in them, newest first, for `Array.prototype.sort`. Numbers compare
 * one by one from the left, so `Blender 4.10` precedes `Blender 4.2`, and a name with more numbers
 * precedes one whose numbers are its prefix, so `GIMP 3.0.1` precedes `GIMP 3.0` and `GIMP 3`
 * precedes `GIMP`. Names with equal numbers compare equal, which keeps their order in a stable sort.
 * @param left - one name.
 * @param right - the other name.
 * @returns a negative number when `left` is newer, a positive number when `right` is newer, else 0.
 */
export function newestFirst(left: string, right: string): number {
  const a = versionKey(left)
  const b = versionKey(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? -1) - (a[index] ?? -1)
    if (difference !== 0) return difference
  }
  return 0
}
