/**
 * Assets tab, browser half: the right Sidebar's `assets` page type with its guide entry, its body, and its chip
 * title. The body lists the 2D and 3D art of the Session's game project in a searchable picker, sorted into the
 * project's folders, and shows the selected asset: images in a zoomable view that plays their 2D animations, and
 * models in a 3D view that three.js draws from a chunk loaded on first use, with their clips, skeleton, and details.
 * Each Session keeps its scan and choices until its scope ends. Every file the tab and its pictures read comes through
 * the Host's `GET /api/game-assets.file` route inside the Session's project folder, which a link inside the project
 * cannot lead a read out of. The plugin also answers the agent's asset tools: it draws an asset for a
 * `game-assets/render` request of a Session it may read, inside the folder the request names, and opens an asset in the
 * Session's Assets tab for `game-assets/reveal`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the ctx.remote merge with the `workspaceFiles` namespace and the forwarded events, the `file` resource
// protocol, the sessions service and its list of Sessions with their folders, and the right Sidebar's registry and seats.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetGrid } from '@deepseek-ai/dsh-game-assets/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { answerRender, canDrawModels, drawWeight, HEAD_BYTES, type AgentRenderSources } from './agent.ts'
import { MAX_TEXT_BYTES, type AnimationSources } from './animations2d.ts'
import { AssetsTab, AssetsTabTitle, type AssetsTabInjected } from './AssetsTab.tsx'
import { AssetsGlyph } from './icon.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { DrawQueue } from './queue.ts'
import { readAsset, readHead, relatedUrl, type AssetFile } from './read.ts'
import { childPath, revealTab, sessionStates, type ListFolder } from './project-tab.ts'
import { scanAssets, type AssetScan, type ScanLimits } from './scan.ts'
import { AssetsSource } from './source.ts'
import { ProjectWalks } from './walks.ts'

export type { AssetsTabInjected, AssetsTabProps, ViewerLimits } from './AssetsTab.tsx'
export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from './formats.ts'
export type { GameAssetsLocaleKey } from './locales.ts'
export type { AssetFile } from './read.ts'
export type { ListFolder } from './project-tab.ts'
export type { AssetEntry, AssetScan, ScanLimits } from './scan.ts'
export type { ScanState, ViewState } from './source.ts'
export type { SpriteAnimation, SpriteFrame } from './sprites.ts'
export type { FolderNode, KindFilter, TreeRow } from './tree.ts'

/** Registry id of the Assets tab type, also its slot key. */
export const TAB_ID = '@deepseek-ai/dsh-client-ui-game-assets'

/** Kind of the Assets tab. */
export const TAB_KIND = 'assets'

export { REVEAL_WAIT_MS } from './project-tab.ts'

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
  /**
   * Largest file the viewer reads, in bytes; also the most memory a model's loader may allocate beyond its files as the
   * file asks for it, the most a glTF model and the files it names take together, and the most a model's textures take
   * in their files and again decoded. A larger asset shows a notice instead.
   */
  maxPreviewBytes?: number
  /**
   * Most pixels, width times height, of an image the viewer decodes, as its header states them before any pixel is
   * decoded; a larger image shows a notice instead, and an agent's picture of it fails.
   */
  maxDecodedPixels?: number
  /** Pictures this window draws at once for agents; later requests wait their turn. */
  maxAgentDraws?: number
  /**
   * Largest total memory in bytes that the pictures this window draws at once for agents decode, as each request counts
   * it: an image its file and the pixels its header states, a model what the Host counted, its file, the files it names,
   * and the memory its textures, a VOX file's meshes, and an FBX file's arrays take; a larger draw draws alone.
   */
  maxAgentDrawBytes?: number
}

