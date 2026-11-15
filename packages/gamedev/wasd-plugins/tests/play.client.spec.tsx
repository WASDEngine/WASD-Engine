// @vitest-environment jsdom
/**
 * The Play page's window half: game links, the navigator, the sidebar's Play and Build switch, the Play page in a
 * browser, the game library beside it, and the follower that opens the Desktop shell's game links.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { followGameLinks, linkInstalls } from '../src/client/library.ts'
import { en } from '../src/client/locales.ts'
import { createPlayNavigator, gamePage, parseGameLink, PLAY_PANEL, type PlayNavigation } from '../src/client/play.ts'
import { PlayBuildToggle, type PlayBuildToggleProps } from '../src/client/PlayBuildToggle.tsx'
import { PlayPage, type PlayPageProps } from '../src/client/PlayPage.tsx'
import { PlayLibrary, type LaunchFailure } from '../src/client/PlayLibrary.tsx'
import type { DesktopWasdLink, DesktopWasdLinksBridge, WasdLibraryGame, WasdLibraryView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)

describe('game links', () => {
  it('reads the site\'s Install links and builds the game\'s page', () => {
    expect(parseGameLink('wasdengine://games/sky-keep-1?install=1')).toEqual({ slug: 'sky-keep-1', install: true })
    expect(parseGameLink('wasdengine://games/sky-keep?v=3')).toEqual({ slug: 'sky-keep', version: 3, install: false })
    expect(parseGameLink('wasdengine://games/sky-keep?v=0&install=yes')).toEqual({ slug: 'sky-keep', install: false })
    for (const other of ['wasdengine://open', 'https://site.test/games/sky-keep', 'wasdengine://games/Sky', 'not a url']) {
      expect(parseGameLink(other), other).toBeUndefined()
    }
    expect(gamePage('https://site.test', { slug: 'sky-keep', install: true })).toBe('https://site.test/games/sky-keep')
    expect(gamePage('https://site.test', { slug: 'sky-keep', version: 2, install: false })).toBe('https://site.test/games/sky-keep?v=2')
  })

  it('numbers each navigation, so the same address goes again, and remembers the page\'s address', () => {
    const navigator = createPlayNavigator()
    expect(navigator.store.getSnapshot()).toBeUndefined()
    navigator.go('https://site.test/explore')
    navigator.go('https://site.test/explore')
    expect(navigator.store.getSnapshot()).toEqual({ url: 'https://site.test/explore', seq: 2 })
    navigator.remember('https://site.test/games/sky-keep')
    expect(navigator.last()).toBe('https://site.test/games/sky-keep')
  })

  /** The shell's bridge, which hands out the lists a spec queues, one list per take. */
  function shell(waiting: DesktopWasdLink[][]) {
    let notify = (): void => {}
    const links: DesktopWasdLinksBridge = {
      take: vi.fn(() => Promise.resolve(waiting.shift() ?? [])),
      subscribe: (listener) => {
        notify = listener
        return () => { notify = () => {} }
      },
    }
    return { links, notify: () => { notify() } }
  }
  const SITE = 'https://site.test'
  const fromPlay = { kind: 'play', origin: SITE } as const

  it('takes the shell\'s links in order and opens each game link once', async () => {
    const { links, notify } = shell([
      [{ url: 'wasdengine://games/a?install=1', source: fromPlay }, { url: 'wasdengine://open', source: fromPlay }, { url: 'wasdengine://games/b', source: fromPlay }],
      [{ url: 'wasdengine://games/c?v=2', source: { kind: 'system' } }],
    ])
    const opened: string[] = []
    const warn = vi.fn()
    const stop = followGameLinks({
      links, site: () => Promise.resolve(SITE), warn,
      open: (link) => { opened.push(`${link.slug}:${String(link.install)}:${String(link.version)}`); return Promise.resolve(link.slug === 'b' ? 'refused' : undefined) },
    })
    await vi.waitFor(() => { expect(opened).toEqual(['a:true:undefined', 'b:false:undefined']) })
    notify()
    await vi.waitFor(() => { expect(opened).toHaveLength(3) })
    expect(opened[2]).toBe('c:false:2')
    expect(warn).toHaveBeenCalledWith('wasd-plugins: the game b did not start installing: refused', undefined)
    stop()
  })

  it('installs only for the site\'s Install button in the Play page, and opens the game\'s page for every other link', async () => {
    const install = 'wasdengine://games/sky-keep?install=1'
    const { links } = shell([[
      { url: install, source: { kind: 'system' } },
      { url: install, source: { kind: 'page' } },
      { url: install, source: { kind: 'play', origin: 'https://ads.example' } },
      { url: install, source: fromPlay },
      // Whatever crosses from the main process is read as data.
      { url: install, source: { kind: 'play' } as never },
      { url: 42 as never, source: fromPlay },
    ]])
    const opened: boolean[] = []
    const stop = followGameLinks({
      links, site: () => Promise.resolve(SITE), warn: vi.fn(),
      open: (link) => { opened.push(link.install); return Promise.resolve(undefined) },
    })
    await vi.waitFor(() => { expect(opened).toEqual([false, false, false, true, false]) })
    stop()
    expect(linkInstalls({ url: install, source: fromPlay }, SITE)).toBe(true)
    expect(linkInstalls({ url: install, source: fromPlay }, 'https://other.test')).toBe(false)
  })
})

