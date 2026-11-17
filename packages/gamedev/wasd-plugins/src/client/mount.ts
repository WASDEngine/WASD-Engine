/**
 * Remote contribution and registrations of WASD Engine Plugins' browser half: the Export / Share button after the agent
 * preset label of each Session header and in the New Session row of a blank Session, the Multiplayer button after
 * Export / Share and Add-ons in the header, the Play and Build switch in the sidebar's mode seat with the Play page as
 * the main panel {@link PLAY_PANEL} and the game library it shows, the first build tip beside the composer's model seat,
 * and, where the Desktop Browser tabs can be driven, the window half of the agent's Browser. A Desktop window also
 * opens the confirmation pages the multiplayer tools ask for, and opens the game links the shell hands the app in the
 * Play page. The Export / Share button exists while the Peer may read the `wasdPlugins` Remote's project views, the
 * Multiplayer button while it may read its multiplayer views, the Play page and its switch while it may read the site
 * links, the agent's Browser while it may follow the Browser commands, and the link follower while it may follow the
 * links; LiveShare keeps all of them for the owner. The first build tip exists while the model seat, Agent Teams, and
 * the workspace file Remote do.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
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
import type {
  WasdBrowserRequests, WasdDesktopPlatform, WasdLibraryOutcome, WasdLibraryView, WasdLinkRequests, WasdMobilePlatform,
} from '../types.ts'
import { followBrowserRequests } from './browser.ts'
import { createDismissedProjects, dismissProject, FIRST_BUILD_EFFORT, watchHoldsNothing } from './first-build.ts'
import { FirstBuildTip, type FirstBuildTipInjected } from './FirstBuildTip.tsx'
import { desktopBridges, followGameLinks, followLibrary } from './library.ts'
import { followLinkRequests } from './links.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh, type WasdPluginsUiKey } from './locales.ts'
import {
  ExportShareButton, type ExportPlatform, type ExportShareInjected, type ExportSharePlacement, type ReleaseTarget, type ShareRequest,
} from './ExportShareButton.tsx'
import { MultiplayerButton, type MultiplayerButtonInjected, type MultiplayerRequest } from './MultiplayerButton.tsx'
import { createPlayNavigator, gamePage, PLAY_PANEL } from './play.ts'
import { PlayBuildToggle, type PlayBuildToggleInjected } from './PlayBuildToggle.tsx'
import { PlayPage, type PlayPageInjected } from './PlayPage.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess', 'sessions']

/**
 * Order of the Export / Share button: right after the agent preset label (-10) in the header actions, and before the
 * branch and New worktree controls (0) in the New Session options.
 */
export const EXPORT_SHARE_ORDER = -9

/** Order of the Multiplayer button: after Export / Share (-9) and the game add-ons' Add-ons button (-8). */
export const MULTIPLAYER_ORDER = -7

/** The prompt each Multiplayer dialog button sends. */
const MULTIPLAYER_PROMPTS: Readonly<Record<MultiplayerRequest, WasdPluginsUiKey>> = {
  setup: 'multiplayer.promptSetup',
  test: 'multiplayer.promptTest',
  server: 'multiplayer.promptServer',
}

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
 * The tool calls an export asks for, as the prompt lists them, one per line: `wasd_export_desktop` for Windows and
 * macOS, `wasd_export_web` with its ZIP file for the Web, and `wasd_export_mobile` for Android and iOS, each with its
 * arguments as one JSON object.
 * @param platforms - the platforms, in the order the dialog lists them.
 * @returns the lines.
 */
