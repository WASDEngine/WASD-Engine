/**
 * The window half of the game library: the Host's library stream, which the Play page shows, and, in the Desktop app,
 * the game links the shell hands the app (`dshDesktop.wasdLinks`), from the site's Install buttons in the system browser
 * or in the Play page. A window takes the waiting links when it starts and whenever the shell has new ones, and opens
 * each at its game's page, installing the game when the link asks to.
 */
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopWasdLinksBridge, WasdLibraryView } from '../types.ts'
import { parseGameLink, type GameLink } from './play.ts'

/** One item of the followed library stream. */
export interface LibraryDelivery {
  /** The library. */
  readonly value: WasdLibraryView
  /** Mark the item as applied. */
  accept(): void
}

/** The logical library stream, which reopens itself across carrier losses. */
export interface LibraryStream extends AsyncIterable<LibraryDelivery> {
  /** Stop the stream for good. @returns once nothing can still deliver. */
  dispose(): Promise<void>
}

/** What the library follower needs from the window. */
export interface LibraryFollowerServices {
  /** Open the logical library stream. */
  readonly follow: () => LibraryStream
  /** Where the latest library goes. */
  readonly store: { set(view: WasdLibraryView | undefined): void }
  /** Report a failure that no request receives. */
  readonly warn: (message: string, error: unknown) => void
}

/**
 * Keep the store at the Host's latest library until the returned disposer runs.
 * @param services - the stream, the store, and the warning sink.
 * @returns the disposer that stops following.
 */
export function followLibrary(services: LibraryFollowerServices): () => void {
  const lifetime = new AbortController()
  const stream = services.follow()
  void (async () => {
    for await (const delivery of stream) {
      if (lifetime.signal.aborted) return
      delivery.accept()
      services.store.set(delivery.value)
    }
  })().catch((error: unknown) => {
    if (!lifetime.signal.aborted) services.warn('wasd-plugins: the game library stream stopped', error)
  })
  return () => {
    lifetime.abort()
    void stream.dispose()
  }
}

/** What the game link follower needs from the window. */
export interface GameLinkServices {
  /** The Desktop shell's waiting game links. */
  readonly links: DesktopWasdLinksBridge
  /**
   * Show a linked game, and install it when the link asks to.
   * @param link - the link.
   * @returns undefined once done, or why the install did not start.
   */
  readonly open: (link: GameLink) => Promise<string | undefined>
  /** Report a failure that no request receives. */
  readonly warn: (message: string, error: unknown) => void
}

/**
 * Take and open the shell's game links, oldest first, until the returned disposer runs.
 * @param services - the shell's links, the opener, and the warning sink.
 * @returns the disposer that stops following.
 */
export function followGameLinks(services: GameLinkServices): () => void {
  let stopped = false
  let draining: Promise<void> = Promise.resolve()
  const drain = async (): Promise<void> => {
    for (const raw of await services.links.take()) {
      if (stopped) return
      const link = parseGameLink(raw)
      if (link === undefined) continue
      const failure = await services.open(link)
      if (failure !== undefined) services.warn(`wasd-plugins: the game ${link.slug} did not start installing: ${failure}`, undefined)
    }
  }
  // One drain at a time keeps the links in their order.
  const run = (): void => {
    draining = draining.then(drain).catch((error: unknown) => {
      if (!stopped) services.warn('wasd-plugins: a game link could not be opened', error)
    })
  }
  const unsubscribe = services.links.subscribe(run)
  run()
  return () => {
    stopped = true
    unsubscribe()
  }
}

/** The Desktop shell's bridges of the application page that the Play page uses. */
export interface DesktopPlayBridges {
  /** Guest admission of the Desktop Browser's kind; undefined outside the Desktop app. */
  readonly browser: DesktopBrowserBridge | undefined
  /** The game links the shell was asked to open; undefined outside the Desktop app. */
  readonly links: DesktopWasdLinksBridge | undefined
}

/**
 * Read the Desktop shell's bridges of the application page.
 * @returns the bridges, which exist only on the Desktop app's application page.
 */
export function desktopBridges(): DesktopPlayBridges {
  const desktop = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly browser?: DesktopBrowserBridge; readonly wasdLinks?: DesktopWasdLinksBridge }
  }).dshDesktop
  return { browser: desktop?.browser, links: desktop?.wasdLinks }
}
