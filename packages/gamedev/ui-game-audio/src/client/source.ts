/**
 * One Session's Audio tab state outside React: the latest walk of the project for sounds, what each sound's headers
 * say (its length, rate, and channels, read a few at a time after each walk), and the listener's choices (the
 * selected sound, the search text, the kind filter, and the folders folded shut). A walk keeps the previous result on
 * screen while it runs and after it fails; a second request while one runs is dropped. The state lives until the
 * Session's scope ends, so the tab shows it again when it is reopened.
 */
import type { AudioCategory, AudioProbe } from '@deepseek-ai/dsh-game-audio/audio'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { scanSounds, type ListFolder, type ScanLimits, type SoundEntry, type SoundScan } from './scan.ts'

/** Where the walk stands. */
export interface ScanState {
  /** `idle` before the first walk; `scanning` while one runs; then whether the latest one succeeded. */
  readonly status: 'idle' | 'scanning' | 'ready' | 'failed'
  /** The latest successful walk, kept while a later one runs or after it fails. */
  readonly scan?: SoundScan
  /** The latest walk's failure; cleared by the next successful walk. */
  readonly failure?: RemoteFailure
  /** When the latest walk settled, in milliseconds since the epoch. */
  readonly settledAt?: number
}

/** Which sounds the list shows: every kind, or one. */
export type KindFilter = 'all' | AudioCategory

/** The listener's choices in the tab. */
export interface ViewState {
  /** Workspace path of the selected sound; undefined while none is selected. */
  readonly selected: string | undefined
  /** The search text. */
  readonly query: string
  readonly filter: KindFilter
  /** Workspace paths of the folders folded shut. */
  readonly closed: readonly string[]
}

/** What a sound's headers said, for the size it had when they were read. */
export interface ProbeEntry {
  readonly bytes: number | undefined
  /** The facts; undefined for headers the probe does not read. */
  readonly probe: AudioProbe | undefined
}

/**
 * Read what one sound's headers say.
 * @param sound - the sound.
 * @param signal - cancellation.
 * @returns the facts, or undefined.
 */
export type ProbeSound = (sound: SoundEntry, signal: AbortSignal) => Promise<AudioProbe | undefined>

/**
 * Walk freshness the tab accepts when it shows again, in milliseconds; a project whose walk takes longer is walked
 * again only after ten times its last walk's duration.
 */
export const FRESH_SCAN_MS = 2000

/** How many times its own duration a walk stays fresh. */
const FRESH_SCAN_FACTOR = 10

/** Header probes in flight at once. */
const PROBES_AT_ONCE = 4

/** Probe results gathered before the tab redraws with them. */
const PROBES_PER_UPDATE = 16

/** One Session's Audio tab state. */
export class AudioSource {
  /** The walk. */
  readonly scanState: SnapshotStore<ScanState> = createSnapshotStore<ScanState>({ status: 'idle' })
  /** The listener's choices. */
  readonly view: SnapshotStore<ViewState> = createSnapshotStore<ViewState>({ selected: undefined, query: '', filter: 'all', closed: [] })
  /** What each sound's headers said, by workspace path. */
  readonly probes: SnapshotStore<ReadonlyMap<string, ProbeEntry>> = createSnapshotStore<ReadonlyMap<string, ProbeEntry>>(new Map())
  private running: AbortController | undefined
  private probing: AbortController | undefined
  private closed = false
  /** How long the latest settled walk took, in milliseconds. */
  private lastDuration = 0
  /** The navigation revision each tab took last. */
  private readonly navigations = new Map<string, number>()

  /**
   * @param list - the Session's bound folder listing.
   * @param probe - reads one sound's headers.
   * @param limits - the walk's caps.
   * @param now - the clock, in milliseconds since the epoch.
   * @param report - receives a walk or probe that threw instead of returning a Remote failure.
   */
  constructor(
    private readonly list: ListFolder,
    private readonly probe: ProbeSound,
    private readonly limits: ScanLimits,
    private readonly now: () => number,
    private readonly report: (error: unknown) => void,
  ) {}

  /** Walk the project unless a walk runs or the source is closed. */
  rescan(): void {
    if (this.closed || this.running !== undefined) return
    const walk = new AbortController()
    this.running = walk
    this.scanState.set({ ...this.scanState.getSnapshot(), status: 'scanning' })
    void this.walk(walk.signal).finally(() => {
      if (this.running === walk) this.running = undefined
    })
  }

