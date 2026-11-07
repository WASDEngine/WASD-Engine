/**
 * The Game tab's follow stream of one Session id: a snapshot, then run, log, and runtime changes. The Session needs
 * no live Agent; until its Agent starts a run, the snapshot and run items carry no run. Changes coalesce while the
 * consumer is behind: a run item carries the latest view, a log item the newest entries after the stream's cursor,
 * and a runtime item the latest runtime view. The stream ends when its signal aborts or the plugin is disposed.
 * @module @deepseek-ai/dsh-godot/src/follow
 */
import type { GodotRun } from './run.ts'
import type { SessionChange, SessionWatcher } from './runs.ts'
import type { GodotFollowItem, GodotRuntimeView } from './types.ts'

/** Log entries in the snapshot and at most in each log item; the Game tab shows this many. */
export const FOLLOW_LOG_ENTRIES = 200

/** State a follow stream reads. */
export interface FollowSources {
  /** @returns the followed Session's current or most recent run, or undefined while it has none or no live Agent. */
  run(): GodotRun | undefined
  /**
   * Observe the followed Session's run and log changes.
   * @param watcher - change receiver.
   * @returns the unsubscriber.
   */
  watch(watcher: SessionWatcher): () => void
  /**
   * Resolve the current runtime view.
   * @param signal - cancellation.
   * @returns the view.
   */
  runtimeView(signal: AbortSignal): Promise<GodotRuntimeView>
  /** @returns the most recently published runtime view. */
  latestRuntime(): GodotRuntimeView
  /**
   * Observe runtime view changes.
   * @param listener - called after each published change.
   * @returns the unsubscriber.
   */
  watchRuntime(listener: () => void): () => void
}

class FollowWatcher implements SessionWatcher {
  run = false
  logs = false
  runtime = false
  ended = false
  private wake: (() => void) | undefined

  notify(change: SessionChange | 'runtime'): void {
    if (change === 'end') this.ended = true
    else this[change] = true
    this.wake?.()
  }

  /** Read and clear one change flag. */
  take(change: 'run' | 'logs' | 'runtime'): boolean {
    const changed = this[change]
    this[change] = false
    return changed
  }

  async wait(signal: AbortSignal): Promise<void> {
    if (this.run || this.logs || this.runtime || this.ended || signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        this.wake = undefined
        resolve()
      }
      this.wake = done
      signal.addEventListener('abort', done, { once: true })
    })
  }
}

/**
 * Follow one Session.
 * @param sources - Session and runtime state.
 * @param signal - stream cancellation.
 * @returns the stream: one snapshot item, then change items.
 */
export async function* followSession(sources: FollowSources, signal: AbortSignal): AsyncGenerator<GodotFollowItem, void, undefined> {
  const watcher = new FollowWatcher()
  const unwatchSession = sources.watch(watcher)
  const unwatchRuntime = sources.watchRuntime(() => { watcher.notify('runtime') })
  try {
    const runtime = await sources.runtimeView(signal)
    // The snapshot below reflects every run and log change so far.
    watcher.take('run')
    watcher.take('logs')
    const run = sources.run()
    let cursor = run?.logs.lastSeq ?? 0
    yield { type: 'snapshot', run: run?.view() ?? null, runtime, logs: run?.logs.last(FOLLOW_LOG_ENTRIES) ?? [], cursor }
    // One item per pass, so a disposed plugin or an aborted signal ends the stream before the next item.
    for (;;) {
      await watcher.wait(signal)
      if (signal.aborted || watcher.ended) return
      if (watcher.take('runtime')) {
        yield { type: 'runtime', runtime: sources.latestRuntime() }
        continue
      }
      const current = sources.run()
      if (watcher.take('run')) {
        yield { type: 'run', run: current?.view() ?? null }
        continue
      }
      watcher.take('logs')
      // Entries of a run replaced or ended with its Agent before this read are skipped; a run item announced that.
      const entries = current?.logs.newestAfter(cursor, FOLLOW_LOG_ENTRIES) ?? []
      const last = entries.at(-1)
      if (last !== undefined) {
        cursor = last.seq
        yield { type: 'logs', entries, cursor }
      }
    }
  } finally {
    unwatchSession()
    unwatchRuntime()
  }
}
