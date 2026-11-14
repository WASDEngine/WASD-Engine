/**
 * The window half of the links multiplayer tools open: a Desktop window follows the Host's waiting links, claims each
 * one once, and opens the links it claimed with `window.open`, which the Desktop app hands to the system browser
 * without a click. Web windows do not follow the links, because a browser blocks a window that no click opened; the
 * tool then gives the user the link.
 */
import type { WasdLinkRequests } from '../types.ts'

/** One item of the followed link stream. */
export interface LinkRequestDelivery {
  /** The waiting links. */
  readonly value: WasdLinkRequests
  /** Mark the item as applied. */
  accept(): void
}

/** The logical stream of waiting links, which reopens itself across carrier losses. */
export interface LinkRequestStream extends AsyncIterable<LinkRequestDelivery> {
  /** Stop the stream for good. @returns once nothing can still deliver. */
  dispose(): Promise<void>
}

/** What the link follower needs from the window. */
export interface LinkFollowerServices {
  /** Open the logical stream of waiting links. */
  readonly follow: () => LinkRequestStream
  /**
   * Take a link for this window.
   * @returns whether this window took it.
   */
  readonly claim: (id: string) => Promise<boolean>
  /** Open a link this window took. */
  readonly open: (url: string) => void
  /** Report a failure that no tool call receives. */
  readonly warn: (message: string, error: unknown) => void
}

/**
 * Follow the waiting links until the returned disposer runs.
 * @param services - the stream, the claim, the opener, and the warning sink.
 * @returns the disposer that stops following.
 */
export function followLinkRequests(services: LinkFollowerServices): () => void {
  const lifetime = new AbortController()
  // Links this window already tried to take, so a later list does not claim them again.
  const tried = new Set<string>()
  const stream = services.follow()
  void (async () => {
    for await (const delivery of stream) {
      if (lifetime.signal.aborted) return
      delivery.accept()
      const current = new Set(delivery.value.links.map(link => link.id))
      for (const id of [...tried]) if (!current.has(id)) tried.delete(id)
      for (const link of delivery.value.links) {
        if (tried.has(link.id)) continue
        tried.add(link.id)
        void services.claim(link.id).then((took) => {
          if (took && !lifetime.signal.aborted) services.open(link.url)
        }, (error: unknown) => {
          services.warn('wasd-plugins: a window could not take a link to open', error)
        })
      }
    }
  })().catch((error: unknown) => {
    if (!lifetime.signal.aborted) services.warn('wasd-plugins: the link stream stopped', error)
  })
  return () => {
    lifetime.abort()
    void stream.dispose()
  }
}
