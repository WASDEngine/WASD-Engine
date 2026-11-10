/**
 * Remote contribution and registrations of the Godot browser plugin: the Game tab, its opening for Agent runs, the stop of
 * the Session's game when the tab closes, the tool cards, and, in the macOS Desktop app, the holes of the application
 * root through which the shell's game layers show.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-godot/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { DesktopGameLayerBridge, GodotFollowItem } from '../types.ts'
import { failureOf, type GameFailure } from './actions.ts'
import { GODOT_CARD_TOOLS, GodotToolCard } from './cards.tsx'
import { nextFrame } from './frames.ts'
import { GameTab, GameTabTitle, type GameTabInjected } from './GameTab.tsx'
import { GameControllerIcon } from './icon.tsx'
import { LayerHoles, presentLayer, type LayerPresentation } from './layer.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { ACTIVE_PHASES, createGameSource, type GameSource } from './source.ts'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'shortcuts']

/** Registry id of the Game tab type, also its slot key. */
export const TAB_ID = 'godot-game'

/** Kind of the Game tab. */
export const TAB_KIND = 'godot'

/** The generated `godot` Remote namespace as the browser calls it. */
export type GodotRemote = ClientRemote['godot']

/** Codes of an input batch that reached a run which ended meanwhile; the batch is dropped silently. */
const ENDED_RUN_CODES: ReadonlySet<string> = new Set(['godot/not-running', 'godot/stale-run'])

/** Per-Session state of the Game tab, owned by the Session's scope. */
interface SessionGame {
  readonly source: GameSource
  readonly release: () => void
}

/**
 * The Session's frame stream address.
 * @param sessionId - the Session.
 * @param runId - the Session's run.
 * @returns the address relative to the page's base.
 */
function frameUrl(sessionId: SessionId, runId: string): URL {
  return new URL(`api/godot.frames?${new URLSearchParams({ session: sessionId, run: runId }).toString()}`, document.baseURI)
}

async function settle(call: Promise<RemoteResult<unknown>>): Promise<GameFailure | undefined> {
  return failureOf(await call)
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'godot: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote: GodotRemote = ctx.remote.godot
  const games = new Map<SessionId, SessionGame>()
  // The Agent run id for which each Session last opened the Game tab; a Session runs one game at a time.
  const opened = new Map<SessionId, string>()
  ctx.effect(() => () => {
    for (const game of [...games.values()]) game.release()
    games.clear()
    opened.clear()
  }, 'godot: follow streams')
  const gameOf = (sessionId: SessionId): SessionGame | undefined => {
    const known = games.get(sessionId)
    if (known !== undefined) return known
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const source = createGameSource({
      // The Gateway's logical stream reopens the follow stream after a carrier loss; the source reopens it after other stops.
      open: () => ctx.remote.$stream<GodotFollowItem>({
        name: 'Godot follow stream',
        open: signal => remote.follow(sessionId, signal),
        ended: () => new Error('the Godot follow stream ended'),
      }),
    })
    const dispose = binding.ctx.effect(() => () => {
      source.close()
      games.delete(sessionId)
    }, 'godot: release Session game state')
    const game: SessionGame = { source, release: () => { void dispose() } }
    games.set(sessionId, game)
    return game
  }
  // The macOS Desktop shell shows a windowless game's layer behind the page, through holes in the application root.
  const layers = (globalThis as typeof globalThis & { dshDesktop?: { readonly gameLayer?: DesktopGameLayerBridge } }).dshDesktop?.gameLayer
  let showLayer: GameTabInjected['showLayer']
  if (layers !== undefined) {
    const holes = new LayerHoles(() => document.getElementById('root'))
    ctx.effect(() => () => { holes.dispose() }, 'godot: application root holes for game layers')
    const services = { bridge: layers, holes, schedule: nextFrame, pixelRatio: () => window.devicePixelRatio }
    showLayer = (presentation: LayerPresentation) => presentLayer(services, presentation)
  }
  // Windows Desktop intercepts bound chords such as Ctrl+W before the page sees them; the shortcut service's recording
  // state suspends that interception while the game view has focus. Web and Linux Desktop dispatch application
  // shortcuts after the view, which consumes the keys it maps. macOS Desktop keeps intercepting, because the recording
  // state would also turn off its Command shortcuts and menu, which the view leaves to the application.
  const captureKeyboard = (): (() => void) => {
    const shortcuts = ctx.shortcuts
    if (shortcuts.runtime !== 'desktop' || shortcuts.platform !== 'windows') return () => {}
    const failed = (error: unknown): void => {
      ctx.logger.warn('godot: application shortcuts may take keys from the focused game view', error)
    }
    void shortcuts.recording(true).catch(failed)
    return () => { void shortcuts.recording(false).catch(failed) }
  }
  const tabFace = (sessionId: SessionId): GameTabInjected => {
    const game = gameOf(sessionId)
    if (game === undefined) throw new Error(`godot: Session ${sessionId} is not retained`)
    return {
      hooks: { game: game.source.observable },
      reconnect: game.source.reconnect,
      play: request => settle(remote.run(sessionId, request)),
      stop: () => settle(remote.stop(sessionId)),
      control: request => settle(remote.control(sessionId, request)),
      install: () => settle(remote.installRuntime()),
      input: async (runId, events) => {
        const result = await remote.input(sessionId, runId, events)
        if (result.ok || ENDED_RUN_CODES.has(result.error.code)) return
        throw result.error
      },
      openFrames: (runId, signal) => fetch(frameUrl(sessionId, runId), { signal, cache: 'no-store' }),
      ...showLayer === undefined ? {} : { showLayer },
      captureKeyboard,
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    keepMounted: true,
    title: () => t('tab.title'),
    guide: [{ id: 'play', order: 40, title: () => t('guide.title'), description: () => t('guide.description'), icon: GameControllerIcon }],
  }), 'godot: Game tab type')
  // Closing the tab stops the Session's game, as Stop does; a game left running keeps rendering and using the CPU.
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (sessionId) => {
    void remote.stop(sessionId).then((result) => {
      if (!result.ok && result.error.code !== 'godot/not-running') ctx.logger.warn('godot: the game did not stop when its tab closed', result.error)
    })
  }), 'godot: stop the game when its tab closes')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: tabFace,
  }, GameTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
  }, GameTabTitle))
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of GODOT_CARD_TOOLS) yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, GodotToolCard)
  })

  // The on-screen Session follows its game, so a run the Agent starts opens the Game tab once per run id.
  ctx.effect(() => {
    let watched: { readonly sessionId: SessionId; readonly stop: (() => void) | undefined } | undefined
    const watch = (sessionId: SessionId): (() => void) | undefined => {
      const game = gameOf(sessionId)
      if (game === undefined) return undefined
      const check = (): void => {
        const run = game.source.observable.getSnapshot().state?.run
        if (run?.startedBy !== 'agent' || !ACTIVE_PHASES.has(run.phase) || opened.get(sessionId) === run.runId) return
        opened.set(sessionId, run.runId)
        ctx.sidebarRight.openTabIn(sessionId, TAB_KIND)
      }
      const unsubscribe = game.source.observable.subscribe(check)
      check()
      return unsubscribe
    }
    const sync = (): void => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (watched?.sessionId === sessionId) return
      watched?.stop?.()
      watched = sessionId === undefined ? undefined : { sessionId, stop: watch(sessionId) }
    }
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      watched?.stop?.()
      watched = undefined
    }
  }, 'godot: open the Game tab for Agent runs')
}

/**
 * Mount the Godot Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated Godot Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountGame(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.godot', ...inject.slice(1)], registerUi)
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
