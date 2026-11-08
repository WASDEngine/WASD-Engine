/**
 * The body of an app MCP server entry: decode and validate the options the
 * Host passed, keep one application worker per calling Session, and serve the
 * application's tools over stdio until the client goes away. The entry
 * supplies only what belongs to its application.
 *
 * @module
 */

import { join } from 'node:path'
import type { z } from 'zod'
import { JsonLineWorker, type JsonLineWorkerSpec, type WorkerReady } from './json-line-worker.ts'
import { materializePayload } from './materialize.ts'
import { serveAppMcp, type AppMcpProcess, type AppTool } from './mcp-server.ts'
import { TOOL_CALL_RESERVE_MS, decodeServerOptions, type AppServerOptions } from './options.ts'
import { SHARED_SCOPE, WorkerPool, type AppWorkerScope, type WorkerPoolFiles } from './pool.ts'
import type { AppToolDependencies } from './tools.ts'
import type { JsonObject } from './types.ts'

/** What an application's worker starter receives from the server process. */
export interface AppWorkerDependencies<W extends { readonly ready: WorkerReady } = JsonLineWorker> {
  /** Resolves the worker script to a real file that the application can open, outside `app.asar`. */
  readonly workerScript: () => Promise<string>
  /** Starts a worker process and resolves after its ready line. */
  readonly start: (spec: JsonLineWorkerSpec, signal: AbortSignal) => Promise<W>
}

/** Starts an application's workers for the worker pool and keeps setup notes for the next tool result. */
export interface AppWorkers {
  /**
   * Prepare the application and start one worker for one Session. Starts run one at a time, so first-use setup
   * shared by every worker, such as installing the application, never runs twice at once.
   * @param signal - cancels the preparation and the wait for the ready line.
   * @param scope - the Session and the directory for this worker's own files, such as its application profile.
   * @returns the ready worker.
   */
  start(signal: AbortSignal, scope: AppWorkerScope): Promise<JsonLineWorker>
  /**
   * Hand over the setup notes gathered since the previous call.
   * @returns the notes, oldest first.
   */
  takeNotes(): readonly string[]
}

/** What one application contributes to its MCP server process. */
export interface AppMcpServerDefinition<O extends AppServerOptions> {
  /** Server name reported to the client. */
  readonly name: string
  /** Application name in the worker pool's messages, such as `Blender`. */
  readonly app: string
  /** Server version reported to the client. */
  readonly version: string
  /** Server instructions, which the client adds to the system prompt. */
  readonly instructions: string
  /** `file:` URL of the shipped worker script; the application opens its copy under `<dataRoot>/payload/`. */
  readonly workerScript: URL
  /**
   * Validate the options that the Host passed.
   * @param value - the decoded options.
   * @returns the typed options.
   */
  readonly parseOptions: (value: JsonObject) => O
  /**
   * Create the application's worker starter.
   * @param options - the validated options.
   * @param dependencies - the worker script copy and the worker start.
   * @returns the starter the supervisor uses.
   */
  readonly workers: (options: O, dependencies: AppWorkerDependencies) => AppWorkers
  /**
   * Build the tools.
   * @param dependencies - worker access, setup notes, the data directory, and request budgets.
   * @returns the tools in the order the server lists them.
   */
  readonly tools: (dependencies: AppToolDependencies) => readonly AppTool<z.ZodRawShape>[]
}

/**
 * Run an app MCP server process. It decodes `argv[2]` and validates it with `parseOptions`, then
 * serves the tools with `serveAppMcp`. Each calling Session gets its own worker from a `WorkerPool`,
 * which runs at most `maxWorkers` workers and stops a Session's worker after `workerIdleTimeoutMs`
 * without calls; calls that name no Session share one worker. A worker's request budget is
 * `requestTimeoutMs` and its shutdown grace `graceMs`; the pool starts a worker through `workers` on
 * the Session's first call, after copying the worker script with `materializePayload`, and gives it
 * a numbered folder in `<dataRoot>/workers/<pid>/`, the folder of the server process. The tools get `dataRoot`, `requestTimeoutMs`, and
 * `toolCallTimeoutMs` less `TOOL_CALL_RESERVE_MS` as their `maxTimeoutMs`. Shutdown closes the pool,
 * which stops every worker and deletes the worker folders.
 * @param definition - the application's name, instructions, worker script, options, workers, and tools.
 * @param argv - the server process's `process.argv`.
 * @param io - the process resources to serve on; omission binds the current process.
 * @param files - file-system effects of the worker pool; omission uses Node's.
 * @returns once the server is serving.
 * @throws TypeError when `argv[2]` holds no server options; the errors of `parseOptions` and `serveAppMcp`.
 */
export async function runAppMcpServer<O extends AppServerOptions>(
  definition: AppMcpServerDefinition<O>, argv: readonly string[], io?: AppMcpProcess, files?: WorkerPoolFiles,
): Promise<void> {
  const options = definition.parseOptions(decodeServerOptions(argv))
  const workers = definition.workers(options, {
    workerScript: async () => await materializePayload(definition.workerScript, options.dataRoot),
    start: async (spec, signal) => await JsonLineWorker.start(spec, signal),
  })
  const pool = new WorkerPool({
    app: definition.app,
    root: join(options.dataRoot, 'workers'),
    start: async (signal, scope) => await workers.start(signal, scope),
    takeNotes: () => workers.takeNotes(),
    maxWorkers: options.maxWorkers,
    idleTimeoutMs: options.workerIdleTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    closeGraceMs: options.graceMs,
    files,
  })
  await pool.prepare()
  const toolsOf = (scope: string): ReadonlyMap<string, AppTool<z.ZodRawShape>> => new Map(definition.tools({
    call: async (method, params, callOptions) => await pool.call(scope, method, params, callOptions),
    takeNotes: () => pool.takeNotes(scope),
    dataRoot: options.dataRoot,
    requestTimeoutMs: options.requestTimeoutMs,
    maxTimeoutMs: options.toolCallTimeoutMs - TOOL_CALL_RESERVE_MS,
  }).map(tool => [tool.name, tool]))
  await serveAppMcp({
    name: definition.name,
    version: definition.version,
    instructions: definition.instructions,
    tools: [...toolsOf(SHARED_SCOPE).values()],
    scopedTools: session => toolsOf(session === undefined ? SHARED_SCOPE : `session:${session}`),
    onClose: async () => { await pool.close() },
    process: io,
  })
}
