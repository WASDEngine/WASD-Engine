/**
 * Assets tab, browser half: the right Sidebar's `assets` page type with its guide entry, its body, and its chip
 * title. The body lists the 2D and 3D art of the Session's game project in a searchable picker, sorted into the
 * project's folders, and shows the selected asset: images in a zoomable view that plays their 2D animations, and
 * models in a 3D view that three.js draws from a chunk loaded on first use, with their clips, skeleton, and details.
 * Each Session keeps its scan and choices until its scope ends. The plugin also answers the agent's asset tools: it
 * draws an asset for a `game-assets/render` request of a Session it may read, and opens an asset in the Session's
 * Assets tab for `game-assets/reveal`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the ctx.remote merge with the `workspaceFiles` namespace and the forwarded events, the `file` resource
// protocol, the sessions service, the workspace's Session navigation, and the right Sidebar's registry, seats, and
// navigation.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetGrid, AssetReveal } from '@deepseek-ai/dsh-game-assets/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { answerRender, canDrawModels, type AgentRenderSources } from './agent.ts'
import { MAX_TEXT_BYTES, type AnimationSources } from './animations2d.ts'
import { AssetsTab, AssetsTabTitle, type AssetsTabInjected } from './AssetsTab.tsx'
import { AssetsGlyph } from './icon.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { DrawQueue } from './queue.ts'
import { readAsset, relatedUrl } from './read.ts'
import { childPath, scanAssets, type AssetScan, type ListFolder, type ScanLimits } from './scan.ts'
import { AssetsSource, freshScanMs } from './source.ts'

export type { AssetsTabInjected, AssetsTabProps } from './AssetsTab.tsx'
export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from './formats.ts'
export type { GameAssetsLocaleKey } from './locales.ts'
export type { AssetFile, ReadBytes } from './read.ts'
export type { AssetEntry, AssetScan, ListFolder, ScanLimits } from './scan.ts'
export type { ScanState, ViewState } from './source.ts'
export type { SpriteAnimation, SpriteFrame } from './sprites.ts'
export type { FolderNode, KindFilter, TreeRow } from './tree.ts'

/** Registry id of the Assets tab type, also its slot key. */
export const TAB_ID = '@deepseek-ai/dsh-client-ui-game-assets'

/** Kind of the Assets tab. */
export const TAB_KIND = 'assets'

/** How long a reveal waits for its Session to come on screen, in milliseconds. */
export const REVEAL_WAIT_MS = 10_000

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The asset to select, the clip or 2D animation to play, and the sprite grid to read an image as. */
    assets: { readonly path: string; readonly animation?: string; readonly grid?: AssetGrid }
  }
}

/** Caps of the project scan, of one viewed file, and of the pictures drawn for agents. */
export interface Config {
  /** Folders one scan lists, the project folder included, before it stops and says the list is incomplete. */
  maxFolders?: number
  /** Assets one scan collects before it stops and says the list is incomplete. */
  maxAssets?: number
  /** Largest file the viewer reads, in bytes; a larger asset shows a notice instead. */
  maxPreviewBytes?: number
  /** Pictures this window draws at once for agents; later requests wait their turn. */
  maxAgentDraws?: number
  /**
   * Largest total size in bytes of the assets this window draws at once for agents, as each request counts its asset;
   * a larger asset draws alone.
   */
  maxAgentDrawBytes?: number
}

/** Validated scan, preview, and drawing caps. */
export const Config: z<Config, Required<Config>> = z.object({
  maxFolders: z.natural().min(1).default(2000),
  maxAssets: z.natural().min(1).default(5000),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxAgentDraws: z.natural().min(1).default(3),
  maxAgentDrawBytes: z.natural().min(1).default(64 * 1024 * 1024),
})

/** Browser services the tab needs. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles']

/**
 * Register the Assets tab type, its body and chip title, its copy, and the answers to the agent's asset tools.
 * @param ctx - the browser plugin context.
 * @param config - the scan and preview caps.
 */
