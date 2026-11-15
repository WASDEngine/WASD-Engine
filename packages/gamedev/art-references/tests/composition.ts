/**
 * A Host composition with the real Agent, tool, prompt, and executor services, a fake web search, a fake model that
 * takes images, a fake attachment store, and the art references plugin loaded with its validated configuration. The
 * plugin's own requests reach a {@link FakeWeb}, which each spec's mock of `src/transport.ts` hands the plugin through
 * {@link pluginWeb}: `.lan` hosts resolve to a private address, every other host to a public one.
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
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import * as ArtReferences from '../src/index.ts'
import { FakeWeb, pluginWeb } from './fixtures.ts'

/** The fake model and attachment store: whether the model takes images, and the images stored. */
export interface FakeModel {
  seesImages: boolean
  readonly stored: { readonly name: string; readonly mediaType: string; readonly bytes: number }[]
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly web: FakeWeb
  readonly model: FakeModel
  /** Queries the fake web search answered. */
  readonly searches: WebSearchRequest[]
  /** Results of the fake web search by query; a missing query fails its search. */
  readonly results: Map<string, WebSearchResult>
  /** The Agent's working directory, the game project. */
  readonly work: string
  /** The plugin's cache folder. */
  readonly dataRoot: string
  /** The calling Agent. */
  readonly agent: Agent
  /** Dispose the plugin's fiber. */
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
 * Compose the services, the fakes, and the plugin, and route the global `fetch` for the fake web's hosts to it.
 * @param config - plugin configuration beside the cache folder.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(config: Partial<ArtReferences.Config> = {}): Promise<Composition> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-art-references-work-'))
  const dataRoot = join(work, '.cache')
  const web = new FakeWeb()
  pluginWeb.current = web
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, work)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const searches: WebSearchRequest[] = []
  const results = new Map<string, WebSearchResult>()
  ctx.provide('web', {
    search(request: WebSearchRequest) {
      searches.push(request)
      const result = results.get(request.query)
      return result === undefined ? Promise.reject(new Error('Web search is not available: sign in to WASD Engine.')) : Promise.resolve(result)
    },
  } as never)
  const model: FakeModel = { seesImages: true, stored: [] }
  ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ inputModalities: model.seesImages ? ['text', 'image'] : ['text'] }) } as never)
  let attachments = 0
  ctx.provide('attachments', {
    saveImages(inputs: readonly { data: Buffer; mediaType: string; name: string }[]) {
      return Promise.resolve(inputs.map((input) => {
        model.stored.push({ name: input.name, mediaType: input.mediaType, bytes: input.data.byteLength })
        attachments += 1
        return { attachmentId: `attachment-${attachments}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
      }))
    },
  } as never)
  const fiber = ctx.plugin(ArtReferences, ArtReferences.Config({ dataRoot, ...config }))
  try {
    await fiber
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(work, { recursive: true, force: true })
    throw error
  }
  const agent = await fakeAgent(ctx, 'owner')
  return {
    ctx, web, model, searches, results, work, dataRoot, agent,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
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
 * @param signal - the call's cancellation, which a time limit or the user's Stop aborts.
 * @returns the settled result.
 */
export function callTool(
  composition: Composition,
  name: string,
  args: Record<string, unknown> = {},
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, { signal, callId: ToolCallId(`reference-${calls}`), name, arguments: args, agent: composition.agent })
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
 * The names of a result's image blocks.
 * @param result - tool result.
 * @returns each image's attachment name.
 */
export function imageNames(result: ToolExecutionResult): string[] {
  return result.content.flatMap(block => block.type === 'image' ? [block.attachment.name ?? ''] : [])
}
