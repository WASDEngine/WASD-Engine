/**
 * The Play page, the main panel the sidebar's Play switch shows: the WASD Engine site's games inside the app, under a
 * toolbar with Back, Forward, Reload, Explore, and Open in browser, beside the game library of the games installed on
 * this computer, where choosing a game shows its page. In the Desktop app the site shows in a sandboxed `<webview>`
 * guest of the Desktop Browser's kind (the shell admits it through `dshDesktop.browser`), whose user agent carries
 * {@link IN_APP_AGENT}, so the site shows its in-app presentation; a link the site opens in a new window opens there
 * when it is on the site and in the system browser otherwise, and the shell hands the app the `wasdengine://` game
 * links the site's Install buttons write. A browser cannot frame the site, so the Web UI offers to open Explore in a
 * new tab instead. The page starts at the address it showed last, the Explore page the first time, and goes wherever
 * the navigator sends it. While the app is signed in, its first page opens through a one-time sign-in link the Host
 * asks the site for, so the site shows the app's account.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconGlobeOutlineRegular, IconLayersOutlineRegular,
  IconRefreshOutlineRegular, IconRightUpOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WasdLibraryView, WasdPlayStorage } from '../types.ts'
import type { NS } from './locales.ts'
import { gamePage, IN_APP_AGENT, type PlayNavigation } from './play.ts'
import { PlayLibrary, type PlayLibraryActions } from './PlayLibrary.tsx'
import css from './PlayPage.module.css'

/**
 * The storage of the Play page's guest: its own, apart from every workspace's Browser tabs. The Desktop shell knows
 * the guest by it, and lets only the site's Install button there install a game.
 */
const PLAY_STORAGE: WasdPlayStorage = 'wasd-engine-play'

/** The Electron tag API the page drives. */
interface PlayWebview extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  setUserAgent(userAgent: string): void
}

/** Registration-side state and operations of the Play page. */
export interface PlayPageInjected extends PlayLibraryActions {
  readonly hooks: {
    /** The latest request to show an address. */
    readonly navigation: ObservableSnapshot<PlayNavigation | undefined>
    /** The game library, once the Host answered. */
    readonly library: ObservableSnapshot<WasdLibraryView | undefined>
  }
  /** Follow the game library while the page shows it. @returns the function that stops following. */
  readonly watchLibrary: () => () => void
  /** @returns the site's Explore page. */
  readonly explore: () => Promise<string>
  /**
   * Ask for a one-time link that opens a page of the site signed in as the app's account.
   * @param next - the page, a path on the site.
   * @returns the link, or undefined while the app is signed out or when no link could be had.
   */
  readonly signIn: (next: string) => Promise<string | undefined>
  /** The Desktop shell's guest admission; undefined in the Web UI. */
  readonly desktop: DesktopBrowserBridge | undefined
  /**
   * Note the address the page shows, where it starts again next time.
   * @param url - the page's address.
   */
  readonly remember: (url: string) => void
  /** @returns the address the page showed last, if any. */
  readonly last: () => string | undefined
  /**
   * Open an address in the system browser, or a new tab of the Web UI.
   * @param url - an http(s) address.
   */
  readonly openExternal: (url: string) => void
}

/** Props of {@link PlayPage}. */
export type PlayPageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & InjectFace<PlayPageInjected>

