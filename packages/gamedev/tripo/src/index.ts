/**
 * 3D models for the agent: the `tripo_*` tools make textured 3D models with Tripo's P2 model, give them new textures,
 * rig them, and animate them, and save each as a .glb file in the game project, for every Session and, through WASD
 * Engine's MCP server, for other agents on the computer. The tasks run through the WASD Engine API at `apiOrigin`, which
 * runs them at Tripo and charges them to the signed-in account's plan, so the tools need a signed-in account and no
 * Tripo key. Activation makes no request.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-tripo
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { accountAccess, gatewayOrigin, sessionFiles } from '@deepseek-ai/dsh-game-mcp/kit'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { TripoApi } from './api.ts'
import { tripoMcpProvider } from './mcp.ts'
import { tripoToolDefinitions, type TripoToolHost } from './tools.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'tripo'

/** Services the plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Deployment configuration of the Tripo tools. */
export interface Config {
  /** Origin of the WASD Engine API, the inference origin that the account sign-in releases its token to. */
  apiOrigin: string
  /** Time limit of one call, which waits for Tripo's task and saves its model; a textured P2 model takes about a minute. */
  taskTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  apiOrigin: z.string().pattern(/^https?:\/\/\S+$/u).default('https://api.wasdengine.com'),
  taskTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
})

/** The Session's own surface: paths relative to its working directory. */
const SESSION_SURFACE = {
  pathDescription: 'File to write, relative to the working directory, such as models/knight.glb.',
  imageDescription: 'An existing image, relative to the working directory, such as art/concepts/knight.png.',
}

/**
 * Register the Tripo tools for this plugin's lifetime, and offer them to WASD Engine's MCP server while it runs.
 * @param ctx - plugin context with the tool registry and the working directory service.
 * @param config - validated configuration.
 * @throws Error when `apiOrigin` is not an HTTP or HTTPS origin.
 */
export function apply(ctx: Context, config: Config): void {
  const apiOrigin = gatewayOrigin(config.apiOrigin, 'Tripo')
  const api = new TripoApi({
    apiOrigin,
    fetch: (input, init) => fetch(input, init),
    access: accountAccess(ctx),
  })
  const host: TripoToolHost = {
    api,
    taskTimeoutMs: config.taskTimeoutMs,
    file: sessionFiles(ctx),
  }
  for (const definition of tripoToolDefinitions(host, SESSION_SURFACE)) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tools.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(tripoMcpProvider(host)), 'tripo: game MCP tools')
  })
}
