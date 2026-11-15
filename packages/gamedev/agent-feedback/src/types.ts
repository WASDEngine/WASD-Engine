/**
 * Types of the feedback agents send and of the tool usage the plugin reports to the WASD Engine site.
 * @module @deepseek-ai/dsh-agent-feedback/src/types
 */

/** What feedback is about: something broken, something missing, something unclear, or an idea. */
export type FeedbackKind = 'bug' | 'missing_feature' | 'confusing' | 'suggestion'

/** The agent that sends feedback or calls a tool: WASD Engine's own, or one connected through its MCP server. */
export interface ReportingAgent {
  /** Whether the agent is connected through WASD Engine's MCP server rather than WASD Engine's own. */
  readonly connected: boolean
  /** `wasd-engine` for WASD Engine's own agent, else the connected agent's client id, such as `claude-code`. */
  readonly id: string
  /** Display name, such as Claude Code. */
  readonly title: string
}

/** One feedback as the plugin posts it to the WASD Engine site. */
export interface FeedbackReport {
  readonly kind: FeedbackKind
  readonly message: string
  /** What the feedback concerns, such as a tool name; empty when the agent named nothing. */
  readonly about: string
  readonly agent: ReportingAgent
  /** The AI model the agent runs on or named; empty when unknown. */
  readonly model: string
}

/** One feedback as the WASD Engine site receives it: the request's JSON fields. */
export interface SentFeedback {
  readonly kind: FeedbackKind
  readonly message: string
  readonly about: string
  readonly connected: boolean
  readonly agent: string
  readonly agent_title: string
  readonly model: string
  /** Empty when the app names no version. */
  readonly app_version: string
  /** The operating system as Node names it, such as `darwin`. */
  readonly platform: string
}

/** What one count of a usage report is of: who called which tool of which game tool plugin or MCP server. */
export interface ToolUsageKey {
  readonly agent: ReportingAgent
  /** Whether the server is an MCP server the user added rather than one of WASD Engine's game tool plugins. */
  readonly custom: boolean
  /** The game tool plugin's MCP provider id, such as `godot`, or `added-mcp-servers` for every server the user added. */
  readonly server: string
  /** Display name of the server, such as Godot. */
  readonly serverTitle: string
  /** The tool's name as connected agents call it, such as `godot_run`, or `all-tools` for the servers the user added. */
  readonly tool: string
}

/** One key's calls since the last report. */
export interface ToolUsageCount {
  readonly key: ToolUsageKey
  readonly calls: number
  readonly errors: number
}
