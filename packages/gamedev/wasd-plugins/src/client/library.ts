/**
 * The window half of the game library: the Host's library stream, which the Play page shows, and, in the Desktop app,
 * the game links the shell hands the app (`dshDesktop.wasdLinks`), from the site's Install buttons in the Play page or
 * the system browser, and from any other page in the app. A window takes the waiting links when it starts and whenever
 * the shell has new ones, and opens each at its game's page. It installs the game only for a link the Play page's own
 * guest followed in its main frame while that frame showed the site, as the site's Install button there does; a link
 * from anywhere else opens the game's page, where the player chooses Install.
 */
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopWasdLink, DesktopWasdLinksBridge, WasdLibraryView } from '../types.ts'
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
  /** @returns the origin of the site the Play page shows. */
  readonly site: () => Promise<string>
  /**
   * Show a linked game, and install it when `link.install` says to, which the follower allows only for the site's
   * Install button in the Play page.
   * @param link - the link.
   * @returns undefined once done, or why the install did not start.
   */
  readonly open: (link: GameLink) => Promise<string | undefined>
  /** Report a failure that no request receives. */
  readonly warn: (message: string, error: unknown) => void
}

/**
 * Whether a game link may install its game: only one the Play page's own guest followed in its main frame while that
 * frame showed the site, as the site's Install button there does.
 * @param link - the link as the shell handed it over.
 * @param site - the origin of the site the Play page shows.
 * @returns whether the link installs when it asks to.
 */
export function linkInstalls(link: DesktopWasdLink, site: string): boolean {
  // The link crossed from the main process, so its source is read as data.
  const source: unknown = link.source
  return typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'play'
    && 'origin' in source && source.origin === site
}

/**
 * Take and open the shell's game links, oldest first, until the returned disposer runs. Each opens its game's page;
 * one that asks to install installs only when {@link linkInstalls} allows it.
 * @param services - the shell's links, the site's origin, the opener, and the warning sink.
 * @returns the disposer that stops following.
 */
export function followGameLinks(services: GameLinkServices): () => void {
  let stopped = false
  let draining: Promise<void> = Promise.resolve()
  const drain = async (): Promise<void> => {
    for (const delivered of await services.links.take()) {
      if (stopped) return
      const url: unknown = delivered.url
      const link = typeof url === 'string' ? parseGameLink(url) : undefined
      if (link === undefined) continue
      const install = link.install && linkInstalls(delivered, await services.site())
      const failure = await services.open({ ...link, install })
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
