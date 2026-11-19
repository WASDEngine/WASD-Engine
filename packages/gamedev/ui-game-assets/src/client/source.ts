/**
 * One Session's Assets tab state outside React: the latest project scan, kept as the game project tabs keep their
 * walks (`ProjectSource` in `project-tab.ts`), and the reader's choices (the selected asset, the open folders of the
 * picker's tree, and the kind filter). The state lives until the Session's scope ends, so the tab shows it again when
 * it is reopened.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AssetGrid } from '@deepseek-ai/dsh-game-assets/types'
import { ProjectSource, type ListFolder, type ProjectScanState } from './project-tab.ts'
import { scanAssets, type AssetScan, type ScanLimits } from './scan.ts'
import type { KindFilter } from './tree.ts'

/** Where the project scan stands. */
export type ScanState = ProjectScanState<AssetScan>

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

/** One Session's Assets tab state. */
export class AssetsSource extends ProjectSource<AssetScan> {
  /** The reader's choices. */
  readonly view: SnapshotStore<ViewState> = createSnapshotStore<ViewState>({ selected: undefined, open: undefined, filter: 'all' })
  private requests = 0

  /**
   * @param list - the Session's bound folder listing.
   * @param limits - the scan caps.
   * @param now - the clock, in milliseconds since the epoch.
   * @param report - receives a scan that threw instead of returning a Remote failure.
   */
  constructor(list: ListFolder, limits: ScanLimits, now: () => number, report: (error: unknown) => void) {
    super(createSnapshotStore<ScanState>({ status: 'idle' }), signal => scanAssets(list, limits, signal), now, report)
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
}
