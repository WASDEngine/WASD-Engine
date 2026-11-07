/**
 * A Host composition with the real Agent, tool, prompt, and subprocess services, a Session controller that resumes
 * Sessions as fake Agents, and the Godot plugin.
 */
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { AttachmentId, type ImageAttachmentRef, type ImageRequestTarget, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { vi } from 'vitest'
import GodotController, { type Config } from '../src/index.ts'
import { GodotRuntimeManager } from '../src/runtime.ts'
import { fakeAgent, type FakeAgent } from './agents.ts'
import { scratch, writeProject, type FakeGodotConfig, type Scratch } from './helpers.ts'

/** Model routes the fake model service reports. */
export const ROUTES = {
  vision: ['text', 'image'],
  blind: ['text'],
  unknown: undefined,
} as const

/** The Session controller's activation, which resumes a Session without a live Agent. */
export type ResolveAgent = Context['sessionController']['resolveAgent']

/** The composition's Session controller: by default `resolveAgent` answers the live Agent, else resumes the Session. */
export interface FakeSessionController {
  /** Sessions that the default `resolveAgent` resumed as new fake Agents, in order. */
  readonly resumed: SessionId[]
  /** The activation; a spec may replace it. */
  resolveAgent: ResolveAgent
}

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  readonly dir: Scratch
  readonly project: string
  readonly routes: Set<ConnectionFetchRoute>
  readonly saved: SaveImageAttachment[]
  readonly owner: FakeAgent
  readonly sessionController: FakeSessionController
  readonly godot: GodotController
  /** Dispose the Godot plugin's fiber. */
  unload(): Promise<void>
  cleanup(): Promise<void>
}

/** Options of {@link compose}. */
export interface CompositionOptions {
  readonly game?: FakeGodotConfig
  readonly config?: Partial<Config>
  readonly attachments?: boolean
  readonly connection?: boolean
  /** Compose no Session controller. */
  readonly sessionController?: boolean
  readonly model?: keyof typeof ROUTES | 'none'
  /** Write project.godot without application/config/name. */
  readonly unnamed?: boolean
}

/**
 * Compose the services and the Godot plugin around a fake Godot executable and an empty shipped-runtime folder.
 * @param options - fake behavior, plugin config, and optional services.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(options: CompositionOptions = {}): Promise<Composition> {
  const dir = await scratch('compose')
  // A source checkout may hold a runtime in the package's `libgodot` folder, which the plugin prefers to
  // `godotExecutable`; an empty folder in the scratch directory keeps every run on the fake executable.
  const shipped = vi.spyOn(GodotRuntimeManager.prototype, 'bundledDirectory').mockReturnValue(join(dir.root, 'bundled'))
  const project = await writeProject(join(dir.root, 'work', 'game'), options.game ?? { game: {} }, options.unnamed === true ? {} : undefined)
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, join(dir.root, 'work'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TypertRegistry)
  const routes = new Set<ConnectionFetchRoute>()
  if (options.connection !== false) {
    ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => { routes.add(route); return async () => { routes.delete(route) } } } } as never)
  }
  const saved: SaveImageAttachment[] = []
  if (options.attachments !== false) {
    ctx.provide('attachments', {
      async saveImages(inputs: readonly SaveImageAttachment[]): Promise<ImageAttachmentRef[]> {
        saved.push(...inputs)
        // Images whose bytes read BARE come back without a display name or original dimensions.
        return inputs.map((input) => {
          const bare = Buffer.from(input.data).toString('latin1') === 'BARE'
          return {
            attachmentId: AttachmentId(`a${saved.length}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 640, height: 360,
            ...bare || input.name === undefined ? {} : { name: input.name },
            ...bare ? {} : { originalDimensions: { width: 1280, height: 720 } },
          }
        })
      },
      async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget) {
        return { attachment: ref, data: new Uint8Array(1), mediaType: ref.mediaType, bytes: 1, width: target.width, height: target.height }
      },
    } as never)
  }
  const sessionController: FakeSessionController = {
    resumed: [],
    resolveAgent: async (sessionId) => {
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) return { agent: live }
      sessionController.resumed.push(sessionId)
      return { agent: (await fakeAgent(ctx, sessionId)).agent }
    },
  }
  if (options.sessionController !== false) ctx.provide('sessionController', sessionController as never)
  ctx.provide('llm', {
    async resolveModelInfo(_provider: string, model: string) {
      return { id: model, inputModalities: ROUTES[model as keyof typeof ROUTES] }
    },
    imageRequestTarget: (_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget => ({
      width: image.width / 2, height: image.height / 2, maxBytes: image.bytes,
    }),
  } as never)
  const fiber = ctx.plugin(GodotController, GodotController.Config({
    dataRoot: join(dir.root, 'data'),
    godotExecutable: dir.fakeGodot,
    importBeforeRun: false,
    startTimeoutMs: 10_000,
    requestTimeoutMs: 5000,
    stopGraceMs: 1000,
    ...options.config,
  }))
  await fiber
  const model = options.model ?? 'vision'
  const owner = await fakeAgent(ctx, 'owner', model === 'none' ? null : { provider: 'test', model })
  return {
    ctx, dir, project, routes, saved, owner, sessionController, godot: ctx.godot,
    unload: () => fiber.dispose(),
    async cleanup() {
      await ctx.fiber.dispose()
      shipped.mockRestore()
      await dir.cleanup()
    },
  }
}

let calls = 0

/**
 * Call a tool as the composition's Agent.
 * @param composition - composition.
 * @param name - tool name.
 * @param args - arguments.
 * @param signal - cancellation.
 * @returns the settled result.
 */
export function callTool(
  composition: Composition,
  name: string,
  args: Record<string, unknown> = {},
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(composition.ctx, { signal, callId: ToolCallId(`godot-${calls}`), name, arguments: args, agent: composition.owner.agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
