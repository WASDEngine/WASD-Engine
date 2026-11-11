/**
 * Helpers for the tools of an app MCP server: the dependencies a tool set
 * receives, typed tool declarations, worker request parameters, worker reply
 * validation, setup notes, file sizes, and the `execute_python` tool of a
 * Python-scripted application.
 *
 * @module
 */

import { z } from 'zod'
import type { AppTool, AppToolResult } from './mcp-server.ts'
import type { JsonObject, JsonValue } from './types.ts'

/** Longest code an `execute_python` call accepts, in UTF-16 code units. */
const CODE_MAX = 200_000

/** What a tool set needs from its server process. */
export interface AppToolDependencies {
  /**
   * Run one worker method, starting or restarting the worker when needed.
   * @param method - worker method name.
   * @param params - method parameters.
   * @param options - cancellation and an optional budget, in milliseconds, for this request.
   * @returns the method's JSON result.
   */
  readonly call: (
    method: string, params: JsonObject, options: { readonly signal: AbortSignal; readonly timeoutMs?: number },
  ) => Promise<JsonValue>
  /** @returns the setup notes not yet reported to the agent, oldest first; each note is handed over once. */
  readonly takeNotes: () => readonly string[]
  /** Absolute directory the plugin owns, for the files the tools write. */
  readonly dataRoot: string
  /** Default budget of one worker request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Longest budget, in milliseconds, that a tool call may request for one worker request. */
  readonly maxTimeoutMs: number
}

/** A worker reply that does not match its schema: the worker and the server disagree about the protocol. */
export class WorkerReplyError extends Error {
  override readonly name = 'WorkerReplyError'
}

/**
 * Bind worker reply validation to one application.
 * @param app - application name that the error message names, such as `Blender`.
 * @returns a function that validates the reply of `method` against `schema` and returns the typed
 *   reply; it throws a {@link WorkerReplyError} that names the method and each mismatch.
 */
export function replyParser(app: string): <T>(schema: z.ZodType<T>, method: string, value: JsonValue) => T {
  return (schema, method, value) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new WorkerReplyError(`The ${app} worker sent an unexpected ${method} reply: ${z.prettifyError(parsed.error)}`)
    return parsed.data
  }
}

/**
 * Declare a tool whose `run` receives arguments typed by its `input` shape.
 * @param tool - the tool.
 * @returns the same tool, typed for the tool list of `serveAppMcp`.
 */
export function defineAppTool<S extends z.ZodRawShape>(tool: AppTool<S>): AppTool<z.ZodRawShape> {
  return tool
}

/**
 * Worker request parameters from tool arguments: each given argument under its own name, and no
 * entry for an omitted optional one.
 * @param args - validated tool arguments with JSON values.
 * @returns the parameters.
 */
export function workerParams(args: { readonly [key: string]: JsonValue | undefined }): JsonObject {
  const params: JsonObject = {}
  for (const [key, value] of Object.entries(args)) if (value !== undefined) params[key] = value
  return params
}

/**
 * Put the setup notes that no result reported yet, such as the application version after a worker
 * start, before a result's text, separated by blank lines.
 * @param dependencies - the tool set's dependencies, whose `takeNotes` hands the notes over.
 * @param result - the tool's result.
 * @returns the result with the notes first, or `result` itself when there are none.
 */
export function withSetupNotes(dependencies: Pick<AppToolDependencies, 'takeNotes'>, result: AppToolResult): AppToolResult {
  const notes = dependencies.takeNotes()
  return notes.length === 0 ? result : { ...result, text: [...notes, result.text].join('\n\n') }
}

/**
 * A file or memory size for result text: whole bytes below 1 KiB, otherwise KiB below 1 MiB, MiB below 1 GiB,
 * otherwise GiB, with one decimal.
 * @param bytes - size in bytes.
 * @returns the size, such as `512 bytes`, `2.0 KiB`, `5.0 MiB`, or `1.5 GiB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

const ExecuteReply = z.object({
  result: z.json(),
  output: z.string(),
  seconds: z.number().nullable(),
  error: z.object({ type: z.string(), message: z.string(), traceback: z.string() }).optional(),
})

function executeText(reply: z.infer<typeof ExecuteReply>): string {
  const parts: string[] = []
  if (reply.error !== undefined) parts.push(reply.error.traceback.trim() || `${reply.error.type}: ${reply.error.message}`)
  if (reply.result !== null) parts.push(`result: ${JSON.stringify(reply.result)}`)
  if (reply.output !== '') parts.push(`output:\n${reply.output}`)
  if (parts.length === 0) parts.push('Done. The code assigned no result and printed nothing.')
  return parts.join('\n\n')
}

/** The model-facing text of an application's `execute_python` tool. */
export interface ExecutePythonText {
  /** Application name in the `timeout_seconds` description and in reply errors, such as `Blender`. */
  readonly app: string
  /** Tool title. */
  readonly title: string
  /** Tool description: what the Python namespace holds and how `result` and printed output return. */
  readonly description: string
}

/**
 * The `execute_python` tool. It sends `code` to the worker method `execute_python`, whose reply
 * carries `result` (JSON), the printed `output`, the run time in `seconds`, and the `error` of a
 * raised exception. The result text holds the traceback first (or `<type>: <message>` when it is empty),
 * then `result: <JSON>` unless `result` is null, then `output:` and the printed output, each part
 * one blank line apart, and a fixed notice when there is no part; a raised exception makes it an
 * error result. `timeout_seconds` takes whole seconds from 1 to `maxTimeoutMs` (rounded down, and
 * at least 1), and its description names the `requestTimeoutMs` default in seconds.
 * @param dependencies - worker access, setup notes, and request budgets.
 * @param text - application name, title, and description.
 * @returns the tool.
 */
export function executePythonTool(dependencies: AppToolDependencies, text: ExecutePythonText): AppTool<z.ZodRawShape> {
  const parseReply = replyParser(text.app)
  const defaultTimeoutSeconds = Math.round(dependencies.requestTimeoutMs / 1000)
  const maxTimeoutSeconds = Math.max(1, Math.floor(dependencies.maxTimeoutMs / 1000))
  return defineAppTool({
    name: 'execute_python',
    title: text.title,
    description: text.description,
    input: {
      code: z.string().min(1).max(CODE_MAX).describe('Python source to run.'),
      timeout_seconds: z.int().min(1).max(maxTimeoutSeconds).optional()
        .describe(`Seconds before ${text.app} is stopped and restarted (default ${String(defaultTimeoutSeconds)}).`),
    },
    async run(args, signal) {
      const options = args.timeout_seconds === undefined ? { signal } : { signal, timeoutMs: args.timeout_seconds * 1000 }
      const reply = parseReply(ExecuteReply, 'execute_python', await dependencies.call('execute_python', { code: args.code }, options))
      return withSetupNotes(dependencies, { text: executeText(reply), isError: reply.error !== undefined })
    },
  })
}