export function apply(ctx: Context, config: Required<Config> = Config({})): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-assets: dictionaries')
  const t = ctx.locale.bind(NS)
  const limits: ScanLimits = { maxFolders: config.maxFolders, maxAssets: config.maxAssets }
  const viewer = (): Promise<typeof import('./viewer/index.ts')> => import('./viewer/index.ts')
  const listOf = (sessionId: SessionId): ListFolder => (path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal)
  const readOf = (sessionId: SessionId) => (path: string, maxBytes: number, signal: AbortSignal) => readAsset(
    (target, options, readSignal) => ctx.remote.workspaceFiles.readBytes(sessionId, target, options, readSignal),
    path, maxBytes, signal,
  )
  // Each Session's state with the release of its Session-scope effect; both end with the Session or this plugin.
  const sources = new Map<SessionId, { readonly source: AssetsSource; readonly release: () => void }>()
  ctx.effect(() => () => {
    for (const { release } of [...sources.values()]) release()
    sources.clear()
  }, 'ui-game-assets: Session state')
  const sourceOf = (sessionId: SessionId): AssetsSource => {
    const known = sources.get(sessionId)
    if (known !== undefined) return known.source
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-game-assets: Session ${sessionId} is not retained`)
    const source = new AssetsSource(
      listOf(sessionId),
      limits,
      () => Date.now(),
      (error) => { ctx.logger.warn('ui-game-assets: the project scan failed', error) },
    )
    const dispose = binding.ctx.effect(() => () => {
      source.close()
      if (sources.get(sessionId)?.source === source) sources.delete(sessionId)
    }, 'ui-game-assets: release Session state')
    sources.set(sessionId, { source, release: () => { void dispose() } })
    return source
  }
  // The latest project walk of each Session drawn for without an Assets tab scan, such as a teammate's or a connected
  // agent's, which the pictures drawn for that Session share while it runs and while it stays fresh.
  const walks = new Map<SessionId, { readonly scan: Promise<AssetScan | undefined>; expiresAt?: number }>()
  const walking = new AbortController()
  ctx.effect(() => () => {
    walking.abort()
    walks.clear()
  }, 'ui-game-assets: agent project walks')
  const walkOf = async (sessionId: SessionId, signal: AbortSignal): Promise<AssetScan | undefined> => {
    signal.throwIfAborted()
    const now = Date.now()
    for (const [id, known] of walks) if (known.expiresAt !== undefined && now >= known.expiresAt) walks.delete(id)
    let walk = walks.get(sessionId)
    if (walk === undefined) {
      const started: { readonly scan: Promise<AssetScan | undefined>; expiresAt?: number } = {
        scan: scanAssets(listOf(sessionId), limits, walking.signal).then(
          result => (result.ok ? result.value : undefined),
          (error: unknown) => {
            // The walk ended with this plugin, or a Remote call rejected for an assembly fault: no Godot files.
            if (!walking.signal.aborted) ctx.logger.warn('ui-game-assets: a project walk for an agent failed', error)
            return undefined
          },
        ).finally(() => { started.expiresAt = Date.now() + freshScanMs(Date.now() - now) }),
      }
      walks.set(sessionId, started)
      walk = started
    }
    // The caller stops waiting when its call ends; the walk goes on for the others.
    const waiting = Promise.withResolvers<AssetScan | undefined>()
    const stop = (): void => { waiting.reject(signal.reason) }
    signal.addEventListener('abort', stop, { once: true })
    void walk.scan.then(waiting.resolve).finally(() => { signal.removeEventListener('abort', stop) })
    return await waiting.promise
  }
  /**
   * The reads that find an image's animations in one Session.
   * @param sessionId - the Session.
   * @param scanOf - the scan whose Godot files are read.
   * @returns the reads.
   */
  const animationSources = (sessionId: SessionId, scanOf: (signal: AbortSignal) => Promise<AssetScan | undefined>): AnimationSources => ({
    async readText(path, signal) {
      const result = await readOf(sessionId)(path, MAX_TEXT_BYTES, signal)
      return result.ok ? new TextDecoder().decode(result.value.data) : undefined
    },
    async files(folder, signal) {
      const listed = await ctx.remote.workspaceFiles.list(sessionId, folder === '' ? '.' : folder, signal)
      return listed.ok ? listed.value.entries.filter(entry => entry.type === 'file').map(entry => childPath(listed.value.path, entry.name)) : []
    },
    async godot(signal) {
      const scan = await scanOf(signal)
      return { files: scan?.godotFiles ?? [], projects: scan?.godotProjects ?? [] }
    },
  })
  // An agent that just wrote a Godot resource looks for it, so its pictures use the tab's scan only while it is fresh.
  const agentSources = (sessionId: SessionId): AgentRenderSources => ({
    read: readOf(sessionId),
    animations: animationSources(sessionId, async signal => sources.get(sessionId)?.source.freshScan() ?? await walkOf(sessionId, signal)),
    relatedUrl: (base, reference) => relatedUrl(document.baseURI, base, reference),
    viewer,
  })
  const tabFace = (scopeKey: string): AssetsTabInjected => {
    const sessionId = brandString<SessionId>(scopeKey)
    const source = sourceOf(sessionId)
    return {
      hooks: { scan: source.scanState, view: source.view },
      rescan: () => { source.rescan() },
      refresh: () => { source.refresh() },
      select: (path, ask) => { source.select(path, ask) },
      setOpen: (keys) => { source.setOpen(keys) },
      setFilter: (filter) => { source.setFilter(filter) },
      read: (path, signal) => readOf(sessionId)(path, config.maxPreviewBytes, signal).catch((error: unknown) => {
        // A Remote call rejects only for an assembly fault; the viewer shows it as a failed read.
        ctx.logger.warn('ui-game-assets: reading an asset failed', error)
        return { ok: false, error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } as const
      }),
      relatedUrl: (base, reference) => relatedUrl(document.baseURI, base, reference),
      fileAddress: path => fileAddressFor(sessionId, undefined, path),
      animations: animationSources(sessionId, async signal => source.scanState.getSnapshot().scan ?? await walkOf(sessionId, signal)),
      takeNavigation: (tabId, revision) => source.takeNavigation(tabId, revision),
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    title: () => t('tab.title'),
    guide: [{ id: 'browse', order: 45, title: () => t('guide.title'), description: () => t('guide.description'), icon: AssetsGlyph }],
  }), 'ui-game-assets: Assets tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: tabFace,
  }, AssetsTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
  }, AssetsTabTitle))

  // The agent's asset tools: this window draws for the Sessions it may read, several pictures at a time in the order
  // the requests came; a window that cannot draw 3D leaves a model to another window. Once WebGL worked, it works.
  const draws = new DrawQueue(config.maxAgentDraws, config.maxAgentDrawBytes)
  let drawsModels = false
  ctx.effect(() => ctx.remote.$on('game-assets/render', function (request, next) {
    const sessionId = ctx.sessions.scopeOf(this)
    if (sessionId === undefined || (request.kind === 'model' && !(drawsModels ||= canDrawModels()))) return next()
    const { agent: _agent, signal = new AbortController().signal, ...fields } = request
    return draws.run(fields.bytes, signal, () => answerRender(fields, agentSources(sessionId), signal))
  }), 'ui-game-assets: draw assets for agents')
  // Only the latest reveal goes on: one that waits for its Session to come on screen stops when another arrives.
  let revealing: (() => void) | undefined
  ctx.effect(() => () => { revealing?.() }, 'ui-game-assets: stop the waiting reveal')
  ctx.effect(() => ctx.remote.$on('game-assets/reveal', (reveal) => {
    revealing?.()
    revealing = revealAsset(ctx, reveal)
  }), 'ui-game-assets: reveal assets')
}

/** How often a reveal tries again while the Session's sidebar surface is not mounted yet, in milliseconds. */
const REVEAL_RETRY_MS = 50

/**
 * Open an asset in its Session's Assets tab: at once when the Session is on screen, or after the window shows it. The
 * sidebar reports a Session on screen in the render before its surface takes commands, so an open that finds no
 * surface tries again until {@link REVEAL_WAIT_MS} has passed.
 * @param ctx - the browser plugin context.
 * @param reveal - the Session, the asset, and the animation to play.
 * @returns a function that stops the reveal if it has not opened the tab yet.
 */
function revealAsset(ctx: Context, reveal: AssetReveal): () => void {
  const sidebar = ctx.get('sidebarRight')
  if (sidebar === undefined) return () => {}
  const deadline = Date.now() + REVEAL_WAIT_MS
  let retry: ReturnType<typeof setTimeout> | undefined
  const open = (): void => {
    retry = undefined
    if (sidebar.mounted.getSnapshot() !== reveal.sessionId) return
    try {
      sidebar.openTab(TAB_KIND, {
        params: {
          path: reveal.path,
          ...reveal.animation === undefined ? {} : { animation: reveal.animation },
          ...reveal.grid === undefined ? {} : { grid: reveal.grid },
        },
      })
    } catch (error) {
      // Error: the Session's surface mounts in the render after it came on screen; another try follows shortly.
      if (Date.now() < deadline) retry = setTimeout(open, REVEAL_RETRY_MS)
      else ctx.logger.warn('ui-game-assets: the Assets tab could not be opened for an agent', error)
    }
  }
  if (sidebar.mounted.getSnapshot() === reveal.sessionId) {
    open()
    return () => { clearTimeout(retry) }
  }
  const workspace = ctx.get('uiWorkspace')
  if (workspace === undefined) return () => {}
  const stop = sidebar.mounted.subscribe(() => {
    if (sidebar.mounted.getSnapshot() !== reveal.sessionId) return
    stop()
    clearTimeout(timer)
    open()
  })
  const timer = setTimeout(stop, REVEAL_WAIT_MS)
  workspace.openSession(reveal.sessionId)
  return () => {
    stop()
    clearTimeout(timer)
    clearTimeout(retry)
  }
}
