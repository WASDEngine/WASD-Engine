/**
 * A Host composition with the real Agent, tool, prompt, and executor services, fake attachment and model services, a
 * game project folder of sound files, a fake WASD Engine window that answers measure requests, and the audio plugin
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
import * as GameAudio from '../src/index.ts'
import type { AudioMeasureEvent, AudioMeasurements, AudioMeasureResult, AudioReveal } from '../src/types.ts'
import { pcmWav } from './signals.ts'

/** Input modalities of the fake model routes. */
const ROUTES: Readonly<Record<string, readonly string[]>> = { vision: ['text', 'image'], blind: ['text'] }

/** A 1 × 1 PNG. */
export const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='

/** Files of the fake game project, by workspace path. */
export const PROJECT_FILES: Readonly<Record<string, string | Uint8Array>> = {
  'project.godot': '[application]\n',
  'audio/sfx/jump.wav': pcmWav({ sampleRate: 48_000, frames: 29_760 }),
  'audio/sfx/coin.wav': pcmWav({ sampleRate: 44_100, channels: 2, frames: 17_640 }),
  'audio/sfx/coin.wav.import': '[remap]\n\nimporter="wav"\ntype="AudioStreamWAV"\n\n[params]\n\nedit/loop_mode=2\nedit/loop_begin=441\nedit/loop_end=-1\nedit/trim=true\n',
  'audio/voice/hero_hello.wav': pcmWav({ sampleRate: 22_050, frames: 33_075 }),
  'audio/voice/hero_hello.wav.import': '[remap]\nimporter="wav"\n[params]\nedit/loop_mode=0\n',
  'audio/score.wav': pcmWav({ sampleRate: 8000, frames: 8000 * 45 }),
  'audio/notes.txt': 'not a sound',
  '.godot/imported/jump.wav-abc.sample': 'cache',
  'node_modules/pkg/ignored.wav': pcmWav({ frames: 10 }),
}

/** What the fake window answers: a result, or a function of the request. */
export type WindowAnswer = AudioMeasureResult | ((request: AudioMeasureEvent) => AudioMeasureResult | Promise<AudioMeasureResult>)

/** A running composition owned by one spec. */
export interface Composition {
  readonly ctx: Context
  /** The Agent's working directory: the game project folder. */
  readonly work: string
  /** Images the attachment store saved. */
  readonly saved: SaveImageAttachment[]
  /** Measure requests the fake window received. */
  readonly requests: AudioMeasureEvent[]
  /** Reveals the plugin emitted. */
  readonly reveals: AudioReveal[]
  /** The calling Agent, whose model accepts images. */
  readonly agent: Agent
  /** An Agent whose model accepts text only. */
  readonly blind: Agent
  /**
   * Open the fake window: it answers every measure request until closed.
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
export async function compose(config: Partial<GameAudio.Config> = {}): Promise<Composition> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-game-audio-work-'))
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
        attachmentId: AttachmentId(`a${String(saved.length - inputs.length + index + 1)}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      }))
    },
  } as never)
  ctx.provide('llm', {
    async resolveModelInfo(_provider: string, model: string) {
      return { id: model, inputModalities: ROUTES[model] }
    },
  } as never)
  const requests: AudioMeasureEvent[] = []
  const reveals: AudioReveal[] = []
  ctx.on('game-audio/reveal', (reveal) => { reveals.push(reveal) })
  await ctx.plugin(GameAudio, GameAudio.Config(config))
  const agent = await fakeAgent(ctx, 'owner', 'vision', work)
  const blind = await fakeAgent(ctx, 'blind', 'blind', work)
  return {
    ctx, work, saved, requests, reveals, agent, blind,
    openWindow(answer) {
      return ctx.on('game-audio/measure', async (request) => {
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
  return executeToolFixture(composition.ctx, { signal: new AbortController().signal, callId: ToolCallId(`audio-${String(calls)}`), name, arguments: args, agent })
}

/**
 * Join a result's text blocks.
 * @param result - tool result.
 * @returns the text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** A stereo jump sound as a window measures it: clipped, late, and clicking where it repeats. */
export const JUMP: AudioMeasurements = {
  sampleRate: 44_100,
  channels: 2,
  seconds: 0.4,
  start: 0,
  end: 0.4,
  peak: 1,
  rms: 0.2,
  loudness: -14.25,
  leadingSilence: 0.08,
  trailingSilence: 0.02,
  dominantFrequency: 440,
  spectralCentroid: 2310,
  channelLevels: [{ peak: 1, rms: 0.2, dcOffset: 0.02, clipped: 12 }, { peak: 0.5, rms: 0.1, dcOffset: 0, clipped: 0 }],
  seam: { jump: 0.42, step: 0.03, levelChange: -9.5 },
  stereo: { correlation: -0.6, balance: 6, identical: false },
}