describe('PlayBuildToggle', () => {
  function toggle(active: MainPanelId | null, wide = true) {
    const play = vi.fn()
    const build = vi.fn()
    const props: PlayBuildToggleProps = {
      ...({} as PlayBuildToggleProps),
      wide,
      usePanelInfo: selector => selector({ activePanelId: active }),
      t,
      play,
      build,
    }
    render(<PlayBuildToggle {...props} />)
    return { play, build }
  }

  it('marks Build while the Sessions show, and Play switches to the Play page', () => {
    const { play, build } = toggle(null)
    const group = screen.getByRole('group', { name: en['mode.label'] })
    const [playButton, buildButton] = within(group).getAllByRole('button')
    expect(playButton?.textContent).toBe(en['mode.play'])
    expect(playButton?.getAttribute('aria-pressed')).toBe('false')
    expect(buildButton?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(buildButton as HTMLElement)
    expect(build).not.toHaveBeenCalled()
    fireEvent.click(playButton as HTMLElement)
    expect(play).toHaveBeenCalledOnce()
  })

  it('marks Play on the Play page, Build returns to the Sessions, and the rail shows icons alone', () => {
    const { build } = toggle(PLAY_PANEL, false)
    const playButton = screen.getByRole('button', { name: en['mode.play'] })
    expect(playButton.getAttribute('aria-pressed')).toBe('true')
    expect(playButton.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en['mode.build'] }))
    expect(build).toHaveBeenCalledOnce()
  })
})

/** How a spec answers a game's start. */
type Launch = (id: string, anyway: boolean) => Promise<LaunchFailure | undefined>

