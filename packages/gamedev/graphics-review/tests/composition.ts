/**
 * A Host composition with the real Agent, model, tool, prompt, and executor services, a scripted `deepseek-account`
 * route that records each request and answers with a scripted reply, a fake account sign-in, a fake attachment store, a
 * fake add-on catalog, a fake game MCP server, and the graphics review plugin loaded with its validated configuration.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import LlmRuntime, {
  LlmAdapter, LlmError, ReasoningEffortId, ToolCallId,
  type BuiltinLlmFailureCode, type GenerateOptions, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo,
  type PreparedAdapterCall, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as GraphicsReview from '../src/index.ts'

/** The efforts of the account route's models, least first, with its default of `high`. */
export const ACCOUNT_REASONING: LlmModelReasoningInfo = {
  efforts: ['off', 'low', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })),
  defaultEffort: ReasoningEffortId('high'),
}

/** The scripted route: its listed models, what each takes, the requests it received, and its next reply. */
export interface FakeModels {
  /** Models the `deepseek-account` route lists, with whether each takes images. */
  models: { id: string; images: boolean }[]
  /** What listing the models throws; undefined, the listing answers. */
  listFailure: Error | undefined
  /** Reasoning efforts of every model; undefined, the models offer none. */
  reasoning: LlmModelReasoningInfo | undefined
  /** Failure codes the route refuses models with before any request, by model id. */
  refusals: Record<string, BuiltinLlmFailureCode>
  /** Requests received, in order. */
  readonly requests: GenerateOptions[]
  /** The next reply: chunks to stream, or an error the stream throws. */
  reply: StreamChunk[] | Error
  /** Images the attachment store saved. */
  readonly stored: { readonly name: string; readonly mediaType: string; readonly data: Buffer }[]
}

/** The fake account sign-in. */
export interface FakeAccount {
  signedIn: boolean
  /** Whether reading the sign-in fails. */
  unreadable: boolean
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly models: FakeModels
  readonly account: FakeAccount
  /** The providers the fake game MCP server offers. */
  readonly providers: readonly GameMcpProvider[]
  /** The Agent's working directory, the game project. */
  readonly work: string
  /** The calling Agent. */
  readonly agent: Agent
  /** Dispose the graphics review plugin's fiber. */
  unload(): Promise<void>
  cleanup(): Promise<void>
}

/** Which optional services the composition runs; each runs unless set to false. */
export interface ComposeOptions {
  readonly addons?: boolean
  readonly account?: boolean
  readonly attachments?: boolean
}

/**
 * The chunks of a reply that reasons, streams text, and stops.
 * @param text - the reply's text; empty, the reply holds only its reasoning.
 * @param kind - how it ends.
 * @returns the chunks.
 */
export function textReply(text: string, kind: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Looking at the image.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Looking at the image.' } },
    ...text === '' ? [] : [
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
    ] satisfies StreamChunk[],
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

/** The `deepseek-account` route as the review sees it: the listed models, their facts, and the scripted reply. */
class ScriptedRoute extends LlmAdapter {
  constructor(private readonly script: FakeModels) {
    super()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.script.listFailure !== undefined) return Promise.reject(this.script.listFailure)
    return Promise.resolve(this.script.models.map(model => ({ provider, id: model.id, name: model.id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const images = this.script.models.find(entry => entry.id === model)?.images === true
    const { reasoning } = this.script
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: images ? ['text', 'image'] : ['text'], ...reasoning === undefined ? {} : { reasoning },
    })
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const refusal = this.script.refusals[model]
    if (refusal !== undefined) throw new LlmError(`DeepSeek model "${model}" is held back for DeepSeek Harness 99.0.0`, refusal)
    return super.prepareCall(provider, model, signal)
  }

  async* stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.script.requests.push(request)
    const reply = this.script.reply
    if (reply instanceof Error) throw reply
    yield* reply
  }
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
 * @param options - which optional services run.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(config: Partial<GraphicsReview.Config> = {}, options: ComposeOptions = {}): Promise<Composition> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-work-'))
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  const models: FakeModels = {
    models: [{ id: 'reviewer', images: true }], listFailure: undefined, reasoning: ACCOUNT_REASONING, refusals: {}, requests: [],
    reply: textReply('**Verdict:** Ready, 8/10.'), stored: [],
  }
  ctx.llm.registerAdapter(['deepseek-account'], new ScriptedRoute(models))
  const account: FakeAccount = { signedIn: true, unreadable: false }
  if (options.account !== false) {
    ctx.provide('deepseekAccount', {
      getState: () => account.unreadable
        ? Promise.reject(new Error('the stored sign-in cannot be read'))
        : Promise.resolve({ status: account.signedIn ? 'credential-stored' : 'signed-out' }),
    } as never)
  }
  if (options.attachments !== false) {
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
  }
  if (options.addons !== false) {
    ctx.provide('gameAddons', {
      catalogEntries: () => [
        { id: 'sky3d', host: 'godot', useWhen: 'A 3D game needs a sky that changes with the time of day.' },
        { id: 'sapling-tree-gen', host: 'blender', useWhen: 'A level needs trees in several variations.' },
      ],
    } as never)
  }
  const providers: GameMcpProvider[] = []
  ctx.provide('gameMcp', {
    provide(provider: GameMcpProvider) {
      providers.push(provider)
      return () => { providers.splice(providers.indexOf(provider), 1) }
    },
  } as never)
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
    ctx, models, account, providers, work, agent,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
      await rm(work, { recursive: true, force: true })
    },
  }
}

let calls = 0

/**
 * Call the tool, as the composition's Agent unless `withAgent` is false.
 * @param composition - composition.
 * @param args - arguments.
 * @param withAgent - whether the call comes from the composition's Agent.
 * @returns the settled result.
 */
export function review(composition: Composition, args: Record<string, unknown>, withAgent = true): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, {
    signal: new AbortController().signal, callId: ToolCallId(`review-${calls}`), name: 'graphics_review', arguments: args,
    ...withAgent ? { agent: composition.agent } : {},
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
