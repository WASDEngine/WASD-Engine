/**
 * Main-process side of `dshDesktop.wasdLinks`: the WASD Engine game links (`wasdengine://games/<slug>`, from the site's
 * Install buttons) that macOS hands the app (`open-url`, also before the app is ready), that Windows passes to the app's
 * command line or to a second launch's, and that a page in a Browser or Play webview navigates to. The links wait in an
 * inbox until the application page takes them, so a link that starts the app reaches the page once it loads; the page
 * hears about each new one through {@link WASD_LINKS_IPC}'s `changed` event. `dshDesktop.wasdLinks` documents the link
 * fields.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { WASD_LINKS_IPC } from './wasdengine-links-names.ts'

/** Most links the inbox keeps while no page takes them; older ones drop first. */
const MAX_PENDING = 16

/** Longest link the inbox accepts. */
const MAX_LINK_LENGTH = 2048

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

/** Game links waiting for the application page. */
export class WasdLinkInbox {
  private readonly pending: string[] = []
  private notify: () => void = () => {}

  /** @param scheme - the app's URL scheme, without `:`. */
  constructor(private readonly scheme: string) {}

  /**
   * Keep a game link for the page and tell the page about it.
   * @param raw - a URL from the system, the command line, or a webview.
   * @returns whether it was a game link.
   */
  deliver(raw: unknown): boolean {
    const link = gameLink(raw, this.scheme)
    if (link === undefined) return false
    this.pending.push(link)
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
    for (const argument of argv ?? []) found = this.deliver(argument) || found
    return found
  }

  /**
   * Hand the waiting links to the page, oldest first, and forget them.
   * @returns the links.
   */
  take(): string[] {
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
