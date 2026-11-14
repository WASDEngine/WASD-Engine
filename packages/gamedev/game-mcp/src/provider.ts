/**
 * What a game tool plugin contributes to WASD Engine's MCP server through `ctx.gameMcp.provide()`: its identity, its
 * readiness, and its tools, each backed by a harness tool definition that the server runs for connected agents; and the
 * `game-mcp/tool-result` event, which reports each finished call of those tools.
 * @module @deepseek-ai/dsh-game-mcp/src/provider
 */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** A JSON object, such as a tool's arguments or JSON Schema. */
export type JsonObject = { [key: string]: JsonValue }

/** An agent on this computer that calls the server, as the server identifies it from its requests. */
export interface GameMcpClient {
  /** Lowercase id, such as `claude-code`, or `agent` when the requests name no client. */
  readonly id: string
  /** Display name, such as Claude Code. */
  readonly title: string
}

/** One MCP content block of a tool result: text, or a base64 image. */
export type GameMcpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/** How ready a provider's application is, as `search_game_tools` reports it. */
export interface GameMcpProviderStatus {
  /** `ready`: calls run; `starting`: the tools appear or the application starts soon; `unavailable`: calls fail until the user acts. */
  readonly state: 'ready' | 'starting' | 'unavailable'
  /** What the agent or the user can do, for `starting` and `unavailable`. */
  readonly message?: string
}

/** One call from a connected agent. */
export interface GameMcpCall {
  /** The calling agent. */
  readonly client: GameMcpClient
  /** Aborts when the agent cancels the call, its request closes, or the server stops. */
  readonly signal: AbortSignal
  /**
   * Resolve the Agent of the Session through which the calling agent works in the game project that holds
   * `directory`: the game project registration that contains it, or a new one for the directory itself, and that
   * project's Session for this agent, or for this agent and `name`, created on first use. Agents that share one
   * connection, such as the subagents of one session, give different names to work in Sessions of their own.
   * @param directory - absolute path of an existing directory.
   * @param name - Session name of 1 to 40 characters, which names that differ only in case share; undefined picks
   *   the agent's unnamed Session.
   * @returns the Session's live Agent.
   * @throws when the path is not absolute or not a directory, the name is unusable, or the Host cannot create or
   *   resume the Session.
   */
  session(directory: string, name?: string): Promise<Agent>
  /**
   * Ask the WASD Engine windows that may read a Session to show it, through the `game-mcp/reveal` event.
   * @param sessionId - Session to show.
   */
  reveal(sessionId: SessionId): void
}

/** The arguments and Agent of one prepared call. */
export interface GameMcpPreparedCall {
  /** Arguments the tool definition receives. */
  readonly args: JsonObject
  /** Agent the definition runs as; absent for a tool that needs no Session. */
  readonly agent?: Agent
}

/** The content of a successful call, at once or later. */
export type GameMcpContentResult = Promise<readonly GameMcpContent[]> | readonly GameMcpContent[]

/**
 * A page where the user confirms what a call asked for, such as a purchase on the WASD Engine site, which the server
 * sends as a URL-mode elicitation to an agent whose client supports one.
 */
export interface GameMcpConfirmation {
  /** The page; an https address in production. */
  readonly url: string
  /** What the user confirms there, for the client to show with the page's host. */
  readonly message: string
}

/** One tool that the server offers to connected agents. */
export interface GameMcpTool {
  /** Name agents call: the provider id, an underscore, and letters, digits, `_`, or `-`, at most 64 characters. */
  readonly name: string
  /** The harness tool that runs each call; its description and parameters are offered unless overridden. */
  readonly definition: ToolDefinition
  /** Model-facing description offered instead of the definition's. */
  readonly description?: string
  /** JSON Schema of the arguments offered instead of the definition's parameters; an object schema. */
  readonly inputSchema?: JsonObject
  /** Whether a call only reads state, which agents may use to skip approval prompts. */
  readonly readOnly?: boolean
  /**
   * Map one call's arguments to the definition's and choose the Agent it runs as. Absent, the definition receives
   * the arguments unchanged and runs without an Agent.
   * @param args - the agent's arguments.
   * @param call - the calling agent, cancellation, and the Session operations.
   * @returns the prepared call.
   * @throws an error whose message the agent receives as the tool's failure.
   */
  readonly prepare?: (args: JsonObject, call: GameMcpCall) => Promise<GameMcpPreparedCall>
  /**
   * Turn a successful call's canonical value into MCP content. Absent, the server renders the value with the
   * definition's `output.render` and sends its text blocks; image blocks then need this function.
   * @param value - the definition's canonical value.
   * @param args - the arguments the definition received.
   * @param exec - the execution the definition ran with.
   * @returns the result content, text first.
   */
  readonly content?: (value: JsonValue, args: JsonObject, exec: ToolRunContext) => GameMcpContentResult
  /**
   * The page where the user confirms what a successful call asked for. A client that declared URL-mode elicitation
   * gets the page as an elicitation and the call's content once the user answered; other clients get the content,
   * which names the page too.
   * @param value - the definition's canonical value.
   * @returns the page, or undefined when the call needs no confirmation.
   */
  readonly confirmation?: (value: JsonValue) => GameMcpConfirmation | undefined
}

/** One game tool plugin as connected agents find it. */
export interface GameMcpProvider {
  /** Lowercase plugin id, such as `godot`; it prefixes the provider's tool names. */
  readonly id: string
  /** Display name, such as Godot. */
  readonly title: string
  /** One sentence on what the plugin's tools do. */
  readonly description: string
  /** How to use the tools, which the server adds to its instructions under the provider's title. */
  readonly instructions?: string
  /** @returns the tools offered now; the list may change while the application starts or reconnects. */
  tools(): readonly GameMcpTool[]
  /**
   * Report the plugin's readiness.
   * @param signal - cancellation.
   * @returns the readiness now.
   */
  status(signal: AbortSignal): Promise<GameMcpProviderStatus>
}

/** The provider of WASD Engine's MCP server that offers one tool, as `gameMcp.toolOwner()` finds it. */
export interface GameMcpToolOwner {
  /** Id of the provider, such as `blender`. */
  readonly provider: string
  /** Display name of the provider, such as Blender. */
  readonly title: string
  /** The tool's name as connected agents call it, such as `blender_execute_python`. */
  readonly tool: string
}

/** One finished call of a provider's tool by a connected agent, as the `game-mcp/tool-result` event reports it. */
export interface GameMcpToolResult {
  /** Id of the provider that offers the tool, such as `blender`. */
  readonly provider: string
  /** Name the agent called, such as `blender_execute_python`. */
  readonly tool: string
  /** Arguments the tool definition received. */
  readonly args: JsonObject
  /** The calling agent. */
  readonly client: GameMcpClient
  /** Agent of the Session the call ran in; absent for a tool that needs no Session and for a call whose preparation failed. */
  readonly agent?: Agent
  /** Whether the agent received an error result. */
  readonly isError: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connected agent's call of a provider tool finished, after its result was made; `search_game_tools`, a refused
     * call, and a call of an unknown tool do not emit it.
     * @mode emit
     * @param result - the provider, tool, arguments, calling agent, Session, and whether the call failed.
     */
    'game-mcp/tool-result'(result: GameMcpToolResult): void
  }
}
