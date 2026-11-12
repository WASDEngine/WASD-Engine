/**
 * Agent control of Desktop Browser tabs, a WASD Engine addition (wasdengine/FORK.md lists the fork changes). The
 * Electron carrier gives the page of each tab an automation face over its `<webview>` guest: scripts in the page, a
 * picture of its visible part, trusted input, and typed text. The `sidebarBrowserAutomation` service finds the face of
 * one Session's mounted tab for another browser plugin; WASD Engine Plugins drives the tab its agent uses through it.
 * The Web iframe carrier has no face, because the application cannot read a cross-origin frame.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserController } from '../browser/BrowserController.ts'
import type { BrowserFrameState } from '../browser/BrowserFrame.ts'
import { parseBrowserAddress, type BrowserAddressFailure } from '../browser/url.ts'
import type { WebviewElement } from '../electron/ElectronWebviewPresentation.ts'
import type { BrowserBodyProps } from '../view/BrowserBody.tsx'

/** Owning Session of a Browser tab. */
type SessionId = BrowserBodyProps['sessionId']

/** A modifier key held during keyboard input. */
export type BrowserInputModifier = 'shift' | 'control' | 'alt' | 'meta'

/**
 * Trusted input, as Electron's `sendInputEvent` takes it. Pointer positions are CSS pixels of the page's viewport;
 * `keyCode` names a key the way Electron accelerators do (`Enter`, `Tab`, `A`), or a typed character for `char`.
 */
