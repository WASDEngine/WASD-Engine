/** Browser half of WASD Engine's MCP server: the setup panel for another agent, and the window following its games. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-game-mcp/remote'
import { mountGameMcp } from './mount.ts'

export { inject } from './mount.ts'
export type { AgentSetupInjected, AgentSetupProps } from './AgentSetup.tsx'
export type { GameMcpUiKey } from './locales.ts'
export type { ServerSnapshot } from './source.ts'

/**
 * Mount the game MCP Remote, then the setup panel and the window's following of connected agents' games.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountGameMcp(ctx, remote)
}
