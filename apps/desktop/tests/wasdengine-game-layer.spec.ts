/**
 * The macOS Desktop shell's display of windowless games' layers: request validation, the views the Node-API module
 * creates and moves, their removal with the page, the IPC registration, the module build, and its packaging.
 */
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { applyWasdengineGameLayer, GAME_LAYER_FILE } from '../scripts/wasdengine-builder-config.mjs'
import { gameLayerCompileArgs } from '../scripts/wasdengine-game-layer.ts'
import { GAME_LAYER_IPC, GAME_LAYER_MODULE } from '../src/wasdengine-game-layer-names.ts'
import { DesktopGameLayers, registerWasdengineGameLayers, type GameLayerModule, type GameLayerWindow } from '../src/wasdengine-game-layer.ts'

const PLACEMENT = { context: 4096, x: 10, y: 20, width: 320, height: 180, layerWidth: 800, layerHeight: 450 }

/** A window whose page and lifecycle events the test drives. */
function fakeWindow(zoom = 1) {
  const contents = Object.assign(new EventEmitter(), { getZoomFactor: () => zoom })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    getNativeWindowHandle: () => Buffer.alloc(8),
  })
  return { window, emitter: window, contents }
}

/** A view handle of the fake module. */
interface FakeHandle {
  readonly id: number
}

/** A Node-API module that records its views. */
function fakeModule() {
  let created = 0
  const views = new Map<FakeHandle, { readonly id: number; placed: number[]; attached: boolean }>()
  const attach = vi.fn((): FakeHandle => {
    const handle = { id: ++created }
    views.set(handle, { id: created, placed: [], attached: true })
    return handle
  })
  const module: GameLayerModule<FakeHandle> = {
    attach,
    place: (handle, ...geometry) => { (views.get(handle) as { placed: number[] }).placed = geometry },
    detach: (handle) => { (views.get(handle) as { attached: boolean }).attached = false },
  }
  return { module, attach, views, attached: () => [...views.values()].filter(view => view.attached) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('DesktopGameLayers', () => {
  it('creates one view per layer, places it in points at the page’s zoom, and moves it in place', () => {
    const m = fakeModule()
    const layers = new DesktopGameLayers(() => m.module, vi.fn())
    const { window } = fakeWindow(1.25)
    expect(layers.show(window, 'a', PLACEMENT)).toBe(true)
    expect(layers.show(window, 'a', { ...PLACEMENT, x: 30 })).toBe(true)
    expect(m.attach).toHaveBeenCalledOnce()
    expect(m.attached()[0]?.placed).toEqual([4096, 37.5, 25, 400, 225, 800, 450])
    expect(layers.show(window, 'b', PLACEMENT)).toBe(true)
    expect(m.attached()).toHaveLength(2)
    layers.hide(window, 'a')
    layers.hide(window, 'unknown')
    expect(m.attached().map(view => view.id)).toEqual([2])
  })

  it('refuses an invalid id or placement before the module sees it', () => {
    const m = fakeModule()
    const layers = new DesktopGameLayers(() => m.module, vi.fn())
    const { window } = fakeWindow()
    expect(() => layers.show(window, '', PLACEMENT)).toThrow('layer id')
    expect(() => layers.show(window, 'x'.repeat(129), PLACEMENT)).toThrow('layer id')
    expect(() => { layers.hide(window, 7) }).toThrow('layer id')
    expect(() => layers.show(window, 'a', null)).toThrow('must be an object')
    for (const context of [0, 2 ** 32, 1.5, '7']) {
      expect(() => layers.show(window, 'a', { ...PLACEMENT, context })).toThrow('the context must be an integer')
    }
    expect(() => layers.show(window, 'a', { ...PLACEMENT, x: Number.NaN })).toThrow('x must be a finite number')
    expect(() => layers.show(window, 'a', { ...PLACEMENT, y: 1e9 })).toThrow('y must be a finite number')
    expect(() => layers.show(window, 'a', { ...PLACEMENT, width: 0 })).toThrow('width must be positive')
    expect(() => layers.show(window, 'a', { ...PLACEMENT, layerHeight: -1 })).toThrow('layerHeight must be positive')
    expect(m.attach).not.toHaveBeenCalled()
  })

  it('removes a page’s layers when it navigates, its renderer exits, or its window closes', () => {
    const m = fakeModule()
    const layers = new DesktopGameLayers(() => m.module, vi.fn())
    const { window, emitter, contents } = fakeWindow()
    layers.show(window, 'a', PLACEMENT)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(m.attached()).toHaveLength(1)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(m.attached()).toHaveLength(0)
    layers.show(window, 'a', PLACEMENT)
    contents.emit('render-process-gone')
    expect(m.attached()).toHaveLength(0)
    layers.show(window, 'a', PLACEMENT)
    emitter.emit('closed')
    expect(m.attached()).toHaveLength(0)
    expect(contents.listenerCount('render-process-gone')).toBe(1)
  })

  it('keeps one window’s layer from another window and moves a reused id to the window that shows it', () => {
    const m = fakeModule()
    const layers = new DesktopGameLayers(() => m.module, vi.fn())
    const first = fakeWindow()
    const second = fakeWindow()
    layers.show(first.window, 'a', PLACEMENT)
    layers.hide(second.window, 'a')
    expect(m.attached()).toHaveLength(1)
    layers.show(second.window, 'a', PLACEMENT)
    expect(m.attached().map(view => view.id)).toEqual([2])
    layers.clear(first.window)
    expect(m.attached()).toHaveLength(1)
  })

  it('answers false and warns once when the module does not load', () => {
    const warn = vi.fn()
    const load = vi.fn((): GameLayerModule => { throw new Error('image not found') })
    const layers = new DesktopGameLayers(load, warn)
    const { window } = fakeWindow()
    expect(layers.show(window, 'a', PLACEMENT)).toBe(false)
    expect(layers.show(window, 'a', PLACEMENT)).toBe(false)
    layers.hide(window, 'a')
    expect(load).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('streams frames instead')
  })
})

describe('registerWasdengineGameLayers', () => {
  it('serves the bridge channels for the authenticated primary window on macOS only', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const ipc = { handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler) }) }
    const { window } = fakeWindow()
    const assertProductSender = vi.fn((): GameLayerWindow => window)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    registerWasdengineGameLayers(ipc, assertProductSender)
    expect(ipc.handle).not.toHaveBeenCalled()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    registerWasdengineGameLayers(ipc, assertProductSender)
    expect([...handlers.keys()]).toEqual([GAME_LAYER_IPC.show, GAME_LAYER_IPC.hide])
    const event = {} as IpcMainInvokeEvent
    // The module is not built beside the test, so the bridge reports that it cannot show layers.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await handlers.get(GAME_LAYER_IPC.show)?.(event, 'a', PLACEMENT)).toBe(false)
    expect(await handlers.get(GAME_LAYER_IPC.hide)?.(event, 'a')).toBeUndefined()
    expect(assertProductSender).toHaveBeenCalledTimes(2)
    assertProductSender.mockImplementation(() => { throw new Error('dsh desktop: rejected IPC from an unowned renderer') })
    expect(() => handlers.get(GAME_LAYER_IPC.show)?.(event, 'a', PLACEMENT)).toThrow('unowned renderer')
  })
})

