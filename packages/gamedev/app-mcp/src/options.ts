/**
 * Server options travel from the Host to an app MCP server process as one
 * command-line argument, `argv[2]`: base64url-encoded UTF-8 JSON. The encoding
 * keeps `${` out of the command line, which the MCP manager would read as a
 * credential template, and needs no shell quoting. The server validates the
 * decoded options against a strict schema of the shared fields and its own.
 *
 * @module
 */

import { z } from 'zod'
import type { JsonObject } from './types.ts'

/**
 * The server options that every app MCP server receives. Each field mirrors
 * the plugin Config field of the same name; a server's own options extend it.
 */
export interface AppServerOptions {
  /** Absolute directory the plugin owns; worker script copies and the server's files go under it. */
  readonly dataRoot: string
  /** Default budget of one worker request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Budget of one tool call, in milliseconds; a worker request may use it less {@link TOOL_CALL_RESERVE_MS}. */
  readonly toolCallTimeoutMs: number
  /** Milliseconds each step of a worker shutdown waits before escalating. */
  readonly graceMs: number
  /** Bytes of recent worker output kept for diagnostics. */
  readonly maxLogBytes: number
}

/**
 * Milliseconds of each tool call's budget that no worker request may use: the time a worker start
 * and the return of the result take. A request that runs out of time then fails with its own error
 * before the MCP client gives up on the call, which would cancel it with a generic timeout.
 */
export const TOOL_CALL_RESERVE_MS = 30_000

/** Zod fields of {@link AppServerOptions}; a server spreads them into its strict options schema. */
export const AppServerOptionFields = {
  dataRoot: z.string().min(1),
  requestTimeoutMs: z.int().min(1),
  toolCallTimeoutMs: z.int().min(1),
  graceMs: z.int().min(1),
  maxLogBytes: z.int().min(1),
} as const

/**
 * Validate the options a server entry decoded with {@link decodeServerOptions}.
 * @param app - application name that starts the error message, such as `Blender`.
 * @param schema - the server's strict options schema, built with {@link AppServerOptionFields}.
 * @param value - the decoded options.
 * @returns the typed options.
 * @throws Error naming each missing, invalid, or unknown field.
 */
export function parseAppServerOptions<T extends AppServerOptions>(app: string, schema: z.ZodType<T>, value: JsonObject): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${app} MCP server options are invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** Index of the options in `process.argv`: after the executable and the server entry. */
const OPTIONS_ARGUMENT = 2

const BASE64URL = /^[A-Za-z0-9_-]+$/u

const JsonObjectSchema = z.record(z.string(), z.json())

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Prefix of every decoding error: names the argument and how it should have been produced. */
const MISPLACED = 'app MCP server: argv[2] must hold the base64url server options that registerAppMcpServer passes'

/**
 * Encode server options for the server process command line.
 * @param options - JSON options the server entry reads with {@link decodeServerOptions}.
 * @returns unpadded base64url text of the options' JSON.
 */
export function encodeServerOptions(options: JsonObject): string {
  return Buffer.from(JSON.stringify(options), 'utf8').toString('base64url')
}

/**
 * Decode the server options a server entry received.
 * @param argv - the server process's `process.argv`; the options are `argv[2]`.
 * @returns the options object.
 * @throws TypeError when `argv[2]` is missing, is not canonical unpadded base64url,
 *   or does not decode to a UTF-8 JSON object.
 */
export function decodeServerOptions(argv: readonly string[]): JsonObject {
  const encoded = argv[OPTIONS_ARGUMENT]
  if (encoded === undefined) throw new TypeError(`${MISPLACED}; it is missing`)
  const bytes = Buffer.from(encoded, 'base64url')
  if (!BASE64URL.test(encoded) || bytes.toString('base64url') !== encoded) {
    throw new TypeError(`${MISPLACED}; it is not canonical unpadded base64url text`)
  }
  let value: unknown
  try {
    value = JSON.parse(utf8.decode(bytes))
  } catch (error) {
    // TextDecoder throws TypeError and JSON.parse SyntaxError, both Errors.
    throw new TypeError(`${MISPLACED}; it does not decode to UTF-8 JSON: ${(error as Error).message}`, { cause: error })
  }
  const parsed = JsonObjectSchema.safeParse(value)
  if (!parsed.success) throw new TypeError(`${MISPLACED}; it decodes to JSON that is not an object`)
  return parsed.data
}
