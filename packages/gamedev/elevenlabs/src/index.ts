/**
 * ElevenLabs for the agent: the `elevenlabs_voices`, `elevenlabs_speech`, `elevenlabs_sound_effect`, and
 * `elevenlabs_music` tools find voices for characters and save speech, sound effects, and music into the game project,
 * and `elevenlabs_clone_voice` and `elevenlabs_delete_voice` keep up to three voices cloned from the user's
 * recordings, for every Session and, through WASD Engine's MCP server, for other agents on the computer. A clone in a
 * Session waits for the user to confirm consent in WASD Engine's approval prompt. The audio comes from the
 * WASD Engine API at `apiOrigin`, which makes it with ElevenLabs and charges it to the signed-in account's plan, so the
 * tools need a signed-in account and no ElevenLabs key. Activation makes no request.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-elevenlabs
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { AudioApi, type AudioAccess } from './api.ts'
import { consentPrompt } from './consent.ts'
import { elevenLabsMcpProvider } from './mcp.ts'
import { elevenLabsToolDefinitions, type CloneConsent, type ElevenLabsToolHost, type ElevenLabsToolSurface } from './tools.ts'

export type * from './types.ts'
export { AudioRequestError } from './api.ts'
export { CONSENT_STATEMENT, CONSENT_STATEMENT_VERSION } from './consent.ts'

/** Cordis plugin name. */
export const name = 'elevenlabs'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the ElevenLabs tools. */
export interface Config {
  /** Origin of the WASD Engine API, the inference origin that the account sign-in releases its token to. */
  apiOrigin: string
  /** Time limit of one `elevenlabs_voices` call. */
  searchTimeoutMs: number
  /** Time limit of one `elevenlabs_speech` or `elevenlabs_sound_effect` call. */
  generationTimeoutMs: number
  /** Time limit of one `elevenlabs_music` call. */
  musicTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  apiOrigin: z.string().pattern(/^https?:\/\/\S+$/u).default('https://api.wasdengine.com'),
  searchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  generationTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(210_000),
  musicTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(660_000),
})

/**
 * The Session's own surface: paths relative to its working directory, and consent confirmed by the user in WASD
 * Engine's approval prompt, which the Session's audit log records.
 * @param ctx - plugin context with the optional approval service.
 * @returns the surface.
 */
function sessionSurface(ctx: Context): ElevenLabsToolSurface {
  return {
    pathDescription: 'File to write, relative to the working directory, such as audio/voices/guard_halt.mp3.',
    samplesDescription: 'Recordings to clone, each relative to the working directory, such as recordings/rhea-1.wav.',
    consentChannel: 'app',
    consentInstruction: 'WASD Engine asks the user to confirm that before anything is sent',
    async confirmClone(exec, name, files): Promise<CloneConsent> {
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) return 'unavailable'
      const prompt = consentPrompt(name, files)
      const outcome = await approval.request({
        agent: exec.agent, toolName: 'elevenlabs_clone_voice', callId: exec.callId, reason: prompt.en, displayReason: prompt, signal: exec.signal,
      })
      switch (outcome) {
        case 'allowed-once': return 'confirmed'
        case 'rejected': return 'declined'
        case 'cancelled': return 'cancelled'
        case 'unavailable': return 'unavailable'
        default: throw new Error(`unexpected approval outcome ${JSON.stringify(outcome satisfies never)}`)
      }
    },
  }
}

/**
 * Register the ElevenLabs tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `apiOrigin` is not an HTTP or HTTPS origin.
 */
export function apply(ctx: Context, config: Config): void {
  const origin = URL.canParse(config.apiOrigin) ? new URL(config.apiOrigin) : undefined
  if (origin === undefined || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.apiOrigin.replace(/\/$/u, '')) {
    throw new Error(`ElevenLabs plugin: apiOrigin must be an HTTP or HTTPS origin without a path, got ${JSON.stringify(config.apiOrigin)}.`)
  }
  const api = new AudioApi({
    apiOrigin: origin.origin,
    fetch: (input, init) => fetch(input, init),
    async access(url): Promise<AudioAccess | undefined> {
      const account = ctx.get('deepseekAccount')
      const token = await account?.resolveToken(url)
      if (account === undefined || token === undefined || token === '') return undefined
      return { token, reject: () => account.rejectToken(token) }
    },
  })
  const host: ElevenLabsToolHost = {
    api,
    searchTimeoutMs: config.searchTimeoutMs,
    generationTimeoutMs: config.generationTimeoutMs,
    musicTimeoutMs: config.musicTimeoutMs,
    async file(requested, exec) {
      if (isAbsolute(requested)) return requested
      if (exec.agent === undefined) throw new Error('Pass path as an absolute path.')
      return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested)
    },
  }
  for (const definition of elevenLabsToolDefinitions(host, sessionSurface(ctx))) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(elevenLabsMcpProvider(host)), 'elevenlabs: game MCP tools')
  })
}
