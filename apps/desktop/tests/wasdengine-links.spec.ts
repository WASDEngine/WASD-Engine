/**
 * WASD Engine game links wait in the main process until the application page takes them, each with its source: only
 * the Play page's own guest, navigating its main frame itself, gives a link that may install; every other source's link
 * loses `install`. Repeats and floods of one source drop, so no page can keep pulling the window to the Play page.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopWasdLinkSource } from '@deepseek-ai/dsh-wasd-plugins/types'
import { WASD_LINKS_IPC } from '../src/wasdengine-links-names.ts'

vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() },
    }),
  },
}))
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const { gameLink, guestLinkSource, registerWasdengineLinks, SYSTEM_LINK, WasdLinkInbox } = await import('../src/wasdengine-links.ts')
type DesktopGuestLink = import('../src/wasdengine-links.ts').DesktopGuestLink

const SITE = 'https://wasdengine.test'
const PLAY: DesktopWasdLinkSource = { kind: 'play', origin: SITE }
const PAGE: DesktopWasdLinkSource = { kind: 'page' }

/** An inbox on a clock the spec moves. */
function inbox() {
  const clock = { now: 0 }
  return { links: new WasdLinkInbox('wasdengine', () => clock.now), clock }
}

describe('gameLink', () => {
  it('accepts the site\'s game links and refuses everything else', () => {
    expect(gameLink('wasdengine://games/sky-keep-1?install=1&v=2', 'wasdengine')).toBe('wasdengine://games/sky-keep-1?install=1&v=2')
    expect(gameLink('WASDENGINE://games/sky-keep', 'wasdengine')).toBe('wasdengine://games/sky-keep')
    for (const other of [
      'wasdengine://open', 'wasdengine://games/', 'wasdengine://games/Sky_Keep', 'wasdengine://games/a/b',
      'https://wasdengine.com/games/sky-keep', 'other://games/sky-keep', `wasdengine://games/${'a'.repeat(81)}`, 42, undefined,
    ]) expect(gameLink(other, 'wasdengine'), String(other)).toBeUndefined()
  })
})