/** What the toolbar shows of the guest. */
interface GuestState {
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

const NO_GUEST: GuestState = { url: '', title: '', canGoBack: false, canGoForward: false }

/** Whether an address is on the site of `explore`. */
function onSite(url: string, explore: string): boolean {
  try {
    return new URL(url).origin === new URL(explore).origin
  } catch {
    // Not an address: not on the site.
    return false
  }
}

/** The path and query of an address on the site, the page a sign-in link opens. */
function sitePath(url: string): string {
  const { pathname, search } = new URL(url)
  return pathname + search
}

/** Whether an address is at `path`; never for no path. */
function atPath(url: string, path: string | undefined): boolean {
  if (path === undefined) return false
  try {
    return new URL(url).pathname === path
  } catch {
    // Not an address: at no path.
    return false
  }
}

/**
 * Render the Play page.
 * @param props - composed slot props.
 * @returns the page.
 */
export function PlayPage(props: PlayPageProps) {
  const { t, useNavigation, useLibrary, watchLibrary, explore: readExplore, desktop, remember, last, openExternal, signIn } = props
  const navigation = useNavigation(request => request)
  const library = useLibrary(view => view)
  const [explore, setExplore] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [guest, setGuest] = useState<GuestState>(NO_GUEST)
  const [libraryOpen, setLibraryOpen] = useState(true)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<PlayWebview | undefined>(undefined)
  const ready = useRef(false)
  const pending = useRef<string | undefined>(undefined)
  // The path of the sign-in link the guest opened first: a step on the way to its page, never a page to show again.
  const signInPath = useRef<string | undefined>(undefined)
  const shownSeq = useRef(navigation?.seq ?? 0)

  useEffect(() => watchLibrary(), [watchLibrary])

  useEffect(() => {
    let current = true
    readExplore().then((url) => { if (current) setExplore(url) }, (error: unknown) => {
      if (current) setFailure((error as Error).message)
    })
    return () => { current = false }
  }, [readExplore])

  // One guest for the page's life, made once the site's address is known.
  useEffect(() => {
    if (desktop === undefined || explore === undefined || host.current === null) return
    const container = host.current
    const lifetime = new AbortController()
    const signal = lifetime.signal
    let lease: DesktopBrowserLeaseId | undefined
    let element: PlayWebview | undefined
    const observe = (): void => {
      if (element === undefined || !ready.current) return
      const url = element.getURL()
      if (url.startsWith('http') && !atPath(url, signInPath.current)) remember(url)
      setGuest({ url, title: element.getTitle(), canGoBack: element.canGoBack(), canGoForward: element.canGoForward() })
    }
    void desktop.acquire(PLAY_STORAGE).then((reservation) => {
      if (signal.aborted) {
        void desktop.release(reservation.lease)
        return
      }
      lease = reservation.lease
      element = document.createElement('webview') as PlayWebview
      element.className = css.webview ?? ''
      // The Desktop shell forwards the app's shortcuts from guests it marks as Browser frames.
      element.dataset.sidebarBrowserFrame = 'webview'
      element.setAttribute('name', reservation.lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('allowpopups', '')
      element.setAttribute('src', `about:blank#${reservation.lease}`)
      const guestElement = element
      guestElement.addEventListener('dom-ready', () => {
        guestElement.setUserAgent(`${navigator.userAgent} ${IN_APP_AGENT}`)
        void (async () => {
          // The first page opens through a sign-in link as the app's account. Requests to show an address wait while
          // the link is asked for, and the latest one becomes the page, asked for again.
          const take = (): string | undefined => {
            const requested = pending.current
            pending.current = undefined
            return requested
          }
          const ask = (url: string): Promise<string | undefined> =>
            onSite(url, explore) ? signIn(sitePath(url)).catch(() => undefined) : Promise.resolve(undefined)
          let start = take() ?? last() ?? explore
          let link = await ask(start)
          for (let newer = take(); newer !== undefined && !signal.aborted; newer = take()) {
            start = newer
            link = await ask(start)
          }
          if (signal.aborted) return
          if (link !== undefined) signInPath.current = new URL(link).pathname
          ready.current = true
          await guestElement.loadURL(link ?? start)
        })().catch(() => {
          // A load the guest abandons, or one a later navigation replaced, reports through did-fail-load.
        })
      }, { once: true, signal })
      for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) {
        guestElement.addEventListener(name, observe, { signal })
      }
      const unsubscribe = desktop.onOpenRequested(reservation.lease, (url) => {
        if (onSite(url, explore)) void guestElement.loadURL(url).catch(() => undefined)
        else openExternal(url)
      })
      signal.addEventListener('abort', unsubscribe, { once: true })
      container.append(guestElement)
      view.current = guestElement
    }, (error: unknown) => {
      if (!signal.aborted) setFailure((error as Error).message)
    })
    return () => {
      lifetime.abort()
      ready.current = false
      view.current = undefined
      element?.remove()
      if (lease !== undefined) void desktop.release(lease)
    }
  }, [desktop, explore, remember, last, openExternal, signIn])

  // Each new request sends the guest to its address; before the guest is ready, the request waits for it.
  useEffect(() => {
    if (navigation === undefined || navigation.seq === shownSeq.current) return
    shownSeq.current = navigation.seq
    if (view.current !== undefined && ready.current) void view.current.loadURL(navigation.url).catch(() => undefined)
    else pending.current = navigation.url
  }, [navigation])

  const go = (url: string | undefined): void => {
    if (url !== undefined && view.current !== undefined && ready.current) void view.current.loadURL(url).catch(() => undefined)
  }
  const external = guest.url.startsWith('http') && !atPath(guest.url, signInPath.current) ? guest.url : explore
  const openPage = (slug: string): void => {
    if (explore !== undefined) go(gamePage(new URL(explore).origin, { slug, install: false }))
  }

  if (desktop === undefined) {
    return (
      <div className={css.page}>
        <div className={css.fallback}>
          <h2 className={css.fallbackTitle}>{t('play.webTitle')}</h2>
          <p className={css.fallbackBody}>{t('play.webBody')}</p>
          <Button variant="primary" disabled={explore === undefined} onClick={() => { if (explore !== undefined) openExternal(explore) }}>
            {t('play.webOpen')}
          </Button>
          {failure !== undefined && <p className={css.warning} role="alert">{t('play.loadFailed', { message: failure })}</p>}
        </div>
      </div>
    )
  }

  const toolbarButton = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip label={label} delayMs={500}>
      <button type="button" className={css.toolButton} aria-label={label} onClick={onClick} disabled={disabled}>{icon}</button>
    </Tooltip>
  )
  const activeTasks = library?.tasks.filter(task => task.state !== 'failed').length ?? 0

