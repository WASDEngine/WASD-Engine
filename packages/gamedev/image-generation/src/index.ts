/**
 * Image generation for the agent: the `image_generate` tool makes game art, UI pieces, and textures with Google's Nano
 * Banana 2.1 and saves them into the game project, for every Session and, through WASD Engine's MCP server, for other
 * agents on the computer. The images come from the WASD Engine API at `apiOrigin`, which makes them with Google's
 * Gemini API and charges them to the signed-in account's plan, so the tool needs a signed-in account and no Google
 * key. Activation makes no request.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-image-generation
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { ImageApi, type ImageAccess } from './api.ts'
import { imageMcpProvider } from './mcp.ts'
import { imageToolDefinitions, type ImageToolHost } from './tools.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'image-generation'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the image tool. */
export interface Config {
  /** Origin of the WASD Engine API, the inference origin that the account sign-in releases its token to. */
  apiOrigin: string
  /** Time limit of one `image_generate` call; the API waits up to 300 s for Google. */
  generationTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  apiOrigin: z.string().pattern(/^https?:\/\/\S+$/u).default('https://api.wasdengine.com'),
  generationTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(330_000),
})

/** The Session's own surface: paths relative to its working directory. */
const SESSION_SURFACE = {
  pathDescription: 'File to write, relative to the working directory, such as art/items/potion.png.',
  imagesDescription: 'Existing images, each relative to the working directory, such as art/items/potion.png.',
}

/**
 * Register the image tool for this plugin's lifetime, and offer it to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `apiOrigin` is not an HTTP or HTTPS origin.
 */
export function apply(ctx: Context, config: Config): void {
  const origin = URL.canParse(config.apiOrigin) ? new URL(config.apiOrigin) : undefined
  if (origin === undefined || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.apiOrigin.replace(/\/$/u, '')) {
    throw new Error(`Image generation plugin: apiOrigin must be an HTTP or HTTPS origin without a path, got ${JSON.stringify(config.apiOrigin)}.`)
  }
  const api = new ImageApi({
    apiOrigin: origin.origin,
    fetch: (input, init) => fetch(input, init),
    async access(url): Promise<ImageAccess | undefined> {
      const account = ctx.get('deepseekAccount')
      const token = await account?.resolveToken(url)
      if (account === undefined || token === undefined || token === '') return undefined
      return { token, reject: () => account.rejectToken(token) }
    },
  })
  const host: ImageToolHost = {
    api,
    generationTimeoutMs: config.generationTimeoutMs,
    async file(requested, exec) {
      if (isAbsolute(requested)) return requested
      if (exec.agent === undefined) throw new Error('Pass path as an absolute path.')
      return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested)
    },
  }
  for (const definition of imageToolDefinitions(host, SESSION_SURFACE)) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tool.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(imageMcpProvider(host)), 'image-generation: game MCP tools')
  })
}
