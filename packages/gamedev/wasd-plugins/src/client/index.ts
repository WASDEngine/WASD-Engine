/** Browser half of WASD Engine Plugins: the Release button in Session headers and Explore Games in the sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-wasd-plugins/remote'
import { mountWasdPlugins } from './mount.ts'

export { inject } from './mount.ts'
export type { ExploreLinkInjected, ExploreLinkProps } from './ExploreLink.tsx'
export type { ReleaseButtonInjected, ReleaseButtonProps } from './ReleaseButton.tsx'
export type { WasdPluginsUiKey } from './locales.ts'

/**
 * Mount the `wasdPlugins` Remote, then the Release button and Explore Games.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountWasdPlugins(ctx, remote)
}
