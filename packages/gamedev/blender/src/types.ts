/** Types shared by the Blender Host plugin and its MCP server process. */
import type { AppServerOptions } from '@deepseek-ai/dsh-app-mcp'

/**
 * Which Blender runs the tools: `bpy` (the Python module that the Desktop app ships or uv installs), `app` (an installed
 * Blender), or `auto`.
 */
export type BlenderBackend = 'auto' | 'bpy' | 'app'

/** Options the Host plugin passes to the MCP server process; each field mirrors the plugin Config field of the same name. */
export interface BlenderServerOptions extends AppServerOptions {
  readonly backend: BlenderBackend
  readonly bpyVersion: string
  readonly pythonVersion: string
  readonly uvPath: string
  readonly blenderPath: string
  readonly startupTimeoutMs: number
}
