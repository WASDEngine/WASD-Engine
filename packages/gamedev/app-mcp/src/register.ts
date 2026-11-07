/**
 * Host-side registration of an app MCP server: the plugin contributes a stdio
 * server to the MCP manager for its own lifetime. The server runs the
 * package's server entry under the Host's own executable (Electron runs it as
 * Node), so the Desktop app needs no separate Node installation. A TypeScript
 * entry, which a source launch of the harness registers, runs through tsx.
 *
 * @module
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { encodeServerOptions } from './options.ts'
import type { JsonObject } from './types.ts'

/** One app MCP server a plugin registers. */
export interface AppMcpServerRegistration {
  /** Server key and tool namespace: tools become `mcp__<serverName>__<tool>`. */
  readonly serverName: string
  /** `file:` URL of the server entry, which calls `serveAppMcp`: built JavaScript, or TypeScript in a source checkout. */
  readonly entry: URL
  /** JSON options the entry reads with `decodeServerOptions`. */
  readonly options: JsonObject
  /** Milliseconds the MCP client waits for one tool call. */
  readonly toolCallTimeoutMs: number
  /** Milliseconds the MCP client gives one connection attempt, including tool discovery. */
  readonly startupTimeoutMs: number
}

/**
 * Environment of the server process on top of the scrubbed Host environment.
 * `ELECTRON_RUN_AS_NODE` makes the Desktop executable run as Node; the empty
 * Python variables keep a Python setup from the user's shell out of the
 * workers the server starts.
 */
const SERVER_ENV: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE: '1',
  PYTHONPATH: '',
  PYTHONHOME: '',
  VIRTUAL_ENV: '',
}

/**
 * The repository's TypeScript configuration, whose `paths` map workspace
 * imports to their sources. A TypeScript entry exists only in a source
 * checkout, where this package sits four directories below the root.
 */
const SOURCE_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))

/**
 * Milliseconds the MCP client may spend closing the server. The server's own
 * shutdown is bounded by 10 s, so it exits before this budget runs out.
 */
const CLOSE_TIMEOUT_MS = 15_000

/**
 * Reconnect policy for a server that exits. A local server that keeps exiting
 * right after it starts fails the same way every time (a broken installation
 * or payload), so it gets fewer attempts than the MCP client's default.
 */
const RECONNECT = { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 } as const

/**
 * Register an app MCP server with the MCP manager for the plugin's lifetime;
 * disposing the plugin removes the server and its tools. The manager starts
 * the server once the registration settles; the server starts no worker until
 * the first tool call. A `.ts` entry starts as `node --import tsx/esm`, with
 * `TSX_TSCONFIG_PATH` naming the repository configuration, so its workspace
 * imports resolve to their sources from any working directory.
 * @param ctx - plugin context that injects `mcpManager`.
 * @param registration - server name, entry, options, and client budgets.
 * @throws TypeError when `entry` is not a `file:` URL; the manager's error when
 *   the name is taken or the entry is invalid.
 */
export function registerAppMcpServer(ctx: Context, registration: AppMcpServerRegistration): void {
  const script = fileURLToPath(registration.entry)
  const source = script.endsWith('.ts')
  const entry: McpServerRegistration = {
    transport: 'stdio',
    command: process.execPath,
    // Resolved only for a source entry: the packaged Desktop app ships no tsx.
    args: [...source ? ['--import', import.meta.resolve('tsx/esm')] : [], script, encodeServerOptions(registration.options)],
    env: { ...SERVER_ENV, ...source ? { TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH } : {} },
    cwd: '',
    toolCallTimeoutMs: registration.toolCallTimeoutMs,
    startupTimeoutMs: registration.startupTimeoutMs,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    reconnect: { ...RECONNECT },
  }
  ctx.effect(() => ctx.mcpManager.register(registration.serverName, entry), `app-mcp: ${registration.serverName} server`)
}
