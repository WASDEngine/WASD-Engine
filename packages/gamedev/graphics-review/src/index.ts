/**
 * Graphics review for the agent: `graphics_review` sends an image of the game's graphics, which the agent captured or
 * made, to a reviewer that critiques it as a game art director and technical artist would and names the WASD Engine
 * tools and add-ons that would make it look better. The reviewer is the model route of the WASD Engine account,
 * `provider`, with the reviewer's instructions, so the account pays for each review as for any model call; the
 * model-facing texts call it a specialized graphics expert reviewer model and mention no cost. The Session's agent
 * gets the tool and a `graphics-review` system prompt section that asks for two to four reviews of each piece of
 * graphics it makes itself and none of the assets it downloads; agents connected through WASD Engine's MCP server get
 * the same tool under the provider `graphics`. The reviewer names only the WASD Engine tools that the calling agent
 * has. With the `gameAddons` service, the reviewer may name every catalog add-on that the user has not turned off, while
 * the agent has `game_addons`, and Blender's add-ons while it also has the Blender tools; with the `deepseekAccount`
 * service, a route that lists no model while no one is signed in asks for a sign-in.
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
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
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

/** Catalog categories whose add-ons change nothing an image shows, which the reviewer does not read. */
const UNSEEN_CATEGORIES: ReadonlySet<string> = new Set(['gameplay', 'kits', 'testing'])

/**
 * The catalog add-ons the reviewer may name: those that agents may use when the review starts and that change what a
 * game looks like, each with its cue, so the reviewer's prompt stays short as the catalog grows.
 * @param ctx - context with the optional `gameAddons` service.
 * @returns the add-ons in catalog order; none without the service.
 */
function catalogAddons(ctx: Context): readonly ReviewAddon[] {
  const addons = ctx.get('gameAddons')
  if (addons === undefined) return []
  return addons.allowedEntries()
    .filter(entry => !UNSEEN_CATEGORIES.has(entry.category))
    .map(entry => ({ id: entry.id, host: entry.host, cue: entry.cue }))
}

/**
 * The names of the tools the calling agent has, which the reviewer may name: as the call's agent and step see them, or,
 * for a connected agent's call, which has neither, as WASD Engine registers them, since the tools that connected agents
 * get are those of the same plugins.
 * @param ctx - context with the tool registry.
 * @param exec - the call's execution.
 * @returns the tools' names.
 */
function agentTools(ctx: Context, exec: ToolRunContext): string[] {
  return ctx.tools.definitions(exec.agent, exec.toolSet).map(definition => definition.name)
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
    review: (request, exec) => reviewImage(ctx, settings, {
      ...request, addons: catalogAddons(ctx), tools: agentTools(ctx, exec),
    }, exec.signal),
  }
  ctx.tools.register(graphicsReviewToolDefinition({
    ...base,
    async image(requested, exec) {
      // A Windows network path (`\\host\share`, `//host/share`) would connect to another computer with the user's credentials.
      if (/^[\\/]{2}/u.test(requested)) throw new Error(`${requested} is a network path; pass an image on this computer.`)
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
