/**
 * Art references for the agent: `reference_search` finds reference images on the web for art the agent is about to
 * make, through the web search of `ctx.web` and the pages it finds, and numbers them on one contact sheet;
 * `reference_save` saves the chosen ones with their sources into the game project's `references/` folder, which
 * Godot leaves out of the game. The `art-references` system prompt section tells the agent to gather references before
 * it makes any art and to ask the user which direction they want when the references disagree. Downloads and contact
 * sheets stay in the cache folder `dataRoot` for `cacheDays` days. Agents connected through WASD Engine's MCP server
 * get the same tools. Activation makes no request.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-art-references
 */
import { lookup } from 'node:dns/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-working-directory'
import { ReferenceCache, ReferenceFinder, type SearchWeb } from './finder.ts'
import { referenceMcpProvider } from './mcp.ts'
import type { ReferenceWeb } from './net.ts'
import { artReferencesPrompt } from './prompt.ts'
import { referenceToolDefinitions, type ReferenceToolHost, type ReferenceToolSurface } from './tools.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'art-references'

/** Services the plugin needs. */
export const inject = ['tools', 'web', 'workingDirectory']

/** Deployment configuration of the reference tools. */
export interface Config {
  /** The cache folder of downloaded images and contact sheets. */
  dataRoot: string
  /** `User-Agent` of every page and image request. */
  userAgent: string
  /** Days a downloaded image or a contact sheet stays in the cache folder. */
  cacheDays: number
  /** Time limit of one `reference_search` call. */
  searchTimeoutMs: number
  /** Time limit of one `reference_save` call. */
  saveTimeoutMs: number
  /** Most queries one search takes. */
  maxQueries: number
  /** Most pages one search reads by address. */
  maxPages: number
  /** Pages one query's web search returns. */
  resultsPerQuery: number
  /** Most images on one contact sheet. */
  maxCandidates: number
  /** Most images one save takes. */
  maxSaved: number
  /** Most images one save shows the caller's model. */
  maxModelImages: number
  /** Longest side in pixels of an image the caller's model receives. */
  modelImageEdge: number
  /** Time limit of reading one page. */
  pageTimeoutMs: number
  /** Time limit of downloading one image. */
  imageTimeoutMs: number
  /** Most bytes of a page read. */
  maxPageBytes: number
  /** Largest image downloaded, in bytes. */
  maxImageBytes: number
  /** Smallest longest side, in pixels, of an image worth studying. */
  minImageEdge: number
  /** Side in pixels of each image's square on the contact sheet. */
  sheetCell: number
  /** Most images in one row of the contact sheet. */
  sheetColumns: number
  /** Most frames on an animation's frames sheet; a longer animation is sampled evenly. */
  framesMaxFrames: number
  /** Longest side in pixels of an animation's frames sheet. */
  framesMaxEdge: number
  /** Pages read and images downloaded at once. */
  concurrency: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config> & Pick<Config, 'dataRoot'>, Config> = z.object({
  dataRoot: z.string().min(1).required(),
  userAgent: z.string().min(1).default('Mozilla/5.0 (compatible; WASDEngine-References/1.0; +https://wasdengine.com)'),
  cacheDays: z.natural().min(1).default(30),
  searchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(150_000),
  saveTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxQueries: z.natural().min(1).default(4),
  maxPages: z.natural().min(1).default(4),
  resultsPerQuery: z.natural().min(1).max(50).default(8),
  maxCandidates: z.natural().min(1).max(99).default(16),
  maxSaved: z.natural().min(1).default(8),
  maxModelImages: z.natural().default(4),
  modelImageEdge: z.natural().min(256).default(1024),
  pageTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  imageTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(20_000),
  maxPageBytes: z.natural().min(1024).default(2 * 1024 * 1024),
  maxImageBytes: z.natural().min(1024).default(16 * 1024 * 1024),
  minImageEdge: z.natural().min(1).default(24),
  sheetCell: z.natural().min(64).default(240),
  sheetColumns: z.natural().min(1).default(4),
  framesMaxFrames: z.natural().min(2).default(24),
  framesMaxEdge: z.natural().min(256).default(1024),
  concurrency: z.natural().min(1).default(6),
})

/**
 * The images of the Session's own tools: each image becomes an attachment that the Session's model receives, and a
 * model that does not accept images gets the text alone.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the image surface.
 */
function sessionImages(ctx: Context): ReferenceToolSurface {
  return {
    async seesImages(exec) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      const route = exec.agent?.model.current()
      if (attachments === undefined || llm === undefined || route === undefined) return false
      const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      return info.inputModalities?.includes('image') === true
    },
    async keep(_exec, images) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return []
      return [...await attachments.saveImages(images.map(image => ({ data: image.data, mediaType: image.mediaType, name: image.name })))]
    },
  }
}

