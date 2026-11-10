/**
 * WASD Engine's MCP server for other agents on this computer, such as Claude Code or Codex: a Streamable HTTP
 * endpoint on `127.0.0.1` that requires the token in the server's data folder and offers the game tools that
 * plugins contribute through `ctx.gameMcp.provide()`, a search over them, and a call by name. Games that a connected
 * agent starts run in a Session of the WASD Engine window, which the server asks the window to show. Every user signs
 * in to WASD Engine, so while the account plugin reports no stored sign-in the server refuses each tool call with a
 * message that asks the user to sign in; a Host without the account plugin runs every call. The `gameMcp`
 * Remote streams the endpoint, the setup prompt, and the agents seen to the window, and the `game-mcp/reveal`
 * event asks the window to show a Session.
 * @module @deepseek-ai/dsh-game-mcp
 */
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { localhostAllowedHostnames, localhostAllowedOrigins, hostHeaderValidationResponse, originValidationResponse, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { GameToolCatalog, PROVIDER_ID_PATTERN } from './catalog.ts'
import { ClientDirectory } from './clients.ts'
import { listenLoopback, LOOPBACK_HOST, type HttpListener } from './http.ts'
import { setupPrompt } from './prompt.ts'
import type { GameMcpCall, GameMcpClient, GameMcpProvider } from './provider.ts'
import { authInfoFor, createGameMcpHandler } from './server.ts'
import { ExternalSessions } from './sessions.ts'
import { authorizes, loadToken } from './token.ts'
import type { GameMcpServerState, GameMcpView } from './types.ts'

export type * from './types.ts'
export type * from './provider.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute folder of the access token and of the connected agents' Session bindings. */
  dataRoot: string
  /** Loopback port of the endpoint; while another program holds it, the server listens on a free port for that Host run. */
  port: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WASD Engine's MCP server for other agents on this computer. */
    gameMcp: GameMcpServer
  }
}

/** Path of the MCP endpoint. */
export const MCP_PATH = '/mcp'

/** The error result of a tool call while WASD Engine is signed out. */
export const SIGNED_OUT_MESSAGE = 'WASD Engine is signed out, and its game tools need a signed-in user. Ask the user to open WASD Engine and sign in, then call the tool again.'

function plainResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } })
}

function parseBody(body: Uint8Array | undefined): JsonValue | undefined {
  if (body === undefined || body.byteLength === 0) return undefined
  try {
    return JSON.parse(Buffer.from(body).toString('utf8')) as JsonValue
  } catch {
    // The MCP handler answers a body that is not JSON with its own parse error.
    return undefined
  }
}

/** Owner of the MCP endpoint, its game tool providers, and the connected agents' Sessions. */
export default class GameMcpServer extends TypertRemoteService {
  static inject = ['typert']
  static Config: z<Partial<Config> & Pick<Config, 'dataRoot'>, Config> = z.object({
    dataRoot: z.string().required(),
    port: z.natural().max(65_535).default(9273),
  })

  private readonly providers: GameMcpProvider[] = []
  private readonly clients = new ClientDirectory()
  private readonly catalog: GameToolCatalog
  private readonly sessions: ExternalSessions
  private readonly handler: McpHttpHandler
  private readonly watchers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private state: GameMcpServerState = 'starting'
  private url: string | undefined
  private token: string | undefined
  private message: string | undefined
  private toolNames = ''

  /**
   * @param ctx - plugin context; the listener lives as long as it.
   * @param config - validated configuration; a relative `dataRoot` fails the plugin load.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'gameMcp', { namespace: 'gameMcp' })
    if (!isAbsolute(config.dataRoot)) throw new Error(`Game MCP plugin: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}.`)
    this.catalog = new GameToolCatalog(() => this.providers, (message) => { ctx.logger.warn(message) })
    this.sessions = new ExternalSessions(ctx, join(config.dataRoot, 'sessions.json'))
    this.handler = createGameMcpHandler({
      catalog: this.catalog,
      refusal: () => this.refusal(),
      call: (client, signal) => this.bindCall(client, signal),
    }, (error) => { ctx.logger.debug(`game-mcp: ${error.message}`) })
    ctx.on('tools/change', () => { this.toolsChanged() })
    ctx.effect(() => {
      let listener: HttpListener | undefined
      let closed = false
      void this.start().then((started) => {
        if (closed) void started?.close()
        else listener = started
      })
      return async () => {
        closed = true
        this.lifetime.abort()
        await listener?.close()
        await this.handler.close()
      }
    }, 'game-mcp: listener')
  }

  /**
   * Offer a plugin's game tools to connected agents for the calling plugin's lifetime.
   * @param provider - the plugin's identity, readiness, and tools; its tool names start with its id and an underscore.
   * @returns an idempotent disposer that withdraws the tools.
   * @throws when the id is not lowercase letters and digits starting with a letter, or another provider has it.
   */
  provide(provider: GameMcpProvider): () => void {
    if (!PROVIDER_ID_PATTERN.test(provider.id)) throw new Error(`gameMcp.provide(): invalid provider id ${JSON.stringify(provider.id)}`)
    const dispose = this.ctx.effect(() => {
      if (this.providers.some(existing => existing.id === provider.id)) throw new Error(`gameMcp.provide(): a provider already has the id "${provider.id}"`)
      this.providers.push(provider)
      this.toolsChanged()
      return () => {
        this.providers.splice(this.providers.indexOf(provider), 1)
        this.toolsChanged()
      }
    }, 'gameMcp.provide()')
    return () => void dispose()
  }