  return (
    <div className={css.page}>
      <div className={css.toolbar} role="toolbar" aria-label={t('play.toolbar')} data-window-drag>
        {toolbarButton(t('play.back'), <IconChevronLeftOutlineRegular size={16} />, () => { view.current?.goBack() }, !guest.canGoBack)}
        {toolbarButton(t('play.forward'), <IconChevronRightOutlineRegular size={16} />, () => { view.current?.goForward() }, !guest.canGoForward)}
        {toolbarButton(t('play.reload'), <IconRefreshOutlineRegular size={16} />, () => { view.current?.reload() })}
        {toolbarButton(t('play.explore'), <IconGlobeOutlineRegular size={16} />, () => { go(explore) }, explore === undefined)}
        <span className={css.title} title={guest.url}>{guest.title === '' ? t('play.title') : guest.title}</span>
        {toolbarButton(t('play.openBrowser'), <IconRightUpOutlineRegular size={16} />, () => { if (external !== undefined) openExternal(external) }, external === undefined)}
        <Tooltip label={libraryOpen ? t('play.hideLibrary') : t('play.showLibrary')} delayMs={500}>
          <button
            type="button"
            className={css.libraryToggle}
            aria-pressed={libraryOpen}
            onClick={() => { setLibraryOpen(open => !open) }}
          >
            <IconLayersOutlineRegular size={16} />
            <span>{t('library.title')}</span>
            {activeTasks > 0 && <span className={css.badge}>{activeTasks}</span>}
          </button>
        </Tooltip>
      </div>
      <div className={css.body}>
        <div ref={host} className={css.view} aria-busy={explore === undefined}>
          {failure !== undefined && <p className={css.warning} role="alert">{t('play.loadFailed', { message: failure })}</p>}
        </div>
        {libraryOpen && <PlayLibrary {...props} library={library} openPage={openPage} />}
      </div>
    </div>
  )
}
