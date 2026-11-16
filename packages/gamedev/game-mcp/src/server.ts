/**
 * The MCP protocol face of the server: a handler that serves the 2026-07-28 revision and, statelessly, the 2025
 * revisions, from one low-level MCP server per request whose tool list and instructions come from the catalog at
 * that moment. `tools/call` answers the search and call tools itself, hands the create tool to the service, and runs
 * every other name through the catalog, once the service lets this call run: WASD Engine refuses every call while no
 * one is signed in. The caller's identity reaches each request as its authentication information.
 *
 * The response to every request is an event stream that starts as soon as the request arrives and carries keep-alive
 * comments every 15 seconds, so an agent that waits a fixed time for a response to begin, as Claude Code waits 60
 * seconds, keeps waiting for a tool call that runs longer, such as a release that uploads a large build. While a call
 * runs, an agent that asked for progress gets a progress notification every `progressIntervalMs`, so an agent that
 * gives up on a call that reports nothing for minutes, as Claude Code does after 5, keeps waiting too.
 *
 * A call whose tool names a confirmation page, such as a purchase the user confirms on the WASD Engine site, reaches a
 * client that declared URL-mode elicitation (`elicitation.url`) on the 2026-07-28 revision as an input-required
 * result with that page; the client shows it to the user and retries the call, which then returns the call's content
 * and how the user answered without running the tool again. The content travels in `requestState`, sealed with a
 * per-process HMAC key and bound to the method and the calling agent. Other clients, and every client of the
 * stateless 2025 revisions, get the content alone, which names the page.
 *
 * A failed call of a tool that spends the account's AI usage, once the service finds a Free account whose usage is used
 * up (`free-plan.ts`), reaches such a client the same way, as the page that upgrades the account to Pro: declining it
 * keeps the user on Free, and the retry tells the agent only that the tool is not available now. Other clients get a
 * text the agent passes on to the user with the page, and the user stays on Free unless they upgrade. MCP sends the
 * server instructions once per connection, so the first tool result an agent gets after the providers that spend the
 * usage turned off, or on again, ends with a note that names them.
 * @module @deepseek-ai/dsh-game-mcp/src/server
 */
import { randomBytes } from 'node:crypto'
import {
  CLIENT_CAPABILITIES_META_KEY, createMcpHandler, createRequestStateCodec, inputRequired, Server, type AuthInfo, type CallToolResult,
  type InputRequiredResult, type McpHttpHandler, type ServerContext, type Tool,
} from '@modelcontextprotocol/server'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CALL_TOOL, CREATE_PROJECT_TOOL, SEARCH_TOOL, type GameToolCatalog, type McpCallResult } from './catalog.ts'
import { DISMISSED, STAYING, UPGRADING, type UsageOffer } from './free-plan.ts'
import { MAX_BODY_BYTES } from './http.ts'
import type { GameMcpCall, GameMcpClient, GameMcpContent, JsonObject } from './provider.ts'
import { UNKNOWN_CLIENT } from './clients.ts'

/** Name the server reports to agents. */
export const SERVER_NAME = 'wasd-engine'

/** Version of the server's tool surface, reported to agents. */
export const SERVER_VERSION = '1.0.0'

/** Key of a call's confirmation page among its input requests. */
export const CONFIRM_INPUT = 'confirm'

/** Key of the page that upgrades a Free account whose usage is used up among a call's input requests. */
export const USAGE_INPUT = 'usage'

/** Seconds a call that waits for its confirmation page can be retried. */
const CONFIRMATION_SECONDS = 1800

/** What a call that waits for its confirmation page carries to its retry. */
interface ConfirmationState {
  readonly content: GameMcpContent[]
}

/** What a call that waits for the user's answer to the page that upgrades the account carries to its retry. */
interface UsageState {
  readonly usage: true
}

