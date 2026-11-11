// @vitest-environment jsdom
/**
 * The Assets tab in the production right Sidebar, Slot renderer, and resource service: the guide offers it, the picker
 * sorts the project's assets into folders, searches them, and picks one from the keyboard, an image shows and reloads
 * when its file changes, a Blender file shows its export, and the scan's empty and failed states.
 */
import type { WorkspaceDirectoryListing, WorkspaceFileBytes, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { contextMenuHook, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const SESSION = 'assets-session' as SessionId
const SHORTCUT_CATALOG: readonly never[] = []

type Listing = RemoteResult<WorkspaceDirectoryListing>
type Bytes = RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>

/** The project: folders by workspace path. */
const PROJECT: Readonly<Record<string, readonly string[]>> = {
  '': ['assets/', '.godot/', 'icon.svg', 'project.godot'],
  assets: ['models/', 'textures/'],
  'assets/models': ['archer.glb', 'src/'],
  'assets/models/src': ['archer.blend'],
  'assets/textures': ['hero.png', 'grass.png'],
}

function listing(path: string): Listing {
  const key = path === '.' ? '' : path
  const names = PROJECT[key]
  if (names === undefined) return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
  const entries = names.map(name => name.endsWith('/') ? { name: name.slice(0, -1), type: 'directory' as const } : { name, type: 'file' as const, size: 3 })
  return { ok: true, value: { path: key, entries, truncated: false } }
}

let runtime: SlotTestRuntime | undefined
const restore: (() => void)[] = []

function stubPrototype(target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  restore.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, descriptor)
  })
}

