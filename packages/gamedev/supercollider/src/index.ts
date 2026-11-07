/**
 * Headless SuperCollider tools for the agent. The Host plugin registers the `wasd_supercollider` MCP server with the
 * MCP server manager; the server process (`worker.ts`) starts one sclang worker on the first tool call. Activation
 * never installs or starts SuperCollider.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AppMcpConfig, registerAppMcpPlugin } from '@deepseek-ai/dsh-app-mcp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { SUPERCOLLIDER_INSTRUCTIONS, SUPERCOLLIDER_SERVER_NAME } from './instructions.ts'

export type { SuperColliderServerOptions } from './types.ts'

/** Cordis plugin name. */
export const name = 'supercollider'

/** Services the plugin needs. */
export const inject = ['mcpManager']

/** Deployment configuration of the SuperCollider tools. */
export interface Config extends AppMcpConfig {
  /** Absolute directory for the interpreter's user folders, render scratch files, and the worker class copy. */
  dataRoot: string
  /** Absolute sclang executable; empty uses the runtime that the Desktop app ships, then an installed SuperCollider. */
  sclangPath: string
  /** Absolute scsynth executable; empty uses the scsynth of the runtime or installation that provides sclang. */
  scsynthPath: string
  /** Budget for the MCP server to start and list its tools. */
  startupTimeoutMs: number
  /** Budget for sclang to compile its class library and report ready; the first start after an install takes longer. */
  readyTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  dataRoot: z.string().min(1).required(),
  sclangPath: z.string().default(''),
  scsynthPath: z.string().default(''),
  startupTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  readyTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  // Schemastery erases object field types on dict; the shared Config declares their output types.
  ...AppMcpConfig.dict as { [Key in keyof AppMcpConfig]: z<unknown, AppMcpConfig[Key]> },
})

/**
 * Register the SuperCollider MCP server for this plugin's lifetime.
 * @param ctx - plugin context with the MCP server manager.
 * @param config - validated configuration.
 * @throws Error when dataRoot, sclangPath, or scsynthPath is not absolute.
 */
export function apply(ctx: Context, config: Config): void {
  registerAppMcpPlugin(ctx, config, {
    app: 'SuperCollider',
    serverName: SUPERCOLLIDER_SERVER_NAME,
    module: import.meta.url,
    paths: ['sclangPath', 'scsynthPath'],
    options: ['sclangPath', 'scsynthPath', 'readyTimeoutMs'],
    gameMcp: {
      id: 'supercollider',
      title: 'SuperCollider',
      description: 'Make sound effects and music for the game in a headless SuperCollider: render sclang code offline to audio files and measure them.',
      instructions: SUPERCOLLIDER_INSTRUCTIONS,
    },
  })
}
