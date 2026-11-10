/**
 * Remote contribution and registrations of WASD Engine Plugins' browser half: the Release button after the agent preset
 * label of each Session header, and Explore Games at the foot of the left sidebar. The Release button exists while the
 * Peer may read the `wasdPlugins` Remote's project views, and Explore Games while it may read the site links;
 * LiveShare keeps both for the owner.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-wasd-plugins/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ExploreLink, type ExploreLinkInjected } from './ExploreLink.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { ReleaseButton, type ReleaseButtonInjected } from './ReleaseButton.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess', 'sessions']

/** Order of the Release button in the header actions: right after the agent preset label (-10). */
export const RELEASE_ORDER = -9

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'wasd-plugins: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.wasdPlugins
  ctx.remoteAccess.whenAccess('wasdPlugins/project', function* () {
    const injected = (): ReleaseButtonInjected => ({
      async readProject(projectDir) {
        const result = await remote.project(projectDir)
        return result.ok ? { view: result.value } : { error: result.error.message }
      },
      async startRelease(sessionId: SessionId, notes: string) {
        const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
        if (conversation === undefined) return 'The Session is not open.'
        const text = notes === '' ? t('release.prompt') : t('release.promptWithNotes', { notes })
        try {
          await conversation.send(text)
          return undefined
        } catch (error) {
          return (error as Error).message
        }
      },
    })
    yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'wasd-release',
      order: RELEASE_ORDER,
      locale: NS,
      inject: injected,
    }, ReleaseButton))
  })
  ctx.remoteAccess.whenAccess('wasdPlugins/links', function* () {
    const injected = (): ExploreLinkInjected => ({
      openExplore() {
        void remote.links().then((result) => {
          if (result.ok) window.open(result.value.explore, '_blank', 'noopener,noreferrer')
          else ctx.logger.warn(`wasd-plugins: the Explore page link is unavailable: ${result.error.message}`)
        })
      },
    })
    yield ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'wasd-explore',
      locale: NS,
      inject: injected,
    }, ExploreLink))
  })
}

/**
 * Mount the `wasdPlugins` Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated `wasdPlugins` Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountWasdPlugins(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.wasdPlugins', ...inject.slice(1)], registerUi)
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
