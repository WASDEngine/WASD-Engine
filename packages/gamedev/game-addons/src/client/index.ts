/** Browser half of the game add-ons: the Add-ons button and dialog in Session headers. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-game-addons/remote'
import { mountGameAddons } from './mount.ts'

export { inject } from './mount.ts'
export type { AddonsButtonInjected, AddonsButtonProps, Outcome } from './AddonsButton.tsx'
export type { GameAddonsUiKey } from './locales.ts'

/**
 * Mount the `gameAddons` Remote, then the Add-ons button.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the button, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountGameAddons(ctx, remote)
}