/**
 * Register the reference tools and their system prompt section for this plugin's lifetime, and offer the tools to
 * WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry, the web service, and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `dataRoot` is not an absolute path.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.dataRoot)) throw new Error(`Art references plugin: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}.`)
  const web: ReferenceWeb = {
    userAgent: config.userAgent,
    lookup: async (hostname, signal) => {
      signal.throwIfAborted()
      return await lookup(hostname, { all: true, order: 'verbatim' })
    },
    fetch: (url, init) => fetch(url, init),
  }
  const search: SearchWeb = async (query, maxResults, signal) => {
    const result = await ctx.web.search({ query, maxResults }, signal)
    return result.sources.map(source => ({ url: source.url, ...source.title === undefined ? {} : { title: source.title } }))
  }
  const cache = new ReferenceCache(config.dataRoot, config.cacheDays * 24 * 60 * 60 * 1000)
  const finder = new ReferenceFinder(web, search, cache, {
    resultsPerQuery: config.resultsPerQuery,
    maxCandidates: config.maxCandidates,
    pageTimeoutMs: config.pageTimeoutMs,
    imageTimeoutMs: config.imageTimeoutMs,
    maxPageBytes: config.maxPageBytes,
    maxImageBytes: config.maxImageBytes,
    minImageEdge: config.minImageEdge,
    sheetCell: config.sheetCell,
    sheetColumns: config.sheetColumns,
    concurrency: config.concurrency,
  })
  const host: ReferenceToolHost = {
    finder,
    searchTimeoutMs: config.searchTimeoutMs,
    saveTimeoutMs: config.saveTimeoutMs,
    maxQueries: config.maxQueries,
    maxPages: config.maxPages,
    maxSaved: config.maxSaved,
    maxModelImages: config.maxModelImages,
    modelImageEdge: config.modelImageEdge,
    frames: { maxFrames: config.framesMaxFrames, maxEdge: config.framesMaxEdge },
    async project(exec) {
      if (exec.agent === undefined) throw new Error('reference_save runs only inside a Session.')
      return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    },
  }
  for (const definition of referenceToolDefinitions(host, sessionImages(ctx))) ctx.tools.register(definition)
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'art-references',
      order: inner.systemPrompt.getSectionOrder('TOOL_WEB_FETCH'),
      text: ({ scope, toolSet }) => ctx.tools.get('reference_search', scope, toolSet) === undefined ? '' : artReferencesPrompt({
        ask: ctx.tools.get('ask_user_question', scope, toolSet) !== undefined,
        imageGenerate: ctx.tools.get('image_generate', scope, toolSet) !== undefined,
      }),
    })
  })
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(referenceMcpProvider(host)), 'art-references: game MCP tools')
  })
  // Old downloads and contact sheets go when the plugin starts; a failed sweep leaves them for the next start.
  void cache.prune().catch((error: unknown) => {
    ctx.logger.warn(`art-references: could not prune the cache folder: ${error instanceof Error ? error.message : String(error)}`)
  })
}
