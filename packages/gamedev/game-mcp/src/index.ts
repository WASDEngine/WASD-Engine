/**
 * WASD Engine's MCP server for other agents on this computer, such as Claude Code or Codex: a Streamable HTTP
 * endpoint on `127.0.0.1` that requires the token in the server's data folder and offers the game tools that
 * plugins contribute through `ctx.gameMcp.provide()`, a search over them, a call by name, and the creation of a game
 * project, which opens no Session in it. The listener starts with the plugin, before the other plugins that provide game
 * tools have loaded, so the server answers requests only once the Loader's tree has settled, or after `readyTimeoutMs`:
 * MCP has no way to send an agent new instructions, and an agent keeps the overview it received when it connected. Games
 * that a connected agent starts run in a Session of the WASD Engine window, which the server asks the window to show.
 * A folder in a temporary folder, such as an agent's scratch folder, never becomes a game project through the server.
 * Every user signs in to WASD Engine, so while the account plugin reports no stored sign-in the server refuses each tool
 * call with a message that asks the user to sign in; a Host without the account plugin runs every call. A Free account
 * whose AI usage is used up is offered the upgrade to Pro when a tool that spends that usage fails, and a user who stays
 * on Free is offered no such tool until the usage refreshes (`free-plan.ts`). The `gameMcp`
 * Remote streams the endpoint, the setup prompt, and the agents seen to the window, the `game-mcp/reveal` event asks the
 * window to show a Session, the `game-mcp/tool-result` event reports each finished call of a provider tool, and the
 * `game-mcp/project-created` event reports each game project an agent created. Both carry the AI model the agent named
 * in the call, when the tool takes one.
 * @module @deepseek-ai/dsh-game-mcp
 */
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { localhostAllowedHostnames, localhostAllowedOrigins, hostHeaderValidationResponse, originValidationResponse, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { GameToolCatalog, OVERVIEW_LIMIT, PROVIDER_ID_PATTERN } from './catalog.ts'
import { ClientDirectory } from './clients.ts'
import { FREE_PLAN_FILE, FreePlan, ProviderNotes } from './free-plan.ts'
import { listenLoopback, LOOPBACK_HOST, type HttpListener } from './http.ts'
import { createGameProject } from './projects.ts'
import { setupPrompt } from './prompt.ts'
import type { GameMcpCall, GameMcpClient, GameMcpProvider, GameMcpToolOwner } from './provider.ts'
import { authInfoFor, createGameMcpHandler } from './server.ts'
import { ExternalSessions } from './sessions.ts'
import { systemTemporaryFolders } from './temporary-folders.ts'
import { authorizes, loadToken } from './token.ts'
import type { GameMcpServerState, GameMcpView } from './types.ts'

export type * from './types.ts'
export type * from './provider.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute folder of the access token, of the connected agents' Session bindings, and of a choice to stay on Free. */
  dataRoot: string
  /** Loopback port of the endpoint; while another program holds it, the server listens on a free port for that Host run. */
  port: number
  /**
   * Interval in milliseconds of the progress notifications a running tool call sends to an agent that asked for
   * progress; agents such as Claude Code give up on a call that reports nothing for 5 minutes.
   */
  progressIntervalMs: number
  /**
   * Longest time in milliseconds that the first requests wait for the composition to finish loading its plugins, so
   * that a plugin that never finishes delays agents no longer; the default stays under the 10 seconds that Codex gives
   * a server to start.
   */
  readyTimeoutMs: number
  /**
   * Absolute folders where agents keep throwaway work, such as Claude Code's scratchpad under /tmp: a call that names a
   * folder in one, which no game project contains, runs in a Session outside every game project instead of registering
   * the folder as one, and `create_game_project` refuses a location in one. Default: the Host's temporary folder and,
   * outside Windows, /tmp and /var/tmp.
   */
  temporaryFolders: string[]
}

/** The part of the Loader that the server waits for. */
interface LoaderReadiness {
  /** @returns once the Loader's tree has no pending import or plugin start. */
  await(): Promise<void>
}

/** Code of the deadline of the wait for the composition. */
const READY_TIMEOUT_CODE = 'GAME_MCP_READY_TIMEOUT'

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

/**
 * Whether a request's answer carries the server instructions, which an agent keeps for its connection.
 * @param parsed - the request's JSON body.
 * @returns true for `initialize` and `server/discover`.
 */
