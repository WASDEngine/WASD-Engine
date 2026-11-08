/**
 * Headless GIMP tools for the agent. The Host plugin registers the `wasd_gimp` MCP server with the
 * MCP server manager; the server process (`worker.ts`) starts one GIMP worker on the first tool
 * call. Activation never installs or starts GIMP.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AppMcpConfig, registerAppMcpPlugin } from '@deepseek-ai/dsh-app-mcp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { GIMP_INSTRUCTIONS, GIMP_SERVER_NAME } from './instructions.ts'

export type { GimpServerOptions } from './types.ts'

/** Cordis plugin name. */
export const name = 'gimp'

/** Services the plugin needs. */
export const inject = ['mcpManager']

/** Deployment configuration of the GIMP tools. */
export interface Config extends AppMcpConfig {
  /** Absolute directory for the GIMP profile, snapshots, and the worker script copy. */
  dataRoot: string
  /**
   * Absolute gimp-console executable of GIMP 3; empty uses GIMP_CONSOLE, then the runtime that the Desktop app ships,
   * then the standard install locations.
   */
  gimpConsolePath: string
  /** Budget for the MCP server to start and list its tools. */
  startupTimeoutMs: number
  /** Budget for a GIMP worker to become ready; the first start with a new profile takes about 15 s. */
  readyTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  dataRoot: z.string().min(1).required(),
  gimpConsolePath: z.string().default(''),
  startupTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  readyTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  // Schemastery erases object field types on dict; the shared Config declares their output types.
  ...AppMcpConfig.dict as { [Key in keyof AppMcpConfig]: z<unknown, AppMcpConfig[Key]> },
})

/**
 * Register the GIMP MCP server for this plugin's lifetime.
 * @param ctx - plugin context with the MCP server manager.
 * @param config - validated configuration.
 * @throws Error when dataRoot or gimpConsolePath is not absolute.
 */
export function apply(ctx: Context, config: Config): void {
  registerAppMcpPlugin(ctx, config, {
    app: 'GIMP',
    serverName: GIMP_SERVER_NAME,
    module: import.meta.url,
    paths: ['gimpConsolePath'],
    options: ['gimpConsolePath', 'readyTimeoutMs'],
    gameMcp: {
      id: 'gimp',
      title: 'GIMP',
      description: 'Create and edit images in a headless GIMP 3: textures, sprites, and sprite sheets.',
      instructions: GIMP_INSTRUCTIONS,
    },
  })
}
