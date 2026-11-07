/**
 * Shared runtime of the headless application MCP servers (Blender, GIMP) and
 * of other plugins that hand package files to external applications. A Host
 * plugin spreads the shared `AppMcpConfig` fields into its Config and
 * registers a stdio MCP server with the MCP manager (`registerAppMcpPlugin`,
 * or `registerAppMcpServer` for a custom entry). The server entry calls
 * `runAppMcpServer`, which decodes the options (`decodeServerOptions`) and
 * serves the tools (`serveAppMcp`); the tools run methods of one long-lived
 * application worker through a `WorkerSupervisor`, which starts the worker as
 * a `JsonLineWorker` on the first call. The setup host and tool helpers carry
 * what the application servers share. `materializePayload` copies a shipped
 * file, possibly inside `app.asar`, to a real path. This is a library: it
 * exports no plugin.
 *
 * @module @deepseek-ai/dsh-app-mcp
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/**
 * Config fields that every app MCP plugin shares. A plugin's `Config`
 * extends this interface and spreads `AppMcpConfig.dict` into its own object
 * schema, beside its `dataRoot` and `startupTimeoutMs`.
 */
export interface AppMcpConfig {
  /**
   * Budget of one tool call, including a worker start and its first-use setup; a worker request,
   * including an `execute_python` timeout, may use it less 30 s.
   */
  toolCallTimeoutMs: number
  /**
   * Default budget of one worker request, at least 30 s less than `toolCallTimeoutMs`; on expiry
   * the worker stops, its state is lost, and the next call starts a fresh worker.
   */
  requestTimeoutMs: number
  /** Grace period between asking a worker to stop and terminating it. */
  graceMs: number
  /** Most bytes of recent worker output, and of setup command output, kept for error messages. */
  maxLogBytes: number
}

/** Validates the shared fields when the plugin loads. */
export const AppMcpConfig: z<Partial<AppMcpConfig>, AppMcpConfig> = z.object({
  toolCallTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(900_000),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
  graceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
})

export { materializePayload } from './materialize.ts'
export { JsonLineWorker, WorkerError } from './json-line-worker.ts'
export type {
  JsonLineWorkerSpec, WorkerErrorCode, WorkerErrorDetails, WorkerExit, WorkerReady, WorkerRequestOptions,
} from './json-line-worker.ts'
export { WorkerSupervisor } from './supervisor.ts'
export type { WorkerCallOptions, WorkerSupervisorOptions } from './supervisor.ts'
export { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_EDGE, serveAppMcp } from './mcp-server.ts'
export type { AppMcpProcess, AppMcpServerOptions, AppTool, AppToolImage, AppToolResult } from './mcp-server.ts'
export { runAppMcpServer } from './app-server.ts'
export type { AppMcpServerDefinition, AppWorkerDependencies, AppWorkers } from './app-server.ts'
export { registerAppMcpServer } from './register.ts'
export type { AppMcpServerRegistration } from './register.ts'
export type { AppGameMcpIdentity } from './game-mcp.ts'
export { registerAppMcpPlugin } from './plugin.ts'
export type { AppMcpPlugin, AppMcpPluginConfig } from './plugin.ts'
export { AppServerOptionFields, TOOL_CALL_RESERVE_MS, decodeServerOptions, encodeServerOptions, parseAppServerOptions } from './options.ts'
export type { AppServerOptions } from './options.ts'
export { firstExecutable, newestFirst, nodeSetupHost } from './setup-host.ts'
export type { CommandArgv, SetupHost } from './setup-host.ts'
export {
  WorkerReplyError, defineAppTool, executePythonTool, formatBytes, replyParser, withSetupNotes, workerParams,
} from './tools.ts'
export type { AppToolDependencies, ExecutePythonText } from './tools.ts'
export type { JsonObject, JsonValue } from './types.ts'