beforeEach(() => {
  stubPrototype(Element.prototype, 'getAnimations', () => [])
  stubPrototype(Element.prototype, 'scrollIntoView', () => {})
  // jsdom draws no canvas, so the 3D view reports that WebGL is unavailable.
  stubPrototype(HTMLCanvasElement.prototype, 'getContext', () => null)
  let blobs = 0
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:assets/${String(++blobs)}`),
    revokeObjectURL: vi.fn(),
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})

afterEach(async () => {
  try {
    await runtime?.dispose()
    runtime = undefined
  } finally {
    for (const undo of restore.splice(0).reverse()) undo()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

async function boot(list: (path: string) => Promise<Listing> = async path => listing(path)) {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  rt.ctx.provide('contextMenus', { register: () => () => {}, open: vi.fn(), active: createSnapshotStore(null) } as never)
  rt.slots.provideRoot({ props: { useContextMenu: contextMenuHook(() => {}) } })
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: rt.panelInfo } as never)
  rt.ctx.provide('shortcuts', { register: () => () => {}, catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await rt.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const listCalls = vi.fn((_sessionId: string, path: string, _signal: AbortSignal) => list(path))
  const readBytes = vi.fn(async (_sessionId: string, path: string): Promise<Bytes> => ({
    ok: true, value: { absolutePath: `/project/${path}`, version: 'v1', bytes: 3, offset: 0, data: new Uint8Array([1, 2, 3]), eof: true },
  }))
  rt.remote.provideNamespaces({ workspaceFiles: { list: listCalls, readBytes } })
  // The `file` resource: each address reports version v1, then whatever the test pushes.
  const versions = new Map<string, (stat: WorkspaceFileStat) => void>()
  rt.ctx.effect(() => rt.ctx.resources.register({
    protocol: 'file',
    open: async function* (address, { signal }) {
      const path = address.slice(address.indexOf(SESSION) + SESSION.length + 1)
      const queue: WorkspaceFileStat[] = [{ absolutePath: `/project/${path}`, version: 'v1' }]
      let wake: (() => void) | undefined
      versions.set(path, (stat) => {
        queue.push(stat)
        wake?.()
      })
      while (!signal.aborted) {
        const next = queue.shift()
        if (next !== undefined) {
          yield { ok: true as const, value: next }
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    },
  }))
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...inject], apply })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  const openAssets = (): void => { act(() => { rt.ctx.sidebarRight.openTab('assets') }) }
  return { rt, view, listCalls, readBytes, versions, openAssets }
}

describe('Assets tab', () => {
  it('is offered on the guide with its description, and opens from it', async () => {
    const h = await boot()
    act(() => { h.rt.ctx.sidebarRight.openTab('guide') })
    const entry = h.view.container.querySelector<HTMLElement>('[data-sidebar-right-guide-entry="assets"]')
    expect(entry?.textContent).toBe('AssetsView the 2D and 3D art in this game project')
    act(() => { entry?.click() })
    await waitFor(() => { expect(h.view.container.querySelector('[data-game-assets]')).not.toBeNull() })
    expect(h.view.container.querySelector('[data-sidebar-right-guide]')).toBeNull()
  })

  it('sorts the project\'s assets into its folders, searches them, and picks one from the keyboard', async () => {
    const h = await boot()
    h.openAssets()
    expect(await screen.findByText('Choose an asset to view')).toBeTruthy()
    expect(screen.getByText('5 assets in this project')).toBeTruthy()
    expect(h.listCalls.mock.calls.map(call => call[1]).sort()).toEqual(['.', 'assets', 'assets/models', 'assets/models/src', 'assets/textures'])
    fireEvent.click(screen.getByRole('button', { name: 'Browse assets' }))
    const dialog = await screen.findByRole('dialog', { name: 'Assets' })
    const tree = within(dialog).getByRole('tree')
    const rows = (): string[] => within(tree).getAllByRole('treeitem').map(row => `${row.getAttribute('aria-level') ?? ''}:${row.textContent ?? ''}`)
    // The project folder's folders start open; each level lists its folders before its assets.
    expect(rows()).toEqual(['1:assets4', '2:models2', '2:textures2', '1:icon.svg'])
    const search = within(dialog).getByRole('combobox', { name: 'Search assets' })
    expect(document.activeElement).toBe(search)
    // Enter on the active folder closes it and opens it again.
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(rows()).toEqual(['1:assets4', '1:icon.svg'])
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(rows()).toEqual(['1:assets4', '2:models2', '2:textures2', '1:icon.svg'])
    fireEvent.click(within(tree).getByRole('treeitem', { name: /textures/u }))
    expect(rows()).toContain('3:grass.png')
    // The 2D filter leaves the images; `assets`, now holding only `textures`, shares its row.
    fireEvent.click(within(dialog).getByRole('tab', { name: '2D' }))
    expect(rows()).toEqual(['1:assets/textures2', '2:grass.png', '2:hero.png', '1:icon.svg'])
    fireEvent.click(within(dialog).getByRole('tab', { name: 'All' }))
    // Typing searches names and paths; the arrows and Enter pick a result.
    fireEvent.change(search, { target: { value: 'her' } })
    const results = within(dialog).getByRole('listbox')
    expect(within(results).getAllByRole('option').map(option => option.textContent)).toEqual(['hero.pngassets/textures', 'archer.glbassets/models', 'archer.blendassets/models/src'])
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(within(results).getAllByRole('option')[0]?.id)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    const trigger = screen.getByRole('button', { name: /hero\.png/u })
    expect(trigger.textContent).toBe('hero.pngassets/textures')
    expect(document.activeElement).toBe(trigger)
    // The image shows with its format, size, and zoom.
    const image = await waitFor(() => {
      const element = h.view.container.querySelector('img')
      expect(element).not.toBeNull()
      return element as HTMLImageElement
    })
    expect(image.getAttribute('src')).toMatch(/^blob:assets\//u)
    expect(h.readBytes).toHaveBeenCalledWith(SESSION, 'assets/textures/hero.png', {}, expect.any(AbortSignal))
    Object.defineProperty(image, 'naturalWidth', { value: 64 })
    Object.defineProperty(image, 'naturalHeight', { value: 32 })
    fireEvent.load(image)
    expect(screen.getByRole('img', { name: 'Preview of hero.png' })).toBeTruthy()
    expect(screen.getByText('64 × 32')).toBeTruthy()
    expect(screen.getByText('PNG')).toBeTruthy()
  })

  it('reads the viewed file again when its version changes', async () => {
    const h = await boot()
    h.openAssets()
    await screen.findByText('Choose an asset to view')
    act(() => { h.rt.ctx.sidebarRight.openTab('assets') })
    fireEvent.click(screen.getByRole('button', { name: 'Browse assets' }))
    const search = await screen.findByRole('combobox', { name: 'Search assets' })
    fireEvent.change(search, { target: { value: 'grass' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => { expect(h.readBytes).toHaveBeenCalledOnce() })
    act(() => { h.versions.get('assets/textures/grass.png')?.({ absolutePath: '/project/assets/textures/grass.png', version: 'v2' }) })
    await waitFor(() => { expect(h.readBytes).toHaveBeenCalledTimes(2) })
  })

  it('shows a Blender file through the model exported from it, and opens that model', async () => {
    const h = await boot()
    h.openAssets()
    await screen.findByText('Choose an asset to view')
    fireEvent.click(screen.getByRole('button', { name: 'Browse assets' }))
    const search = await screen.findByRole('combobox', { name: 'Search assets' })
    fireEvent.change(search, { target: { value: 'archer.blend' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(await screen.findByText('Showing archer.glb, exported from this Blender file.')).toBeTruthy()
    await waitFor(() => { expect(h.readBytes).toHaveBeenCalledWith(SESSION, 'assets/models/archer.glb', {}, expect.any(AbortSignal)) })
    expect(await screen.findByText('Showing 3D models needs WebGL, which is off or unavailable here.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open the model' }))
    expect(screen.getByRole('button', { name: /archer\.glb/u }).textContent).toBe('archer.glbassets/models')
    expect(screen.queryByText('Showing archer.glb, exported from this Blender file.')).toBeNull()
  })

  it('says when the project has no art, and offers a retry when its folders cannot be listed', async () => {
    let fail = true
    const h = await boot(async (path) => {
      if (fail) return { ok: false, error: new RemoteError('gateway/internal', 'down', {}) }
      return path === '.' ? { ok: true, value: { path: '', entries: [{ name: 'main.gd', type: 'file' }], truncated: false } } : listing(path)
    })
    h.openAssets()
    expect(await screen.findByText('Could not list the project’s folders.')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No art yet')).toBeTruthy()
    expect(screen.getByText('Images and 3D models in this game project appear here.')).toBeTruthy()
  })
})
