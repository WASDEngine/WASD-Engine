/**
 * Window half of the agent's Browser: it follows the agents' Browser commands, takes those it can carry out, and acts
 * on a Desktop Browser tab in the right Sidebar. A window takes a command for a Session while the Session is on screen,
 * or while it holds that Session's agent tab, which keeps working when the user turns to another Session. The agent tab
 * is the Browser tab `browser_open` opened, or the Browser tab the user had open when the agent first read or looked at
 * the Browser; `browser_open` never loads into a tab the user opened. A window carries out one Session's commands in
 * order. Values a page script returns come from the page, so the window checks them before use.
 */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserAddressFailure, SidebarBrowserAutomation, SidebarBrowserTab } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WasdBrowserImage, WasdBrowserLimits, WasdBrowserOutcome, WasdBrowserRequest, WasdBrowserRequests } from '../types.ts'
import {
  clickControl, locateControl, pageScript, prepareField, snapshotPage, viewportSize, type ControlLocation, type FieldPreparation,
  type PageSnapshot,
} from './page.ts'

/** Kind of the right Sidebar's Browser tabs. */
export const BROWSER_KIND = 'browser'

/** Pause after an action before checking whether it started loading a page, in milliseconds. */
const ACTION_SETTLE_MS = 300

/** Pause after a page finished loading, for its scripts to fill it in, in milliseconds. */
const RENDER_SETTLE_MS = 500

/** Interval between checks of a loading page or a mounting tab, in milliseconds. */
const POLL_MS = 100

/** Longest wait for a tab the window opened to mount its page, in milliseconds. */
const TAB_MOUNT_MS = 5000

/** Most elements a page text visits. */
const MAX_ELEMENTS = 30_000

/** JPEG quality of screenshots. */
const SCREENSHOT_QUALITY = 0.85

/** One item of the followed command stream. */
export interface BrowserRequestDelivery {
  /** The waiting commands. */
  readonly value: WasdBrowserRequests
  /** Mark the item as applied. */
  accept(): void
}

/** The logical stream of waiting commands, which reopens itself across carrier losses. */
export interface BrowserRequestStream extends AsyncIterable<BrowserRequestDelivery> {
  /** Stop the stream for good. @returns once nothing can still deliver. */
  dispose(): Promise<void>
}

/** A tab of the right Sidebar. */
export interface SidebarTabRecord {
  /** Tab id. */
  readonly id: TabId
  /** Tab kind. */
  readonly kind: string
}

/** The right Sidebar operations the window half uses. */
export interface BrowserSidebar {
  /** The Session on screen. */
  readonly mounted: { getSnapshot(): SessionId | undefined; subscribe(listener: () => void): () => void }
  /** Open a new tab of a kind in a Session whose layout the window adopted. */
  openTabIn(sessionId: SessionId, kind: string): void
  /** @returns the open tabs of a Session whose layout the window adopted. */
  tabsIn(sessionId: SessionId): readonly SidebarTabRecord[]
  /** @returns the active tab of the Session on screen. */
  active(): SidebarTabRecord | undefined
  /** Focus a tab of the Session on screen. */
  focus(tabId: TabId): void
  /** @returns whether the docked column of the Session on screen is expanded. */
  isExpanded(): boolean
  /** Expand or collapse the docked column of the Session on screen. */
  toggleExpanded(): void
}

/** What the window half needs. */
export interface BrowserDriverServices {
  /** Open the logical stream of waiting commands. */
  readonly follow: () => BrowserRequestStream
  /** @returns whether this window took the command. */
  readonly claim: (id: string) => Promise<boolean>
  /** End a command this window took. */
  readonly settle: (id: string, outcome: WasdBrowserOutcome) => Promise<void>
  /** The right Sidebar. */
  readonly sidebar: BrowserSidebar
  /** The Desktop Browser tabs. */
  readonly automation: SidebarBrowserAutomation
  /** Report a failure that no tool call receives. */
  readonly warn: (message: string, error: unknown) => void
}

