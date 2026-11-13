/**
 * The MCP protocol face of the server: a handler that serves the 2026-07-28 revision and, statelessly, the 2025
 * revisions, from one low-level MCP server per request whose tool list and instructions come from the catalog at
 * that moment. `tools/call` answers the search and call tools itself and runs every other name through the
 * catalog, once the service lets this call run: WASD Engine refuses every call while no one is signed in. The
 * caller's identity reaches each request as its authentication information.
 *
 * The response to every request is an event stream that starts as soon as the request arrives and carries keep-alive
 * comments every 15 seconds, so an agent that waits a fixed time for a response to begin, as Claude Code waits 60
 * seconds, keeps waiting for a tool call that runs longer, such as a release that uploads a large build. While a call
 * runs, an agent that asked for progress gets a progress notification every `progressIntervalMs`, so an agent that
 * gives up on a call that reports nothing for minutes, as Claude Code does after 5, keeps waiting too.
 * @module @deepseek-ai/dsh-game-mcp/src/server
 */
import { createMcpHandler, Server, type AuthInfo, type CallToolResult, type McpHttpHandler, type ServerContext, type Tool } from '@modelcontextprotocol/server'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CALL_TOOL, SEARCH_TOOL, type GameToolCatalog, type McpCallResult } from './catalog.ts'
import { MAX_BODY_BYTES } from './http.ts'
import type { GameMcpCall, GameMcpClient, JsonObject } from './provider.ts'
import { UNKNOWN_CLIENT } from './clients.ts'

/** Name the server reports to agents. */
export const SERVER_NAME = 'wasd-engine'

/** Version of the server's tool surface, reported to agents. */
export const SERVER_VERSION = '1.0.0'

/** What the protocol face needs from the service. */
export interface GameMcpServing {
  /** The tools and instructions. */
  readonly catalog: GameToolCatalog
  /**
   * Decide whether a tool call may run now.
   * @returns undefined to run it, or the text of the error result that refuses it.
   */
  refusal(): Promise<string | undefined>
  /**
   * Bind one call to its agent and cancellation.
   * @param client - calling agent.
   * @param signal - the request's cancellation.
   * @returns the call.
   */
  call(client: GameMcpClient, signal: AbortSignal): GameMcpCall
  /** Interval in milliseconds of the progress notifications a running tool call sends to an agent that asked for progress. */
  readonly progressIntervalMs: number
}

/**
 * The authentication information that carries a request's caller to its handlers.
 * @param token - the verified access token.
 * @param client - the agent that sent the request.
 * @returns the information.
 */
export function authInfoFor(token: string, client: GameMcpClient): AuthInfo {
  return { token, clientId: client.id, scopes: [], extra: { title: client.title } }
}

function clientOf(info: AuthInfo | undefined): GameMcpClient {
  const title = info?.extra?.title
  return info === undefined || typeof title !== 'string' ? UNKNOWN_CLIENT : { id: info.clientId, title }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResult(text: string): McpCallResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Tell an agent that asked for progress, every `intervalMs` until disposed, that its call still runs. The progress
 * value counts the notifications, so it grows with each one as the protocol requires; the message gives the time.
 * @param context - the call's request context; without a progress token, nothing is sent.
 * @param intervalMs - interval between notifications.
 * @param report - receives a notification that could not be sent.
 * @returns the disposable that stops the notifications.
 */
function progressWhileRunning(context: ServerContext, intervalMs: number, report: (error: Error) => void): Disposable {
  const progressToken = context.mcpReq._meta?.progressToken
  if (progressToken === undefined) return { [Symbol.dispose]() {} }
  const started = Date.now()
  let progress = 0
  const timer = setInterval(() => {
    progress++
    const seconds = Math.round((Date.now() - started) / 1000)
    context.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, message: `Still running after ${String(seconds)} s.` } })
      .catch((error: unknown) => { report(error instanceof Error ? error : new Error(String(error))) })
  }, intervalMs)
  return { [Symbol.dispose]() { clearInterval(timer) } }
}

/**
 * Run one `tools/call`.
 * @param serving - the service.
 * @param name - tool name.
 * @param args - arguments as the agent sent them.
 * @param call - the bound call.
 * @returns the MCP result.
 */
async function callTool(serving: GameMcpServing, name: string, args: JsonObject, call: GameMcpCall): Promise<McpCallResult> {
  const catalog = serving.catalog
  if (name === SEARCH_TOOL) {
    const query = typeof args.query === 'string' ? args.query : ''
    const plugin = typeof args.plugin === 'string' ? args.plugin : undefined
    return { content: [{ type: 'text', text: await catalog.search(query, plugin, call.signal) }] }
  }
  let target = name
  let targetArgs = args
  if (name === CALL_TOOL) {
    if (typeof args.name !== 'string') return errorResult(`${CALL_TOOL} needs name, the tool to call.`)
    if (args.arguments !== undefined && !isObject(args.arguments)) return errorResult(`${CALL_TOOL}: arguments must be an object.`)
    target = args.name
    targetArgs = args.arguments ?? {}
    if (target === SEARCH_TOOL || target === CALL_TOOL) return callTool(serving, target, targetArgs, call)
  }
  const entry = catalog.tools().find(candidate => candidate.tool.name === target)
  if (entry === undefined) return errorResult(`WASD Engine has no game tool named ${JSON.stringify(target)}; ${SEARCH_TOOL} lists the tools.`)
  return catalog.run(entry, targetArgs, call)
}

/**
 * Create the MCP handler.
 * @param serving - the service.
 * @param report - receives protocol errors and rejected requests.
 * @returns the web-standard handler.
 */
export function createGameMcpHandler(serving: GameMcpServing, report: (error: Error) => void): McpHttpHandler {
  return createMcpHandler(() => {
    const catalog = serving.catalog
    // oxlint-disable-next-line typescript/no-deprecated -- unlike McpServer, the low-level Server lists JSON Schemas unchanged.
    const server = new Server({ name: SERVER_NAME, title: 'WASD Engine', version: SERVER_VERSION }, {
      capabilities: { tools: { listChanged: true } },
      instructions: catalog.instructions(),
    })
    // Every listed schema is an object schema: the catalog's own, `defineTool`'s, or one an MCP server listed.
    server.setRequestHandler('tools/list', () => ({ tools: catalog.listing().map(tool => ({ ...tool, inputSchema: tool.inputSchema as Tool['inputSchema'] })) }))
    function answer(result: McpCallResult): CallToolResult {
      return server.projectCallToolResult({ ...result, content: [...result.content] }, undefined)
    }
    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
      const refused = await serving.refusal()
      if (refused !== undefined) return answer(errorResult(refused))
      // The SDK parsed the arguments from the request's JSON body.
      const args = (request.params.arguments ?? {}) as JsonObject
      const call = serving.call(clientOf(context.http?.authInfo), context.mcpReq.signal)
      using _progress = progressWhileRunning(context, serving.progressIntervalMs, report)
      return answer(await callTool(serving, request.params.name, args, call))
    })
    return server
  }, {
    legacy: 'stateless',
    // The stateless serving of the 2025 revisions streams every response already; this makes the 2026-07-28
    // revision's responses stream from the start too, instead of sending one JSON body once the call ends.
    responseMode: 'sse',
    onerror: report,
    maxRequestBodySize: MAX_BODY_BYTES,
  })
}