describe('WasdLinkInbox', () => {
  it('keeps links with their sources until the page takes them, and tells the page once it listens', () => {
    const { links } = inbox()
    expect(links.deliver('wasdengine://games/sky-keep?install=1', PLAY)).toBe(true)
    expect(links.deliver('wasdengine://open', SYSTEM_LINK)).toBe(false)
    const notify = vi.fn()
    links.listen(notify)
    expect(notify).toHaveBeenCalledOnce()
    expect(links.deliverArguments(['WASD Engine.exe', '--flag', 'wasdengine://games/moon-run'])).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(links.take()).toEqual([
      { url: 'wasdengine://games/sky-keep?install=1', source: PLAY },
      { url: 'wasdengine://games/moon-run', source: SYSTEM_LINK },
    ])
    expect(links.take()).toEqual([])
    expect(links.deliverArguments(undefined)).toBe(false)
  })

  it('drops install from the links of every source but the Play page\'s guest', () => {
    const { links } = inbox()
    links.deliver('wasdengine://games/a?install=1&v=2', SYSTEM_LINK)
    links.deliver('wasdengine://games/b?install=1', PAGE)
    links.deliverArguments(['wasdengine://games/c?v=3&install=1'])
    links.deliver('wasdengine://games/d?install=1', PLAY)
    expect(links.take()).toEqual([
      { url: 'wasdengine://games/a?v=2', source: SYSTEM_LINK },
      { url: 'wasdengine://games/b', source: PAGE },
      { url: 'wasdengine://games/c?v=3', source: SYSTEM_LINK },
      { url: 'wasdengine://games/d?install=1', source: PLAY },
    ])
  })

  it('passes a link that repeats one of its source within seconds once, and a few links of one source a minute', () => {
    const { links, clock } = inbox()
    // A double click, and a page that sends the same link again and again.
    expect(links.deliver('wasdengine://games/a?install=1', PLAY)).toBe(true)
    expect(links.deliver('wasdengine://games/a?install=1', PLAY)).toBe(true)
    clock.now = 4000
    links.deliver('wasdengine://games/a?install=1', PLAY)
    // The same link from another source is its own.
    links.deliver('wasdengine://games/a', PAGE)
    expect(links.take()).toEqual([
      { url: 'wasdengine://games/a?install=1', source: PLAY },
      { url: 'wasdengine://games/a', source: PAGE },
    ])
    // Each repeat within five seconds of the last kept it out; once it stops for five seconds, it passes again.
    clock.now = 9500
    links.deliver('wasdengine://games/a?install=1', PLAY)
    expect(links.take()).toHaveLength(1)
    // Pages share three links a minute, the first went at 4 s; the operating system has five, and the Play page ten per site.
    clock.now = 20_000
    for (let index = 0; index < 6; index++) {
      links.deliver(`wasdengine://games/page-${String(index)}`, PAGE)
      links.deliver(`wasdengine://games/system-${String(index)}`, SYSTEM_LINK)
    }
    const passed = links.take()
    expect(passed.filter(link => link.source.kind === 'page').map(link => link.url)).toEqual([
      'wasdengine://games/page-0', 'wasdengine://games/page-1',
    ])
    expect(passed.filter(link => link.source.kind === 'system')).toHaveLength(5)
    // A page's flood leaves the Play page's Install buttons alone, and the limit frees up after a minute.
    links.deliver('wasdengine://games/sky-keep?install=1', PLAY)
    expect(links.take()).toEqual([{ url: 'wasdengine://games/sky-keep?install=1', source: PLAY }])
    clock.now = 81_000
    links.deliver('wasdengine://games/page-9', PAGE)
    expect(links.take()).toEqual([{ url: 'wasdengine://games/page-9', source: PAGE }])
  })

  it('keeps only the newest sixteen links while no page takes them', () => {
    const { links } = inbox()
    for (let index = 0; index < 20; index++) links.deliver(`wasdengine://games/game-${String(index)}`, { kind: 'play', origin: `https://site-${String(index)}.test` })
    const taken = links.take()
    expect(taken).toHaveLength(16)
    expect(taken[0]?.url).toBe('wasdengine://games/game-4')
  })

  it('serves the page\'s take only to the product sender', () => {
    const { links } = inbox()
    links.deliver('wasdengine://games/sky-keep', SYSTEM_LINK)
    const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
    const assertProductSender = vi.fn((event: IpcMainInvokeEvent) => {
      if (event.sender !== 'owner' as never) throw new Error('rejected')
    })
    registerWasdengineLinks({ handle: (channel, handler) => { handlers.set(channel, handler as never) } }, links, assertProductSender)
    const take = handlers.get(WASD_LINKS_IPC.take)!
    expect(() => take({ sender: 'stranger' } as never)).toThrow('rejected')
    expect(take({ sender: 'owner' } as never)).toEqual([{ url: 'wasdengine://games/sky-keep', source: SYSTEM_LINK }])
  })
})