/** A command that cannot be carried out, with the message the agent reads. */
class BrowserCommandError extends Error {
  override name = 'BrowserCommandError'
}

/** A Browser tab and its face. */
interface AgentTab {
  readonly id: TabId
  readonly face: SidebarBrowserTab
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

const ADDRESS_FAILURES: Record<BrowserAddressFailure, string> = {
  'empty': 'The address is empty.',
  'invalid': 'The address is not a valid URL.',
  'protocol': 'The Browser opens only http and https addresses.',
  'credentials': 'The Browser does not open addresses that hold a user name or password.',
  'application-origin': 'The Browser does not open WASD Engine\'s own pages.',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function pageSnapshotOf(value: unknown): PageSnapshot {
  const fields = record(value)
  if (fields === undefined || typeof fields.title !== 'string' || typeof fields.url !== 'string'
    || typeof fields.text !== 'string' || typeof fields.truncated !== 'boolean') {
    throw new BrowserCommandError('The page did not let the Browser read it.')
  }
  return { title: fields.title, url: fields.url, text: fields.text, truncated: fields.truncated }
}

function locationOf(value: unknown): ControlLocation {
  const fields = record(value)
  if (fields?.found === false && (fields.reason === 'missing' || fields.reason === 'hidden')) return { found: false, reason: fields.reason }
  if (fields?.found !== true || typeof fields.x !== 'number' || typeof fields.y !== 'number' || !Number.isFinite(fields.x)
    || !Number.isFinite(fields.y) || typeof fields.select !== 'boolean') {
    throw new BrowserCommandError('The page did not let the Browser find the element.')
  }
  return { found: true, x: fields.x, y: fields.y, select: fields.select,
    ...typeof fields.covered === 'string' ? { covered: fields.covered.slice(0, 100) } : {} }
}

function preparationOf(value: unknown): FieldPreparation {
  const fields = record(value)
  if (fields?.ready === false && (fields.reason === 'missing' || fields.reason === 'not-a-field' || fields.reason === 'no-such-option')) {
    return { ready: false, reason: fields.reason }
  }
  if (fields?.ready === true && fields.mode === 'insert') return { ready: true, mode: 'insert' }
  if (fields?.ready === true && fields.mode === 'chosen' && typeof fields.choice === 'string') {
    return { ready: true, mode: 'chosen', choice: fields.choice.slice(0, 100) }
  }
  throw new BrowserCommandError('The page did not let the Browser use the field.')
}

function viewportOf(value: unknown): { readonly width: number; readonly height: number } {
  const fields = record(value)
  if (typeof fields?.width !== 'number' || typeof fields.height !== 'number' || !(fields.width > 0) || !(fields.height > 0)) {
    throw new BrowserCommandError('The page did not report its size.')
  }
  return { width: fields.width, height: fields.height }
}

function missingElement(element: number): BrowserCommandError {
  return new BrowserCommandError(`Element ${String(element)} is not on the page now; call browser_read for the current numbers.`)
}

/**
 * Encode a PNG `data:` URL as a JPEG, which keeps screenshots of photos and art small.
 * @param dataUrl - the PNG.
 * @returns the JPEG's base64 data, or undefined where the window cannot encode one.
 */
async function jpegOf(dataUrl: string): Promise<string | undefined> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return undefined
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.drawImage(bitmap, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_QUALITY })
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new Error('The screenshot could not be encoded.'))
      }
      reader.onerror = () => { reject(reader.error ?? new Error('The screenshot could not be encoded.')) }
      reader.readAsDataURL(blob)
    })
    return encoded.slice(encoded.indexOf(',') + 1)
  } finally {
    bitmap.close()
  }
}

/**
 * Follow the agents' Browser commands and carry out those this window can.
 * @param services - the Remote calls, the right Sidebar, and the Desktop Browser tabs.
 * @returns the disposer that stops following; commands already taken still settle.
 */
