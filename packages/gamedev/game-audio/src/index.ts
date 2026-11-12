/**
 * Audio for the agent: the `audio_search` and `audio_review` tools list a game project's sound effects, dialogue, and
 * music and measure them as WASD Engine's Audio tab plays them, for every Session and, through WASD Engine's MCP
 * server, for other agents on the computer. `audio_review` asks the WASD Engine windows that may read the calling
 * Session to decode and measure the sound through the forwarded `game-audio/measure` request, which the Audio tab's
 * browser half answers with the measurements and a picture of the waveform and spectrogram; `show` emits
 * `game-audio/reveal`, which opens the sound in that Session's Audio tab. The `./audio` export holds the browser-safe
 * formats, header probe, measurements, and picture that the Audio tab and the SuperCollider tools share.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-game-audio
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { AudioProbe } from './audio/probe.ts'
import { AUDIO_ERROR } from './audio/errors.ts'
import { probeFile } from './files.ts'
import { audioMcpProvider } from './mcp.ts'
import { parseMeasureResult } from './result.ts'
import { audioToolDefinitions, NO_WINDOW_MESSAGE, type AudioToolHost, type AudioToolSurface } from './tools.ts'
import type { AudioMeasureResult } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'game-audio'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the audio tools. */
export interface Config {
  /** Time limit of one `audio_review` call, which waits for a window to read, decode, and measure the sound. */
  measureTimeoutMs: number
  /** Longest window one `audio_review` call measures, in seconds. */
  maxReviewSeconds: number
  /** Largest file a window reads to measure it, in bytes. */
  maxPreviewBytes: number
  /** Folders one project walk lists, the project folder included. */
  maxFolders: number
  /** Sounds one project walk collects. */
  maxSounds: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  measureTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  maxReviewSeconds: z.natural().min(1).default(300),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxFolders: z.natural().min(1).default(2000),
  maxSounds: z.natural().min(1).default(5000),
})

/**
 * The message of a call whose window did not answer in time.
 * @param timeoutMs - the time limit.
 * @returns the message for the agent.
 */
function windowTimeoutMessage(timeoutMs: number): string {
  return `No WASD Engine window measured the sound within ${String(Math.round(timeoutMs / 1000))} s. Ask the user to keep WASD Engine's window open, then call audio_review again.`
}

/**
 * An Error for a rejection reason, keeping the message and code of an error object that crossed the Remote.
 * @param reason - what the work or the signal rejected with.
 * @returns the error.
 */
function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const message: unknown = typeof reason === 'object' && reason !== null ? Reflect.get(reason, 'message') : undefined
  const code: unknown = typeof reason === 'object' && reason !== null ? Reflect.get(reason, 'code') : undefined
  return Object.assign(new Error(typeof message === 'string' ? message : String(reason)), typeof code === 'string' ? { code } : {})
}

/**
 * Wait for a promise unless a signal aborts first.
 * @param promise - the work, which keeps running when the wait ends early.
 * @param signal - ends the wait.
 * @returns the promise's value.
 * @throws the signal's reason when it aborts first, or the promise's failure.
 */
function settleBefore<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(asError(signal.reason)) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(asError(error))
    })
  })
}

/**
 * The picture surface of the Session's own tools: the picture becomes an attachment that the Session's model receives,
 * and a model that does not accept images gets the figures alone.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the surface.
 */
function sessionPictures(ctx: Context): AudioToolSurface {
  return {
    async seesImages(exec) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      const route = exec.agent?.model.current()
      if (attachments === undefined || llm === undefined || route === undefined) return false
      const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      return info.inputModalities?.includes('image') === true
    },
    async keep(_exec, picture, imageName) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return []
      const dot = imageName.lastIndexOf('.')
      const stored = await attachments.saveImages([{
        data: Buffer.from(picture.data, 'base64'),
        mediaType: picture.mediaType,
        name: `${dot > 0 ? imageName.slice(0, dot) : imageName}-waveform.png`,
      }])
      return [...stored]
    },
  }
}

/**
 * Register the audio tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const noWindow = (): Promise<AudioMeasureResult> => Promise.reject(new HarnessError(NO_WINDOW_MESSAGE, AUDIO_ERROR.window))
  // Probes by path, kept while the file's size and modification time stay the same; the plugin's scope owns them.
  const probes = new Map<string, { readonly key: string; readonly probe: AudioProbe | undefined }>()
  const host: AudioToolHost = {
    scanLimits: { maxFolders: config.maxFolders, maxSounds: config.maxSounds },
    measureTimeoutMs: config.measureTimeoutMs,
    maxReviewSeconds: config.maxReviewSeconds,
    maxPreviewBytes: config.maxPreviewBytes,
    async project(exec) {
      if (exec.agent === undefined) throw new HarnessError('The audio tools need a Session: they read its project folder.', AUDIO_ERROR.window)
      return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    },
    async probe(absolute, file) {
      const key = `${String(file.bytes)}:${String(file.modified)}`
      const known = probes.get(absolute)
      if (known?.key === key) return known.probe
      const probe = await probeFile(absolute, file.bytes)
      // The oldest entry leaves once the cache holds a walk's worth of sounds.
      if (!probes.has(absolute) && probes.size >= config.maxSounds) probes.delete(probes.keys().next().value ?? '')
      probes.set(absolute, { key, probe })
      return probe
    },
    async measure(agent, request, signal) {
      // A window that went away may never answer, and an MCP call has no tool time limit, so the plugin bounds the wait.
      using bounded = deadline(signal, config.measureTimeoutMs, AUDIO_ERROR.window)
      let answer: unknown
      try {
        const asked = ctx.waterfall(scopeTarget(agent, agent), 'game-audio/measure', { ...request, agent, signal: bounded.signal }, noWindow)
        answer = await settleBefore(asked, bounded.signal)
      } catch (error) {
        signal.throwIfAborted()
        if (timeoutOf(bounded.signal) !== undefined) {
          throw new HarnessError(windowTimeoutMessage(config.measureTimeoutMs), AUDIO_ERROR.window)
        }
        if (error instanceof HarnessError) throw error
        // A window's failure keeps its message and code for the agent.
        const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
        throw new HarnessError(error instanceof Error ? error.message : String(error), typeof code === 'string' ? code : AUDIO_ERROR.measure, { cause: error })
      }
      return parseMeasureResult(answer)
    },
    reveal(reveal) {
      ctx.emit('game-audio/reveal', reveal)
    },
  }
  ctx.effect(() => () => { probes.clear() }, 'game-audio: header probes')
  for (const definition of audioToolDefinitions(host, sessionPictures(ctx))) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(audioMcpProvider(host)), 'game-audio: game MCP tools')
  })
}
