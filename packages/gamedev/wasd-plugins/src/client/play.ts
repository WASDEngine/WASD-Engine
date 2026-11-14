/**
 * The Play page's shared parts: its main panel id, the WASD Engine game links that the site's Install buttons write
 * (`wasdengine://games/<slug>`, with `install=1` and, for an earlier version of a single-player game, `v=<n>`), and the
 * navigator through which the sidebar's Play button and the app's game links send the page to an address on the site.
 */
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The main panel of the Play page. */
export const PLAY_PANEL = 'wasd-play' as MainPanelId

/**
 * The marker the Play page's webview adds to its user agent, so the site shows its in-app presentation: Install in
 * place of Install with WASD Engine, and no offer of the app.
 */
export const IN_APP_AGENT = 'WASDEngineApp/1'

/** A game link of the site's Install buttons. */
export interface GameLink {
  /** The game's address on the site, `/games/<slug>`. */
  readonly slug: string
  /** An earlier version of a single-player game; absent for the latest. */
  readonly version?: number
  /** Whether the link asks to install the game, not only to show its page. */
  readonly install: boolean
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u

/**
 * Read a game link.
 * @param raw - a `wasdengine://games/<slug>` link.
 * @returns the link's game, version, and request, or undefined for anything else.
 */
export function parseGameLink(raw: string): GameLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Not a URL: no link.
    return undefined
  }
  const slug = url.pathname.replace(/^\/+/u, '')
  if (url.protocol !== 'wasdengine:' || url.hostname !== 'games' || !SLUG.test(slug)) return undefined
  const v = url.searchParams.get('v')
  const version = v !== null && /^[1-9]\d{0,6}$/u.test(v) ? Number(v) : undefined
  return { slug, ...version === undefined ? {} : { version }, install: url.searchParams.get('install') === '1' }
}

/**
 * The site's page of a linked game.
 * @param origin - the site's origin.
 * @param link - the game link.
 * @returns the page's address: the game's page, at the linked version when the link names one.
 */
export function gamePage(origin: string, link: GameLink): string {
  const url = new URL(`/games/${link.slug}`, origin)
  if (link.version !== undefined) url.searchParams.set('v', String(link.version))
  return url.href
}

/** An address the Play page goes to; `seq` grows with each request, so a request for the same address goes again. */
export interface PlayNavigation {
  /** The address. */
  readonly url: string
  /** The request's number. */
  readonly seq: number
}

/**
 * Requests that send the Play page to an address, and the address it showed last, where it starts again after the
 * main column showed another panel, which unmounts it.
 */
export interface PlayNavigator {
  /** The latest request, or undefined before any. */
  readonly store: SnapshotStore<PlayNavigation | undefined>
  /**
   * Send the Play page to an address.
   * @param url - an address on the site.
   */
  go(url: string): void
  /**
   * Note the address the Play page shows.
   * @param url - the page's address.
   */
  remember(url: string): void
  /** @returns the address the Play page showed last, or undefined before it showed one. */
  last(): string | undefined
}

/**
 * Make the Play page's navigator.
 * @returns a navigator without requests.
 */
export function createPlayNavigator(): PlayNavigator {
  const store = createSnapshotStore<PlayNavigation | undefined>(undefined)
  let shown: string | undefined
  return {
    store,
    go(url) {
      shown = url
      store.set({ url, seq: (store.getSnapshot()?.seq ?? 0) + 1 })
    },
    remember(url) {
      shown = url
    },
    last: () => shown,
  }
}