export function followBrowserRequests(services: BrowserDriverServices): () => void {
  const { sidebar, automation } = services
  const key = `__wasdBrowserControls${Math.random().toString(36).slice(2)}`
  const taken = new Set<string>()
  const agentTabs = new Map<SessionId, TabId>()
  const queues = new Map<SessionId, Promise<void>>()
  let waiting: readonly WasdBrowserRequest[] = []
  const lifetime = new AbortController()

  const onScreen = (sessionId: SessionId): boolean => sidebar.mounted.getSnapshot() === sessionId
  const agentTab = (sessionId: SessionId): AgentTab | undefined => {
    const id = agentTabs.get(sessionId)
    const face = id === undefined ? undefined : automation.tab(sessionId, id)
    return id === undefined || face === undefined ? undefined : { id, face }
  }
  const canServe = (request: WasdBrowserRequest): boolean => agentTab(request.sessionId) !== undefined || onScreen(request.sessionId)

  /** Show a tab of the Session on screen, expanding the column. */
  const reveal = (sessionId: SessionId, tabId: TabId): void => {
    if (!onScreen(sessionId)) return
    sidebar.focus(tabId)
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
  }

  const mounted = async (sessionId: SessionId, tabId: TabId): Promise<SidebarBrowserTab> => {
    const deadline = Date.now() + TAB_MOUNT_MS
    for (;;) {
      const face = automation.tab(sessionId, tabId)
      if (face !== undefined) return face
      if (Date.now() >= deadline) {
        throw new BrowserCommandError('The Browser tab did not open in the right panel; ask the user to show this conversation in WASD Engine.')
      }
      await delay(POLL_MS)
    }
  }

  /** A new agent tab in the Session on screen. */
  const openTab = async (sessionId: SessionId): Promise<AgentTab> => {
    if (!onScreen(sessionId)) {
      throw new BrowserCommandError('This conversation is not on screen in WASD Engine, so the Browser cannot open. Ask the user to show it, or use web_search and web_fetch.')
    }
    const before = new Set(sidebar.tabsIn(sessionId).filter(tab => tab.kind === BROWSER_KIND).map(tab => tab.id))
    sidebar.openTabIn(sessionId, BROWSER_KIND)
    const opened = sidebar.tabsIn(sessionId).find(tab => tab.kind === BROWSER_KIND && !before.has(tab.id))
    if (opened === undefined) throw new BrowserCommandError('The Browser tab did not open in the right panel.')
    agentTabs.set(sessionId, opened.id)
    return { id: opened.id, face: await mounted(sessionId, opened.id) }
  }

  /** The Browser tab the user has open in the Session on screen: the active one, else the newest. */
  const userTab = (sessionId: SessionId): AgentTab | undefined => {
    if (!onScreen(sessionId)) return undefined
    const active = sidebar.active()
    const id = active?.kind === BROWSER_KIND ? active.id : sidebar.tabsIn(sessionId).filter(tab => tab.kind === BROWSER_KIND).at(-1)?.id
    const face = id === undefined ? undefined : automation.tab(sessionId, id)
    if (id === undefined || face === undefined) return undefined
    agentTabs.set(sessionId, id)
    return { id, face }
  }

  const requireTab = (sessionId: SessionId, adopt: boolean): AgentTab => {
    const tab = agentTab(sessionId) ?? (adopt ? userTab(sessionId) : undefined)
    if (tab !== undefined) return tab
    throw new BrowserCommandError(adopt
      ? 'No page is open in the Browser; call browser_open first.'
      : 'No page is open in your Browser tab; call browser_open first, or browser_read to use the Browser tab the user has open.')
  }

  /** Wait until an action's page load, if it started one, ended, and the page's scripts had a moment. */
  const settlePage = async (tab: SidebarBrowserTab, limits: WasdBrowserLimits): Promise<void> => {
    await delay(ACTION_SETTLE_MS)
    const deadline = Date.now() + limits.loadTimeoutMs
    while ((tab.state().loading || !tab.page.ready()) && Date.now() < deadline) await delay(POLL_MS)
    if (!tab.state().loading) await delay(RENDER_SETTLE_MS)
  }

  const pageOutcome = async (tab: SidebarBrowserTab, limits: WasdBrowserLimits, note?: string): Promise<WasdBrowserOutcome> => {
    const state = tab.state()
    const error = state.error === undefined ? undefined
      : state.error.description === undefined ? 'the page failed to load' : `${state.error.description} (${String(state.error.code)})`
    const snapshot = tab.page.ready()
      ? pageSnapshotOf(await tab.page.evaluate(pageScript(snapshotPage,
        { key, maxChars: limits.maxChars, maxElements: MAX_ELEMENTS, layout: true })))
      : { title: state.target?.title ?? '', url: state.target?.url ?? '', text: '', truncated: false }
    const text = snapshot.text.slice(0, limits.maxChars)
    return {
      ok: true,
      page: {
        url: snapshot.url.slice(0, 16 * 1024), title: snapshot.title.slice(0, 1000), text,
        truncated: snapshot.truncated || text.length < snapshot.text.length, loading: state.loading,
        ...error === undefined ? {} : { error },
      },
      ...note === undefined ? {} : { note },
    }
  }

  const locate = async (tab: SidebarBrowserTab, element: number): Promise<Extract<ControlLocation, { found: true }>> => {
    const location = locationOf(await tab.page.evaluate(pageScript(locateControl, { key, element })))
    if (location.found) return location
    if (location.reason === 'missing') throw missingElement(element)
    throw new BrowserCommandError(`Element ${String(element)} is not visible on the page.`)
  }

  const click = async (tab: SidebarBrowserTab, x: number, y: number): Promise<void> => {
    await tab.page.sendInput({ type: 'mouseMove', x, y })
    await tab.page.sendInput({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await tab.page.sendInput({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }

  const screenshot = async (tab: SidebarBrowserTab, limits: WasdBrowserLimits): Promise<WasdBrowserImage> => {
    const capture = await tab.page.capture(limits.screenshotWidth)
    const viewport = viewportOf(await tab.page.evaluate(pageScript(viewportSize)))
    let jpeg: string | undefined
    try {
      jpeg = await jpegOf(capture.dataUrl)
    } catch (error) {
      services.warn('wasd-plugins: a Browser screenshot stays a PNG, because encoding it as a JPEG failed', error)
    }
    return {
      data: jpeg ?? capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1),
      mediaType: jpeg === undefined ? 'image/png' : 'image/jpeg',
      width: capture.width,
      height: capture.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    }
  }

  const run = async ({ sessionId, command, limits }: WasdBrowserRequest): Promise<WasdBrowserOutcome> => {
    switch (command.kind) {
      case 'open': {
        const tab = agentTab(sessionId) ?? await openTab(sessionId)
        const refused = tab.face.load(command.url)
        if (refused !== undefined) throw new BrowserCommandError(ADDRESS_FAILURES[refused])
        reveal(sessionId, tab.id)
        await settlePage(tab.face, limits)
        return await pageOutcome(tab.face, limits)
      }
      case 'read': {
        const tab = requireTab(sessionId, true)
        if (tab.face.state().loading || !tab.face.page.ready()) await settlePage(tab.face, limits)
        return await pageOutcome(tab.face, limits)
      }
      case 'click': {
        const tab = requireTab(sessionId, false)
        let note: string | undefined
        if (command.element !== undefined) {
          const location = await locate(tab.face, command.element)
          if (location.covered === undefined && !location.select) await click(tab.face, location.x, location.y)
          else {
            const clicked = await tab.face.page.evaluate(pageScript(clickControl, { key, element: command.element }))
            if (clicked !== true) throw missingElement(command.element)
            if (location.covered !== undefined) {
              note = `Element ${String(command.element)} was clicked by script, because ${location.covered} covers it; check whether that matters.`
            }
          }
        } else if (command.x !== undefined && command.y !== undefined) await click(tab.face, command.x, command.y)
        else throw new BrowserCommandError('Give element, or both x and y.')
        await settlePage(tab.face, limits)
        return await pageOutcome(tab.face, limits, note)
      }
      case 'type': {
        const tab = requireTab(sessionId, false)
        const location = await locate(tab.face, command.element)
        if (location.covered === undefined && !location.select) await click(tab.face, location.x, location.y)
        const script = pageScript(prepareField, { key, element: command.element, text: command.text })
        const field = preparationOf(await tab.face.page.evaluate(script))
        if (!field.ready) {
          if (field.reason === 'missing') throw missingElement(command.element)
          throw new BrowserCommandError(field.reason === 'no-such-option'
            ? `Element ${String(command.element)} has no option "${command.text}".`
            : `Element ${String(command.element)} is not a field you can type into.`)
        }
        if (field.mode === 'insert') await tab.face.page.insertText(command.text)
        if (command.submit) {
          await tab.face.page.sendInput({ type: 'keyDown', keyCode: 'Enter' })
          await tab.face.page.sendInput({ type: 'char', keyCode: '\r' })
          await tab.face.page.sendInput({ type: 'keyUp', keyCode: 'Enter' })
        }
        await settlePage(tab.face, limits)
        return await pageOutcome(tab.face, limits, field.mode === 'chosen' ? `Chose "${field.choice}".` : undefined)
      }
      case 'screenshot': {
        const tab = requireTab(sessionId, true)
        reveal(sessionId, tab.id)
        if (command.element !== undefined) await locate(tab.face, command.element)
        if (tab.face.state().loading || !tab.face.page.ready()) await settlePage(tab.face, limits)
        else await delay(ACTION_SETTLE_MS)
        const image = await screenshot(tab.face, limits)
        const state = tab.face.state()
        return {
          ok: true,
          page: { url: state.target?.url ?? '', title: state.target?.title ?? '', text: '', truncated: false, loading: state.loading },
          image,
        }
      }
      default: {
        const unknown: never = command
        throw new BrowserCommandError(`The Browser does not know the command ${JSON.stringify(unknown)}.`)
      }
    }
  }

  const serve = async (request: WasdBrowserRequest): Promise<void> => {
    if (!await services.claim(request.id)) return
    let result: WasdBrowserOutcome
    try {
      result = await run(request)
    } catch (error) {
      result = { ok: false, message: error instanceof BrowserCommandError ? error.message : `The Browser failed: ${messageOf(error)}` }
    }
    await services.settle(request.id, result)
  }

  const consider = (): void => {
    for (const request of waiting) {
      if (taken.has(request.id) || !canServe(request)) continue
      taken.add(request.id)
      const next = (queues.get(request.sessionId) ?? Promise.resolve()).then(() => serve(request)).catch((error: unknown) => {
        services.warn('wasd-plugins: a Browser command failed in the window', error)
      })
      queues.set(request.sessionId, next)
      void next.then(() => { if (queues.get(request.sessionId) === next) queues.delete(request.sessionId) })
    }
  }

  const stream = services.follow()
  const unsubscribe = sidebar.mounted.subscribe(consider)
  void (async () => {
    for await (const delivery of stream) {
      if (lifetime.signal.aborted) return
      delivery.accept()
      waiting = delivery.value.requests
      const current = new Set(waiting.map(request => request.id))
      for (const id of [...taken]) if (!current.has(id)) taken.delete(id)
      consider()
    }
  })().catch((error: unknown) => {
    if (!lifetime.signal.aborted) services.warn('wasd-plugins: the Browser command stream stopped', error)
  })
  return () => {
    lifetime.abort()
    unsubscribe()
    void stream.dispose()
  }
}
