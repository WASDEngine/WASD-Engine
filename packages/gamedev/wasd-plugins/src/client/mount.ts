/**
 * Remote contribution and registrations of WASD Engine Plugins' browser half: the Export / Share button after the agent
 * preset label of each Session header and in the New Session row of a blank Session, Explore Games at the foot of the
 * left sidebar, the first build tip beside the composer's model seat, and, where the Desktop Browser tabs can be driven,
 * the window half of the agent's Browser. The Export / Share button exists while the Peer may read the `wasdPlugins`
 * Remote's project views, Explore Games while it may read the site links, and the agent's Browser while it may follow
 * the Browser commands; LiveShare keeps all three for the owner. The first build tip exists while the model seat, Agent
 * Teams, and the workspace file Remote do.
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
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-wasd-plugins/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WasdBrowserRequests, WasdDesktopPlatform } from '../types.ts'
import { followBrowserRequests } from './browser.ts'
import { ExploreLink, type ExploreLinkInjected } from './ExploreLink.tsx'
import { createDismissedProjects, dismissProject, FIRST_BUILD_EFFORT, watchHoldsNothing } from './first-build.ts'
import { FirstBuildTip, type FirstBuildTipInjected } from './FirstBuildTip.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type WasdPluginsUiKey } from './locales.ts'
import { ExportShareButton, type ExportShareInjected, type ExportSharePlacement, type ReleaseTarget, type ShareRequest } from './ExportShareButton.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess', 'sessions']

/**
 * Order of the Export / Share button: right after the agent preset label (-10) in the header actions, and before the
 * branch and New worktree controls (0) in the New Session options.
 */
export const EXPORT_SHARE_ORDER = -9

/** The share prompt of each target, without and with the user's notes. */
const SHARE_PROMPTS = {
  linked: ['share.prompt', 'share.promptWithNotes'],
  same: ['share.promptSameGame', 'share.promptSameGameWithNotes'],
  new: ['share.promptNewGame', 'share.promptNewGameWithNotes'],
} as const satisfies Record<ReleaseTarget, readonly [WasdPluginsUiKey, WasdPluginsUiKey]>

/**
 * The `wasd_release_game` arguments a share asks for, as the prompt quotes them: the visibility, the desktop downloads
 * when there are any, and the game choice of a project that has a game.
 * @param request - the share.
 * @returns the arguments as one JSON object.
 */
export function shareArguments(request: ShareRequest): string {
  return JSON.stringify({
    visibility: request.visibility,
    ...request.desktop.length === 0 ? {} : { desktop: request.desktop },
    ...request.target === 'linked' ? {} : { new_game: request.target === 'new' },
  })
}

/**
 * The `wasd_export_desktop` arguments an export asks for, as the prompt quotes them.
 * @param platforms - the platforms.
 * @returns the arguments as one JSON object.
 */
export function exportArguments(platforms: readonly WasdDesktopPlatform[]): string {
  return JSON.stringify({ platforms })
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'wasd-plugins: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.wasdPlugins
  ctx.remoteAccess.whenAccess('wasdPlugins/project', function* () {
    const send = async (sessionId: SessionId, text: string): Promise<string | undefined> => {
      const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
      if (conversation === undefined) return 'The Session is not open.'
      try {
        await conversation.send(text)
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    }
    const injected = (placement: ExportSharePlacement) => (): ExportShareInjected => ({
      placement,
      async readProject(projectDir) {
        const result = await remote.project(projectDir)
        return result.ok ? { view: result.value } : { error: result.error.message }
      },
      startShare(sessionId: SessionId, request: ShareRequest) {
        const [prompt, withNotes] = SHARE_PROMPTS[request.target]
        const values = { arguments: shareArguments(request) }
        return send(sessionId, request.notes === '' ? t(prompt, values) : t(withNotes, { ...values, notes: request.notes }))
      },
      startExport(sessionId: SessionId, platforms: readonly WasdDesktopPlatform[]) {
        return send(sessionId, t('export.prompt', { arguments: exportArguments(platforms) }))
      },
    })
    yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'wasd-export-share',
      order: EXPORT_SHARE_ORDER,
      locale: NS,
      inject: injected('header'),
    }, ExportShareButton))
    // The header shows no actions until a Session's first prompt, so a blank Session offers Export / Share in this row.
    yield ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
      name: 'conversation.hero.options',
      id: 'wasd-export-share',
      order: EXPORT_SHARE_ORDER,
      locale: NS,
      inject: injected('newSession'),
    }, ExportShareButton))
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
              // This Session only: the saved default for new Sessions keeps the user's own effort.
              const result = await directory.select({
                provider: current.provider, model: current.model, reasoningEffort: FIRST_BUILD_EFFORT,
              }, { saveDefault: false })
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
  // Only the Desktop Browser plugin provides the automation service, so Web windows never take Browser commands.
  ctx.inject(['sidebarRight', 'sidebarBrowserAutomation', 'remoteAccess'], (inner) => {
    inner.remoteAccess.whenAccess('wasdPlugins/browserRequests', () => followBrowserRequests({
      // The Gateway's logical stream reopens the command stream after a carrier loss.
      follow: () => ctx.remote.$stream<WasdBrowserRequests>({
        name: 'WASD Engine Browser commands',
        open: signal => remote.browserRequests(signal),
        ended: () => new Error('the WASD Engine Browser command stream ended'),
      }),
      claim: async (id, follower) => {
        const result = await remote.claimBrowserRequest(id, follower)
        return result.ok && result.value
      },
      settle: async (id, outcome) => {
        const result = await remote.settleBrowserRequest(id, outcome)
        if (!result.ok) throw result.error
      },
      sidebar: inner.sidebarRight,
      automation: inner.sidebarBrowserAutomation,
      warn: (message, error) => { ctx.logger.warn(message, error) },
    }))
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
