/**
 * Assets for the agent: the `asset_search` and `asset_view` tools find a game project's 2D art and 3D models and show
 * them as WASD Engine's Assets tab draws them, for every Session and, through WASD Engine's MCP server, for other
 * agents on the computer. `asset_view` asks the WASD Engine windows that may read the calling Session to draw the
 * asset through the forwarded `game-assets/render` request, which the Assets tab's browser half answers with the
 * asset's details and images; `show` emits `game-assets/reveal`, which opens the asset in that Session's Assets tab.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-game-assets
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { assetMcpProvider } from './mcp.ts'
import { parseRenderResult } from './result.ts'
import { ASSET_ERROR, assetToolDefinitions, MIN_IMAGE_EDGE, NO_WINDOW_MESSAGE, type AssetToolHost, type AssetToolSurface } from './tools.ts'
import type { AssetRenderResult } from './types.ts'

export type * from './types.ts'
export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from './formats.ts'

/** Cordis plugin name. */
export const name = 'game-assets'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the asset tools. */
export interface Config {
  /** Time limit of one `asset_view` call, which waits for a window to read and draw the asset. */
  renderTimeoutMs: number
  /** Longest edge in pixels of the image `asset_view` returns when the call names no size. */
  imageEdge: number
  /** Largest longest edge in pixels a call may ask for. */
  maxImageEdge: number
  /** Largest area in pixels of one returned image. */
  maxImagePixels: number
  /** Largest file a window reads to draw it, in bytes. */
  maxPreviewBytes: number
  /** Folders one project walk lists, the project folder included. */
  maxFolders: number
  /** Assets one project walk collects. */
  maxAssets: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  renderTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  imageEdge: z.natural().min(MIN_IMAGE_EDGE).default(1024),
  maxImageEdge: z.natural().min(MIN_IMAGE_EDGE).default(1568),
  maxImagePixels: z.natural().min(MIN_IMAGE_EDGE * MIN_IMAGE_EDGE).default(1_150_000),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxFolders: z.natural().min(1).default(2000),
  maxAssets: z.natural().min(1).default(5000),
})

/**
 * The images of the Session's own tools: each drawn image becomes an attachment that the Session's model receives,
 * and a model that does not accept images gets the details alone.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the image surface.
 */
function sessionImages(ctx: Context): AssetToolSurface {
  return {
    async seesImages(exec) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      const route = exec.agent?.model.current()
      if (attachments === undefined || llm === undefined || route === undefined) return false
      const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      return info.inputModalities?.includes('image') === true
    },
    async keep(_exec, images, imageName) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return []
      const stem = imageName.slice(0, imageName.lastIndexOf('.') > 0 ? imageName.lastIndexOf('.') : imageName.length)
      const stored = await attachments.saveImages(images.map((image, index) => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mediaType,
        name: `${stem}${images.length === 1 ? '' : `-${String(index + 1)}`}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`,
      })))
      return [...stored]
    },
  }
}

/**
 * Register the asset tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `imageEdge` exceeds `maxImageEdge`.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.imageEdge > config.maxImageEdge) throw new Error(`Game assets plugin: imageEdge (${config.imageEdge}) must not exceed maxImageEdge (${config.maxImageEdge}).`)
  const noWindow = (): Promise<AssetRenderResult> => Promise.reject(new HarnessError(NO_WINDOW_MESSAGE, ASSET_ERROR.window))
  const host: AssetToolHost = {
    scanLimits: { maxFolders: config.maxFolders, maxAssets: config.maxAssets },
    renderTimeoutMs: config.renderTimeoutMs,
    defaultImageEdge: config.imageEdge,
    maxImageEdge: config.maxImageEdge,
    maxImagePixels: config.maxImagePixels,
    maxPreviewBytes: config.maxPreviewBytes,
    async project(exec) {
      if (exec.agent === undefined) throw new HarnessError('The asset tools need a Session: they read its project folder.', ASSET_ERROR.window)
      return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    },
    async render(agent, request, signal) {
      // The gateway keeps a request that no window answers for a window that connects later, so a call made while no
      // window is connected would wait out its time limit; it fails at once instead.
      if (ctx.get('typertGateway')?.hasLiveClient() === false) throw new HarnessError(NO_WINDOW_MESSAGE, ASSET_ERROR.window)
      let answer: unknown
      try {
        answer = await ctx.waterfall(scopeTarget(agent, agent), 'game-assets/render', { ...request, agent, signal }, noWindow)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof HarnessError) throw error
        // A window's failure keeps its message and code for the agent.
        const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
        throw new HarnessError(error instanceof Error ? error.message : String(error), typeof code === 'string' ? code : ASSET_ERROR.draw, { cause: error })
      }
      return parseRenderResult(answer)
    },
    revealTarget(agent) {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return agent
      try {
        return subagents.rootOf(agent)
      } catch (error) {
        // An independently resumed child has no live tree root; its own Session shows the asset.
        if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') return agent
        throw error
      }
    },
    reveal(reveal) {
      ctx.emit('game-assets/reveal', reveal)
    },
  }
  for (const definition of assetToolDefinitions(host, sessionImages(ctx))) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(assetMcpProvider(host)), 'game-assets: game MCP tools')
  })
}
