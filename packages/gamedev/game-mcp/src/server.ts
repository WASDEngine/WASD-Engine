/**
 * The MCP protocol face of the server: a handler that serves the 2026-07-28 revision and, statelessly, the 2025
 * revisions, from one low-level MCP server per request whose tool list and instructions come from the catalog at
 * that moment. `tools/call` answers the search and call tools itself and runs every other name through the
 * catalog. The caller's identity reaches each request as its authentication information.
 * @module @deepseek-ai/dsh-game-mcp/src/server
 */
import { createMcpHandler, Server, type AuthInfo, type CallToolResult, type McpHttpHandler, type Tool } from '@modelcontextprotocol/server'
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
   * Bind one call to its agent and cancellation.
   * @param client - calling agent.
   * @param signal - the request's cancellation.
   * @returns the call.
   */
  call(client: GameMcpClient, signal: AbortSignal): GameMcpCall
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
    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
      const call = serving.call(clientOf(context.http?.authInfo), context.mcpReq.signal)
      // The SDK parsed the arguments from the request's JSON body.
      const args = (request.params.arguments ?? {}) as JsonObject
      const result = await callTool(serving, request.params.name, args, call)
      return server.projectCallToolResult({ ...result, content: [...result.content] }, undefined)
    })
    return server
  }, { legacy: 'stateless', onerror: report, maxRequestBodySize: MAX_BODY_BYTES })
}