export function exportCalls(platforms: readonly ExportPlatform[]): string {
  const desktop = platforms.filter((platform): platform is WasdDesktopPlatform => platform === 'windows' || platform === 'macos')
  const mobile = platforms.filter((platform): platform is WasdMobilePlatform => platform === 'android' || platform === 'ios')
  return [
    ...desktop.length === 0 ? [] : [`- \`wasd_export_desktop\` ${JSON.stringify({ platforms: desktop })}`],
    ...platforms.includes('web') ? [`- \`wasd_export_web\` ${JSON.stringify({ zip: true })}`] : [],
    ...mobile.length === 0 ? [] : [`- \`wasd_export_mobile\` ${JSON.stringify({ platforms: mobile })}`],
  ].join('\n')
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
      startExport(sessionId: SessionId, platforms: readonly ExportPlatform[]) {
        return send(sessionId, t('export.prompt', { calls: exportCalls(platforms) }))
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
  ctx.remoteAccess.whenAccess('wasdPlugins/multiplayer', function* () {
    const injected = (): MultiplayerButtonInjected => ({
      async readMultiplayer(projectDir) {
        const result = await remote.multiplayer(projectDir)
        return result.ok ? { view: result.value } : { error: result.error.message }
      },
      async ask(sessionId: SessionId, request: MultiplayerRequest) {
        const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
        if (conversation === undefined) return 'The Session is not open.'
        try {
          await conversation.send(t(MULTIPLAYER_PROMPTS[request]))
          return undefined
        } catch (error) {
          return (error as Error).message
        }
      },
    })
    yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'wasd-multiplayer',
      order: MULTIPLAYER_ORDER,
      locale: NS,
      inject: injected,
    }, MultiplayerButton))
  })
  // Only a Desktop window opens a link without a click, handing `window.open` to the system browser; a browser would
  // block the window, and the tool gives the link instead. The Desktop carrier of the sidebar Browser marks such a
  // window, as it does for the Browser commands.
  ctx.inject(['sidebarBrowserAutomation', 'remoteAccess'], (inner) => {
    inner.remoteAccess.whenAccess('wasdPlugins/linkRequests', () => followLinkRequests({
      // The Gateway's logical stream reopens the link stream after a carrier loss.
      follow: () => ctx.remote.$stream<WasdLinkRequests>({
        name: 'WASD Engine links',
        open: signal => remote.linkRequests(signal),
        ended: () => new Error('the WASD Engine link stream ended'),
      }),
      claim: async (id) => {
        const result = await remote.claimLink(id)
        return result.ok && result.value
      },
      open: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
      warn: (message, error) => { ctx.logger.warn(message, error) },
    }))
  })
  // The Play page and its switch need the main column's panels; the site's links give the page its address.
  ctx.inject(['layout'], (inner) => {
    inner.remoteAccess.whenAccess('wasdPlugins/links', function* () {
      const explore = async (): Promise<string> => {
        const result = await remote.links()
        if (!result.ok) throw new Error(result.error.message)
        return result.value.explore
      }
      const navigator = createPlayNavigator()
      const library = createSnapshotStore<WasdLibraryView | undefined>(undefined)
      const outcome = async (call: Promise<RemoteResult<WasdLibraryOutcome>>): Promise<string | undefined> => {
        const result = await call
        if (!result.ok) return result.error.message
        return result.value.ok ? undefined : result.value.message
      }
      const desktop = desktopBridges()
      yield ctx.slots.inject('sidebar.mode', () => ctx.slots.register({
        name: 'sidebar.mode',
        locale: NS,
        inject: (): PlayBuildToggleInjected => ({
          play: () => { inner.layout.selectPanel(PLAY_PANEL) },
          build: () => { inner.layout.selectPanel(null) },
        }),
      }, PlayBuildToggle))
      yield ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PLAY_PANEL,
        locale: NS,
        inject: (): PlayPageInjected => ({
          hooks: { navigation: navigator.store, library },
          watchLibrary,
          explore,
          desktop: desktop.browser,
          remember: (url) => { navigator.remember(url) },
          last: () => navigator.last(),
          signIn: async (next) => {
            const result = await remote.siteSignInLink(next)
            if (result.ok) return result.value ?? undefined
            ctx.logger.warn(`wasd-plugins: the Play page could not sign in to the site: ${result.error.message}`)
            return undefined
          },
          openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
          install: (slug, version) => outcome(remote.installGame(slug, version)),
          launch: async (id, anyway) => {
            const result = await remote.launchGame(id, anyway)
            if (!result.ok) return { message: result.error.message }
            if (result.value.ok) return undefined
            return { message: result.value.message, ...result.value.refusal === undefined ? {} : { refusal: result.value.refusal } }
          },
          remove: id => outcome(remote.removeGame(id)),
          dismiss: (slug) => {
            void remote.dismissLibraryTask(slug).then((result) => {
              if (!result.ok) ctx.logger.warn(`wasd-plugins: a failed download could not be dismissed: ${result.error.message}`)
            })
          },
        }),
      }, PlayPage))
      // The library streams only while a Play page shows it.
      let following: { count: number; readonly stop: () => void } | undefined
      const watchLibrary = (): (() => void) => {
        following ??= {
          count: 0,
          stop: followLibrary({
            // The Gateway's logical stream reopens the library stream after a carrier loss.
            follow: () => ctx.remote.$stream<WasdLibraryView>({
              name: 'WASD Engine game library',
              open: signal => remote.library(signal),
              ended: () => new Error('the WASD Engine game library stream ended'),
            }),
            store: library,
            warn: (message, error) => { ctx.logger.warn(message, error) },
          }),
        }
        const watcher = following
        watcher.count++
        let released = false
        return () => {
          if (released) return
          released = true
          watcher.count--
          if (watcher.count === 0 && following === watcher) {
            watcher.stop()
            following = undefined
          }
        }
      }
      yield () => {
        following?.stop()
        following = undefined
      }
      // Only the Desktop shell hands the app game links: the site's Install buttons and pages opened at a game. Only the
      // Install button of the site in the Play page installs; the follower opens every other link's page.
      if (desktop.links !== undefined) {
        yield followGameLinks({
          links: desktop.links,
          site: async () => new URL(await explore()).origin,
          open: async (link) => {
            inner.layout.selectPanel(PLAY_PANEL)
            navigator.go(gamePage(new URL(await explore()).origin, link))
            if (!link.install) return undefined
            return await outcome(remote.installGame(link.slug, link.version ?? 0))
          },
          warn: (message, error) => { ctx.logger.warn(message, error) },
        })
      }
    })
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