describe('guest links', () => {
  it('names a link of the Play page\'s guest that its main frame followed itself a play link, and every other one a page link', () => {
    const facts = (workspace: string | undefined, via: DesktopGuestLink['via']): DesktopGuestLink => ({ workspace, via, origin: SITE })
    expect(guestLinkSource(facts('wasd-engine-play', 'main-frame'))).toEqual({ kind: 'play', origin: SITE })
    for (const other of [
      facts('wasd-engine-play', 'frame'), facts('wasd-engine-play', 'window'), facts(undefined, 'main-frame'),
      facts('cwd:/Users/ada/game', 'main-frame'), facts('session:wasd-engine-play', 'main-frame'),
    ]) expect(guestLinkSource(other), JSON.stringify(other)).toEqual({ kind: 'page' })
  })

  /** A window with the guests the spec attaches, whose app links reach a real inbox. */
  function window() {
    const { links } = inbox()
    const seen: { url: string; link: DesktopGuestLink }[] = []
    const guests = new DesktopBrowserGuests(() => undefined, (url, link) => {
      seen.push({ url, link })
      return links.deliver(url, guestLinkSource(link))
    })
    const owner = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
    guests.bind({ webContents: owner } as never, () => () => {})
    /** Attach a guest of a workspace's storage, showing a page of `origin` in its main frame. */
    const attach = (workspace: string, origin: string) => {
      const reservation = guests.acquire(owner as never, workspace)
      const main = { origin, frameTreeNodeId: 1 }
      const child = { origin: 'https://games.test', frameTreeNodeId: 2 }
      const guest = Object.assign(new EventEmitter(), {
        mainFrame: main, getURL: () => `about:blank#${reservation.lease}`, setWindowOpenHandler: vi.fn(), close: vi.fn(), isDestroyed: () => false,
      })
      owner.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: `about:blank#${reservation.lease}`, partition: reservation.partition })
      owner.emit('did-attach-webview', {}, guest)
      guest.emit('dom-ready')
      const opener = guest.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string; postBody?: unknown }) => { action: string }
      return {
        /** A navigation of the main frame or a subframe, started by `initiator`; whether the guest stayed. */
        navigate(url: string, frame: 'main' | 'child', initiator: 'main' | 'child' | null): boolean {
          const preventDefault = vi.fn()
          const frames = { main, child }
          guest.emit('will-frame-navigate', {
            url, isMainFrame: frame === 'main', frame: frames[frame], initiator: initiator === null ? null : frames[initiator], preventDefault,
          })
          return preventDefault.mock.calls.length > 0
        },
        open: (url: string) => opener({ url }),
      }
    }
    return { attach, links, seen }
  }

  it('lets only the Play page\'s own main frame install, and opens every other in-app link\'s page', () => {
    const { attach, links, seen } = window()
    const play = attach('wasd-engine-play', SITE)
    const tab = attach('cwd:/Users/ada/game', SITE)
    // The site's Install button: the Play page's main frame navigates itself.
    expect(play.navigate('wasdengine://games/a?install=1', 'main', 'main')).toBe(true)
    // A game's frame navigates the page, or itself; the page opens a window; a Browser tab shows the site.
    expect(play.navigate('wasdengine://games/b?install=1', 'main', 'child')).toBe(true)
    expect(play.navigate('wasdengine://games/c?install=1', 'child', 'child')).toBe(true)
    expect(play.navigate('wasdengine://games/d?install=1', 'main', null)).toBe(true)
    expect(play.open('wasdengine://games/e?install=1')).toEqual({ action: 'deny' })
    expect(tab.navigate('wasdengine://games/f?install=1', 'main', 'main')).toBe(true)
    expect(seen.map(({ link }) => link.via)).toEqual(['main-frame', 'frame', 'frame', 'frame', 'window', 'main-frame'])
    expect(seen.map(({ link }) => link.workspace)).toEqual(['wasd-engine-play', 'wasd-engine-play', 'wasd-engine-play', 'wasd-engine-play', 'wasd-engine-play', 'cwd:/Users/ada/game'])
    // Pages pass three links a minute, so the window and the Browser tab's links drop.
    expect(links.take()).toEqual([
      { url: 'wasdengine://games/a?install=1', source: { kind: 'play', origin: SITE } },
      { url: 'wasdengine://games/b', source: PAGE },
      { url: 'wasdengine://games/c', source: PAGE },
      { url: 'wasdengine://games/d', source: PAGE },
    ])
    // Ordinary pages still load.
    expect(play.navigate('https://wasdengine.test/games/a', 'main', 'main')).toBe(false)
    expect(seen).toHaveLength(7)
  })

  it('names the origin the Play page\'s main frame showed, so a page the guest moved on to cannot install', () => {
    const { attach, links } = window()
    const play = attach('wasd-engine-play', 'https://elsewhere.test')
    play.navigate('wasdengine://games/a?install=1', 'main', 'main')
    expect(links.take()).toEqual([{ url: 'wasdengine://games/a?install=1', source: { kind: 'play', origin: 'https://elsewhere.test' } }])
  })
})
