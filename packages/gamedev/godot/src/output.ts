/**
 * Parsing of Godot engine console output (import steps, checks, and runner output outside the harness
 * connection) into log fields.
 * @module @deepseek-ai/dsh-godot/src/output
 */
import type { GodotLogLevel } from './types.ts'

/** Log fields parsed from one engine message. */
export interface EngineOutputLine {
  /** Severity, or the stream for plain lines. */
  readonly level: GodotLogLevel
  /** Message text. */
  readonly message: string
  /** Source file from the following `at:` line. */
  readonly file?: string
  /** Source line from the following `at:` line. */
  readonly line?: number
  /** Function from the following `at:` line. */
  readonly function?: string
}

// Godot colors console output on terminals and in some headless paths.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu

const PREFIXES: ReadonlyArray<readonly [string, GodotLogLevel]> = [
  ['SCRIPT ERROR:', 'script_error'],
  ['SHADER ERROR:', 'shader_error'],
  ['ERROR:', 'error'],
  ['WARNING:', 'warning'],
]

const AT_LINE = /^\s+at:\s+(?:(.*?)\s+)?\((.+):(\d+)\)\s*$/u

/**
 * Split console text into lines without escape sequences or carriage returns.
 * @param text - collected stream text.
 * @returns the lines, empty ones included.
 */
export function consoleLines(text: string): string[] {
  return text.replace(ANSI_ESCAPE, '').split('\n').map(line => line.replace(/\r$/u, ''))
}

/**
 * Parse Godot console output. A line starting with `ERROR:`, `SCRIPT ERROR:`, `SHADER ERROR:`, or `WARNING:`
 * starts a message; an immediately following `at: function (file:line)` line adds its location.
 * @param text - collected stream text.
 * @param stream - stream the text came from; plain lines take it as their level.
 * @param plainLines - whether non-empty lines without a prefix become messages too.
 * @returns the parsed messages in output order.
 */
export function parseEngineOutput(text: string, stream: 'stdout' | 'stderr', plainLines: boolean): EngineOutputLine[] {
  const parsed: EngineOutputLine[] = []
  let located = true
  for (const line of consoleLines(text)) {
    const at = AT_LINE.exec(line)
    const previous = parsed.at(-1)
    if (at !== null && !located && previous !== undefined) {
      parsed[parsed.length - 1] = {
        ...previous,
        file: at[2] as string,
        line: Number(at[3]),
        ...at[1] === undefined || at[1] === '' ? {} : { function: at[1] },
      }
      located = true
      continue
    }
    const prefix = PREFIXES.find(([marker]) => line.startsWith(marker))
    if (prefix !== undefined) {
      parsed.push({ level: prefix[1], message: line.slice(prefix[0].length).trim() })
      located = false
      continue
    }
    located = true
    if (plainLines && line.trim() !== '') parsed.push({ level: stream, message: line })
  }
  return parsed
}

/**
 * Find the summary line of Godot's crash handler.
 * @param text - collected stream text.
 * @returns the text after `handle_crash:`, or undefined when the output has no crash report.
 */
export function crashSummary(text: string): string | undefined {
  const line = consoleLines(text).find(candidate => candidate.startsWith('handle_crash:'))
  return line?.slice('handle_crash:'.length).trim()
}

/**
 * Format a duration for messages.
 * @param milliseconds - duration.
 * @returns seconds with at most one decimal, for example `1.5 s`.
 */
export function formatSeconds(milliseconds: number): string {
  return `${Number((milliseconds / 1000).toFixed(1))} s`
}

/**
 * Describe how a process ended.
 * @param exit - exit code and signal.
 * @param exit.exitCode - exit code, or null after a signal.
 * @param exit.signal - terminating signal, or null.
 * @returns `exit code N` or `signal NAME`.
 */
export function describeExit(exit: { readonly exitCode: number | null; readonly signal: string | null }): string {
  return exit.signal === null ? `exit code ${String(exit.exitCode)}` : `signal ${exit.signal}`
}

/**
 * Keep the last non-empty lines of console text.
 * @param text - collected stream text.
 * @param count - maximum lines.
 * @returns the lines joined with newlines.
 */
export function lastLines(text: string, count: number): string {
  return consoleLines(text).filter(line => line.trim() !== '').slice(-count).join('\n')
}