  /** Run one walk and publish its outcome unless it was stopped; then read the new sounds' headers. */
  private async walk(signal: AbortSignal): Promise<void> {
    const began = this.now()
    let next: ScanState
    try {
      const outcome = await scanSounds(this.list, this.limits, signal)
      next = outcome.ok
        ? { status: 'ready', scan: outcome.value, settledAt: this.now() }
        : { status: 'failed', ...this.kept(), failure: outcome.error, settledAt: this.now() }
    } catch (error) {
      if (signal.aborted) return
      this.report(error)
      next = { status: 'failed', ...this.kept(), settledAt: this.now() }
    }
    if (signal.aborted) return
    this.lastDuration = this.now() - began
    this.scanState.set(next)
    if (next.status === 'ready' && next.scan !== undefined) this.probeAll(next.scan)
  }

  /** Walk unless the latest walk is fresh, by {@link FRESH_SCAN_MS} or ten times its duration, or one runs. */
  refresh(): void {
    const settledAt = this.scanState.getSnapshot().settledAt
    const fresh = Math.max(FRESH_SCAN_MS, this.lastDuration * FRESH_SCAN_FACTOR)
    if (settledAt !== undefined && this.now() - settledAt < fresh) return
    this.rescan()
  }

  /**
   * Select a sound.
   * @param path - workspace path of the sound, or undefined to clear the selection.
   */
  select(path: string | undefined): void {
    this.view.set({ ...this.view.getSnapshot(), selected: path })
  }

  /**
   * Replace the search text.
   * @param query - the search text.
   */
  setQuery(query: string): void {
    this.view.set({ ...this.view.getSnapshot(), query })
  }

  /**
   * Choose which kinds the list shows.
   * @param filter - the kinds.
   */
  setFilter(filter: KindFilter): void {
    this.view.set({ ...this.view.getSnapshot(), filter })
  }

  /**
   * Fold a folder's sounds away, or show them again.
   * @param folder - workspace path of the folder.
   */
  toggleFolder(folder: string): void {
    const view = this.view.getSnapshot()
    const closed = view.closed.includes(folder) ? view.closed.filter(path => path !== folder) : [...view.closed, folder]
    this.view.set({ ...view, closed })
  }

  /**
   * Claim a tab's navigation once, so a sound an agent opened is selected once per opening.
   * @param tabId - the tab.
   * @param revision - the navigation's revision.
   * @returns whether the revision is new for the tab.
   */
  takeNavigation(tabId: string, revision: number): boolean {
    if (revision === 0 || this.navigations.get(tabId) === revision) return false
    this.navigations.set(tabId, revision)
    return true
  }

  /** Stop the running walk and probes; later requests do nothing. */
  close(): void {
    this.closed = true
    this.running?.abort()
    this.running = undefined
    this.probing?.abort()
    this.probing = undefined
  }

  private kept(): Pick<ScanState, 'scan'> {
    const scan = this.scanState.getSnapshot().scan
    return scan === undefined ? {} : { scan }
  }

  /** Read the headers of the walk's sounds whose size changed or that were never read, a few at a time. */
  private probeAll(scan: SoundScan): void {
    this.probing?.abort()
    const controller = new AbortController()
    this.probing = controller
    const known = this.probes.getSnapshot()
    const listed = new Set(scan.sounds.map(sound => sound.path))
    const pending = scan.sounds.filter(sound => known.get(sound.path)?.bytes !== sound.bytes || sound.bytes === undefined)
    // Sounds gone from the project leave the map.
    if ([...known.keys()].some(path => !listed.has(path))) {
      this.probes.set(new Map([...known].filter(([path]) => listed.has(path))))
    }
    const found: (readonly [string, ProbeEntry])[] = []
    const publish = (): void => {
      if (found.length === 0 || controller.signal.aborted) return
      this.probes.set(new Map([...this.probes.getSnapshot(), ...found.splice(0)]))
    }
    let next = 0
    const stopped = (): boolean => controller.signal.aborted
    const take = (): SoundEntry | undefined => stopped() ? undefined : pending[next++]
    const worker = async (): Promise<void> => {
      for (let sound = take(); sound !== undefined; sound = take()) {
        const probe = await this.probe(sound, controller.signal).catch((error: unknown) => {
          if (!stopped()) this.report(error)
          return undefined
        })
        found.push([sound.path, { bytes: sound.bytes, probe }])
        if (found.length >= PROBES_PER_UPDATE) publish()
      }
    }
    void Promise.all(Array.from({ length: Math.min(PROBES_AT_ONCE, pending.length) }, worker)).then(publish)
  }
}
