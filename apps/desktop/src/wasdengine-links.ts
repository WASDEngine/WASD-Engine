/**
 * Main-process side of `dshDesktop.wasdLinks`: the WASD Engine game links (`wasdengine://games/<slug>`, from the site's
 * Install buttons) that macOS hands the app (`open-url`, also before the app is ready), that Windows passes to the app's
 * command line or to a second launch's, and that a page in a Browser or Play webview navigates to or opens. The links
 * wait in an inbox until the application page takes them, so a link that starts the app reaches the page once it
 * loads; the page hears about each new one through {@link WASD_LINKS_IPC}'s `changed` event. `dshDesktop.wasdLinks`
 * documents the link fields.
 *
 * Each link carries its source, which only the main process can see ({@link DesktopWasdLinkSource}): only a navigation
 * by the Play page's own guest, in its main frame and started by that frame, is a `play` link, which may install a
 * game once the window sees that the frame showed the site; the inbox drops `install` from every other link, so it opens
 * the game's page in the Play page and installs nothing. The Play page's guest is the one whose lease was acquired
 * with the Play page's storage identity, which no Browser tab's can be, and a page cannot change which lease its guest
 * has. The inbox passes a link that repeats one of the same source within {@link REPEAT_MS} once, and at most
 * {@link LINKS_PER_MINUTE} links of one source a minute, so no page can keep pulling the window to the Play page.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopWasdLink, DesktopWasdLinkSource, WasdPlayStorage } from '@deepseek-ai/dsh-wasd-plugins/types'
import { WASD_LINKS_IPC } from './wasdengine-links-names.ts'

/** Most links the inbox keeps while no page takes them; older ones drop first. */
const MAX_PENDING = 16

/** Longest link the inbox accepts. */
const MAX_LINK_LENGTH = 2048

/** How long a link that repeats one of the same source is dropped, in milliseconds. */
const REPEAT_MS = 5000

/** Most links of one source the inbox passes in a minute, by kind; a `play` source counts per origin. */
const LINKS_PER_MINUTE: Readonly<Record<DesktopWasdLinkSource['kind'], number>> = { play: 10, page: 3, system: 5 }

const MINUTE_MS = 60_000

/** The storage identity of the Play page's guest, as the Play page acquires it. */
const PLAY_STORAGE: WasdPlayStorage = 'wasd-engine-play'

/** The source of the links the operating system hands the app. */
export const SYSTEM_LINK: DesktopWasdLinkSource = { kind: 'system' }

/** What a Browser or Play guest's link of the app's URL scheme came from, as `DesktopBrowserGuests` sees it. */
export interface DesktopGuestLink {
  /** The storage identity the guest's lease was acquired with; undefined before the guest bound its lease. */
  readonly workspace: string | undefined
  /**
   * How the page asked for it: `main-frame`, a navigation of the guest's main frame that the main frame itself started;
   * `frame`, a navigation of a frame inside the page, or of the main frame that another frame started; `window`, a
   * window the page opened.
   */
  readonly via: 'main-frame' | 'frame' | 'window'
  /** The origin of the page the guest's main frame showed when the link came. */
  readonly origin: string
}

/**
 * The source of a guest's link: `play` only for the Play page's guest navigating its own main frame, `page` otherwise.
 * @param link - what the guest's link came from.
 * @returns its source.
 */
export function guestLinkSource(link: DesktopGuestLink): DesktopWasdLinkSource {
  return link.workspace === PLAY_STORAGE && link.via === 'main-frame' ? { kind: 'play', origin: link.origin } : { kind: 'page' }
}

/**
 * Whether a string is a WASD Engine game link of `scheme`: `<scheme>://games/<slug>` with an optional query.
 * @param raw - the candidate, such as a command-line argument.
 * @param scheme - the app's URL scheme, without `:`.
 * @returns the link, normalized by URL parsing, or undefined when it is not a game link.
 */
