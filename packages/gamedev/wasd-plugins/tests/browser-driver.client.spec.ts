// @vitest-environment jsdom
/**
 * The window half of the agent's Browser: which commands a window takes, which Browser tab it acts on, what it
 * returns, and how it stops a command whose page does not answer or whose tool call ended. The tabs are fakes whose
 * page is this test's document; the page scripts run from their source text, as the window sends them, against a
 * document without layout. The followed lists come from a model of the Host's queue.
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
const LIMITS = { maxChars: 10_000, loadTimeoutMs: 2000, operationTimeoutMs: 1000, screenshotWidth: 1280 } as const

/** The page operations a test can hold until it lets them go on, like a page whose main thread is busy. */
type PageOperation = 'evaluate' | 'insertText' | 'sendInput' | 'capture'

/** A Browser tab whose page is the test document. */
function fakeTab() {
  const inputs: BrowserInputEvent[] = []
  const typed: string[] = []
  const loads: string[] = []
  const calls: PageOperation[] = []
  const stall: Partial<Record<PageOperation, Promise<unknown>>> = {}
  const enter = async (operation: PageOperation): Promise<void> => {
    calls.push(operation)
    await stall[operation]
  }
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
      evaluate: async (code) => {
        await enter('evaluate')
        // oxlint-disable-next-line typescript/no-implied-eval -- The fake page runs the script text the window sends.
        const run = new Function(`return ${code.replace('"layout":true', '"layout":false')}`) as () => unknown
        return run()
      },
      capture: async () => {
        await enter('capture')
        return { dataUrl: 'data:image/png;base64,iVBORw0K', width: 640, height: 400 }
      },
      sendInput: async (event) => {
        await enter('sendInput')
        inputs.push(event)
      },
      insertText: async (text) => {
        await enter('insertText')
        typed.push(text)
      },
    },
  }
  return { face, inputs, typed, loads, calls, stall }
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
  // The Host's queue: the commands no window claimed, and the claimed ones whose call still waits.
  const queued = new Map<string, { request: WasdBrowserRequest; claimed: boolean }>()
  const publish = () => {
    const entries = [...queued.values()]
    deliveries.push({
      value: {
        requests: entries.filter(entry => !entry.claimed).map(entry => entry.request),
        claimed: entries.filter(entry => entry.claimed).map(entry => entry.request.id),
      },
      accept: vi.fn(),
    })
    wake?.()
  }
  const claim = vi.fn((id: string) => {
    const entry = queued.get(id)
    if (entry === undefined || entry.claimed) return Promise.resolve(false)
    entry.claimed = true
    publish()
    return Promise.resolve(true)
  })
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
    settle: (id, outcome) => {
      if (queued.delete(id)) outcomes.set(id, outcome)
      publish()
      return Promise.resolve()
    },
    sidebar,
    automation,
    warn,
  })
  let requestSequence = 0
  const send = (command: WasdBrowserCommand, sessionId = SESSION): string => {
    const request: WasdBrowserRequest = { id: `request-${String(++requestSequence)}`, sessionId, command, limits: LIMITS }
    queued.set(request.id, { request, claimed: false })
    publish()
    return request.id
  }
  /** End a command's tool call, as its timeout or its cancellation does on the Host. */
  const end = (id: string) => {
    queued.delete(id)
    publish()
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
  return {
    sidebar, openTabIn, focus, pages, addTab, claim, warn, dispose, stop, send, end, outcome, outcomes, show, isExpanded: () => expanded,
  }
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

  it('never loads into a tab the user opened, even after reading it, and keeps loading into its own', async () => {
    const h = start()
    const user = h.addTab(SESSION, 'user-tab' as TabId)
    page(await h.outcome(h.send({ kind: 'read' })))
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

  it('refuses to type into a password or payment field, or where the page moves the focus to one', async () => {
    document.body.innerHTML = '<input type="password" aria-label="Password"><input autocomplete="cc-number" aria-label="Card">'
      + '<input aria-label="Name">'
    const [, password, name] = document.querySelectorAll('input')
    const h = start()
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/' })))
    const [tab] = h.sidebar.tabsIn(SESSION)
    const fake = h.pages.get(tab!.id)!
    for (const element of [1, 2]) {
      expect(await h.outcome(h.send({ kind: 'type', element, text: 'hunter2', submit: true }))).toEqual({
        ok: false, message: `Element ${String(element)} is a password or payment field, which the Browser never fills in; ask the user to fill it in.`,
      })
    }
    name!.addEventListener('focus', () => { password!.focus() })
    expect(await h.outcome(h.send({ kind: 'type', element: 3, text: 'hunter2', submit: true }))).toEqual({
      ok: false,
      message: 'The page moved the focus to a password or payment field, so the Browser typed nothing; call browser_read and try again, or ask the user to fill in the field.',
    })
    expect(fake.typed).toEqual([])
    expect(fake.inputs.filter(input => input.type === 'keyDown')).toEqual([])
  })

  it('fails a page operation that does not answer in time, and then serves the Session\'s next command', async () => {
    const h = start()
    const user = h.addTab(SESSION, 'user-tab' as TabId)
    const fake = h.pages.get(user.id)!
    const busy = Promise.withResolvers<undefined>()
    fake.stall.evaluate = busy.promise
    const first = h.send({ kind: 'read' })
    const second = h.send({ kind: 'read' })
    await vi.advanceTimersByTimeAsync(0)
    // Both are taken at once, so the second does not wait for the first unclaimed.
    expect(h.claim.mock.calls.map(([id]) => id)).toEqual([first, second])
    expect(await h.outcome(first)).toEqual({
      ok: false,
      message: 'The page did not answer within 1 second while the Browser ran a script in the page; it may be busy or frozen. Call browser_read to try again, or browser_open to load a page.',
    })
    busy.resolve(undefined)
    expect(page(await h.outcome(second)).page.text).toContain('# Results')
  })

  it('stops a command whose tool call ended before its next action on the page, and serves the next command', async () => {
    const h = start()
    page(await h.outcome(h.send({ kind: 'open', url: 'https://example.test/' })))
    const [tab] = h.sidebar.tabsIn(SESSION)
    const fake = h.pages.get(tab!.id)!
    const typing = Promise.withResolvers<undefined>()
    fake.stall.insertText = typing.promise
    const id = h.send({ kind: 'type', element: 1, text: 'godot shaders', submit: true })
    for (let step = 0; step < 50 && !fake.calls.includes('insertText'); step++) await vi.advanceTimersByTimeAsync(10)
    expect(fake.calls).toContain('insertText')
    h.end(id)
    typing.resolve(undefined)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.inputs.filter(input => input.type === 'keyDown')).toEqual([])
    expect(h.outcomes.has(id)).toBe(false)
    expect(page(await h.outcome(h.send({ kind: 'read' }))).page.text).toContain('# Results')
  })

  it('drops a command whose tool call ended while it waited behind the Session\'s earlier command', async () => {
    const h = start()
    const user = h.addTab(SESSION, 'user-tab' as TabId)
    const fake = h.pages.get(user.id)!
    const busy = Promise.withResolvers<undefined>()
    fake.stall.evaluate = busy.promise
    const first = h.send({ kind: 'read' })
    const second = h.send({ kind: 'click', element: 2 })
    await vi.advanceTimersByTimeAsync(0)
    h.end(second)
    busy.resolve(undefined)
    page(await h.outcome(first))
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.outcomes.has(second)).toBe(false)
    expect(fake.inputs).toEqual([])
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