  /**
   * Follow the server for the window: its state, endpoint, and setup prompt, and the agents seen.
   * @param signal - stream cancellation.
   * @returns the current view, then the view after each change, until cancelled or the plugin is disposed.
   */
  @Remote({ mode: 'stream' })
  async* watch(signal: AbortSignal): AsyncIterable<GameMcpView> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    let dirty = true
    let wake = Promise.withResolvers<void>()
    const notify = (): void => {
      dirty = true
      wake.resolve()
    }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      for (;;) {
        if (ended.aborted) return
        if (!dirty) {
          wake = Promise.withResolvers<void>()
          await wake.promise
          continue
        }
        dirty = false
        yield this.view()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  private view(): GameMcpView {
    return {
      state: this.state,
      ...this.url === undefined ? {} : { url: this.url },
      ...this.url === undefined || this.token === undefined ? {} : { prompt: setupPrompt(this.url, this.token) },
      ...this.message === undefined ? {} : { message: this.message },
      clients: this.clients.list(),
    }
  }

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher()
  }

  /** Tell subscribed agents when the tool names change. */
  private toolsChanged(): void {
    const names = this.catalog.tools().map(entry => entry.tool.name).join('\n')
    if (names === this.toolNames) return
    this.toolNames = names
    this.handler.notify.toolsChanged()
  }

  private async start(): Promise<HttpListener | undefined> {
    const logger = this.ctx.logger
    let listener: HttpListener
    try {
      this.token = await loadToken(join(this.config.dataRoot, 'token'))
      const handle = (request: Request, body: Uint8Array<ArrayBuffer> | undefined): Promise<Response> => this.handle(request, body)
      const report = (error: unknown): void => { logger.warn(`game-mcp: request failed: ${String(error)}`) }
      try {
        listener = await listenLoopback(this.config.port, handle, report)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.config.port === 0) throw error
        listener = await listenLoopback(0, handle, report)
        this.message = `Port ${this.config.port} is in use by another program, so the server listens on port ${listener.port} until WASD Engine restarts.`
        logger.warn(`game-mcp: ${this.message}`)
      }
    } catch (error) {
      this.state = 'failed'
      this.message = `The MCP server could not start: ${error instanceof Error ? error.message : String(error)}`
      logger.warn(`game-mcp: ${this.message}`)
      this.changed()
      return undefined
    }
    this.state = 'listening'
    this.url = `http://${LOOPBACK_HOST}:${listener.port}${MCP_PATH}`
    logger.info(`game-mcp: listening on ${this.url}`)
    this.changed()
    return listener
  }

  private async handle(request: Request, body: Uint8Array | undefined): Promise<Response> {
    if (new URL(request.url).pathname !== MCP_PATH) return plainResponse(404, 'Not found')
    // DNS rebinding and cross-site requests from browser pages fail here, before the token is checked.
    const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames())
      ?? originValidationResponse(request, localhostAllowedOrigins())
    if (rejected !== undefined) return rejected
    const token = this.token
    if (token === undefined || !authorizes(request.headers.get('authorization'), token)) {
      return plainResponse(401, 'WASD Engine\'s MCP server needs the token from its setup prompt.', { 'www-authenticate': 'Bearer realm="WASD Engine"' })
    }
    const parsed = parseBody(body)
    const before = this.clients.list().map(client => client.id).join('\n')
    const client = this.clients.identify(parsed, request.headers.get('user-agent') ?? '', Date.now())
    if (this.clients.list().map(seen => seen.id).join('\n') !== before) this.changed()
    return this.handler.fetch(request, { authInfo: authInfoFor(token, client), ...parsed === undefined ? {} : { parsedBody: parsed } })
  }

  /**
   * Refuse tool calls while no one is signed in: the account plugin's stored sign-in, read at each call, lets them run.
   * A sign-in that cannot be read refuses the call too; a Host without the account plugin runs every call.
   * @returns undefined to run the call, or the refusal's text.
   */
  private async refusal(): Promise<string | undefined> {
    const account = this.ctx.get('deepseekAccount')
    if (account === undefined) return undefined
    try {
      return (await account.getState()).status === 'credential-stored' ? undefined : SIGNED_OUT_MESSAGE
    } catch (error) {
      this.ctx.logger.warn(`game-mcp: the sign-in could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return SIGNED_OUT_MESSAGE
    }
  }

  private bindCall(client: GameMcpClient, signal: AbortSignal): GameMcpCall {
    const callSignal = AbortSignal.any([signal, this.lifetime.signal])
    return {
      client,
      signal: callSignal,
      session: directory => this.sessions.agent(client, directory, callSignal),
      reveal: (sessionId: SessionId) => { this.ctx.emit('game-mcp/reveal', sessionId) },
    }
  }
}
