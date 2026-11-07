/** Types shared by the GIMP Host plugin and its MCP server process. */
import type { AppServerOptions } from '@deepseek-ai/dsh-app-mcp'

/** Options the Host plugin passes to the MCP server process; each field mirrors the plugin Config field of the same name. */
export interface GimpServerOptions extends AppServerOptions {
  readonly gimpConsolePath: string
  readonly readyTimeoutMs: number
}
