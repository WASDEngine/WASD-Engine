/**
 * Assets tab, browser half: the right Sidebar's `assets` page type with its guide entry, its body, and its chip
 * title. The body lists the 2D and 3D art of the Session's game project in a searchable picker, sorted into the
 * project's folders, and shows the selected asset: images in a zoomable view and models in a 3D view that three.js
 * draws from a chunk loaded on first use. Each Session keeps its scan and choices until its scope ends.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the ctx.remote merge with the `workspaceFiles` namespace, the `file` resource protocol, the sessions
// service, and the right Sidebar's registry and seats.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { AssetsTab, AssetsTabTitle, type AssetsTabInjected } from './AssetsTab.tsx'
import { AssetsGlyph } from './icon.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { readAsset, relatedUrl } from './read.ts'
import { AssetsSource } from './source.ts'

export type { AssetsTabInjected, AssetsTabProps } from './AssetsTab.tsx'
export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from './formats.ts'
export type { GameAssetsLocaleKey } from './locales.ts'
export type { AssetFile, ReadBytes } from './read.ts'
export type { AssetEntry, AssetScan, ListFolder, ScanLimits } from './scan.ts'
export type { ScanState, ViewState } from './source.ts'
export type { FolderNode, KindFilter, TreeRow } from './tree.ts'

/** Registry id of the Assets tab type, also its slot key. */
export const TAB_ID = '@deepseek-ai/dsh-client-ui-game-assets'

/** Kind of the Assets tab. */
export const TAB_KIND = 'assets'

/** Caps of the project scan and of one viewed file. */
export interface Config {
  /** Folders one scan lists, the project folder included, before it stops and says the list is incomplete. */
  maxFolders?: number
  /** Assets one scan collects before it stops and says the list is incomplete. */
  maxAssets?: number
  /** Largest file the viewer reads, in bytes; a larger asset shows a notice instead. */
  maxPreviewBytes?: number
}

/** Validated scan and preview caps. */
export const Config: z<Config, Required<Config>> = z.object({
  maxFolders: z.natural().min(1).default(2000),
  maxAssets: z.natural().min(1).default(5000),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
})

/** Browser services the tab needs. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles']

/**
 * Register the Assets tab type, its body and chip title, and its copy.
 * @param ctx - the browser plugin context.
 * @param config - the scan and preview caps.
 */
export function apply(ctx: Context, config: Required<Config> = Config({})): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-assets: dictionaries')
  const t = ctx.locale.bind(NS)
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
      (path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal),
      { maxFolders: config.maxFolders, maxAssets: config.maxAssets },
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
  const tabFace = (scopeKey: string): AssetsTabInjected => {
    const sessionId = brandString<SessionId>(scopeKey)
    const source = sourceOf(sessionId)
    return {
      hooks: { scan: source.scanState, view: source.view },
      rescan: () => { source.rescan() },
      refresh: () => { source.refresh() },
      select: (path) => { source.select(path) },
      setOpen: (keys) => { source.setOpen(keys) },
      setFilter: (filter) => { source.setFilter(filter) },
      read: (path, signal) => readAsset(
        (target, options, readSignal) => ctx.remote.workspaceFiles.readBytes(sessionId, target, options, readSignal),
        path, config.maxPreviewBytes, signal,
      ).catch((error: unknown) => {
        // A Remote call rejects only for an assembly fault; the viewer shows it as a failed read.
        ctx.logger.warn('ui-game-assets: reading an asset failed', error)
        return { ok: false, error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } as const
      }),
      relatedUrl: (base, reference) => relatedUrl(document.baseURI, base, reference),
      fileAddress: path => fileAddressFor(sessionId, undefined, path),
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
}