export type BrowserInputEvent =
  | {
    readonly type: 'mouseDown' | 'mouseUp' | 'mouseMove'
    readonly x: number
    readonly y: number
    readonly button?: 'left' | 'middle' | 'right'
    readonly clickCount?: number
  }
  | { readonly type: 'mouseWheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: 'keyDown' | 'keyUp' | 'char'; readonly keyCode: string; readonly modifiers?: readonly BrowserInputModifier[] }

/** A picture of the visible part of a page. */
export interface BrowserCapture {
  /** The picture as a `data:image/png;base64,` URL. */
  readonly dataUrl: string
  /** Picture width in pixels. */
  readonly width: number
  /** Picture height in pixels. */
  readonly height: number
}

/** Operations on the page a Browser tab shows; each rejects with {@link BrowserPageUnavailableError} before the guest is ready. */
export interface BrowserAutomation {
  /** @returns whether the guest is ready for the operations. */
  ready(): boolean
  /**
   * Run a script in the page's main world, which the page's own scripts share.
   * @param code - JavaScript source; a promise it completes with is awaited.
   * @returns the script's completion value, structured-cloned out of the page.
   */
  evaluate(code: string): Promise<unknown>
  /**
   * Capture the visible part of the page.
   * @param maxWidth - largest picture width in pixels; a wider capture is scaled down to it.
   * @returns the picture.
   */
  capture(maxWidth: number): Promise<BrowserCapture>
  /**
   * Send one trusted input event to the page.
   * @param event - the event, positioned in CSS pixels of the viewport.
   * @returns once the guest received it.
   */
  sendInput(event: BrowserInputEvent): Promise<void>
  /**
   * Type text at the page's focus, replacing its selection, as text input from the keyboard would.
   * @param text - the text.
   * @returns once the guest received it.
   */
  insertText(text: string): Promise<void>
}

/** The picture Electron's `capturePage` returns, as the application window can use it. */
export interface WebviewImage {
  /** @returns whether the picture has no pixels. */
  isEmpty(): boolean
  /** @returns the picture's size in pixels. */
  getSize(): { readonly width: number; readonly height: number }
  /**
   * @param options - the target width; the height follows the aspect ratio.
   * @returns a scaled copy.
   */
  resize(options: { readonly width: number; readonly quality?: 'good' | 'better' | 'best' }): WebviewImage
  /** @returns the picture as a PNG `data:` URL. */
  toDataURL(): string
}

/** A Browser tab's page is not ready: it has no guest yet, or its guest went away. */
export class BrowserPageUnavailableError extends Error {
  constructor(message = 'The Browser tab has no page yet.') {
    super(message)
    this.name = 'BrowserPageUnavailableError'
  }
}

/**
 * Build the automation face of an Electron page.
 * @param guest - the ready `<webview>` element, or undefined while the page has none.
 * @returns the face, which reads the element at each call.
 */
export function webviewAutomation(guest: () => WebviewElement | undefined): BrowserAutomation {
  const element = (): WebviewElement => {
    const current = guest()
    if (current === undefined) throw new BrowserPageUnavailableError()
    return current
  }
  const unsupported = (operation: string): never => {
    throw new BrowserPageUnavailableError(`The Browser tab's page cannot ${operation}.`)
  }
  return {
    ready: () => guest() !== undefined,
    async evaluate(code) {
      const page = element()
      return page.executeJavaScript === undefined ? unsupported('run scripts') : await page.executeJavaScript(code)
    },
    async capture(maxWidth) {
      const page = element()
      if (page.capturePage === undefined) return unsupported('be captured')
      const image = await page.capturePage()
      if (image.isEmpty()) throw new BrowserPageUnavailableError('The Browser tab showed nothing to capture.')
      const scaled = image.getSize().width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image
      const { width, height } = scaled.getSize()
      return { dataUrl: scaled.toDataURL(), width, height }
    },
    async sendInput(event) {
      const page = element()
      if (page.sendInputEvent === undefined) return unsupported('take input')
      await page.sendInputEvent(event)
    },
    async insertText(text) {
      const page = element()
      if (page.insertText === undefined) return unsupported('take typed text')
      await page.insertText(text)
    },
  }
}

/** One Desktop Browser tab as another plugin drives it. */
export interface SidebarBrowserTab {
  /** @returns the tab's navigation state. */
  state(): BrowserFrameState
  /**
   * Load an address after the address bar's checks, as typing it there does.
   * @param url - the address.
   * @returns why the address was refused, or undefined once loading started.
   */
  load(url: string): BrowserAddressFailure | undefined
  /** The tab's page. */
  readonly page: BrowserAutomation
}

/** Finds the automation face of a Desktop Browser tab. */
export interface SidebarBrowserAutomation {
  /**
   * @param sessionId - the Session whose right Sidebar holds the tab.
   * @param tabId - the tab.
   * @returns the tab's face while its body is mounted, or undefined.
   */
  tab(sessionId: SessionId, tabId: TabId): SidebarBrowserTab | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent control of Desktop Browser tabs (WASD Engine). */
    sidebarBrowserAutomation: SidebarBrowserAutomation
  }
}

/** The tab controllers of one Session, as the Desktop carrier keeps them. */
export interface BrowserTabControllers {
  /**
   * @param tabId - a tab of the Session.
   * @returns its controller while the tab's body is mounted.
   */
  controller(tabId: TabId): BrowserController | undefined
}

/**
 * Provide the `sidebarBrowserAutomation` service for the plugin scope of the Desktop carrier.
 * @param ctx - scope that owns the Desktop Browser tabs.
 * @param sessions - each Session's tab controllers.
 */
export function applyWasdengineBrowserAutomation(ctx: Context, sessions: ReadonlyMap<SessionId, BrowserTabControllers>): void {
  const service: SidebarBrowserAutomation = {
    tab(sessionId, tabId) {
      const controller = sessions.get(sessionId)?.controller(tabId)
      const page = controller?.automation
      if (controller === undefined || page === undefined) return undefined
      return {
        state: () => controller.getSnapshot().frame,
        load(url) {
          const parsed = parseBrowserAddress(url, window.location.origin)
          if (!parsed.ok) return parsed.reason
          controller.loadUrl(parsed.target.url)
          return undefined
        },
        page,
      }
    },
  }
  const dispose = ctx.reflect.provide('sidebarBrowserAutomation', service)
  ctx.effect(() => () => { void dispose() }, 'ui-sidebar-browser: agent automation')
}
