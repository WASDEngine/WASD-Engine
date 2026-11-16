/**
 * Graphics review for the agent: `graphics_review` sends an image of the game's graphics, which the agent captured or
 * made, to a reviewer that critiques it as a game art director and technical artist would and names the WASD Engine
 * tools and add-ons that would make it look better. The reviewer is the model route of the WASD Engine account,
 * `provider`, with the reviewer's instructions, so the account pays for each review as for any model call; the
 * model-facing texts call it a specialized graphics expert reviewer model and mention no cost. The Session's agent
 * gets the tool and a `graphics-review` system prompt section that asks for a review after all graphics work; agents
 * connected through WASD Engine's MCP server get the same tool under the provider `graphics`. With the `gameAddons`
 * service, the reviewer may name every catalog add-on; with the `deepseekAccount` service, a route that lists no model
 * while no one is signed in asks for a sign-in.
 * @module @deepseek-ai/dsh-graphics-review
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-game-addons'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { graphicsReviewMcpProvider } from './mcp.ts'
import { PROMPT_SECTION, sessionPrompt, TOOL_NAME, type ReviewAddon } from './prompt.ts'
import { reviewImage, type ReviewSettings } from './review.ts'
import { graphicsReviewToolDefinition, SESSION_WORDING, type GraphicsReviewHost } from './tools.ts'

export const name = 'graphics-review'

export const inject = ['tools', 'workingDirectory']

/** Configuration of the `graphics-review` row; every field has a default. */
export interface Config {
  /** Provider route of the WASD Engine account, whose model reviews each image. */
  provider: string
  /** Model of that route; empty, the first listed model that takes images. */
  model: string
  /** Most tokens of one review, its reasoning included. */
  maxTokens: number
  /** Reasoning effort of each review when the model offers it; otherwise the model's least effort. */
  reasoningEffort: string
  /** Time limit of one `graphics_review` call. */
  timeoutMs: number
  /** Largest image file read, in bytes. */
  maxImageBytes: number
  /** Longest side in pixels of the image sent. */
  maxImageEdge: number
  /** Most pixels of the image sent. */
  maxImagePixels: number
  /**
   * Fewest pixels of the image sent: a smaller image, such as pixel art, is enlarged by whole pixels toward them, since
   * the route scales an image below them up by a fraction, which blurs its pixels. The default is the account route's
   * 544×544.
   */
  minImagePixels: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  provider: z.string().min(1).default('deepseek-account'),
  model: z.string().default(''),
  maxTokens: z.natural().min(256).default(16_384),
  reasoningEffort: z.string().min(1).default('low'),
  timeoutMs: z.natural().min(1000).default(240_000),
  maxImageBytes: z.natural().min(1).default(50 * 1024 * 1024),
  maxImageEdge: z.natural().min(64).default(1568),
  maxImagePixels: z.natural().min(4096).default(1_150_000),
  minImagePixels: z.natural().default(544 * 544),
})

/**
 * The catalog add-ons the reviewer may name.
 * @param ctx - context with the optional `gameAddons` service.
 * @returns the add-ons in catalog order; none without the service.
 */
function catalogAddons(ctx: Context): readonly ReviewAddon[] {
  const addons = ctx.get('gameAddons')
  if (addons === undefined) return []
  return addons.catalogEntries().map(entry => ({ id: entry.id, host: entry.host, useWhen: entry.useWhen }))
}

/**
 * Register the tool and its system prompt section for this plugin's lifetime, and offer the tool to WASD Engine's MCP
 * server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const settings: ReviewSettings = {
    provider: config.provider,
    ...config.model === '' ? {} : { model: config.model },
    maxTokens: config.maxTokens,
    reasoningEffort: config.reasoningEffort,
  }
  const base: Omit<GraphicsReviewHost, 'image'> = {
    limits: {
      maxBytes: config.maxImageBytes, maxEdge: config.maxImageEdge, maxPixels: config.maxImagePixels, minPixels: config.minImagePixels,
    },
    timeoutMs: config.timeoutMs,
    review: (request, signal) => reviewImage(ctx, settings, { ...request, addons: catalogAddons(ctx) }, signal),
  }
  ctx.tools.register(graphicsReviewToolDefinition({
    ...base,
    async image(requested, exec) {
      if (isAbsolute(requested)) return requested
      if (exec.agent === undefined) throw new Error('Pass image as an absolute path.')
      return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested)
    },
  }, SESSION_WORDING))
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: PROMPT_SECTION,
      // After the art references section, which also speaks of making art.
      order: inner.systemPrompt.getSectionOrder('TOOL_WEB_FETCH'),
      text: ({ scope, toolSet }) => ctx.tools.get(TOOL_NAME, scope, toolSet) === undefined
        ? ''
        : sessionPrompt(ctx.tools.get('godot_screenshot', scope, toolSet) !== undefined),
    })
  })
  // Agents connected through WASD Engine's MCP server get the same tool.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(graphicsReviewMcpProvider(base)), 'graphics-review: game MCP tools')
  })
}
