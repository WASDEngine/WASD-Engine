/**
 * A Host composition with the real Agent, tool, prompt, and executor services, a fake account sign-in, a fake WASD
 * Engine site, optionally WASD Engine's MCP server with an official MCP client connected to it, and the agent feedback
 * plugin loaded with its validated configuration.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import GameMcpServer, { type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import * as AgentFeedback from '../src/index.ts'
import { startFakeSite, type FakeSite } from './fixtures.ts'

/** The token the fake sign-in holds. */
export const TOKEN = 'wasd-token-for-tests'

/** The model route of the composition's Agent. */
export const ROUTE = { provider: 'test', model: 'test-model' } as const

/** Time limit of the specs that start the MCP server. */
export const TIMEOUT = 60_000

/** The fake account sign-in: whether it is signed in, and whether its service has stopped. */
export interface FakeAccount {
  signedIn: boolean
  /** Set once the sign-in's fiber stops; like the real provider, it then holds no session. */
  closed: boolean
}

/** What a spec composes. */
export interface ComposeOptions {
  /** Plugin configuration. */
  readonly config?: Partial<AgentFeedback.Config>
  /** Start WASD Engine's MCP server before the plugin. */
  readonly gameMcp?: boolean
  /** Provide a model service whose models have this display name. */
  readonly modelName?: string
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly site: FakeSite
  readonly account: FakeAccount
  /** The calling Agent. */
  readonly agent: Agent
  /** The composition's scratch folder, which holds the MCP server's data. */
  readonly work: string
  /** WASD Engine's MCP server, when composed. */
  readonly server: GameMcpServer | undefined
  /** Dispose the agent feedback plugin's fiber. */
  unload(): Promise<void>
  cleanup(): Promise<void>
}

async function fakeAgent(ctx: Context, id: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const selection: Model = { current: () => ROUTE, select: () => {} }
  const agent: Agent = {
    id: sessionId, options: {}, session: Session.create(sessionId), model: selection, inbox: createInboxStub(), status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

/**
 * Compose the services, a fake site, a signed-in account whose sign-in names the fake's origin, and the plugin.
 * @param options - what to compose beside them.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(options: ComposeOptions = {}): Promise<Composition> {
  const site = await startFakeSite()
  const work = await mkdtemp(join(tmpdir(), 'dsh-agent-feedback-'))
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const account: FakeAccount = { signedIn: true, closed: false }
  // The sign-in as a service of its own fiber, as the account plugin provides it.
  class FakeAccountService extends Service {
    constructor(inner: Context) {
      super(inner, 'deepseekAccount')
      inner.effect(() => () => { account.closed = true })
    }

    getState() {
      return Promise.resolve({ status: account.signedIn ? 'credential-stored' : 'signed-out', links: { usageUrl: `${site.origin}/usage`, topUpUrl: `${site.origin}/top_up` }, attempt: null })
    }

    getPlatformSession() {
      return Promise.resolve(account.signedIn && !account.closed ? { origin: site.origin, token: TOKEN, userId: null } : null)
    }
  }
  await ctx.plugin(FakeAccountService)
  if (options.modelName !== undefined) {
    const name = options.modelName
    ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ name }) } as never)
  }
  let server: GameMcpServer | undefined
  if (options.gameMcp === true) {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(work, '.game-mcp'), port: 0 }))
    server = ctx.get('gameMcp')
  }
  const fiber = ctx.plugin(AgentFeedback, AgentFeedback.Config(options.config ?? {}))
  await fiber
  const agent = await fakeAgent(ctx, 'owner')
  return {
    ctx, site, account, agent, work, server,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
      await site.close()
      await rm(work, { recursive: true, force: true })
    },
  }
}

let calls = 0

/**
 * Call a tool as the composition's Agent.
 * @param composition - composition.
 * @param name - tool name.
 * @param args - arguments.
 * @returns the settled result.
 */
export function callTool(composition: Composition, name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, { signal: new AbortController().signal, callId: ToolCallId(`feedback-${calls}`), name, arguments: args, agent: composition.agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Connect an official MCP client to the composition's MCP server once it listens.
 * @param composition - a composition with the MCP server.
 * @param name - the client's name, which the server identifies the agent by.
 * @returns the connected client; the composition's cleanup closes it.
 */
export async function connect(composition: Composition, name = 'claude-code'): Promise<Client> {
  const { ctx, server, work } = composition
  if (server === undefined) throw new Error('compose with gameMcp: true to connect an agent')
  const views: GameMcpView[] = []
  const stop = new AbortController()
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  ctx.effect(() => () => { stop.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  const url = views.at(-1)?.url as string
  const token = (await readFile(join(work, '.game-mcp', 'token'), 'utf8')).trim()
  const client = new Client({ name, version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return client
}
