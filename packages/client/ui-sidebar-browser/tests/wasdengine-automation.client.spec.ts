// @vitest-environment jsdom
/**
 * Agent control of Desktop Browser tabs (WASD Engine): the automation face over a `<webview>` guest, and the
 * `sidebarBrowserAutomation` service, which the Desktop carrier provides and which finds the face of a mounted tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { WebviewElement } from '../src/client/electron/ElectronWebviewPresentation.ts'
import { apply, inject } from '../src/client/index.ts'
import {
  BrowserPageUnavailableError, webviewAutomation, type SidebarBrowserAutomation, type WebviewImage,
} from '../src/client/wasdengine/automation.ts'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const contexts: Context[] = []

/** The owning Session of a tab, as the service takes it. */
type SessionId = Parameters<SidebarBrowserAutomation['tab']>[0]
const SESSION = 'session' as SessionId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

function image(width: number, height: number, empty = false): WebviewImage & { resized: number[] } {
  const resized: number[] = []
  return {
    resized,
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: (options) => {
      resized.push(options.width)
      const scaled = image(options.width, Math.round(height * options.width / width))
      return { ...scaled, toDataURL: () => `data:image/png;base64,scaled-${String(options.width)}` }
    },
    toDataURL: () => 'data:image/png;base64,original',
  }
}

function guest(capture: WebviewImage) {
  const sendInputEvent = vi.fn(async () => {})
  const insertText = vi.fn(async () => {})
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => 'https://example.test/', getTitle: () => 'Example',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(), goBack: vi.fn(), goForward: vi.fn(),
    reload: vi.fn(), isLoading: () => false,
    executeJavaScript: vi.fn(async (code: string) => `ran ${code}`),
    capturePage: vi.fn(async () => capture),
    sendInputEvent,
    insertText,
  })
  return { element, sendInputEvent, insertText }
}

describe('webviewAutomation', () => {
  it('fails every operation until the guest is ready, and then forwards them to it', async () => {
    const guestOf: { ready?: WebviewElement } = {}
    const automation = webviewAutomation(() => guestOf.ready)
    expect(automation.ready()).toBe(false)
    await expect(automation.evaluate('1')).rejects.toBeInstanceOf(BrowserPageUnavailableError)
    await expect(automation.capture(1280)).rejects.toThrow('The Browser tab has no page yet.')
    const { element, sendInputEvent, insertText } = guest(image(800, 600))
    guestOf.ready = element
    expect(automation.ready()).toBe(true)
    expect(await automation.evaluate('document.title')).toBe('ran document.title')
    await automation.sendInput({ type: 'mouseDown', x: 4, y: 5, button: 'left', clickCount: 1 })
    await automation.insertText('godot shaders')
    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 4, y: 5, button: 'left', clickCount: 1 })
    expect(insertText).toHaveBeenCalledWith('godot shaders')
  })

  it('scales a capture wider than the limit and keeps a narrower one', async () => {
    const wide = image(2560, 1600)
    const automation = webviewAutomation(() => guest(wide).element)
    expect(await automation.capture(1280)).toEqual({ dataUrl: 'data:image/png;base64,scaled-1280', width: 1280, height: 800 })
    expect(wide.resized).toEqual([1280])
    const narrow = image(800, 600)
    expect(await webviewAutomation(() => guest(narrow).element).capture(1280)).toEqual({ dataUrl: 'data:image/png;base64,original', width: 800, height: 600 })
    expect(narrow.resized).toEqual([])
    await expect(webviewAutomation(() => guest(image(0, 0, true)).element).capture(1280)).rejects.toThrow('The Browser tab showed nothing to capture.')
  })

  it('refuses operations a guest does not offer', async () => {
    const element: WebviewElement = Object.assign(document.createElement('div'), {
      loadURL: vi.fn(async () => {}), getURL: () => '', getTitle: () => '', canGoBack: () => false, canGoForward: () => false,
      clearHistory: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => false,
    })
    const automation = webviewAutomation(() => element)
    await expect(automation.evaluate('1')).rejects.toThrow('The Browser tab\'s page cannot run scripts.')
    await expect(automation.capture(100)).rejects.toThrow('The Browser tab\'s page cannot be captured.')
    await expect(automation.sendInput({ type: 'keyDown', keyCode: 'Enter' })).rejects.toThrow('The Browser tab\'s page cannot take input.')
    await expect(automation.insertText('a')).rejects.toThrow('The Browser tab\'s page cannot take typed text.')
  })
})

describe('Electron page automation', () => {
  it('becomes ready when the guest is ready and stops when the guest goes away', async () => {
    const fixture = electronFixture()
    try {
      fixture.mount()
      fixture.frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
      const attached = await fixture.guest()
      Object.assign(attached.element, { executeJavaScript: vi.fn(async () => 'Example page') })
      const automation = fixture.frame.automation
      expect(automation?.ready()).toBe(false)
      attached.emit('dom-ready')
      expect(automation?.ready()).toBe(true)
      expect(await automation?.evaluate('document.title')).toBe('Example page')
      attached.emit('destroyed')
      expect(automation?.ready()).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })
})

async function boot(protocolVersion: number) {
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}),
    onOpenRequested: vi.fn(() => () => {}),
  }
  vi.stubGlobal('dshDesktop', { protocolVersion, browser: bridge })
  const ctx = new Context()
  contexts.push(ctx)
  const injected: unknown[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: { inject?: unknown }) => {
      injected.push(options.inject)
      return () => {}
    }),
  }
  ctx.provide('sidebarRight', { openTabs: createSnapshotStore([]), commandTarget: vi.fn(), openTabFromTarget: vi.fn() } as never)
  ctx.provide('shortcuts', { register: () => () => {} } as never)
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx) as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const body = injected.find(value => typeof value === 'function') as (sessionId: SessionId, actions: unknown) => BrowserInjected
  return { ctx, fiber, body }
}

describe('sidebarBrowserAutomation', () => {
  it('finds the face of a mounted Desktop tab, checks addresses as the address bar does, and leaves with the plugin', async () => {
    const { ctx, fiber, body } = await boot(1)
    const service = ctx.get('sidebarBrowserAutomation')
    expect(service).toBeDefined()
    const store = createBrowserStore().create('wasdengine-automation')
    const controllers = body(SESSION, store.actions)
    const tabId = 'agent-tab' as TabId
    const host = document.createElement('div')
    host.id = 'wasdengine-automation-host'
    document.body.append(host)
    const lifetime = new AbortController()
    try {
      expect(service?.tab(SESSION, tabId)).toBeUndefined()
      controllers.mount({ tabId, signal: lifetime.signal, viewportId: host.id, applicationOrigin: window.location.origin,
        initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      const face = service?.tab(SESSION, tabId)
      expect(face?.page.ready()).toBe(false)
      expect(service?.tab('other-session' as SessionId, tabId)).toBeUndefined()
      expect(service?.tab(SESSION, 'other-tab' as TabId)).toBeUndefined()
      expect(face?.load('javascript:alert(1)')).toBe('protocol')
      expect(face?.load('')).toBe('empty')
      expect(face?.load('example.test/games')).toBeUndefined()
      expect(face?.state()).toMatchObject({ target: { url: 'https://example.test/games' }, loading: true })
    } finally {
      lifetime.abort()
      host.remove()
      await fiber.dispose()
    }
    await vi.waitFor(() => { expect(ctx.get('sidebarBrowserAutomation')).toBeUndefined() })
  })

  it('is not provided where Browser tabs are iframes', async () => {
    const { ctx } = await boot(0)
    expect(ctx.get('sidebarBrowserAutomation')).toBeUndefined()
  })
})
