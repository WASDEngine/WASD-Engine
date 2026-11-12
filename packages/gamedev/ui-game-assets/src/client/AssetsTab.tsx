/** Body and chip title of the Assets tab: the asset picker and refresh control above the selected asset's viewer. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AnimationSources } from './animations2d.ts'
import { AssetPicker } from './AssetPicker.tsx'
import { AssetViewer } from './AssetViewer.tsx'
import { formatOf } from './formats.ts'
import { AssetsGlyph } from './icon.tsx'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry, AssetScan } from './scan.ts'
import type { ScanState, ViewAsk, ViewState } from './source.ts'
import type { KindFilter } from './tree.ts'
import css from './AssetsTab.module.css'

/** Business face of the Assets tab body, bound to one Session. */
export interface AssetsTabInjected {
  /** The project scan and the reader's choices; the renderer binds them as `useScan` and `useView`. */
  readonly hooks: { readonly scan: HostObservable<ScanState>; readonly view: HostObservable<ViewState> }
  /** Scan the project now, unless a scan runs. */
  readonly rescan: () => void
  /** Scan the project unless the latest scan is fresh or one runs. */
  readonly refresh: () => void
  /**
   * Select an asset.
   * @param path - workspace path of the asset to show, or undefined for none.
   * @param ask - the clip or 2D animation to play and the grid to read an image as, when it shows.
   */
  readonly select: (path: string | undefined, ask?: ViewAsk) => void
  /** @param keys - row keys of the picker's open folders. */
  readonly setOpen: (keys: readonly string[]) => void
  /** @param filter - the kinds the picker shows. */
  readonly setFilter: (filter: KindFilter) => void
  /**
   * Read an asset completely.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns the file, or the failure to show.
   */
  readonly read: (path: string, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>
  /**
   * The URL of a file that a viewed model or material names.
   * @param base - absolute path of the viewed file.
   * @param reference - the name as the loader requested it.
   * @returns the URL to load.
   */
  readonly relatedUrl: (base: string, reference: string) => string
  /**
   * The `file` resource address of an asset, which reports its version as it changes.
   * @param path - workspace path.
   * @returns the `dsh-resource://file/…` address.
   */
  readonly fileAddress: (path: string) => string
  /** The reads that find an image's 2D animations. */
  readonly animations: AnimationSources
  /**
   * Note that a tab acts on one of its navigations.
   * @param tabId - the tab.
   * @param revision - the navigation's revision.
   * @returns true the first time the tab reaches this revision.
   */
  readonly takeNavigation: (tabId: string, revision: number) => boolean
}

/** Full props of the Assets tab body. */
export type AssetsTabProps =
  & Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useResource' | 'useTabInfo'>
  & InjectFace<AssetsTabInjected>
  & PropsLocale<typeof NS>

/**
 * The selected asset as the latest scan lists it, or, for one the scan does not list, as its path names it.
 * @param path - workspace path of the selection.
 * @param scan - the latest scan.
 * @returns the asset, or undefined without a selection or for a path of no listed format.
 */
export function selectedAsset(path: string | undefined, scan: AssetScan | undefined): AssetEntry | undefined {
  if (path === undefined) return undefined
  const listed = scan?.assets.find(asset => asset.path === path)
  if (listed !== undefined) return listed
  const format = formatOf(path)
  if (format === undefined) return undefined
  const slash = path.lastIndexOf('/')
  return { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format }
}

/**
 * Render the Assets tab of one Session. Showing the tab scans the project unless the latest scan is fresh, and so does
 * opening the picker; the refresh control scans again and reloads the viewed asset. Opening the tab with a `path`
 * parameter, as an agent's `show` does, selects that asset and plays the `animation` it names.
 * @param props - the file resource hook, the tab's navigation, the Session's face, and copy.
 * @returns the tab body.
 */
export function AssetsTab({
  useResource, useTabInfo, useScan, useView, rescan, refresh, select, setOpen, setFilter, read, relatedUrl, fileAddress, animations,
  takeNavigation, t,
}: AssetsTabProps): ReactNode {
  const scanState = useScan(state => state)
  const view = useView(state => state)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [reloads, setReloads] = useState(0)
  useEffect(() => { refresh() }, [refresh])
  const { id: tabId, navigation } = useTabInfo().tab
  // Each navigation that names an asset selects it once, also when the body mounts after it.
  useEffect(() => {
    if (!takeNavigation(tabId, navigation.revision)) return
    const params = navigation.params
    if (params === undefined || !('path' in params) || typeof params.path !== 'string') return
    select(params.path, {
      ...'animation' in params && typeof params.animation === 'string' ? { animation: params.animation } : {},
      ...'grid' in params ? { grid: params.grid } : {},
    })
  }, [navigation, select, tabId, takeNavigation])
  const scan = scanState.scan
  const selected = useMemo(() => selectedAsset(view.selected, scan), [view.selected, scan])
  const openPicker = (open: boolean): void => {
    setPickerOpen(open)
    if (open) refresh()
  }

  let content: ReactNode
  if (scan === undefined) {
    content = scanState.status === 'failed'
      ? (
        <div className={css.centered} role="alert">
          <p className={css.message}>{t('picker.failed')}</p>
          <Button size="sm" variant="outline" onClick={rescan}>{t('action.retry')}</Button>
        </div>
      )
      : <div className={css.centered} role="status" aria-label={t('picker.scanning')}><StateDot state="ongoing" /></div>
  } else if (selected === undefined) {
    content = scan.assets.length === 0
      ? (
        <div className={css.centered}>
          <AssetsGlyph size={28} className={css.emptyGlyph} />
          <p className={css.title}>{t('state.empty.title')}</p>
          <p className={css.message}>{t('state.empty.description')}</p>
        </div>
      )
      : (
        <div className={css.centered}>
          <AssetsGlyph size={28} className={css.emptyGlyph} />
          <p className={css.title}>{t('state.choose.title')}</p>
          <p className={css.message}>
            {t(scan.assets.length === 1 ? 'state.count.one' : 'state.count.other', { count: scan.assets.length })}
          </p>
          <Button size="sm" variant="outline" onClick={() => { openPicker(true) }}>{t('action.browse')}</Button>
        </div>
      )
  } else {
    const asked = view.asked
    const requested = asked !== undefined && asked.path === selected.path ? asked : undefined
    content = (
      <AssetViewer
        key={`${selected.path}#${String(reloads)}`}
        asset={selected}
        assets={scan.assets}
        useResource={useResource}
        read={read}
        relatedUrl={relatedUrl}
        fileAddress={fileAddress}
        animations={animations}
        requested={requested}
        onSelect={(path) => { select(path) }}
        t={t}
      />
    )
  }

  return (
    <div className={css.root} data-game-assets>
      <div className={css.toolbar}>
        <AssetPicker
          scanState={scanState}
          view={view}
          selected={selected}
          open={pickerOpen}
          onOpenChange={openPicker}
          onSelect={select}
          onOpenFolders={setOpen}
          onFilter={setFilter}
          onRetry={rescan}
          t={t}
        />
        <Tooltip label={t('action.refresh')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('action.refresh')}
            aria-busy={scanState.status === 'scanning'}
            onClick={() => {
              rescan()
              setReloads(count => count + 1)
            }}
          >
            {scanState.status === 'scanning' ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />}
          </button>
        </Tooltip>
      </div>
      {scan !== undefined && scanState.status === 'failed' && (
        <div className={css.notice} role="alert">
          <span className={css.noticeText}>{t('picker.failed')}</span>
          <Button size="sm" variant="outline" onClick={rescan}>{t('action.retry')}</Button>
        </div>
      )}
      <div className={css.stage}>{content}</div>
    </div>
  )
}

/**
 * Render the tab chip title.
 * @param props - Assets tab copy.
 * @returns the Assets glyph followed by the tab name.
 */
export function AssetsTabTitle({ t }: PropsLocale<typeof NS>): ReactNode {
  return (
    <>
      <AssetsGlyph />
      <span className={css.chipTitle}>{t('tab.title')}</span>
    </>
  )
}
