/** Types shared by the SuperCollider Host plugin, its MCP server process, and its bridge process. */
import type { AppServerOptions } from '@deepseek-ai/dsh-app-mcp'

/** Options the Host plugin passes to the MCP server process; each field mirrors the plugin Config field of the same name. */
export interface SuperColliderServerOptions extends AppServerOptions {
  readonly sclangPath: string
  readonly scsynthPath: string
  readonly readyTimeoutMs: number
}

/** Where the sclang and scsynth that a worker runs come from. */
export type SuperColliderSource = 'configured' | 'bundled' | 'installed'

/** The SuperCollider programs and folders that one worker uses. */
export interface SuperColliderRuntime {
  /** `configured` for `sclangPath`, `bundled` for the runtime that the Desktop app ships, `installed` for one found on this machine. */
  readonly source: SuperColliderSource
  /** Absolute sclang executable. */
  readonly sclang: string
  /** Absolute scsynth executable that renders offline. */
  readonly scsynth: string
  /** Class library folder that replaces sclang's default paths; undefined keeps the defaults of the installation. */
  readonly classLibrary: string | undefined
  /** UGen plugin folder that scsynth loads exclusively; undefined keeps scsynth's default plugin folders. */
  readonly plugins: string | undefined
  /** Help source folder holding `Classes/<name>.schelp`; undefined uses the one sclang reports. */
  readonly helpSource: string | undefined
}

/**
 * What the bridge process needs to run sclang behind the worker protocol. The MCP server passes it to the bridge as
 * one base64url JSON argument; a type alias, so that it is a JSON object.
 */
export type SclangBridgePlan = {
  /** sclang executable followed by its arguments. */
  readonly sclang: string[]
  /**
   * sclang's environment as changes to the bridge's own: variables to set and variables to remove. The plan travels on
   * the command line, so it carries no inherited values.
   */
  readonly env: { readonly set: { readonly [name: string]: string }; readonly unset: string[] }
  /** sclang working directory. */
  readonly cwd: string
  /** Directory for request parameter files; the worker class deletes each file after reading it. */
  readonly requestDirectory: string
  /** Parameters of the worker class's boot call. */
  readonly boot: SclangBootParameters
  /** Milliseconds sclang gets to exit after its input closes, before the bridge kills it. */
  readonly graceMs: number
}

/** What the worker class learns when it boots: the programs and folders it renders and looks up help with. */
export type SclangBootParameters = {
  /** Absolute scsynth executable for offline renders. */
  readonly scsynth: string
  /** UGen plugin folder passed to scsynth as `-U`, or null for scsynth's defaults. */
  readonly plugins: string | null
  /** Folder for intermediate render, conversion, and log files. */
  readonly scratch: string
  /** Help source folder, or null for the one SCDoc reports. */
  readonly helpSource: string | null
}
