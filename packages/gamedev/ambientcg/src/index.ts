/**
 * ambientCG for the agent: the `ambientcg_search`, `ambientcg_asset`, and `ambientcg_download` tools find CC0 PBR
 * materials, decals, atlases, and HDRI skies in ambientCG's library and save their texture maps into the game project,
 * for every Session and, through WASD Engine's MCP server, for other agents on the computer. Activation makes no
 * request; a search reads the page it lists, which then stays in memory for `catalogMaxAgeMs`.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-ambientcg
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-mcp'
import { downloadFolders, sessionPreviews } from '@deepseek-ai/dsh-game-mcp/kit'
import type {} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { AmbientCgApi } from './api.ts'
import { ambientCgMcpProvider } from './mcp.ts'
import { ambientCgToolDefinitions, type AmbientCgToolHost } from './tools.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'ambientcg'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/* jscpd:ignore-start -- the settings mirror the Poly Haven plugin's by design, and the configuration catalog reads each
 * plugin's settings from its own Config. */
/** Deployment configuration of the ambientCG tools. */
export interface Config {
  /** Base URL of the ambientCG API. */
  apiUrl: string
  /** `User-Agent` of every request, which names the software to ambientCG. */
  userAgent: string
  /** Time limit of one `ambientcg_search` or `ambientcg_asset` call. */
  requestTimeoutMs: number
  /** Time limit of one `ambientcg_download` call. */
  downloadTimeoutMs: number
  /** Largest size of the archive of one `ambientcg_download` call, and of the pictures it unpacks, in bytes. */
  maxDownloadBytes: number
  /** How long search pages, assets, and the categories stay in memory before they are read again; 0 reads them every time. */
  catalogMaxAgeMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  apiUrl: z.string().pattern(/^https?:\/\/\S+$/u).default('https://ambientcg.com/api/v3'),
  userAgent: z.string().min(1).default('WASD Engine'),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  downloadTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
  maxDownloadBytes: z.natural().min(1).default(1024 * 1024 * 1024),
  catalogMaxAgeMs: z.natural().default(12 * 60 * 60 * 1000),
})
/* jscpd:ignore-end */

/**
 * Register the ambientCG tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `apiUrl` is not a URL.
 */
export function apply(ctx: Context, config: Config): void {
  if (!URL.canParse(config.apiUrl)) throw new Error(`ambientCG plugin: apiUrl must be an HTTP or HTTPS URL, got ${JSON.stringify(config.apiUrl)}.`)
  const api = new AmbientCgApi({
    apiUrl: config.apiUrl,
    userAgent: config.userAgent,
    catalogMaxAgeMs: config.catalogMaxAgeMs,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  })
  const folder = downloadFolders(ctx)
  const host: AmbientCgToolHost = {
    api,
    maxDownloadBytes: config.maxDownloadBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    downloadTimeoutMs: config.downloadTimeoutMs,
    archives: new Map(),
    directory: (requested, id, exec) => folder(requested, join('assets', 'ambientcg', id), exec),
  }
  // Each preview becomes an attachment that the Session's model receives; a model that does not accept images gets none.
  for (const definition of ambientCgToolDefinitions(host, sessionPreviews(ctx, () => ctx.get('attachments')))) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(ambientCgMcpProvider(host)), 'ambientcg: game MCP tools')
  })
}
