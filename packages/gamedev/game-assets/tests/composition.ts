/**
 * A Host composition with the real Agent, tool, prompt, and executor services, fake attachment and model services,
 * a game project folder of art files, a fake WASD Engine window that answers render requests, and the asset plugin
 * loaded with its validated configuration.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as GameAssets from '../src/index.ts'
import type { AssetRenderEvent, AssetRenderResult, AssetReveal, ImageAssetDetails, ModelAssetDetails } from '../src/types.ts'

/** Input modalities of the fake model routes. */
const ROUTES: Readonly<Record<string, readonly string[]>> = { vision: ['text', 'image'], blind: ['text'] }

/** A 1 × 1 transparent PNG. */
export const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='

/** Files of the fake game project, by workspace path. */
export const PROJECT_FILES: Readonly<Record<string, string>> = {
  'project.godot': '[application]\n',
  'art/hero.png': 'png',
  'art/hero_walk_01.png': 'png',
  'art/ui/icon.svg': '<svg/>',
  'models/knight.blend': 'blend',
  'models/knight.glb': 'glb',
  'models/rock.fbx': 'fbx',
  '.godot/imported/hero.png-abc.ctex': 'cache',
  'node_modules/pkg/ignored.png': 'png',
  'notes.txt': 'text',
}

/** What the fake window answers: details and images, or a function of the request. */
export type WindowAnswer = AssetRenderResult | ((request: AssetRenderEvent) => AssetRenderResult | Promise<AssetRenderResult>)

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  /** The Agent's working directory: the game project folder. */
  readonly work: string
  /** Images the attachment store saved. */
  readonly saved: SaveImageAttachment[]
  /** Render requests the fake window received. */
  readonly requests: AssetRenderEvent[]
  /** Reveals the plugin emitted. */
  readonly reveals: AssetReveal[]
  /** The calling Agent, whose model accepts images. */
  readonly agent: Agent
  /** An Agent whose model accepts text only. */
  readonly blind: Agent
  /**
   * Open the fake window: it answers every render request until closed.
   * @param answer - the answer.
   * @returns closes the window.
   */
  openWindow(answer: WindowAnswer): () => void
  cleanup(): Promise<void>
}

/**
 * Register a fake Agent whose model route is `model`.
 * @param ctx - the composition's root context.
 * @param id - the Agent's Session id.
 * @param model - `vision` or `blind`.
 * @param cwd - the project folder in the Session's header; none by default.
 * @returns the registered Agent.
 */
export async function fakeAgent(ctx: Context, id: string, model: string, cwd?: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const route = { provider: 'test', model }
  const selection: Model = { current: () => route, select: () => {} }
  const session = cwd === undefined
    ? Session.create(sessionId)
    : Session.create(sessionId, [], { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false })
  const agent: Agent = {
    id: sessionId, options: {}, session, model: selection, inbox: createInboxStub(), status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

/**
 * Compose the services, the project folder, and the plugin.
 * @param config - plugin configuration.
 * @returns the composition; call cleanup in teardown.
 */
export async function compose(config: Partial<GameAssets.Config> = {}): Promise<Composition> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-game-assets-work-'))
  for (const [path, content] of Object.entries(PROJECT_FILES)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
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
      return inputs.map((input, index) => ({
        attachmentId: AttachmentId(`a${saved.length - inputs.length + index + 1}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      }))
    },
  } as never)
  ctx.provide('llm', {
    async resolveModelInfo(_provider: string, model: string) {
      return { id: model, inputModalities: ROUTES[model] }
    },
  } as never)
  const requests: AssetRenderEvent[] = []
  const reveals: AssetReveal[] = []
  ctx.on('game-assets/reveal', (reveal) => { reveals.push(reveal) })
  await ctx.plugin(GameAssets, GameAssets.Config(config))
  const agent = await fakeAgent(ctx, 'owner', 'vision', work)
  const blind = await fakeAgent(ctx, 'blind', 'blind', work)
  return {
    ctx, work, saved, requests, reveals, agent, blind,
    openWindow(answer) {
      return ctx.on('game-assets/render', async (request) => {
        requests.push(request)
        return typeof answer === 'function' ? await answer(request) : answer
      })
    },
    async cleanup() {
      await ctx.fiber.dispose()
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
  return executeToolFixture(composition.ctx, { signal: new AbortController().signal, callId: ToolCallId(`assets-${calls}`), name, arguments: args, agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** A model's details as a window measures them. */
export const KNIGHT: ModelAssetDetails = {
  kind: 'model',
  format: 'GLB',
  bytes: 2_516_582,
  min: [-0.46, 0, -0.2],
  max: [0.46, 1.84, 0.21],
  triangles: 12_340,
  vertices: 7021,
  meshes: 3,
  nodes: 41,
  materials: [
    { name: 'Body', type: 'MeshStandardMaterial', color: '#ffffff', metalness: 0, roughness: 0.8, maps: [{ slot: 'map', texture: 'body.png' }, { slot: 'normalMap', texture: 'body_n.png' }], transparent: false, doubleSided: true, vertexColors: false },
  ],
  materialCount: 1,
  textures: [{ name: 'body.png', width: 1024, height: 1024 }, { name: 'body_n.png', width: 1024, height: 1024 }],
  textureCount: 2,
  bones: [{ name: 'Hips' }, { name: 'Spine', parent: 0 }, { name: 'Head', parent: 1 }, { name: 'LeftLeg', parent: 0 }],
  boneCount: 4,
  animations: [{ name: 'Walk', seconds: 1.0667, tracks: 12, targets: ['Hips', 'Spine', 'LeftLeg'], targetCount: 3 }],
  morphTargets: [{ mesh: 'Face', targets: ['Blink', 'Smile'] }],
  missing: [],
}

/** An image's details as a window measures them. */
export const HERO: ImageAssetDetails = {
  kind: 'image',
  format: 'PNG',
  bytes: 3,
  width: 128,
  height: 32,
  transparency: 'cutout',
  colors: 24,
  animations: [
    { name: 'run', source: 'godot', definedIn: 'scenes/hero.tscn', frames: 4, fps: 8, seconds: 0.5, loop: true, frameWidth: 32, frameHeight: 32 },
  ],
}