describe('PlayPage', () => {
  function page(options: { readonly library?: WasdLibraryView; readonly launch?: Launch } = {}) {
    const navigation = createSnapshotStore<PlayNavigation | undefined>(undefined)
    const library = createSnapshotStore<WasdLibraryView | undefined>(options.library)
    const actions = {
      install: vi.fn((_slug: string, _version: number) => Promise.resolve<string | undefined>(undefined)),
      launch: vi.fn(options.launch ?? ((_id: string, _anyway: boolean) => Promise.resolve<LaunchFailure | undefined>(undefined))),
      remove: vi.fn((_id: string) => Promise.resolve<string | undefined>(undefined)),
      dismiss: vi.fn(),
      openExternal: vi.fn(),
      watchLibrary: vi.fn(() => () => {}),
    }
    const props: PlayPageProps = {
      ...({} as PlayPageProps),
      t,
      useNavigation: bindSnapshotSelector(navigation),
      useLibrary: bindSnapshotSelector(library),
      explore: () => Promise.resolve('https://site.test/explore'),
      desktop: undefined,
      remember: vi.fn(),
      last: () => undefined,
      ...actions,
    }
    render(<PlayPage {...props} />)
    return actions
  }

  it('offers Explore Games in a new tab in a browser, which cannot frame the site', async () => {
    const actions = page()
    expect(actions.watchLibrary).toHaveBeenCalledOnce()
    const open = screen.getByRole('button', { name: en['play.webOpen'] })
    await vi.waitFor(() => { expect((open as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(open)
    expect(actions.openExternal).toHaveBeenCalledWith('https://site.test/explore')
  })
})

describe('PlayPage in the Desktop app', () => {
  /** The Play page with a Desktop guest whose tag API the test drives; `signIn` answers the page's link requests. */
  async function desktopPage(signIn: (next: string) => Promise<string | undefined>) {
    const navigation = createSnapshotStore<PlayNavigation | undefined>(undefined)
    const remember = vi.fn()
    const openExternal = vi.fn()
    const bridge = {
      acquire: vi.fn(() => Promise.resolve({ lease: 'lease-1', partition: 'play-partition' })),
      release: vi.fn(() => Promise.resolve()),
      onOpenRequested: vi.fn(() => () => {}),
    }
    const props: PlayPageProps = {
      ...({} as PlayPageProps),
      t,
      useNavigation: bindSnapshotSelector(navigation),
      useLibrary: bindSnapshotSelector(createSnapshotStore<WasdLibraryView | undefined>({ supported: true, tasks: [], games: [] })),
      explore: () => Promise.resolve('https://site.test/explore'),
      desktop: bridge as never,
      remember,
      last: () => undefined,
      openExternal,
      signIn: vi.fn(signIn),
      install: vi.fn(), launch: vi.fn(), remove: vi.fn(), dismiss: vi.fn(),
      watchLibrary: () => () => {},
    }
    const view = render(<PlayPage {...props} />)
    const guest = await vi.waitFor(() => {
      const element = view.container.querySelector('webview')
      if (element === null) throw new Error('no guest yet')
      return element as HTMLElement
    })
    let shown = 'about:blank#lease-1'
    const loadURL = vi.fn((url: string) => { shown = url; return Promise.resolve() })
    Object.assign(guest, {
      setUserAgent: vi.fn(), loadURL, getURL: () => shown, getTitle: () => 'Explore games',
      canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
    })
    const arrive = (url: string): void => {
      shown = url
      guest.dispatchEvent(new Event('did-navigate'))
    }
    return { props, guest, loadURL, navigation, remember, openExternal, arrive }
  }

  it('opens its first page through the app\'s sign-in link, and never starts again at the sign-in page', async () => {
    const page = await desktopPage(next => Promise.resolve(`https://site.test/app/sign-in#code=wasd_${next.slice(1)}`))
    page.guest.dispatchEvent(new Event('dom-ready'))
    await vi.waitFor(() => { expect(page.loadURL).toHaveBeenCalledWith('https://site.test/app/sign-in#code=wasd_explore') })
    expect(page.props.signIn).toHaveBeenCalledWith('/explore')
    // The sign-in page is a step on the way: neither remembered nor handed to the system browser.
    await act(async () => { page.arrive('https://site.test/app/sign-in') })
    expect(page.remember).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en['play.openBrowser'] }))
    expect(page.openExternal).toHaveBeenCalledWith('https://site.test/explore')
    await act(async () => { page.arrive('https://site.test/explore') })
    expect(page.remember).toHaveBeenCalledWith('https://site.test/explore')
  })

  it('signs in to the page a request asked for while the link was on its way, and opens the page itself while signed out', async () => {
    let answer: (link: string | undefined) => void = () => {}
    const page = await desktopPage(next => next === '/explore'
      ? new Promise((resolve) => { answer = resolve })
      : Promise.resolve(undefined))
    page.guest.dispatchEvent(new Event('dom-ready'))
    await vi.waitFor(() => { expect(page.props.signIn).toHaveBeenCalledWith('/explore') })
    await act(async () => { page.navigation.set({ url: 'https://site.test/games/sky-keep?v=2', seq: 1 }) })
    answer('https://site.test/app/sign-in#code=wasd_explore')
    // The newer page wins; signed out (no link), the page opens as it is.
    await vi.waitFor(() => { expect(page.loadURL).toHaveBeenCalledTimes(1) })
    expect(page.props.signIn).toHaveBeenLastCalledWith('/games/sky-keep?v=2')
    expect(page.loadURL).toHaveBeenCalledWith('https://site.test/games/sky-keep?v=2')
  })
})

describe('PlayLibrary in the Desktop app', () => {
  const COVER = 'https://site.test/game-files/covers/sky-keep.jpg'

  function library(view: WasdLibraryView | undefined, launch?: (id: string, anyway: boolean) => Promise<LaunchFailure | undefined>) {
    const actions = {
      install: vi.fn((_slug: string, _version: number) => Promise.resolve<string | undefined>(undefined)),
      launch: vi.fn(launch ?? ((_id: string, _anyway: boolean) => Promise.resolve<LaunchFailure | undefined>(undefined))),
      remove: vi.fn((_id: string) => Promise.resolve<string | undefined>(undefined)),
      dismiss: vi.fn(),
      openPage: vi.fn(),
    }
    return { actions, element: <PlayLibrary t={t} library={view} {...actions} /> }
  }

  const SKY_KEEP: WasdLibraryGame = {
    id: 'g1', slug: 'sky-keep', title: 'Sky Keep', version: 1, latestVersion: 2, platform: 'macos', bytes: 10,
    installedAt: '2026-11-13T00:00:00Z', coverUrl: COVER,
  }
  const ARENA: WasdLibraryGame = {
    id: 'g2', slug: 'arena', title: 'Arena', version: 4, latestVersion: 5, multiplayer: 'dedicated', platform: 'macos', bytes: 10,
    installedAt: '2026-11-13T00:00:00Z',
  }

  const VIEW: WasdLibraryView = {
    supported: true,
    tasks: [
      { slug: 'moon-run', title: 'Moon Run', version: 3, state: 'downloading', receivedBytes: 25, totalBytes: 100, coverUrl: 'https://site.test/game-files/covers/moon-run.jpg' },
      { slug: 'lost', title: 'Lost Game', version: 1, state: 'failed', receivedBytes: 0, totalBytes: 0, message: 'The download failed.' },
    ],
    games: [{ ...SKY_KEEP, updateVersion: 2 }, { ...ARENA, updateVersion: 5 }],
  }

  /** The library with these games and no downloads. */
  const only = (...games: WasdLibraryGame[]): WasdLibraryView => ({ supported: true, tasks: [], games })

  it('groups downloads and installed games, with progress, Try again, and the installed count', () => {
    const { actions, element } = library(VIEW)
    render(element)
    expect(screen.getByRole('heading', { name: en['library.downloads'] })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en['library.installed'] })).toBeTruthy()
    expect(screen.getByText('2', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Moon Run' }).getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText('Downloading 25%')).toBeTruthy()
    expect(screen.getByText(en['library.failed'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['library.retry'] }))
    expect(actions.install).toHaveBeenCalledWith('lost', 0)
    fireEvent.click(screen.getByRole('button', { name: en['library.dismiss'] }))
    expect(actions.dismiss).toHaveBeenCalledWith('lost')
  })

  it('shows each game\'s picture, or its title when it has none or the picture fails, and opens its page', () => {
    const { actions, element } = library(VIEW)
    const view = render(element)
    const picture = view.container.querySelector(`img[src="${COVER}"]`) as HTMLImageElement
    expect(picture.closest('[aria-hidden="true"]')?.hasAttribute('data-loaded')).toBe(false)
    fireEvent.load(picture)
    expect(picture.closest('[aria-hidden="true"]')?.hasAttribute('data-loaded')).toBe(true)
    // Arena has no picture: its card shows its title alone.
    expect(view.container.querySelectorAll('img')).toHaveLength(2)
    fireEvent.error(picture)
    expect(view.container.querySelector(`img[src="${COVER}"]`)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sky Keep' }))
    expect(actions.openPage).toHaveBeenCalledWith('sky-keep')
  })

  it('plays a game, offers Update only for a single-player game, and its menu opens the page, updates, and uninstalls', async () => {
    const { actions, element } = library(VIEW, (_id: string) => Promise.resolve<LaunchFailure | undefined>({ message: 'Online games need a WASD Engine account.' }))
    render(element)
    expect(screen.getByText(en['library.online'])).toBeTruthy()
    // Only the single-player game offers Update; the online one updates when it starts.
    const updates = screen.getAllByRole('button', { name: en['library.updateShort'] })
    expect(updates).toHaveLength(1)
    fireEvent.click(updates[0] as HTMLElement)
    expect(actions.install).toHaveBeenCalledWith('sky-keep', 0)
    const plays = screen.getAllByRole('button', { name: en['library.play'] })
    expect(plays.map(button => button.getAttribute('aria-describedby') === null)).toEqual([false, false])
    await act(async () => { fireEvent.click(plays[1] as HTMLElement) })
    expect(actions.launch).toHaveBeenCalledWith('g2', false)
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual(['The download failed.', 'Online games need a WASD Engine account.'])

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Arena' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['library.openPage'], en['library.uninstall']])
    fireEvent.click(screen.getByRole('menuitem', { name: en['library.openPage'] }))
    expect(actions.openPage).toHaveBeenCalledWith('arena')

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Sky Keep' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['library.openPage'], 'Update to version 2', en['library.uninstall']])
    fireEvent.click(screen.getByRole('menuitem', { name: en['library.uninstall'] }))
    expect(actions.remove).toHaveBeenCalledWith('g1')
  })

  it('offers Update only while a newer build for this computer is out, and says when the latest version has none yet', () => {
    const waiting: WasdLibraryGame = { ...SKY_KEEP, latestVersion: 3, updateVersion: 2, unavailableVersion: 3 }
    const online: WasdLibraryGame = { ...ARENA, unavailableVersion: 5 }
    const { element } = library(only(waiting, online))
    render(element)
    expect(screen.getAllByRole('button', { name: en['library.updateShort'] })).toHaveLength(1)
    expect(screen.getAllByRole('status').map(note => note.textContent)).toEqual([
      'Version 3 has no macOS download yet.',
      'Version 5 has no macOS download yet, and online play needs it.',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Sky Keep' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['library.openPage'], 'Update to version 2', en['library.uninstall']])
  })

  it('offers only Uninstall for a game WASD Engine took down', () => {
    const { actions, element } = library(only({ ...SKY_KEEP, availability: 'taken_down' }))
    render(element)
    expect(screen.queryByRole('button', { name: en['library.play'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['library.updateShort'] })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(en['library.takenDown'])
    fireEvent.click(screen.getByRole('button', { name: en['library.uninstall'] }))
    expect(actions.remove).toHaveBeenCalledWith('g1')
    expect(actions.launch).not.toHaveBeenCalled()
  })

  it('starts a game its creator removed only through Play anyway, and offers Uninstall beside it', async () => {
    const { actions, element } = library(only({ ...ARENA, availability: 'removed' }))
    render(element)
    expect(screen.getByRole('status').textContent).toBe(en['library.removedOnline'])
    expect(screen.queryByRole('button', { name: en['library.play'] })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['library.playAnyway'] })) })
    expect(actions.launch).toHaveBeenCalledWith('g2', true)
    fireEvent.click(screen.getByRole('button', { name: en['library.uninstall'] }))
    expect(actions.remove).toHaveBeenCalledWith('g2')
  })

  it('says a refusal in the player\'s language as soon as Play is refused', async () => {
    const refusals: LaunchFailure[] = [
      { message: 'The creator of Sky Keep removed it from WASD Engine.', refusal: { reason: 'removed' } },
      { message: 'Version 3 of Sky Keep has no macOS download yet.', refusal: { reason: 'unavailable', version: 3 } },
    ]
    const { actions, element } = library(only(SKY_KEEP), () => Promise.resolve(refusals.shift()))
    render(element)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['library.play'] })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(en['library.removed'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['library.playAnyway'] })) })
    expect(actions.launch.mock.calls).toEqual([['g1', false], ['g1', true]])
    expect(screen.getByRole('status').textContent).toBe('Version 3 has no macOS download yet.')
  })

  it('shows placeholder rows until the library answers, then says how to install a game, or where games install', () => {
    const first = library(undefined)
    const view = render(first.element)
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
    view.rerender(library({ supported: true, tasks: [], games: [] }).element)
    expect(screen.getByText(en['library.emptyTitle'])).toBeTruthy()
    expect(screen.getByText(en['library.empty'])).toBeTruthy()
    view.rerender(library({ supported: false, tasks: [], games: [] }).element)
    expect(screen.getByText(en['library.unsupportedTitle'])).toBeTruthy()
    expect(screen.getByText(en['library.unsupported'])).toBeTruthy()
  })
})
