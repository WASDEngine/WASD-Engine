/** Godot run, runtime, log, and follow-stream fixtures shared by the client specs. */
import { vi } from 'vitest'
import type { GodotFollowItem, GodotLogEntry, GodotRunView, GodotRuntimeView } from '../src/types.ts'
import type { FollowDelivery, FollowStream } from '../src/client/source.ts'

/** A ready LibGodot runtime. */
export const READY: GodotRuntimeView = { state: 'ready', kind: 'libgodot', version: '4.7.2', windowless: true }

/**
 * A run view.
 * @param runId - run id.
 * @param overrides - fields to replace.
 * @returns the run.
 */
export function run(runId: string, overrides: Partial<GodotRunView> = {}): GodotRunView {
  return {
    runId, phase: 'running', startedBy: 'user', projectDir: '/work/game', launch: {}, muted: false, windowless: true, runtime: 'libgodot',
    errorCount: 0, warningCount: 0, startedAt: 1_700_000_000_000, ...overrides,
  }
}

/**
 * A log entry.
 * @param seq - Host sequence number.
 * @param runId - run that logged it.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
export function entry(seq: number, runId = 'r1', overrides: Partial<GodotLogEntry> = {}): GodotLogEntry {
  return { seq, runId, source: 'game', level: 'stdout', message: `line ${String(seq)}`, time: 1_700_000_000_000 + seq, ...overrides }
}

/**
 * A snapshot item.
 * @param current - the run, or null.
 * @param logs - log entries.
 * @param runtime - runtime view.
 * @returns the item.
 */
export function snapshot(
  current: GodotRunView | null,
  logs: readonly GodotLogEntry[] = [],
  runtime: GodotRuntimeView = READY,
): GodotFollowItem {
  return { type: 'snapshot', run: current, runtime, logs, cursor: logs.at(-1)?.seq ?? 0 }
}

/** An async sequence the test feeds by hand, then ends or fails. */
interface Manual<T> extends AsyncIterable<T> {
  push(value: T): void
  fail(error: unknown): void
  end(): void
}

function manual<T>(): Manual<T> {
  const queue: T[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: { readonly error: unknown } | undefined
  return {
    push(value) { queue.push(value); wake?.() },
    fail(error) { failure = { error }; wake?.() },
    end() { closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (failure !== undefined) throw failure.error
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    },
  }
}

/** A generated `godot.follow` handle the test feeds by hand. */
export interface FedHandle extends Manual<GodotFollowItem> {
  /** The generation signal the handle was opened with. */
  readonly signal: AbortSignal
  /** Cancel the handle. */
  dispose(): void
}

/**
 * Create a `godot.follow` handle that ends when its generation signal aborts, as a carrier generation does.
 * @param signal - the generation signal.
 * @returns the handle.
 */
export function feed(signal: AbortSignal): FedHandle {
  const items = manual<GodotFollowItem>()
  signal.addEventListener('abort', () => { items.end() })
  return { ...items, [Symbol.asyncIterator]: () => items[Symbol.asyncIterator](), signal, dispose: () => { items.end() } }
}

/** A logical follow stream the test feeds by hand. */
export interface FedFollow extends FollowStream {
  /** Deliver one item. */
  push(item: GodotFollowItem): void
  /** Fail the stream for good. */
  fail(error: unknown): void
  /** End the stream without disposal. */
  end(): void
  /** Called once per `dispose`. */
  readonly disposed: ReturnType<typeof vi.fn>
  /** Items whose delivery the consumer accepted. */
  readonly accepted: GodotFollowItem[]
}

/**
 * Create a logical follow stream; disposal ends its iteration quietly.
 * @returns the stream.
 */
export function follow(): FedFollow {
  const deliveries = manual<FollowDelivery>()
  const accepted: GodotFollowItem[] = []
  const disposed = vi.fn()
  return {
    push: (item) => { deliveries.push({ value: item, accept: () => { accepted.push(item) } }) },
    fail: (error) => { deliveries.fail(error) },
    end: () => { deliveries.end() },
    disposed,
    accepted,
    dispose: async () => {
      disposed()
      deliveries.end()
    },
    [Symbol.asyncIterator]: () => deliveries[Symbol.asyncIterator](),
  }
}