/** What a call that waits for the user carries to its retry. */
type CallState = ConfirmationState | UsageState

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
  /**
   * Run one call of the create tool, which creates a game project without a Session.
   * @param args - the agent's arguments.
   * @param signal - the call's cancellation.
   * @returns the MCP result; a refused or failed creation is an error result whose text says why.
   */
  createProject(args: JsonObject, signal: AbortSignal): Promise<McpCallResult>
  /**
   * The choice to put to the user in place of a failed call of a tool that spends the account's AI usage.
   * @param failure - the failed call's text.
   * @returns the offer, or undefined to return the failure as it is.
   */
  usageOffer(failure: string): Promise<UsageOffer | undefined>
  /**
   * Keep the user on Free: connected agents are offered no provider that spends the usage until it refreshes.
   * @returns once the choice is recorded.
   */
  stayOnFree(): Promise<void>
  /**
   * The note an agent's tool result carries once after the providers that spend the account's usage turned off, or on
   * again, since the agent received the server instructions.
   * @param client - the calling agent.
   * @returns the note, or undefined when there is nothing new to tell it.
   */
  note(client: GameMcpClient): string | undefined
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
 * Whether the request's client declared URL-mode elicitation: only a 2026-07-28 request carries its client's
 * capabilities, in its `_meta` envelope.
 * @param context - the request's context.
 * @returns true when the capabilities name `elicitation.url`.
 */
function declaresUrlElicitation(context: ServerContext): boolean {
  const envelope = context.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY]
  if (typeof capabilities !== 'object' || capabilities === null) return false
  const elicitation = (capabilities as { readonly elicitation?: unknown }).elicitation
  return typeof elicitation === 'object' && elicitation !== null && (elicitation as { readonly url?: unknown }).url !== undefined
}

/**
 * How the user answered a page that a call's input request showed them.
 * @param response - the client's elicitation result.
 * @returns `accept` or `decline`, or undefined for a dismissed page and anything else.
 */
function actionOf(response: unknown): 'accept' | 'decline' | undefined {
  const action = typeof response === 'object' && response !== null ? (response as { readonly action?: unknown }).action : undefined
  return action === 'accept' || action === 'decline' ? action : undefined
}

/**
 * The note a retried call adds after the user answered its confirmation page.
 * @param response - the client's elicitation result.
 * @returns the note.
 */
function confirmationNote(response: unknown): string {
  switch (actionOf(response)) {
    case 'accept': return 'The user opened the confirmation page. It takes effect once they confirm there; nothing is charged or changed before that.'
    case 'decline': return 'The user declined to open the confirmation page, so nothing was charged or changed.'
    default: return 'The user dismissed the confirmation page, so nothing was charged or changed.'
  }
}

/**
 * What a retried call tells the agent after the user answered the page that upgrades the account: declining keeps the
 * user on Free. None of the texts names the plan or what the tool costs.
 * @param serving - the service, which records a choice to stay on Free.
 * @param response - the client's elicitation result.
 * @returns the text of the call's error result.
 */
async function usageAnswer(serving: GameMcpServing, response: unknown): Promise<string> {
  switch (actionOf(response)) {
    case 'accept': return UPGRADING
    case 'decline':
      await serving.stayOnFree()
      return STAYING
    default: return DISMISSED
  }
}

/**
 * The text of a result's text blocks.
 * @param result - the result.
 * @returns the text.
 */
function textOf(result: McpCallResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
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
  if (name === CREATE_PROJECT_TOOL) return serving.createProject(args, call.signal)
  let target = name
  let targetArgs = args
  if (name === CALL_TOOL) {
    if (typeof args.name !== 'string') return errorResult(`${CALL_TOOL} needs name, the tool to call.`)
    if (args.arguments !== undefined && !isObject(args.arguments)) return errorResult(`${CALL_TOOL}: arguments must be an object.`)
    target = args.name
    targetArgs = args.arguments ?? {}
    if (target === SEARCH_TOOL || target === CALL_TOOL || target === CREATE_PROJECT_TOOL) return callTool(serving, target, targetArgs, call)
  }
  const entry = catalog.tools().find(candidate => candidate.tool.name === target)
  if (entry === undefined) return errorResult(`WASD Engine has no game tool named ${JSON.stringify(target)}; ${SEARCH_TOOL} lists the tools.`)
  const result = await catalog.run(entry, targetArgs, call)
  if (result.isError !== true || entry.provider.spendsUsage !== true) return result
  const offer = await serving.usageOffer(textOf(result))
  return offer === undefined ? result : { ...result, usageOffer: offer }
}

