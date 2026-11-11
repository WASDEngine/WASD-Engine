/**
 * One Godot command that runs to its end with its output collected: the import step, the script check, and the Web
 * export.
 * @module @deepseek-ai/dsh-godot/src/command
 */
import type { SubprocessOutcome, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Parameters of one Godot command. */
export interface GodotCommandOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Complete command line, launcher included. */
  readonly argv: readonly string[]
  /** Working directory: the project folder. */
  readonly cwd: string
  /** Deadline of the command. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation; it stops the command. */
  readonly signal: AbortSignal
}

/** How a Godot command ended. */
export interface GodotCommandOutcome {
  /** Exit code and signal of the process. */
  readonly exit: SubprocessOutcome
  /** The command reached its deadline and was stopped; false after cancellation. */
  readonly timedOut: boolean
  /** Collected stdout. */
  readonly stdout: string
  /** Collected stderr. */
  readonly stderr: string
}

/**
 * Run a Godot command until it ends, its deadline passes, or the signal aborts. The process does not inherit
 * `ELECTRON_RUN_AS_NODE`, which the Desktop Host runs with.
 * @param options - command line and limits.
 * @returns how the command ended and its collected output.
 * @throws the subprocess service's error when the process cannot start.
 */
export async function runGodotCommand(options: GodotCommandOptions): Promise<GodotCommandOutcome> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const handle = options.subprocess.spawn({
    argv: [...options.argv],
    cwd: options.cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: options.outputBytes }, stderr: { maxBytes: options.outputBytes } },
    graceMs: options.graceMs,
    signal: AbortSignal.any([options.signal, timeout]),
    env: { ELECTRON_RUN_AS_NODE: undefined },
  })
  const exit = await handle.done
  return {
    exit,
    timedOut: !options.signal.aborted && timeout.aborted,
    stdout: (handle.collected.stdout as SubprocessOutputReader).readFrom(0).text,
    stderr: (handle.collected.stderr as SubprocessOutputReader).readFrom(0).text,
  }
}