describe('game layer module build and packaging', () => {
  it('compiles one file for both macOS architectures against the Node-API headers, with warnings as errors', () => {
    const args = gameLayerCompileArgs('/src/game_layer.mm', '/out/module.node', '/node/include/node')
    expect(args).toEqual(expect.arrayContaining(['-arch', 'arm64', 'x86_64', '-bundle', 'dynamic_lookup', '-Werror', '-fobjc-arc']))
    expect(args.slice(args.indexOf('-I'), args.indexOf('-I') + 2)).toEqual(['-I', '/node/include/node'])
    expect(args.slice(-3)).toEqual(['-o', '/out/module.node', '/src/game_layer.mm'])
  })

  it('builds the module after the main bundle and ships it unpacked beside it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts.bundle).toBe('tsdown --config-loader native && tsx scripts/wasdengine-game-layer.ts')
    expect(GAME_LAYER_FILE).toBe(`lib/${GAME_LAYER_MODULE}`)
    const tree = { from: '/dsh', to: 'dsh', filter: ['**/*'] }
    expect(applyWasdengineGameLayer({ files: ['lib/main.js', tree], asarUnpack: ['first'] }))
      .toEqual({ files: ['lib/main.js', GAME_LAYER_FILE, tree], asarUnpack: ['first', GAME_LAYER_FILE] })
    expect(applyWasdengineGameLayer({ files: ['lib/main.js'], asarUnpack: [] }).files).toEqual(['lib/main.js', GAME_LAYER_FILE])
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
    const release = createReleaseConfig()
    expect(release.asarUnpack).toContain(GAME_LAYER_FILE)
    const files: readonly unknown[] = release.files
    expect(files.indexOf(GAME_LAYER_FILE)).toBeLessThan(files.findIndex(entry => typeof entry !== 'string'))
  })
})
