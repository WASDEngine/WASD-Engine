/** Browser entry of the Godot plugin: the Game tab, the Godot tool cards, and their Remote. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-godot/remote'
import { mountGame } from './mount.ts'

export { inject } from './mount.ts'
export type { GameFailure, GameIssue } from './actions.ts'
export type { GodotToolCardProps, ToolCardModel } from './cards.tsx'
export type { GameTabInjected, GameTabProps } from './GameTab.tsx'
export type { GodotUiKey } from './locales.ts'
export type { GodotRemote } from './mount.ts'
export type { GameSnapshot, GameState } from './source.ts'

/**
 * Mount the Godot Remote, then the Game tab and tool cards that call it.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountGame(ctx, remote)
}
