/**
 * One Session's Assets tab state outside React: the latest project scan and the reader's choices (the selected asset,
 * the open folders of the picker's tree, and the kind filter). A scan keeps the previous result on screen while it
 * runs and after it fails; a second request while one runs is dropped, because the running scan reads the same
 * folders. The state lives until the Session's scope ends, so the tab shows it again when it is reopened.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
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
}

/**
 * Scan freshness the tab accepts when it shows again or the picker opens, in milliseconds; a project whose scan takes
 * longer is scanned again only after ten times its last scan's duration, so a large project is not walked on every
 * open.
 */
export const FRESH_SCAN_MS = 2000

/** How many times its own duration a scan stays fresh. */
const FRESH_SCAN_FACTOR = 10

/** One Session's Assets tab state. */
export class AssetsSource {
  /** The project scan. */
  readonly scanState: SnapshotStore<ScanState> = createSnapshotStore<ScanState>({ status: 'idle' })
  /** The reader's choices. */
  readonly view: SnapshotStore<ViewState> = createSnapshotStore<ViewState>({ selected: undefined, open: undefined, filter: 'all' })
  private running: AbortController | undefined
  private closed = false
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
    const fresh = Math.max(FRESH_SCAN_MS, this.lastDuration * FRESH_SCAN_FACTOR)
    if (settledAt !== undefined && this.now() - settledAt < fresh) return
    this.rescan()
  }

  /**
   * Select an asset.
   * @param path - workspace path of the asset, or undefined to clear the selection.
   */
  select(path: string | undefined): void {
    this.view.set({ ...this.view.getSnapshot(), selected: path })
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
