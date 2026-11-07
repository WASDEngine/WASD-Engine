/**
 * Run log storage: a Host-wide monotonic sequence and a bounded per-run ring of entries.
 * @module @deepseek-ai/dsh-godot/src/logs
 */
import type { GodotLogEntry, GodotLogLevel } from './types.ts'

/** Levels counted as errors in run views, digests, and startup reports. */
export const ERROR_LEVELS: ReadonlySet<GodotLogLevel> = new Set(['error', 'script_error', 'shader_error'])

/**
 * Whether an entry is error-level.
 * @param entry - log entry.
 * @returns true for errors, script errors, and shader errors.
 */
export function isErrorEntry(entry: GodotLogEntry): boolean {
  return ERROR_LEVELS.has(entry.level)
}

/** Host-wide log sequence; every run of one controller draws from it, so cursors order entries across runs. */
export class LogSequence {
  private last = 0

  /**
   * Issue the next sequence number.
   * @returns the number, starting at 1.
   */
  next(): number {
    this.last += 1
    return this.last
  }

  /**
   * Read the most recently issued number.
   * @returns the number, or 0 before the first.
   */
  current(): number {
    return this.last
  }
}

/** One page of entries read after a cursor. */
export interface LogPage {
  /** Matching entries, oldest first. */
  readonly entries: readonly GodotLogEntry[]
  /** Cursor for the next read: the last returned entry when the page is full, else the newest examined entry. */
  readonly next: number
  /** Whether entries after the cursor were evicted before this read. */
  readonly missed: boolean
}

/** Fixed-capacity ring of one run's entries; the oldest entry is evicted first. */
export class LogRing {
  private readonly slots: Array<GodotLogEntry | undefined>
  private head = 0
  private size = 0
  private evictedThrough = 0

  /**
   * @param capacity - maximum retained entries, at least 1.
   */
  constructor(private readonly capacity: number) {
    this.slots = new Array<GodotLogEntry | undefined>(capacity)
  }

  /** Sequence number of the newest retained entry, or of the newest evicted one when the ring is empty. */
  get lastSeq(): number {
    return this.size === 0 ? this.evictedThrough : (this.at(this.size - 1)).seq
  }

  /**
   * Append an entry with a sequence number above every retained one.
   * @param entry - entry to retain.
   */
  push(entry: GodotLogEntry): void {
    if (this.size < this.capacity) {
      this.slots[(this.head + this.size) % this.capacity] = entry
      this.size += 1
      return
    }
    this.evictedThrough = this.at(0).seq
    this.slots[this.head] = entry
    this.head = (this.head + 1) % this.capacity
  }

  /**
   * Read entries after a cursor.
   * @param after - cursor; entries with a greater sequence number are read.
   * @param limit - maximum entries returned.
   * @param matches - optional filter.
   * @returns the page.
   */
  after(after: number, limit: number, matches: (entry: GodotLogEntry) => boolean = () => true): LogPage {
    const entries: GodotLogEntry[] = []
    let next = after
    for (let index = 0; index < this.size; index += 1) {
      const entry = this.at(index)
      if (entry.seq <= after) continue
      if (entries.length === limit) break
      next = entry.seq
      if (matches(entry)) entries.push(entry)
    }
    return { entries, next, missed: after < this.evictedThrough }
  }

  /**
   * Read the newest entries after a cursor, skipping older ones when more are available.
   * @param after - cursor.
   * @param count - maximum entries.
   * @returns up to `count` entries with a greater sequence number, oldest first.
   */
  newestAfter(after: number, count: number): GodotLogEntry[] {
    const entries: GodotLogEntry[] = []
    for (let index = this.size - 1; index >= 0 && entries.length < count; index -= 1) {
      const entry = this.at(index)
      if (entry.seq <= after) break
      entries.push(entry)
    }
    return entries.reverse()
  }

  /**
   * Read the newest entries.
   * @param count - maximum entries.
   * @returns up to `count` entries, oldest first.
   */
  last(count: number): GodotLogEntry[] {
    const entries: GodotLogEntry[] = []
    for (let index = Math.max(0, this.size - count); index < this.size; index += 1) entries.push(this.at(index))
    return entries
  }

  /**
   * Read every retained entry matching a filter.
   * @param matches - filter.
   * @returns matching entries, oldest first.
   */
  filter(matches: (entry: GodotLogEntry) => boolean): GodotLogEntry[] {
    return this.last(this.size).filter(matches)
  }

  private at(index: number): GodotLogEntry {
    return this.slots[(this.head + index) % this.capacity] as GodotLogEntry
  }
}
