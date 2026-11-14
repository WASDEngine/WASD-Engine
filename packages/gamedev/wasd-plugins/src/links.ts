/**
 * Links a tool asks a window to open, such as the page where the user confirms a game server purchase: the Host
 * queues each link, every window that follows the queue sees the links no window took yet, and the first window that
 * claims a link opens it with `window.open`, which the Desktop app hands to the system browser. A link that no window
 * claims within the queue's timeout counts as not opened, and the tool gives the link to the user instead.
 * @module @deepseek-ai/dsh-wasd-plugins/src/links
 */
import { randomUUID } from 'node:crypto'
import type { WasdLinkRequests } from './types.ts'

/** One link waiting for a window. */
interface PendingLink {
  readonly id: string
  readonly url: string
  readonly settle: (opened: boolean) => void
}

/** The links waiting for a window, and the windows that follow them. */
export class LinkRequests {
  private readonly pending: PendingLink[] = []
  private readonly followers = new Set<() => void>()

  /**
   * @param claimTimeoutMs - how long a link waits for a window to claim it.
   * @param lifetime - aborts every wait when the plugin is disposed.
   */
  constructor(private readonly claimTimeoutMs: number, private readonly lifetime: AbortSignal) {}

  /**
   * Ask a window to open a link.
   * @param url - an http(s) address.
   * @param signal - cancellation of the wait.
   * @returns whether a window claimed the link within the timeout.
   */
  open(url: string, signal: AbortSignal): Promise<boolean> {
    if (!/^https?:\/\//u.test(url)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const stop = AbortSignal.any([signal, this.lifetime, AbortSignal.timeout(this.claimTimeoutMs)])
      const link: PendingLink = {
        id: randomUUID(),
        url,
        settle: (opened) => {
          stop.removeEventListener('abort', onStop)
          this.remove(link)
          resolve(opened)
        },
      }
      const onStop = (): void => { link.settle(false) }
      stop.addEventListener('abort', onStop, { once: true })
      this.pending.push(link)
      this.notify()
    })
  }

  /**
   * Claim a link for the calling window, which then opens it.
   * @param id - the link.
   * @returns whether the window took it; false when another window did or the link's wait ended.
   */
  claim(id: string): boolean {
    const link = this.pending.find(candidate => candidate.id === id)
    if (link === undefined) return false
    link.settle(true)
    return true
  }

  /**
   * Follow the links no window took yet.
   * @param signal - ends the stream.
   * @returns the list, then again after each change, until `signal` aborts or the plugin is disposed.
   */
  async * follow(signal: AbortSignal): AsyncIterable<WasdLinkRequests> {
    const stop = AbortSignal.any([signal, this.lifetime])
    let changed = true
    let wake: (() => void) | undefined
    const follower = (): void => {
      changed = true
      wake?.()
    }
    const onStop = (): void => { wake?.() }
    this.followers.add(follower)
    stop.addEventListener('abort', onStop, { once: true })
    try {
      while (!stop.aborted) {
        if (changed) {
          changed = false
          yield { links: this.pending.map(link => ({ id: link.id, url: link.url })) }
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.followers.delete(follower)
      stop.removeEventListener('abort', onStop)
    }
  }

  private remove(link: PendingLink): void {
    const index = this.pending.indexOf(link)
    if (index < 0) return
    this.pending.splice(index, 1)
    this.notify()
  }

  private notify(): void {
    for (const follower of [...this.followers]) follower()
  }
}
