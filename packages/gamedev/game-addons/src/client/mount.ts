/**
 * Remote contribution and registration of the game add-ons' browser half: the Add-ons button after the Release
 * button of each Session header. It exists while the Peer may read the `gameAddons` Remote's project view; LiveShare
 * keeps it for the owner.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-game-addons/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AddonsButton, type AddonsButtonInjected, type Outcome } from './AddonsButton.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess']

/** Order of the Add-ons button in the header actions: right after the Release button (-9). */
export const ADDONS_ORDER = -8

type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }

/** A Remote result as the button's outcome. */
function outcome<T>(result: RemoteResult<T>): Outcome<T> {
  return result.ok ? { value: result.value } : { error: result.error.message }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'game-addons: dictionaries')
  const remote = ctx.remote.gameAddons
  ctx.remoteAccess.whenAccess('gameAddons/project', function* () {
    const injected = (): AddonsButtonInjected => ({
      readProject: async directory => outcome(await remote.project(directory)),
      install: async (directory, id) => outcome(await remote.installAddon(directory, id)),
      remove: async (directory, id) => outcome(await remote.removeAddon(directory, id)),
    })
    yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'game-addons',
      order: ADDONS_ORDER,
      locale: NS,
      inject: injected,
    }, AddonsButton))
  })
}

/**
 * Mount the `gameAddons` Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated `gameAddons` Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountGameAddons(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.gameAddons', ...inject.slice(1)], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
