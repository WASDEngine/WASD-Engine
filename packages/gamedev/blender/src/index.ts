/**
 * Headless Blender tools for the agent. The Host plugin registers the `wasd_blender` MCP server with
 * the MCP server manager; the server process (`worker.ts`) starts one Blender worker on the first
 * tool call. Activation never downloads, installs, or starts Blender.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AppMcpConfig, registerAppMcpPlugin } from '@deepseek-ai/dsh-app-mcp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { BPY_VERSION_PATTERN, PYTHON_VERSION_PATTERN } from './environment.ts'
import { BLENDER_INSTRUCTIONS, BLENDER_SERVER_NAME } from './instructions.ts'
import type { BlenderBackend } from './types.ts'

export type { BlenderBackend, BlenderServerOptions } from './types.ts'

/** Cordis plugin name. */
export const name = 'blender'

/** Services the plugin needs. */
export const inject = ['mcpManager']

/** Deployment configuration of the Blender tools. */
export interface Config extends AppMcpConfig {
  /** Absolute directory for the bpy environment, managed Python, previews, renders, and the worker script copy. */
  dataRoot: string
  /** `auto` uses the bpy module when uv is available and an installed Blender otherwise; `bpy` and `app` force one. */
  backend: BlenderBackend
  /** bpy package version installed into the managed environment. */
  bpyVersion: string
  /** Python minor version of the managed environment; it must match the bpy release. */
  pythonVersion: string
  /** Absolute uv executable; empty searches PATH and the uv installers' default locations. */
  uvPath: string
  /** Absolute Blender executable; empty uses BLENDER_PATH, then the standard install locations. */
  blenderPath: string
  /** Budget for the MCP server and for each Blender worker start to become ready. */
  startupTimeoutMs: number
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  dataRoot: z.string().min(1).required(),
  backend: z.union(['auto', 'bpy', 'app']).default('auto'),
  bpyVersion: z.string().pattern(BPY_VERSION_PATTERN).default('5.2.3'),
  pythonVersion: z.string().pattern(PYTHON_VERSION_PATTERN).default('3.13'),
  uvPath: z.string().default(''),
  blenderPath: z.string().default(''),
  startupTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  // Schemastery erases object field types on dict; the shared Config declares their output types.
  ...AppMcpConfig.dict as { [Key in keyof AppMcpConfig]: z<unknown, AppMcpConfig[Key]> },
})

/**
 * Register the Blender MCP server for this plugin's lifetime.
 * @param ctx - plugin context with the MCP server manager.
 * @param config - validated configuration.
 * @throws Error when dataRoot, uvPath, or blenderPath is not absolute.
 */
export function apply(ctx: Context, config: Config): void {
  registerAppMcpPlugin(ctx, config, {
    app: 'Blender',
    serverName: BLENDER_SERVER_NAME,
    module: import.meta.url,
    paths: ['uvPath', 'blenderPath'],
    options: ['backend', 'bpyVersion', 'pythonVersion', 'uvPath', 'blenderPath', 'startupTimeoutMs'],
    gameMcp: {
      id: 'blender',
      title: 'Blender',
      description: 'Model, texture, and render 3D assets in a headless Blender, and export them as .glb files into the game.',
      instructions: BLENDER_INSTRUCTIONS,
    },
  })
}
