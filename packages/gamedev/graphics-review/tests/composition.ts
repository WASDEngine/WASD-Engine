/**
 * A Host composition with the real Agent, tool, prompt, and executor services, a fake model service whose
 * `deepseek-account` route records each request and answers with a scripted reply, a fake attachment store, a fake
 * add-on catalog, and the graphics review plugin loaded with its validated configuration.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as GraphicsReview from '../src/index.ts'

/** The fake model service: its listed models, what each takes, the requests it received, and its next reply. */
export interface FakeModels {
  /** Models of the `deepseek-account` route, with whether each takes images. */
  models: { id: string; images: boolean }[]
  /** Requests received, in order. */
  readonly requests: GenerateOptions[]
  /** The next reply: chunks to stream, or an error the stream throws. */
  reply: StreamChunk[] | Error
  /** Images the attachment store saved. */
  readonly stored: { readonly name: string; readonly mediaType: string; readonly data: Buffer }[]
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly models: FakeModels
  /** The Agent's working directory, the game project. */
  readonly work: string
  /** The calling Agent. */
  readonly agent: Agent
  cleanup(): Promise<void>
}

/**
 * The chunks of a reply that streams text and stops.
 * @param text - the reply's text.
 * @param kind - how it ends.
 * @returns the chunks.
 */
export function textReply(text: string, kind: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Looking at the image.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Looking at the image.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind } },
  ]
}

/**
 * The chunks of a reply that fails.
 * @param code - the failure code.
 * @param message - the failure message.
 * @returns the chunks.
 */
export function failedReply(code: string, message: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }]
}

async function fakeAgent(ctx: Context, id: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const route = { provider: 'other', model: 'other' }
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
 * Compose the services, the fakes, and the plugin.
 * @param config - plugin configuration.
 * @param options - whether the add-on catalog service runs.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(config: Partial<GraphicsReview.Config> = {}, options: { addons?: boolean } = {}): Promise<Composition> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-work-'))
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const models: FakeModels = { models: [{ id: 'reviewer', images: true }], requests: [], reply: textReply('**Verdict:** Ready, 8/10.'), stored: [] }
  ctx.provide('llm', {
    listModels: (provider: string) => provider === 'deepseek-account'
      ? Promise.resolve(models.models.map(model => ({ provider, id: model.id, name: model.id })))
      : Promise.reject(new Error(`No provider named ${provider}`)),
    resolveModelInfo: (_provider: string, model: string) => Promise.resolve({
      inputModalities: models.models.find(entry => entry.id === model)?.images === true ? ['text', 'image'] : ['text'],
    }),
    async* stream(request: GenerateOptions) {
      models.requests.push(request)
      const reply = models.reply
      if (reply instanceof Error) throw reply
      yield* reply
    },
  } as never)
  let attachments = 0
  ctx.provide('attachments', {
    saveImages(inputs: readonly { data: Buffer; mediaType: string; name: string }[]) {
      return Promise.resolve(inputs.map((input) => {
        models.stored.push({ name: input.name, mediaType: input.mediaType, data: input.data })
        attachments += 1
        return { attachmentId: `attachment-${attachments}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
      }))
    },
  } as never)
  if (options.addons !== false) {
    ctx.provide('gameAddons', {
      catalogEntries: () => [
        { id: 'sky3d', host: 'godot', useWhen: 'A 3D game needs a sky that changes with the time of day.' },
        { id: 'sapling-tree-gen', host: 'blender', useWhen: 'A level needs trees in several variations.' },
      ],
    } as never)
  }
  const fiber = ctx.plugin(GraphicsReview, GraphicsReview.Config(config))
  try {
    await fiber
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(work, { recursive: true, force: true })
    throw error
  }
  const agent = await fakeAgent(ctx, 'owner')
  return {
    ctx, models, work, agent,
    async cleanup() {
      await ctx.fiber.dispose()
      await rm(work, { recursive: true, force: true })
    },
  }
}

let calls = 0

/**
 * Call the tool as the composition's Agent.
 * @param composition - composition.
 * @param args - arguments.
 * @returns the settled result.
 */
export function review(composition: Composition, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, {
    signal: new AbortController().signal, callId: ToolCallId(`review-${calls}`), name: 'graphics_review', arguments: args, agent: composition.agent,
  })
}

/**
 * The text of a result.
 * @param result - the result.
 * @returns its text blocks, joined.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
