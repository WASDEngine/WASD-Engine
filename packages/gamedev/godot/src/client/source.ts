/** Game state of one Session, folded from the Host's `godot.follow` stream while a surface reads it. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { GodotFollowItem, GodotLogEntry, GodotRunPhase, GodotRunView, GodotRuntimeView } from '../types.ts'

/** Most log entries the Game tab keeps per Session; older entries leave first. */
export const LOG_RING_SIZE = 500

/** Phases in which the run renders frames and accepts input. */
export const LIVE_PHASES: ReadonlySet<GodotRunPhase> = new Set(['running', 'paused'])

/** Phases between a start request and the end of the run. */
export const ACTIVE_PHASES: ReadonlySet<GodotRunPhase> = new Set(['preparing', 'importing', 'starting', 'running', 'paused'])

/** Delay before a stream reopens after an attempt that delivered no snapshot. */
export const FOLLOW_RETRY_INITIAL_MS = 1000

/** Ceiling of the reopen delay, which doubles per consecutive attempt that delivered no snapshot. */
export const FOLLOW_RETRY_MAX_MS = 30_000

/** What the follow stream has reported for one Session. */
export interface GameState {
  /** The Session's current or last run, or null before its first run. */
  readonly run: GodotRunView | null
  /** Runtime availability. */
  readonly runtime: GodotRuntimeView
  /** Log entries of the current run, oldest first, at most {@link LOG_RING_SIZE}. */
  readonly logs: readonly GodotLogEntry[]
  /** Host log cursor after the newest entry. */
  readonly cursor: number
}

/** What the Game tab reads: the folded state, and whether the stream stopped while surfaces read it. */
export interface GameSnapshot {
  /** Null until the stream's first snapshot arrives; after a stop, what the Host reported last. */
  readonly state: GameState | null
  /** Whether the stream stopped before its snapshot, until a reopened stream delivers one; false while one delivers or opens. */
  readonly disconnected: boolean
}

/** One item of a {@link FollowStream}. */
export interface FollowDelivery {
  /** The follow item. */
  readonly value: GodotFollowItem
  /** Mark the opening snapshot of the item's generation as applied. */
  accept(): void
}

/**
 * One logical follow stream that reopens itself across carrier losses (the
 * Gateway's `RemoteStream`); every generation starts with a snapshot.
 * Iteration ends quietly after `dispose` and throws on a terminal failure.
 */
export interface FollowStream extends AsyncIterable<FollowDelivery> {
  /**
   * Stop the stream for good.
   * @returns once no generation can still deliver.
   */
  dispose(): Promise<void>
}

/** Options of {@link createGameSource}. */
export interface GameSourceOptions {
  /**
   * Open the Session's follow stream.
   * @returns a stream nobody iterates yet.
   */
  readonly open: () => FollowStream
}

/** Game state of one Session; the stream runs only while something subscribes. */
export interface GameSource {
  /** Snapshot observable; the renderer binds it as `useGame`. */
  readonly observable: HostObservable<GameSnapshot>
  /** Open a stream now and clear the disconnection; a no-op while a stream is open or nobody subscribes. */
  readonly reconnect: () => void
  /** Stop the stream and drop every subscriber. */
  readonly close: () => void
}

/**
 * Fold one follow item. A snapshot replaces the state; later items need a
 * snapshot first. A new run id drops the entries of other runs, and log
 * entries already held (by `seq`) are not added twice.
 * @param state - state before the item, or null before the first snapshot.
 * @param item - the item.
 * @returns state after the item.
 */
export function foldFollow(state: GameState | null, item: GodotFollowItem): GameState | null {
  switch (item.type) {
    case 'snapshot':
      return { run: item.run, runtime: item.runtime, logs: item.logs.slice(-LOG_RING_SIZE), cursor: item.cursor }
    case 'run':
      if (state === null) return null
      if (item.run?.runId === state.run?.runId) return { ...state, run: item.run }
      return { ...state, run: item.run, logs: state.logs.filter(entry => entry.runId === item.run?.runId) }
    case 'logs': {
      if (state === null) return null
      const newest = state.logs.at(-1)?.seq ?? -Infinity
      const added = item.entries.filter(entry => entry.seq > newest)
      return { ...state, logs: [...state.logs, ...added].slice(-LOG_RING_SIZE), cursor: item.cursor }
    }
    case 'runtime':
      return state === null ? null : { ...state, runtime: item.runtime }
    /* v8 ignore next 2 -- the generated Remote decoder validates this closed union. */
    default:
      return assertNever(item, 'GodotFollowItem.type')
  }
}

