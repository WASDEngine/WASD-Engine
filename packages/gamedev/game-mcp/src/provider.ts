/**
 * What a game tool plugin contributes to WASD Engine's MCP server through `ctx.gameMcp.provide()`: its identity, its
 * readiness, and its tools, each backed by a harness tool definition that the server runs for connected agents.
 * @module @deepseek-ai/dsh-game-mcp/src/provider
 */
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
   * project's Session for this agent, created on first use.
   * @param directory - absolute path of an existing directory.
   * @returns the Session's live Agent.
   * @throws when the path is not absolute or not a directory, or the Host cannot create or resume the Session.
   */
  session(directory: string): Promise<Agent>
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
