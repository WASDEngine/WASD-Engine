/**
 * The `apply` of an app MCP plugin: check its path settings, pass the server
 * the Config fields it needs, and register the server entry that sits beside
 * the plugin module for the plugin's lifetime.
 *
 * @module
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { offerAppTools, type AppGameMcpIdentity } from './game-mcp.ts'
import { TOOL_CALL_RESERVE_MS, type AppServerOptions } from './options.ts'
import { registerAppMcpServer } from './register.ts'
import type { JsonObject, JsonValue } from './types.ts'

/**
 * The Config fields that {@link registerAppMcpPlugin} reads: the shared
 * `AppMcpConfig` fields, `dataRoot`, and `startupTimeoutMs`, which each plugin
 * declares and documents itself.
 */
export interface AppMcpPluginConfig extends AppServerOptions {
  /** Milliseconds the MCP client gives one connection attempt, including tool discovery. */
  readonly startupTimeoutMs: number
}

/** Names of the fields of `C` that hold strings. */
type StringField<C> = { [K in keyof C]-?: C[K] extends string ? K : never }[keyof C] & string

/** How {@link registerAppMcpPlugin} registers one plugin's server. */
export interface AppMcpPlugin<C> {
  /** Application name that starts each configuration error, such as `Blender`. */
  readonly app: string
  /** Server key and tool namespace: tools become `mcp__<serverName>__<tool>`. */
  readonly serverName: string
  /** `import.meta.url` of the plugin's entry module; the server entry is `worker.ts` or `worker.js` beside it, matching its extension. */
  readonly module: string
  /** Config fields besides `dataRoot` that hold file paths; each must be absolute when it is not empty. */
  readonly paths: readonly StringField<C>[]
  /** Config fields the server receives as options of the same name, besides `dataRoot` and the {@link AppServerOptions} budgets. */
  readonly options: readonly (keyof C & string)[]
  /** How agents connected through WASD Engine's MCP server find the server's tools; absent, they are not offered there. */
  readonly gameMcp?: AppGameMcpIdentity
}

/**
 * Register an app MCP plugin's server for the plugin's lifetime. `dataRoot` and the `paths` fields
 * must be absolute or empty, and `requestTimeoutMs` must leave `TOOL_CALL_RESERVE_MS` of
 * `toolCallTimeoutMs`, so a request that runs out of time fails before the MCP client gives up on
 * its tool call. The server options are `dataRoot`, `requestTimeoutMs`,
 * `toolCallTimeoutMs`, `graceMs`, `maxLogBytes`, the worker limits (`maxWorkers`, `workerMemoryBytes`, `workerCores`,
 * `minAvailableMemoryBytes`, `workerIdleTimeoutMs`), and the `options` fields, each under its Config
 * name; the MCP client gets `toolCallTimeoutMs` and `startupTimeoutMs` as its budgets. With `gameMcp`, the
 * server's tools are also offered to agents connected through WASD Engine's MCP server.
 * @param ctx - plugin context that injects `mcpManager`.
 * @param config - the plugin's validated Config.
 * @param plugin - application name, server name, plugin module, and the path and option fields.
 * @throws Error naming the field when a path setting is relative, or naming both budgets when
 *   `requestTimeoutMs` leaves too little of `toolCallTimeoutMs`; the errors of `registerAppMcpServer`.
 */
export function registerAppMcpPlugin<C extends AppMcpPluginConfig & { readonly [K in keyof C]: JsonValue }>(
  ctx: Context, config: C, plugin: AppMcpPlugin<C>,
): void {
  for (const field of ['dataRoot', ...plugin.paths] as const) {
    // Every field named here holds a string; the compiler cannot narrow C[StringField<C>] to string itself.
    const value: JsonValue = config[field]
    if (typeof value === 'string' && (value === '' || isAbsolute(value))) continue
    throw new Error(`${plugin.app} plugin: ${field} must be an absolute path, got ${JSON.stringify(value)}`)
  }
  if (config.requestTimeoutMs > config.toolCallTimeoutMs - TOOL_CALL_RESERVE_MS) {
    throw new Error(`${plugin.app} plugin: requestTimeoutMs (${config.requestTimeoutMs}) must be at least ${TOOL_CALL_RESERVE_MS} less than `
      + `toolCallTimeoutMs (${config.toolCallTimeoutMs}), which keeps that time for a worker start and the result`)
  }
  const options: JsonObject = {
    dataRoot: config.dataRoot,
    requestTimeoutMs: config.requestTimeoutMs,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    graceMs: config.graceMs,
    maxLogBytes: config.maxLogBytes,
    maxWorkers: config.maxWorkers,
    workerMemoryBytes: config.workerMemoryBytes,
    workerCores: config.workerCores,
    minAvailableMemoryBytes: config.minAvailableMemoryBytes,
    workerIdleTimeoutMs: config.workerIdleTimeoutMs,
  }
  for (const field of plugin.options) options[field] = config[field]
  registerAppMcpServer(ctx, {
    serverName: plugin.serverName,
    entry: new URL(plugin.module.endsWith('.ts') ? './worker.ts' : './worker.js', plugin.module),
    options,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    startupTimeoutMs: config.startupTimeoutMs,
  })
  if (plugin.gameMcp !== undefined) offerAppTools(ctx, plugin.serverName, plugin.gameMcp)
}
