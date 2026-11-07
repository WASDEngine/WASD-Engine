/**
 * Browser-safe Remote types of WASD Engine's MCP server: its address, the setup prompt, the agents it serves, and
 * the event that asks the window to show a Session.
 */
import type {} from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Whether the server accepts connections: `starting` until it listens, `failed` when it cannot. */
export type GameMcpServerState = 'starting' | 'listening' | 'failed'

/** One agent that called the server since the Host started. */
export interface GameMcpClientView {
  /** Lowercase id, such as `claude-code`. */
  readonly id: string
  /** Display name, such as Claude Code. */
  readonly title: string
  /** Milliseconds since the epoch of the agent's latest request. */
  readonly lastSeen: number
}

/** The server as the setup view and the window follow it. */
export interface GameMcpView {
  /** Whether the server accepts connections. */
  readonly state: GameMcpServerState
  /** MCP endpoint while listening, such as `http://127.0.0.1:9273/mcp`. */
  readonly url?: string
  /** Prompt that sets another agent up to use the server, with its access token, while listening. */
  readonly prompt?: string
  /** Why the server failed, or why it listens on another port than configured. */
  readonly message?: string
  /** Agents that called the server since the Host started, most recent first. */
  readonly clients: readonly GameMcpClientView[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connected agent's call asked the WASD Engine window to show a Session, such as the one whose game it
     * started; the Host forwards it to the windows that may read the Session.
     * @mode emit
     * @param sessionId - Session to show.
     */
    'game-mcp/reveal'(sessionId: SessionId): void
  }
}
