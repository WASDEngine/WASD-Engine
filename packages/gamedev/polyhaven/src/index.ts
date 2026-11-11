/**
 * Poly Haven for the agent: the `polyhaven_search`, `polyhaven_asset`, and `polyhaven_download` tools find CC0 HDRI
 * skies, tileable PBR textures, and 3D models in Poly Haven's library and save them into the game project, for every
 * Session and, through WASD Engine's MCP server, for other agents on the computer. Activation makes no request; the
 * first search reads the asset list, which then stays in memory for `catalogMaxAgeMs`.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-polyhaven
 */
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { PolyHavenApi } from './api.ts'
import { polyHavenMcpProvider } from './mcp.ts'
import { polyHavenToolDefinitions, type PolyHavenToolHost, type PolyHavenToolSurface } from './tools.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'polyhaven'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the Poly Haven tools. */
export interface Config {
  /** Base URL of the Poly Haven API. */
  apiUrl: string
  /** `User-Agent` of every request; the API terms require it to name the software. */
  userAgent: string
  /** Time limit of one `polyhaven_search` or `polyhaven_asset` call. */
  requestTimeoutMs: number
  /** Time limit of one `polyhaven_download` call. */
  downloadTimeoutMs: number
  /** Largest total size of the files of one `polyhaven_download` call, in bytes. */
  maxDownloadBytes: number
  /** How long the asset list stays in memory before a search reads it again; 0 reads it for every search. */
  catalogMaxAgeMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  apiUrl: z.string().pattern(/^https?:\/\/\S+$/u).default('https://api.polyhaven.com'),
  userAgent: z.string().min(1).default('WASD Engine'),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  downloadTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
  maxDownloadBytes: z.natural().min(1).default(1024 * 1024 * 1024),
  catalogMaxAgeMs: z.natural().default(12 * 60 * 60 * 1000),
})

/**
 * The previews of the Session's own tools: each image becomes an attachment that the Session's model receives, and
 * a model that does not accept images gets none.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the preview surface.
 */
function sessionPreviews(ctx: Context): PolyHavenToolSurface {
  return {
    async preview(exec, load, imageName) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      const route = exec.agent?.model.current()
      if (attachments === undefined || llm === undefined || route === undefined) return undefined
      const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      if (info.inputModalities?.includes('image') !== true) return undefined
      const image = await load(exec.signal)
      const [stored] = await attachments.saveImages([{ data: image.data, mediaType: image.mediaType, name: imageName }])
      return stored
    },
  }
}

/**
 * Register the Poly Haven tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `apiUrl` is not a URL.
 */
export function apply(ctx: Context, config: Config): void {
  if (!URL.canParse(config.apiUrl)) throw new Error(`Poly Haven plugin: apiUrl must be an HTTP or HTTPS URL, got ${JSON.stringify(config.apiUrl)}.`)
  const api = new PolyHavenApi({
    apiUrl: config.apiUrl,
    userAgent: config.userAgent,
    catalogMaxAgeMs: config.catalogMaxAgeMs,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  })
  const host: PolyHavenToolHost = {
    api,
    maxDownloadBytes: config.maxDownloadBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    downloadTimeoutMs: config.downloadTimeoutMs,
    async directory(requested, id, exec) {
      if (requested !== undefined && isAbsolute(requested)) return requested
      if (exec.agent === undefined) throw new Error('Pass directory as an absolute path.')
      return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested ?? join('assets', 'polyhaven', id))
    },
  }
  for (const definition of polyHavenToolDefinitions(host, sessionPreviews(ctx))) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(polyHavenMcpProvider(host)), 'polyhaven: game MCP tools')
  })
}