export function gameLink(raw: unknown, scheme: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH || !raw.toLowerCase().startsWith(`${scheme}://games/`)) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Not a URL: no link.
    return undefined
  }
  const slug = url.pathname.replace(/^\/+/u, '')
  if (url.protocol !== `${scheme}:` || url.hostname !== 'games' || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(slug)) return undefined
  return url.href
}

/** A game link without `install`, which then opens the game's page only. */
function withoutInstall(link: string): string {
  const url = new URL(link)
  url.searchParams.delete('install')
  return url.href
}

/** Game links waiting for the application page. */
export class WasdLinkInbox {
  private readonly pending: DesktopWasdLink[] = []
  /** When each source's links passed within the last minute. */
  private readonly passed = new Map<string, number[]>()
  /** When each link of each source last came, within the last {@link REPEAT_MS}. */
  private readonly seen = new Map<string, number>()
  private notify: () => void = () => {}

  /**
   * @param scheme - the app's URL scheme, without `:`.
   * @param now - the current time in milliseconds.
   */
  constructor(private readonly scheme: string, private readonly now: () => number = Date.now) {}

  /**
   * Keep a game link for the page, with its source, and tell the page about it. A link of a source that never installs
   * loses `install`; a repeat within {@link REPEAT_MS} and a link over its source's limit drop.
   * @param raw - a URL from the system, the command line, or a webview.
   * @param source - where it came from.
   * @returns whether it was a game link, also when it dropped, so a guest stays where it is.
   */
  deliver(raw: unknown, source: DesktopWasdLinkSource): boolean {
    const link = gameLink(raw, this.scheme)
    if (link === undefined) return false
    const url = source.kind === 'play' ? link : withoutInstall(link)
    const from = source.kind === 'play' ? `play ${source.origin}` : source.kind
    const at = this.now()
    for (const [key, time] of this.seen) if (at - time >= REPEAT_MS) this.seen.delete(key)
    for (const [key, times] of this.passed) if (times.every(time => at - time >= MINUTE_MS)) this.passed.delete(key)
    const repeat = `${from} ${url}`
    const repeated = this.seen.has(repeat)
    this.seen.set(repeat, at)
    if (repeated) return true
    const times = (this.passed.get(from) ?? []).filter(time => at - time < MINUTE_MS)
    this.passed.set(from, times)
    if (times.length >= LINKS_PER_MINUTE[source.kind]) return true
    times.push(at)
    this.pending.push({ url, source })
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING)
    this.notify()
    return true
  }

  /**
   * Keep every game link among command-line arguments, as Windows passes a link that starts the app.
   * @param argv - the arguments.
   * @returns whether any argument was a game link.
   */
  deliverArguments(argv: readonly unknown[] | undefined): boolean {
    let found = false
    for (const argument of argv ?? []) found = this.deliver(argument, SYSTEM_LINK) || found
    return found
  }

  /**
   * Hand the waiting links to the page, oldest first, and forget them.
   * @returns the links with their sources.
   */
  take(): DesktopWasdLink[] {
    return this.pending.splice(0)
  }

  /**
   * Set how the page hears about a new link; links that already wait are announced at once.
   * @param notify - sends the page the `changed` event.
   */
  listen(notify: () => void): void {
    this.notify = notify
    if (this.pending.length > 0) notify()
  }
}

/**
 * Serve `dshDesktop.wasdLinks.take` to the primary window's application page.
 * @param ipc - main-process IPC.
 * @param inbox - the links.
 * @param assertProductSender - throws for any other sender.
 */
export function registerWasdengineLinks(
  ipc: Pick<IpcMain, 'handle'>, inbox: WasdLinkInbox, assertProductSender: (event: IpcMainInvokeEvent) => unknown,
): void {
  ipc.handle(WASD_LINKS_IPC.take, (event) => {
    assertProductSender(event)
    return inbox.take()
  })
}
