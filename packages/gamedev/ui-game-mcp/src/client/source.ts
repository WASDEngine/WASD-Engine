/**
 * The MCP server's view, followed from the Host's `gameMcp.watch` stream while something reads it, such as the
 * sign-in dialog's offer or the setup panel. Every item is a complete view. The first subscriber opens the stream
 * and the last one closes it; the view stays readable for the next subscriber. A stream that ends after it
 * delivered reopens at once; one that stops before its first view publishes the disconnection and reopens after
 * {@link FOLLOW_RETRY_INITIAL_MS}, doubling up to {@link FOLLOW_RETRY_MAX_MS}, for as long as anything subscribes.
 */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'

/** Delay before a stream reopens after an attempt that delivered nothing. */
export const FOLLOW_RETRY_INITIAL_MS = 1000

/** Ceiling of the reopen delay. */
export const FOLLOW_RETRY_MAX_MS = 30_000

/** What the setup panel reads. */
export interface ServerSnapshot {
  /** The latest view, or null before the first one. */
  readonly view: GameMcpView | null
  /** Whether the stream stopped and has not delivered since. */
  readonly disconnected: boolean
}

/** One item of a {@link ViewStream}. */
export interface ViewDelivery {
  /** The view. */
  readonly value: GameMcpView
  /** Mark the item as applied. */
  accept(): void
}

/** One logical watch stream that reopens itself across carrier losses (the Gateway's `RemoteStream`). */
export interface ViewStream extends AsyncIterable<ViewDelivery> {
  /** Stop the stream for good. @returns once nothing can still deliver. */
  dispose(): Promise<void>
}

/** The followed view. */
export interface ServerSource {
  /** Snapshot observable; the renderer binds it as `useServer`. */
  readonly observable: HostObservable<ServerSnapshot>
  /** Stop following and drop every subscriber. */
  readonly close: () => void
}

/**
 * Create the server source.
 * @param open - opens the watch stream.
 * @returns the source, which follows the server while it has subscribers.
 */
export function createServerSource(open: () => ViewStream): ServerSource {
  let current: ServerSnapshot = { view: null, disconnected: false }
  const subscribers = new Set<() => void>()
  let stream: ViewStream | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const publish = (next: ServerSnapshot): void => {
    current = next
    notifySubscribers(subscribers, '[game-mcp] server source')
  }
  const stop = (): void => {
    clearTimeout(retry)
    retry = undefined
    const stopped = stream
    stream = undefined
    void stopped?.dispose()
  }
  const follow = (): void => {
    retry = undefined
    const opened = open()
    stream = opened
    void (async () => {
      let delivered = false
      try {
        for await (const delivery of opened) {
          if (stream !== opened) return
          delivery.accept()
          delivered = true
          failures = 0
          publish({ view: delivery.value, disconnected: false })
        }
      } catch {
        // A terminal stream failure stops the stream as an end does; both reopen it below.
      }
      if (stream !== opened) return
      stream = undefined
      if (delivered) {
        follow()
        return
      }
      failures += 1
      if (!current.disconnected) publish({ view: current.view, disconnected: true })
      retry = setTimeout(follow, Math.min(FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_INITIAL_MS * 2 ** (failures - 1)))
    })()
  }
  return {
    observable: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        subscribers.add(listener)
        if (subscribers.size === 1) {
          failures = 0
          follow()
        }
        return () => {
          subscribers.delete(listener)
          if (subscribers.size === 0) stop()
        }
      },
    },
    close: () => {
      subscribers.clear()
      stop()
    },
  }
}
