/**
 * A Host composition with the real Agent, tool, prompt, and executor services, fake attachment and model services,
 * a fake Poly Haven, and the Poly Haven plugin loaded with its validated configuration.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as PolyHaven from '../src/index.ts'
import { startFakePolyHaven, type FakePolyHaven } from './fixtures.ts'

/** Input modalities of the fake model routes. */
const ROUTES: Readonly<Record<string, readonly string[]>> = { vision: ['text', 'image'], blind: ['text'] }

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly fake: FakePolyHaven
  /** The Agent's working directory. */
  readonly work: string
  /** Images the attachment store saved. */
  readonly saved: SaveImageAttachment[]
  /** The calling Agent, whose model accepts images. */
  readonly agent: Agent
  /** An Agent whose model accepts text only. */
  readonly blind: Agent
  /** Dispose the Poly Haven plugin's fiber. */
  unload(): Promise<void>
  cleanup(): Promise<void>
}

async function fakeAgent(ctx: Context, id: string, model: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const route = { provider: 'test', model }
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
 * Compose the services, a fake Poly Haven, and the plugin.
 * @param config - plugin configuration beside the fake's API URL.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(config: Partial<PolyHaven.Config> = {}): Promise<Composition> {
  const fake = await startFakePolyHaven()
  const work = await mkdtemp(join(tmpdir(), 'dsh-polyhaven-work-'))
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const saved: SaveImageAttachment[] = []
  ctx.provide('attachments', {
    async saveImages(inputs: readonly SaveImageAttachment[]): Promise<ImageAttachmentRef[]> {
      saved.push(...inputs)
      return inputs.map(input => ({
        attachmentId: AttachmentId(`a${saved.length}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 512, height: 512,
        ...input.name === undefined ? {} : { name: input.name },
      }))
    },
  } as never)
  ctx.provide('llm', {
    async resolveModelInfo(_provider: string, model: string) {
      return { id: model, inputModalities: ROUTES[model] }
    },
  } as never)
  const fiber = ctx.plugin(PolyHaven, PolyHaven.Config({ apiUrl: fake.url, ...config }))
  await fiber
  const agent = await fakeAgent(ctx, 'owner', 'vision')
  const blind = await fakeAgent(ctx, 'blind', 'blind')
  return {
    ctx, fake, work, saved, agent, blind,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
      await fake.close()
      await rm(work, { recursive: true, force: true })
    },
  }
}

let calls = 0

/**
 * Call a tool as an Agent of the composition.
 * @param composition - composition.
 * @param name - tool name.
 * @param args - arguments.
 * @param agent - calling Agent; the composition's image-capable Agent by default.
 * @returns the settled result.
 */
export function callTool(
  composition: Composition,
  name: string,
  args: Record<string, unknown> = {},
  agent = composition.agent,
): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, { signal: new AbortController().signal, callId: ToolCallId(`polyhaven-${calls}`), name, arguments: args, agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
