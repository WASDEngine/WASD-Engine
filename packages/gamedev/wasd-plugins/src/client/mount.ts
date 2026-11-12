/**
 * Remote contribution and registrations of WASD Engine Plugins' browser half: the Release button after the agent preset
 * label of each Session header and in the New Session row of a blank Session, Explore Games at the foot of the left
 * sidebar, and the first build tip beside the composer's model seat. The Release button exists while the Peer may read
 * the `wasdPlugins` Remote's project views, and Explore Games while it may read the site links; LiveShare keeps both
 * for the owner. The first build tip exists while the model seat, Agent Teams, and the workspace file Remote do.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-wasd-plugins/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ExploreLink, type ExploreLinkInjected } from './ExploreLink.tsx'
import { createDismissedProjects, dismissProject, FIRST_BUILD_EFFORT, watchHoldsNothing } from './first-build.ts'
import { FirstBuildTip, type FirstBuildTipInjected } from './FirstBuildTip.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { ReleaseButton, type ReleaseButtonInjected, type ReleaseButtonPlacement } from './ReleaseButton.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess', 'sessions']

/**
 * Order of the Release button: right after the agent preset label (-10) in the header actions, and before the branch
 * and New worktree controls (0) in the New Session options.
 */
export const RELEASE_ORDER = -9

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'wasd-plugins: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.wasdPlugins
  ctx.remoteAccess.whenAccess('wasdPlugins/project', function* () {
    const injected = (placement: ReleaseButtonPlacement) => (): ReleaseButtonInjected => ({
      placement,
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
      inject: injected('header'),
    }, ReleaseButton))
    // The header shows no actions until a Session's first prompt, so a blank Session offers Release in this row.
    yield ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
      name: 'conversation.hero.options',
      id: 'wasd-release',
      order: RELEASE_ORDER,
      locale: NS,
      inject: injected('newSession'),
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
      // Above the Join Discord row, which keeps its place next to the account row.
      order: -1,
      locale: NS,
      inject: injected,
    }, ExploreLink))
  })
  const dismissedProjects = createDismissedProjects()
  ctx.inject(['modelDirectories', 'remote.agentTeams', 'remote.workspaceFiles'], (scope) => {
    scope.slots.inject('conversation.input.model.callout', () => scope.slots.register({
      name: 'conversation.input.model.callout',
      id: 'wasd-first-build',
      locale: NS,
      inject: (sessionId: SessionId): FirstBuildTipInjected => {
        const directory = scope.modelDirectories.directoryFor(sessionId)
        return {
          hooks: { modelDirectory: directory.store, dismissedProjects },
          watchFolder: (folder, signal) => watchHoldsNothing(scope.remote, sessionId, folder, signal),
          async selectMaxEffort() {
            const current = directory.store.getSnapshot().current
            if (current === null) return 'No model is selected.'
            try {
              const result = await directory.select({
                provider: current.provider, model: current.model, reasoningEffort: FIRST_BUILD_EFFORT,
              })
              return result.ok ? undefined : result.error.message
            } catch (error) {
              return (error as Error).message
            }
          },
          async enableTeamwork() {
            const result = await scope.remote.agentTeams.setEnabled(sessionId, true)
            return result.ok ? undefined : result.error.message
          },
          dismiss: (project) => { dismissProject(dismissedProjects, project) },
        }
      },
    }, FirstBuildTip))
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
