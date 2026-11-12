// @vitest-environment jsdom
/**
 * The window half of the agent's Browser: which commands a window takes, which Browser tab it acts on, and what it
 * returns. The tabs are fakes whose page is this test's document; the page scripts run from their source text, as the
 * window sends them, against a document without layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserInputEvent, SidebarBrowserAutomation, SidebarBrowserTab } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  BROWSER_KIND, followBrowserRequests, type BrowserRequestDelivery, type BrowserSidebar, type SidebarTabRecord,
} from '../src/client/browser.ts'
import type { WasdBrowserCommand, WasdBrowserOutcome, WasdBrowserRequest } from '../src/types.ts'

const SESSION = 'session-1' as SessionId
const OTHER = 'session-2' as SessionId
const LIMITS = { maxChars: 10_000, loadTimeoutMs: 2000, screenshotWidth: 1280 } as const

/** A Browser tab whose page is the test document. */
function fakeTab() {
  const inputs: BrowserInputEvent[] = []
  const typed: string[] = []
  const loads: string[] = []
  const state: ReturnType<SidebarBrowserTab['state']> = {
    target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false, error: undefined, sandboxEnabled: undefined,
  }
  let current = state
  const face: SidebarBrowserTab = {
    state: () => current,
    load(url) {
      if (!/^https?:/u.test(url)) return 'protocol'
      loads.push(url)
      current = { ...current, target: { kind: 'https', url, title: 'Loaded' }, address: 'observed' }
      return undefined
    },
    page: {
      ready: () => true,
      // The test document has no layout, so the page text reads it without visibility checks.
      evaluate: (code) => {
        // oxlint-disable-next-line typescript/no-implied-eval -- The fake page runs the script text the window sends.
        const run = new Function(`return ${code.replace('"layout":true', '"layout":false')}`) as () => unknown
        return Promise.resolve(run())
      },
      capture: () => Promise.resolve({ dataUrl: 'data:image/png;base64,iVBORw0K', width: 640, height: 400 }),
      sendInput: (event) => { inputs.push(event); return Promise.resolve() },
      insertText: (text) => { typed.push(text); return Promise.resolve() },
    },
  }
  return { face, inputs, typed, loads }
}

function harness(onScreen: SessionId | undefined = SESSION) {
  let mounted: SessionId | undefined = onScreen
  const listeners = new Set<() => void>()
  const tabs = new Map<SessionId, SidebarTabRecord[]>()
  const pages = new Map<TabId, ReturnType<typeof fakeTab>>()
  let active: SidebarTabRecord | undefined
  let expanded = false
  let sequence = 0
  const openTabIn = vi.fn((sessionId: SessionId) => {
    addTab(sessionId)
    expanded = true
  })
  const focus = vi.fn((tabId: TabId) => { active = [...tabs.values()].flat().find(tab => tab.id === tabId) })
  const addTab = (sessionId: SessionId, id = `tab-${String(++sequence)}` as TabId) => {
    const tab = { id, kind: BROWSER_KIND }
    tabs.set(sessionId, [...tabs.get(sessionId) ?? [], tab])
    pages.set(id, fakeTab())
    active = tab
    return tab
  }
  const sidebar: BrowserSidebar = {
    mounted: {
      getSnapshot: () => mounted,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    openTabIn,
    tabsIn: sessionId => tabs.get(sessionId) ?? [],
    active: () => active,
    focus,
    isExpanded: () => expanded,
    toggleExpanded: () => { expanded = !expanded },
  }
  const automation: SidebarBrowserAutomation = { tab: (_sessionId, tabId) => pages.get(tabId)?.face }
  const deliveries: BrowserRequestDelivery[] = []
  let wake: (() => void) | undefined
  let disposed = false
  const dispose = vi.fn(() => {
    disposed = true
    wake?.()
    return Promise.resolve()
  })
  const outcomes = new Map<string, WasdBrowserOutcome>()
  const claim = vi.fn((_id: string) => Promise.resolve(true))
  const warn = vi.fn()
  const stop = followBrowserRequests({
    follow: () => ({
      async* [Symbol.asyncIterator]() {
        for (;;) {
          const next = deliveries.shift()
          if (next !== undefined) yield next
          else if (disposed) return
          else await new Promise<void>((resolve) => { wake = resolve })
        }
      },
      dispose,
    }),
    claim,
    settle: (id, outcome) => { outcomes.set(id, outcome); return Promise.resolve() },
    sidebar,
    automation,
    warn,
  })
  let requestSequence = 0
  const send = (command: WasdBrowserCommand, sessionId = SESSION): string => {
    const request: WasdBrowserRequest = { id: `request-${String(++requestSequence)}`, sessionId, command, limits: LIMITS }
    deliveries.push({ value: { requests: [request] }, accept: vi.fn() })
    wake?.()
    return request.id
  }
  const outcome = async (id: string): Promise<WasdBrowserOutcome> => {
    for (let step = 0; step < 100; step++) {
      const value = outcomes.get(id)
      if (value !== undefined) return value
      await vi.advanceTimersByTimeAsync(100)
    }
    throw new Error(`request ${id} did not settle`)
  }
  const show = (sessionId: SessionId | undefined) => {
    mounted = sessionId
    for (const listener of [...listeners]) listener()
  }
  return { sidebar, openTabIn, focus, pages, addTab, claim, warn, dispose, stop, send, outcome, show, isExpanded: () => expanded }
}

function page(outcome: WasdBrowserOutcome) {
  if (!outcome.ok) throw new Error(`expected a page, got: ${outcome.message}`)
  return outcome
}

const stops: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(Element.prototype, {
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) }),
  })
  Object.assign(document, { elementFromPoint: vi.fn(() => null) })
  document.title = 'Results'
  document.body.innerHTML = '<h1>Results</h1><a href="https://godotengine.org/">Godot</a><input aria-label="Search"><button>Go</button>'
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function start(onScreen?: SessionId) {
  const h = harness(onScreen)
  stops.push(h.stop)
  return h
}