/** Validated scan, preview, and drawing caps. */
export const Config: z<Config, Required<Config>> = z.object({
  maxFolders: z.natural().min(1).default(2000),
  maxAssets: z.natural().min(1).default(5000),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxDecodedPixels: z.natural().min(1).default(8192 * 8192),
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
  /** The Session's project folder, from the Host's list of Sessions; undefined until the list names one. */
  const folderOf = (sessionId: SessionId): string | undefined => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  type Read = (path: string, maxBytes: number, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>
  const readIn = (root: string | undefined): Read => async (path, maxBytes, signal) => {
    if (root === undefined) return { ok: false, error: new RemoteError('game-assets/unreadable', 'The Session names no project folder to read from.', { path }) }
    return await readAsset(document.baseURI, root, path, maxBytes, signal)
  }
  const readOf = (sessionId: SessionId): Read => (path, maxBytes, signal) => readIn(folderOf(sessionId))(path, maxBytes, signal)
  const sourceOf = sessionStates(ctx, 'ui-game-assets', sessionId => new AssetsSource(
    listOf(sessionId),
    limits,
    () => Date.now(),
    (error) => { ctx.logger.warn('ui-game-assets: the project scan failed', error) },
  ))
  // The project walks of the Sessions drawn for, whose Godot files an image's animations come from: the pictures drawn
  // for an agent use only a walk that started after their request arrived, so a scene the agent just wrote is in it.
  const walking = new AbortController()
  ctx.effect(() => () => { walking.abort() }, 'ui-game-assets: project walks')
  const walkProject = (sessionId: string, signal: AbortSignal): Promise<AssetScan | undefined> => scanAssets(
    listOf(brandString<SessionId>(sessionId)), limits, signal,
  ).then(
    result => (result.ok ? result.value : undefined),
    (error: unknown) => {
      // The walk ended with this plugin, or a Remote call rejected for an assembly fault: no Godot files.
      if (!signal.aborted) ctx.logger.warn('ui-game-assets: a project walk failed', error)
      return undefined
    },
  )
  const walks = new ProjectWalks<AssetScan>(walkProject, () => Date.now(), walking.signal)
  /**
   * The reads that find an image's animations in one Session.
   * @param sessionId - the Session.
   * @param scanOf - the scan whose Godot files are read.
   * @returns the reads.
   */
  const animationSources = (
    sessionId: SessionId,
    read: (path: string, maxBytes: number, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>,
    scanOf: (signal: AbortSignal) => Promise<AssetScan | undefined>,
  ): AnimationSources => ({
    async readText(path, signal) {
      const result = await read(path, MAX_TEXT_BYTES, signal)
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
  // An agent that just wrote a Godot resource looks for it, so its pictures use a walk that started after its request.
  // Every read of a draw stays inside the folder its request names.
  const agentSources = (sessionId: SessionId, ticket: number, root: string, maxBytes: number): AgentRenderSources => ({
    read: readIn(root),
    async readHead(path, signal) {
      return await readHead(document.baseURI, root, path, HEAD_BYTES, signal).catch(() => {
        // AbortError: the draw counts the file alone, and a cancelled one ends before its turn.
        return undefined
      })
    },
    animations: animationSources(sessionId, readIn(root), signal => walks.get(sessionId, ticket, signal)),
    relatedUrl: (path, reference) => relatedUrl(document.baseURI, root, path, reference, maxBytes),
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
        // A cancelled read rejects with its reason, whose answer the viewer drops; anything else is a fault to name.
        if (!signal.aborted) ctx.logger.warn('ui-game-assets: reading an asset failed', error)
        return { ok: false, error: new RemoteError('game-assets/unreadable', error instanceof Error ? error.message : String(error), { path }) } as const
      }),
      relatedUrl: (path, reference) => {
        const root = folderOf(sessionId)
        return root === undefined ? undefined : relatedUrl(document.baseURI, root, path, reference, config.maxPreviewBytes)
      },
      fileAddress: path => fileAddressFor(sessionId, undefined, path),
      animations: animationSources(
        sessionId,
        readOf(sessionId),
        async signal => source.scanState.getSnapshot().scan ?? await walks.get(sessionId, walks.ticket(), signal),
      ),
      limits: { maxPreviewBytes: config.maxPreviewBytes, maxDecodedPixels: config.maxDecodedPixels },
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
  const drawLimits = { maxDecodedPixels: config.maxDecodedPixels }
  let drawsModels = false
  ctx.effect(() => ctx.remote.$on('game-assets/render', function (request, next) {
    const sessionId = ctx.sessions.scopeOf(this)
    if (sessionId === undefined || (request.kind === 'model' && !(drawsModels ||= canDrawModels()))) return next()
    const { agent: _agent, signal = new AbortController().signal, ...fields } = request
    const reads = agentSources(sessionId, walks.ticket(), fields.root, fields.maxBytes)
    // A draw counts the memory it decodes, which an image's header gives before the draw waits for its turn.
    return drawWeight(fields, reads, drawLimits, signal).then(
      weight => draws.run(weight, signal, () => answerRender(fields, reads, drawLimits, signal)),
    )
  }), 'ui-game-assets: draw assets for agents')
  // Only the latest reveal goes on: one that waits for its Session to come on screen stops when another arrives.
  let revealing: (() => void) | undefined
  ctx.effect(() => () => { revealing?.() }, 'ui-game-assets: stop the waiting reveal')
  ctx.effect(() => ctx.remote.$on('game-assets/reveal', (reveal) => {
    revealing?.()
    revealing = revealTab(ctx, reveal.sessionId, TAB_KIND, {
      path: reveal.path,
      ...reveal.animation === undefined ? {} : { animation: reveal.animation },
      ...reveal.grid === undefined ? {} : { grid: reveal.grid },
    }, 'ui-game-assets: the Assets tab could not be opened for an agent')
  }), 'ui-game-assets: reveal assets')
}