/**
 * Create the game source of one Session. The first subscriber opens the
 * stream and the last one closes it; the state stays readable for the next
 * subscriber. While the Gateway reconnects a stream after a carrier loss, the
 * last state stays published. A stream that ends or fails after its snapshot
 * reopens at once. A stream that stops before delivering a snapshot publishes
 * the disconnection and reopens after {@link FOLLOW_RETRY_INITIAL_MS}, doubling
 * up to {@link FOLLOW_RETRY_MAX_MS}, or at once on `reconnect`, for as long as
 * anything subscribes.
 * @param options - stream opener.
 * @returns the source.
 */
export function createGameSource(options: GameSourceOptions): GameSource {
  return new FollowSource(options)
}

class FollowSource implements GameSource {
  private current: GameSnapshot = { state: null, disconnected: false }
  private readonly subscribers = new Set<() => void>()
  private stream: FollowStream | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  /** Consecutive attempts that delivered no snapshot. */
  private failures = 0

  readonly observable: HostObservable<GameSnapshot> = {
    getSnapshot: () => this.current,
    subscribe: (listener) => {
      this.subscribers.add(listener)
      if (this.subscribers.size === 1) this.follow(true)
      return () => {
        this.subscribers.delete(listener)
        if (this.subscribers.size === 0) this.stop()
      }
    },
  }

  constructor(private readonly options: GameSourceOptions) {}

  readonly reconnect = (): void => {
    if (this.subscribers.size > 0 && this.stream === undefined) this.follow(true)
  }

  readonly close = (): void => {
    this.subscribers.clear()
    this.stop()
  }

  /**
   * Open a stream and read it.
   * @param fresh - whether a subscriber or `reconnect` asked for it, which clears the disconnection and restarts the delay.
   */
  private follow(fresh: boolean): void {
    clearTimeout(this.retry)
    this.retry = undefined
    const stream = this.options.open()
    this.stream = stream
    if (fresh) {
      this.failures = 0
      if (this.current.disconnected) this.publish({ state: this.current.state, disconnected: false })
    }
    void this.consume(stream)
  }

  private async consume(stream: FollowStream): Promise<void> {
    const progress = { delivered: false }
    try {
      await this.read(stream, progress)
    } catch {
      // A terminal stream failure, such as a Gateway or Host refusal, stops the stream as an end does; both reopen it below.
    }
    if (this.stream !== stream) return
    this.stream = undefined
    if (progress.delivered) {
      this.follow(false)
      return
    }
    this.failures += 1
    if (!this.current.disconnected) this.publish({ state: this.current.state, disconnected: true })
    const delay = Math.min(FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_INITIAL_MS * 2 ** (this.failures - 1))
    // The last subscriber's leave and a reconnect clear the timer. The disconnection stays published until the
    // reopened stream delivers its snapshot.
    this.retry = setTimeout(() => { this.follow(false) }, delay)
  }

  /** Fold the items of one stream until it ends, from its first snapshot on; `progress` records that snapshot. */
  private async read(stream: FollowStream, progress: { delivered: boolean }): Promise<void> {
    for await (const delivery of stream) {
      if (this.stream !== stream) return
      const item = delivery.value
      if (item.type === 'snapshot') {
        delivery.accept()
        progress.delivered = true
        this.failures = 0
      } else if (!progress.delivered) {
        continue
      }
      this.publish({ state: foldFollow(this.current.state, item), disconnected: false })
    }
  }

  private stop(): void {
    clearTimeout(this.retry)
    this.retry = undefined
    const stopped = this.stream
    this.stream = undefined
    void stopped?.dispose()
  }

  private publish(next: GameSnapshot): void {
    this.current = next
    notifySubscribers(this.subscribers, '[godot] game source')
  }
}