describe('followBrowserRequests', () => {
  it('opens a tab of its own in the Session on screen, loads the address there, and returns the page text', async () => {
    const h = start()
    const id = h.send({ kind: 'open', url: 'https://duckduckgo.com/?q=godot' })
    const result = page(await h.outcome(id))
    expect(h.claim).toHaveBeenCalledWith(id)
    expect(h.openTabIn).toHaveBeenCalledWith(SESSION, BROWSER_KIND)
    const [agentTab] = h.sidebar.tabsIn(SESSION)
    expect(h.pages.get(agentTab!.id)?.loads).toEqual(['https://duckduckgo.com/?q=godot'])
    expect(h.focus).toHaveBeenCalledWith(agentTab!.id)
    expect(h.isExpanded()).toBe(true)
    expect(result.page).toMatchObject({ title: 'Results', truncated: false, loading: false })
    expect(result.page.text).toBe('# Results\n[Godot](https://godotengine.org/) [1: textbox "Search" value=""] [2: button "Go"]')
  })

  it('never loads into a tab the user opened, and keeps loading into its own', async () => {
    const h = start()
    const user = h.addTab(SESSION, 'user-tab' as TabId)
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/one' })))
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/two' })))
    expect(h.openTabIn).toHaveBeenCalledOnce()
    expect(h.pages.get(user.id)?.loads).toEqual([])
    const own = h.sidebar.tabsIn(SESSION).find(tab => tab.id !== user.id)!
    expect(h.pages.get(own.id)?.loads).toEqual(['https://example.test/one', 'https://example.test/two'])
  })

  it('reads the Browser tab the user has open, then acts on it', async () => {
    const h = start()
    const user = h.addTab(SESSION, 'user-tab' as TabId)
    expect(page(await h.outcome(h.send({ kind: 'read' }))).page.text).toContain('[2: button "Go"]')
    expect(h.openTabIn).not.toHaveBeenCalled()
    page(await h.outcome(h.send({ kind: 'click', element: 2 })))
    expect(h.pages.get(user.id)?.inputs).toEqual([
      { type: 'mouseMove', x: 50, y: 10 },
      { type: 'mouseDown', x: 50, y: 10, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 50, y: 10, button: 'left', clickCount: 1 },
    ])
  })

  it('asks for browser_open before acting without a tab of its own', async () => {
    const h = start()
    const failed = await h.outcome(h.send({ kind: 'click', element: 1 }))
    expect(failed).toEqual({ ok: false, message: 'No page is open in your Browser tab; call browser_open first, or browser_read to use the Browser tab the user has open.' })
  })

  it('clicks a covered control by script and says so, and reports a number that is no longer on the page', async () => {
    const h = start()
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/' })))
    const clicked = vi.fn()
    document.querySelector('button')!.addEventListener('click', clicked)
    Object.assign(document, { elementFromPoint: vi.fn(() => document.querySelector('h1')) })
    const result = page(await h.outcome(h.send({ kind: 'click', element: 2 })))
    expect(clicked).toHaveBeenCalledOnce()
    expect(result.note).toBe('Element 2 was clicked by script, because <h1> "Results" covers it; check whether that matters.')
    expect(await h.outcome(h.send({ kind: 'click', element: 9 })))
      .toEqual({ ok: false, message: 'Element 9 is not on the page now; call browser_read for the current numbers.' })
  })

  it('types into a field, replacing its text, and submits with Enter', async () => {
    const h = start()
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/' })))
    const [tab] = h.sidebar.tabsIn(SESSION)
    const fake = h.pages.get(tab!.id)!
    page(await h.outcome(h.send({ kind: 'type', element: 1, text: 'godot shaders', submit: true })))
    expect(fake.typed).toEqual(['godot shaders'])
    expect(fake.inputs.slice(3)).toEqual([
      { type: 'keyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' },
    ])
    expect(await h.outcome(h.send({ kind: 'type', element: 2, text: 'x', submit: false })))
      .toEqual({ ok: false, message: 'Element 2 is not a field you can type into.' })
  })

  it('refuses an address the Browser does not open', async () => {
    const h = start()
    expect(await h.outcome(h.send({ kind: 'open', url: 'javascript:alert(1)' })))
      .toEqual({ ok: false, message: 'The Browser opens only http and https addresses.' })
  })

  it('returns a screenshot with the viewport it shows, as a PNG where the window cannot encode a JPEG', async () => {
    const h = start()
    h.addTab(SESSION, 'user-tab' as TabId)
    const result = page(await h.outcome(h.send({ kind: 'screenshot' })))
    expect(result.image).toEqual({
      data: 'iVBORw0K', mediaType: 'image/png', width: 640, height: 400, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    })
    expect(result.page.text).toBe('')
  })

  it('leaves a Session that is not on screen to other windows until it comes on screen, and keeps serving its tab after it leaves', async () => {
    const h = start(OTHER)
    const id = h.send({ kind: 'open', url: 'https://example.test/' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.claim).not.toHaveBeenCalled()
    h.show(SESSION)
    page(await h.outcome(id))
    h.show(OTHER)
    expect(page(await h.outcome(h.send({ kind: 'read' }))).page.text).toContain('# Results')
    expect(h.claim).toHaveBeenCalledTimes(2)
  })

  it('stops following when disposed', async () => {
    const h = start()
    h.stop()
    expect(h.dispose).toHaveBeenCalledOnce()
    h.send({ kind: 'read' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })
})