/**
 * Create the MCP handler.
 * @param serving - the service.
 * @param report - receives protocol errors and rejected requests.
 * @returns the web-standard handler.
 */
export function createGameMcpHandler(serving: GameMcpServing, report: (error: Error) => void): McpHttpHandler {
  // One key per server process: the retry of a call that waited for the user reaches this process.
  const confirmations = createRequestStateCodec<CallState>({
    key: randomBytes(32),
    ttlSeconds: CONFIRMATION_SECONDS,
    bind: context => `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ''}`,
  })
  return createMcpHandler(() => {
    const catalog = serving.catalog
    // oxlint-disable-next-line typescript/no-deprecated -- unlike McpServer, the low-level Server lists JSON Schemas unchanged.
    const server = new Server({ name: SERVER_NAME, title: 'WASD Engine', version: SERVER_VERSION }, {
      capabilities: { tools: { listChanged: true } },
      instructions: catalog.instructions(),
      requestState: { verify: (...args: Parameters<typeof confirmations.verify>) => confirmations.verify(...args) },
    })
    // Every listed schema is an object schema: the catalog's own, `defineTool`'s, or one an MCP server listed.
    server.setRequestHandler('tools/list', () => ({ tools: catalog.listing().map(tool => ({ ...tool, inputSchema: tool.inputSchema as Tool['inputSchema'] })) }))
    function answer(result: McpCallResult): CallToolResult {
      return server.projectCallToolResult({ ...result.isError === true ? { isError: true } : {}, content: [...result.content] }, undefined)
    }
    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult | InputRequiredResult> => {
      const refused = await serving.refusal()
      if (refused !== undefined) return answer(errorResult(refused))
      const client = clientOf(context.http?.authInfo)
      // A call's own result, and once after the providers that spend the account's usage turned off or on, the note.
      const noted = (result: McpCallResult): CallToolResult => {
        const note = serving.note(client)
        return answer(note === undefined ? result : { ...result, content: [...result.content, { type: 'text', text: note }] })
      }
      const responses = context.mcpReq.inputResponses
      if (responses !== undefined && CONFIRM_INPUT in responses) {
        // The retry after the user answered the confirmation page: the call already ran.
        const state = context.mcpReq.requestState<CallState>()
        if (state === undefined || typeof state !== 'object' || !('content' in state)) {
          return noted(errorResult('This confirmation is no longer valid; call the tool again.'))
        }
        return noted({ content: [...state.content, { type: 'text', text: confirmationNote(responses[CONFIRM_INPUT]) }] })
      }
      if (responses !== undefined && USAGE_INPUT in responses) {
        // The retry after the user answered the page that upgrades the account: the call already failed.
        const state = context.mcpReq.requestState<CallState>()
        if (state === undefined || typeof state !== 'object' || !('usage' in state)) {
          return noted(errorResult('This question is no longer valid; call the tool again.'))
        }
        return noted(errorResult(await usageAnswer(serving, responses[USAGE_INPUT])))
      }
      // The SDK parsed the arguments from the request's JSON body.
      const args = (request.params.arguments ?? {}) as JsonObject
      const call = serving.call(client, context.mcpReq.signal)
      using _progress = progressWhileRunning(context, serving.progressIntervalMs, report)
      const result = await callTool(serving, request.params.name, args, call)
      if (result.usageOffer !== undefined) {
        const offer = result.usageOffer
        if (declaresUrlElicitation(context)) {
          return inputRequired({
            inputRequests: { [USAGE_INPUT]: inputRequired.elicitUrl({ message: offer.message, url: offer.url }) },
            requestState: await confirmations.mint({ usage: true }, context),
          })
        }
        // Without a client that shows the page, the agent passes the offer on, and the user stays on Free unless they
        // upgrade.
        await serving.stayOnFree()
        return noted(errorResult(offer.passOn))
      }
      if (result.confirmation !== undefined && result.isError !== true && declaresUrlElicitation(context)) {
        return inputRequired({
          inputRequests: {
            [CONFIRM_INPUT]: inputRequired.elicitUrl({ message: result.confirmation.message, url: result.confirmation.url }),
          },
          requestState: await confirmations.mint({ content: result.content }, context),
        })
      }
      return noted(result)
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
