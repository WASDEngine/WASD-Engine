/**
 * One Session's Assets tab state outside React: the latest project scan and the reader's choices (the selected asset,
 * the open folders of the picker's tree, and the kind filter). A scan keeps the previous result on screen while it
 * runs and after it fails; a second request while one runs is dropped, because the running scan reads the same
 * folders. The state lives until the Session's scope ends, so the tab shows it again when it is reopened.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { AssetGrid } from '@deepseek-ai/dsh-game-assets/types'
import { scanAssets, type AssetScan, type ListFolder, type ScanLimits } from './scan.ts'
import type { KindFilter } from './tree.ts'

/** Where the project scan stands. */
export interface ScanState {
  /** `idle` before the first scan; `scanning` while one runs; then whether the latest one succeeded. */
  readonly status: 'idle' | 'scanning' | 'ready' | 'failed'
  /** The latest successful scan, kept while a later one runs or after it fails. */
  readonly scan?: AssetScan
  /** The latest scan's failure; cleared by the next successful scan. */
  readonly failure?: RemoteFailure
  /** When the latest scan settled, in milliseconds since the epoch. */
  readonly settledAt?: number
}

/** The reader's choices in the tab. */
export interface ViewState {
  /** Workspace path of the selected asset; undefined while none is selected. */
  readonly selected: string | undefined
  /** Row keys of the picker's open folders; undefined until the picker first draws a scan. */
  readonly open: readonly string[] | undefined
  /** Which kinds the picker shows. */
  readonly filter: KindFilter
  /** What an agent asked the viewer to show with the selected asset; the viewer applies each request once. */
  readonly asked?: ViewRequest & { readonly path: string }
}

/** What to show with an asset: a clip or 2D animation to play, and a sprite grid to read an image as. */
export interface ViewAsk {
  readonly animation?: string
  readonly grid?: AssetGrid
}

/** One ask, numbered so that the viewer applies it once. */
export interface ViewRequest extends ViewAsk {
  readonly request: number
}

/**
 * Scan freshness the tab accepts when it shows again or the picker opens, in milliseconds; a project whose scan takes
 * longer is scanned again only after ten times its last scan's duration, so a large project is not walked on every
 * open.
 */
export const FRESH_SCAN_MS = 2000

/** How many times its own duration a scan stays fresh. */
const FRESH_SCAN_FACTOR = 10

/**
 * How long a scan stays fresh.
 * @param durationMs - how long the scan took, in milliseconds.
 * @returns {@link FRESH_SCAN_MS}, or ten times the scan's duration when that is longer.
 */
export function freshScanMs(durationMs: number): number {
  return Math.max(FRESH_SCAN_MS, durationMs * FRESH_SCAN_FACTOR)
}

/** One Session's Assets tab state. */
export class AssetsSource {
  /** The project scan. */
  readonly scanState: SnapshotStore<ScanState> = createSnapshotStore<ScanState>({ status: 'idle' })
  /** The reader's choices. */
  readonly view: SnapshotStore<ViewState> = createSnapshotStore<ViewState>({ selected: undefined, open: undefined, filter: 'all' })
  private running: AbortController | undefined
  private closed = false
  private requests = 0
  /** The latest navigation revision each tab acted on. */
  private readonly navigations = new Map<string, number>()
  /** How long the latest settled scan took, in milliseconds. */
  private lastDuration = 0

  /**
   * @param list - the Session's bound folder listing.
   * @param limits - the scan caps.
   * @param now - the clock, in milliseconds since the epoch.
   * @param report - receives a scan that threw instead of returning a Remote failure.
   */
  constructor(
    private readonly list: ListFolder,
    private readonly limits: ScanLimits,
    private readonly now: () => number,
    private readonly report: (error: unknown) => void,
  ) {}

  /** Scan the project unless a scan runs or the source is closed. */
  rescan(): void {
    if (this.closed || this.running !== undefined) return
    const controller = new AbortController()
    this.running = controller
    const startedAt = this.now()
    this.scanState.set({ ...this.scanState.getSnapshot(), status: 'scanning' })
    void scanAssets(this.list, this.limits, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      this.lastDuration = this.now() - startedAt
      this.scanState.set(result.ok
        ? { status: 'ready', scan: result.value, settledAt: this.now() }
        : { status: 'failed', ...this.kept(), failure: result.error, settledAt: this.now() })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      this.report(error)
      this.scanState.set({ status: 'failed', ...this.kept(), settledAt: this.now() })
    }).finally(() => {
      if (this.running === controller) this.running = undefined
    })
  }

  /** Scan unless the latest scan is fresh, by {@link FRESH_SCAN_MS} or ten times its duration, or one runs. */
  refresh(): void {
    const settledAt = this.scanState.getSnapshot().settledAt
    if (settledAt !== undefined && this.now() - settledAt < freshScanMs(this.lastDuration)) return
    this.rescan()
  }

  /**
   * The latest scan while it is fresh, by {@link FRESH_SCAN_MS} or ten times its duration.
   * @returns the scan, or undefined when there is none or it is older.
   */
  freshScan(): AssetScan | undefined {
    const { scan, settledAt } = this.scanState.getSnapshot()
    return settledAt !== undefined && this.now() - settledAt < freshScanMs(this.lastDuration) ? scan : undefined
  }

  /**
   * Select an asset.
   * @param path - workspace path of the asset, or undefined to clear the selection.
   * @param ask - the clip or 2D animation to play and the grid to read an image as, when the viewer shows it.
   */
  select(path: string | undefined, ask?: ViewAsk): void {
    const { asked: _previous, ...rest } = this.view.getSnapshot()
    if (path === undefined || ask === undefined || (ask.animation === undefined && ask.grid === undefined)) {
      this.view.set({ ...rest, selected: path })
      return
    }
    this.requests += 1
    this.view.set({ ...rest, selected: path, asked: { ...ask, path, request: this.requests } })
  }

  /**
   * Replace the open folders.
   * @param keys - row keys of the open folders.
   */
  setOpen(keys: readonly string[]): void {
    this.view.set({ ...this.view.getSnapshot(), open: [...keys] })
  }

  /**
   * Choose which kinds the picker shows.
   * @param filter - the kinds.
   */
  setFilter(filter: KindFilter): void {
    this.view.set({ ...this.view.getSnapshot(), filter })
  }

  /**
   * Note that a tab acts on one of its navigations.
   * @param tabId - the tab.
   * @param revision - the navigation's revision; 0 names no navigation.
   * @returns true the first time the tab reaches this revision, so each navigation applies once however often its
   * body mounts.
   */
  takeNavigation(tabId: string, revision: number): boolean {
    if (revision === 0 || this.navigations.get(tabId) === revision) return false
    this.navigations.set(tabId, revision)
    return true
  }

  /** Stop the running scan; later requests do nothing. */
  close(): void {
    this.closed = true
    this.running?.abort()
    this.running = undefined
  }

  private kept(): Pick<ScanState, 'scan'> {
    const scan = this.scanState.getSnapshot().scan
    return scan === undefined ? {} : { scan }
  }
}
