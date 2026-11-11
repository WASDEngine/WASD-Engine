/**
 * A Host composition with the real Agent, tool, prompt, and executor services, a fake account sign-in, a fake WASD
 * Engine API, and the ElevenLabs plugin loaded with its validated configuration.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ElevenLabs from '../src/index.ts'
import { startFakeAudioApi, type FakeAudioApi } from './fixtures.ts'

/** The token the fake sign-in releases to the API origin. */
export const TOKEN = 'wasd-token-for-tests'

/** The fake account sign-in: whether it is signed in, and what the plugin asked of it. */
export interface FakeAccount {
  signedIn: boolean
  /** URLs the plugin asked a token for. */
  readonly resolved: string[]
  /** Tokens the plugin reported as refused. */
  readonly rejected: string[]
}

/** The fake approval prompt: its answer, and the questions it was asked. */
export interface FakeApproval {
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  readonly asked: Array<{ readonly toolName: string; readonly reason: string | undefined; readonly zh: string | undefined }>
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly api: FakeAudioApi
  readonly account: FakeAccount
  readonly approval: FakeApproval
  /** The Agent's working directory. */
  readonly work: string
  /** The calling Agent. */
  readonly agent: Agent
  /** Dispose the ElevenLabs plugin's fiber. */
  unload(): Promise<void>
  cleanup(): Promise<void>
}

async function fakeAgent(ctx: Context, id: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const route = { provider: 'test', model: 'test' }
  const selection: Model = { current: () => route, select: () => {} }
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
 * Compose the services, a fake API, a signed-in account whose token goes only to the fake's origin, and the plugin.
 * @param config - plugin configuration beside the fake's origin.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(
  config: Partial<ElevenLabs.Config> = {}, options: { readonly approval?: boolean } = {},
): Promise<Composition> {
  const api = await startFakeAudioApi()
  const work = await mkdtemp(join(tmpdir(), 'dsh-elevenlabs-work-'))
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const account: FakeAccount = { signedIn: true, resolved: [], rejected: [] }
  ctx.provide('deepseekAccount', {
    async getState() {
      return { status: account.signedIn ? 'credential-stored' : 'signed-out', links: { usageUrl: `${api.origin}/usage`, topUpUrl: `${api.origin}/top_up` }, attempt: null }
    },
    async resolveToken(url: string) {
      account.resolved.push(url)
      return account.signedIn && new URL(url).origin === api.origin ? TOKEN : undefined
    },
    async rejectToken(token: string) {
      account.rejected.push(token)
    },
  } as never)
  const approval: FakeApproval = { outcome: 'allowed-once', asked: [] }
  if (options.approval !== false) {
    ctx.provide('approval', {
      async request(request: { toolName: string; reason?: string; displayReason?: { zh?: string } }) {
        approval.asked.push({ toolName: request.toolName, reason: request.reason, zh: request.displayReason?.zh })
        return approval.outcome
      },
    } as never)
  }
  const fiber = ctx.plugin(ElevenLabs, ElevenLabs.Config({ apiOrigin: api.origin, ...config }))
  await fiber
  const agent = await fakeAgent(ctx, 'owner')
  return {
    ctx, api, account, approval, work, agent,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
      await api.close()
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
  return executeToolFixture(composition.ctx, { signal: new AbortController().signal, callId: ToolCallId(`elevenlabs-${calls}`), name, arguments: args, agent: composition.agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
