/**
 * Browser half of WASD Engine Plugins: the Export / Share button in Session headers and in the New Session row of a
 * blank Session, the Multiplayer button in Session headers, the sidebar's Play and Build switch with the Play page of
 * the site's games and the game library, and, in the Desktop app, the confirmation pages the multiplayer tools open and
 * the game links of the site's Install buttons.
 */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-wasd-plugins/remote'
import { mountWasdPlugins } from './mount.ts'

export { inject } from './mount.ts'
export type { ExportShareButtonProps, ExportShareInjected, ExportSharePlacement, ReleaseTarget, ShareRequest } from './ExportShareButton.tsx'
export type { MultiplayerButtonInjected, MultiplayerButtonProps, MultiplayerRequest } from './MultiplayerButton.tsx'
export type { PlayBuildToggleInjected, PlayBuildToggleProps } from './PlayBuildToggle.tsx'
export type { PlayLibraryActions, PlayLibraryProps } from './PlayLibrary.tsx'
export type { PlayPageInjected, PlayPageProps } from './PlayPage.tsx'
export type { WasdPluginsUiKey } from './locales.ts'

/**
 * Mount the `wasdPlugins` Remote, then the Export / Share and Multiplayer buttons, the Play page, and its switch.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountWasdPlugins(ctx, remote)
}