function receivesInstructions(parsed: JsonValue | undefined): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  return parsed.method === 'initialize' || parsed.method === 'server/discover'
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
    progressIntervalMs: z.natural().min(1).default(30_000),
    readyTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(8_000),
    temporaryFolders: z.array(z.string()).default(systemTemporaryFolders()),
  })

  private readonly providers: GameMcpProvider[] = []
  private readonly clients = new ClientDirectory()
  private readonly freePlan: FreePlan
  private readonly notes = new ProviderNotes()
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
  /** The wait for the composition, which the first request that reaches the MCP handler starts. */
  private composition: Promise<void> | undefined

  /**
   * @param ctx - plugin context; the listener lives as long as it.
   * @param config - validated configuration; a relative `dataRoot` or temporary folder fails the plugin load.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'gameMcp', { namespace: 'gameMcp' })
    if (!isAbsolute(config.dataRoot)) throw new Error(`Game MCP plugin: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}.`)
    const relative = config.temporaryFolders.find(folder => !isAbsolute(folder))
    if (relative !== undefined) throw new Error(`Game MCP plugin: temporaryFolders must hold absolute paths, got ${JSON.stringify(relative)}.`)
    this.freePlan = new FreePlan(ctx, join(config.dataRoot, FREE_PLAN_FILE), () => { this.toolsChanged() })
    this.catalog = new GameToolCatalog(() => this.providers, (message) => { ctx.logger.warn(message) }, (result) => {
      try {
        ctx.emit('game-mcp/tool-result', result)
      } catch (error) {
        // A listener's failure must not turn the agent's finished call into a failed request.
        ctx.logger.warn(`game-mcp: a game-mcp/tool-result listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, provider => provider.spendsUsage !== true || !this.freePlan.hiding())
    this.sessions = new ExternalSessions(ctx, join(config.dataRoot, 'sessions.json'), config.temporaryFolders)
    this.handler = createGameMcpHandler({
      catalog: this.catalog,
      refusal: () => this.refusal(),
      call: (client, signal) => this.bindCall(client, signal),
      createProject: (args, call) => createGameProject(ctx, args, call, config.temporaryFolders),
      usageOffer: failure => this.freePlan.offer(failure),
      stayOnFree: () => this.freePlan.stayOnFree(),
      note: client => this.notes.note(
        client.id, this.freePlan.hiding(), () => this.providers.filter(provider => provider.spendsUsage === true),
      ),
      progressIntervalMs: config.progressIntervalMs,
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
   * Offer a plugin's game tools to connected agents for the calling plugin's lifetime. When the provider's description
   * makes the overview of the server instructions longer than 4,096 characters, the part that Claude Code passes to its
   * model, a warning names the length.
   * @param provider - the plugin's identity, readiness, and tools; its tool names start with its id and an underscore.
   * @returns an idempotent disposer that withdraws the tools.
   * @throws when the id is not lowercase letters and digits starting with a letter, or another provider has it.
   */
  provide(provider: GameMcpProvider): () => void {
    if (!PROVIDER_ID_PATTERN.test(provider.id)) throw new Error(`gameMcp.provide(): invalid provider id ${JSON.stringify(provider.id)}`)
    const dispose = this.ctx.effect(() => {
      if (this.providers.some(existing => existing.id === provider.id)) throw new Error(`gameMcp.provide(): a provider already has the id "${provider.id}"`)
      this.providers.push(provider)
      const overview = this.catalog.overview().length
      if (overview > OVERVIEW_LIMIT) {
        this.ctx.logger.warn(`game-mcp: with ${provider.title}, the overview of the server instructions comes to ${overview} characters, more than the `
          + `${OVERVIEW_LIMIT} that Claude Code passes to its model; shorten the providers' descriptions`)
      }
      this.toolsChanged()
      return () => {
        this.providers.splice(this.providers.indexOf(provider), 1)
        this.toolsChanged()
      }
    }, 'gameMcp.provide()')
    return () => void dispose()
  }

  /**
   * Find the provider that offers a tool now, so a report of a Session's own tool calls can count them by the plugin
   * connected agents know them by: a Session calls Blender's tools as the MCP client names them, such as
   * `mcp__wasd_blender__execute_python`, and connected agents as `blender_execute_python`.
   * @param name - the tool's name as a Session calls it (its harness definition's name), or as connected agents call it.
   * @returns the provider's id and display name and the tool's name for connected agents, or undefined when no
   * provider offers the tool.
   */
  toolOwner(name: string): GameMcpToolOwner | undefined {
    return this.catalog.owner(name)
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
    // The instructions of `initialize` and `server/discover` stay with the agent for its connection.
    await this.composed()
    // While the user stays on Free, the request lists the providers that spend the account's usage once it has some again.
    await this.freePlan.refresh()
    if (receivesInstructions(parsed)) this.notes.instructed(client.id, this.freePlan.hiding())
    return this.handler.fetch(request, { authInfo: authInfoFor(token, client), ...parsed === undefined ? {} : { parsedBody: parsed } })
  }

  /**
   * Wait, once for the plugin's lifetime, until the composition has loaded its plugins: the Loader's settlement, which
   * joins every entry's import and start and so the providers that register as their plugins start. The wait ends
   * after `readyTimeoutMs`, with a warning, or when the plugin stops; a Host without a Loader is complete already.
   * @returns once the composition has settled or the wait has ended.
   */
  private composed(): Promise<void> {
    this.composition ??= this.awaitComposition()
    return this.composition
  }

  private async awaitComposition(): Promise<void> {
    const loader: LoaderReadiness | undefined = this.ctx.get('loader')
    if (loader === undefined) return
    using limit = deadline(this.lifetime.signal, this.config.readyTimeoutMs, READY_TIMEOUT_CODE)
    const ended = new Promise<void>((resolve) => {
      if (limit.signal.aborted) resolve()
      else limit.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    const settled = loader.await().catch((error: unknown) => {
      // The boot reports a tree that failed to load; the server answers with the providers it has.
      this.ctx.logger.warn(`game-mcp: the plugins could not be awaited: ${error instanceof Error ? error.message : String(error)}`)
    })
    await Promise.race([settled, ended])
    if (timeoutOf(limit.signal, READY_TIMEOUT_CODE) === undefined) return
    this.ctx.logger.warn(`game-mcp: the plugins did not finish loading within ${String(this.config.readyTimeoutMs)} ms, so agents that connect `
      + `now get the instructions of the providers registered so far: ${JSON.stringify(this.providers.map(provider => provider.title))}`)
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
      session: (directory, name) => this.sessions.agent(client, directory, callSignal, name),
      reveal: (sessionId: SessionId) => { this.ctx.emit('game-mcp/reveal', sessionId) },
    }
  }
}
