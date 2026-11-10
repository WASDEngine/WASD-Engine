/**
 * Main-process side of `dshDesktop.gameLayer` on macOS: shows the layers of windowless games behind the primary
 * window's page through the Node-API module that `scripts/wasdengine-game-layer.ts` builds next to the main bundle.
 * The page leaves each layer's rectangle transparent; the module places the layer's view below the web contents.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopGameLayerPlacement } from '@deepseek-ai/dsh-godot/types'
import { GAME_LAYER_IPC, GAME_LAYER_MODULE } from './wasdengine-game-layer-names.ts'

declare const HANDLE: unique symbol

/** A view that the Node-API module created; only the module reads it. */
export interface GameLayerHandle {
  readonly [HANDLE]: 'GameLayerHandle'
}

/** The Node-API module's functions; `wasdengine/game-layer/game_layer.mm` documents them. */
export interface GameLayerModule {
  attach(windowHandle: Buffer): GameLayerHandle
  place(
    handle: GameLayerHandle, context: number, x: number, y: number, width: number, height: number, layerWidth: number, layerHeight: number,
  ): void
  detach(handle: GameLayerHandle): void
}

/** Longest layer id the page may use. */
const MAX_ID_LENGTH = 128

/** Largest coordinate or size accepted, in CSS pixels or points. */
const MAX_EXTENT = 100_000

interface ShownLayer {
  readonly window: BrowserWindow
  readonly handle: GameLayerHandle
}

/** Reads the page's layer id; the IPC boundary validates it. */
function layerId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`game layer: the layer id must be 1 to ${String(MAX_ID_LENGTH)} characters`)
  }
  return value
}

/** Reads the page's placement; the IPC boundary validates it. */
function placementOf(value: unknown): DesktopGameLayerPlacement {
  if (typeof value !== 'object' || value === null) throw new Error('game layer: the placement must be an object')
  const { context, x, y, width, height, layerWidth, layerHeight } = value as Partial<Record<keyof DesktopGameLayerPlacement, unknown>>
  if (typeof context !== 'number' || !Number.isInteger(context) || context < 1 || context > 0xffff_ffff) {
    throw new Error('game layer: the context must be an integer from 1 to 2^32 - 1')
  }
  const coordinate = (name: string, number: unknown): number => {
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > MAX_EXTENT) {
      throw new Error(`game layer: ${name} must be a finite number of at most ${String(MAX_EXTENT)}`)
    }
    return number
  }
  const extent = (name: string, number: unknown): number => {
    const checked = coordinate(name, number)
    if (checked <= 0) throw new Error(`game layer: ${name} must be positive`)
    return checked
  }
  return {
    context,
    x: coordinate('x', x),
    y: coordinate('y', y),
    width: extent('width', width),
    height: extent('height', height),
    layerWidth: extent('layerWidth', layerWidth),
    layerHeight: extent('layerHeight', layerHeight),
  }
}

/**
 * The layers that the primary window's page shows. A page that navigates, a renderer that exits, and a window that
 * closes take their layers with them.
 */
export class DesktopGameLayers {
  private module: GameLayerModule | undefined
  private unavailable = false
  private readonly shown = new Map<string, ShownLayer>()
  private readonly watched = new WeakSet<BrowserWindow>()

  /**
   * @param load - loads the Node-API module; a failure leaves the bridge unable to show layers.
   * @param warn - reports a module that does not load.
   */
  constructor(private readonly load: () => GameLayerModule, private readonly warn: (message: string, error: unknown) => void) {}

  /**
   * Show or move one layer of a window's page.
   * @param window - the window whose page sent the request.
   * @param id - the page's name for the layer.
   * @param placement - the layer and its rectangle in CSS pixels.
   * @returns whether the layer shows; false when the module does not load.
   * @throws {Error} When the id or the placement is invalid.
   */
  show(window: BrowserWindow, id: unknown, placement: unknown): boolean {
    const key = layerId(id)
    const where = placementOf(placement)
    const module = this.moduleOrUndefined()
    if (module === undefined) return false
    let layer = this.shown.get(key)
    if (layer !== undefined && layer.window !== window) {
      this.remove(key)
      layer = undefined
    }
    if (layer === undefined) {
      this.watch(window)
      layer = { window, handle: module.attach(window.getNativeWindowHandle()) }
      this.shown.set(key, layer)
    }
    // A CSS pixel covers the page's zoom factor in points.
    const zoom = window.webContents.getZoomFactor()
    const { context, x, y, width, height, layerWidth, layerHeight } = where
    module.place(layer.handle, context, x * zoom, y * zoom, width * zoom, height * zoom, layerWidth, layerHeight)
    return true
  }

  /**
   * Stop showing one layer of a window's page; an unknown id is ignored.
   * @param window - the window whose page sent the request.
   * @param id - the page's name for the layer.
   * @throws {Error} When the id is invalid.
   */
  hide(window: BrowserWindow, id: unknown): void {
    const key = layerId(id)
    if (this.shown.get(key)?.window === window) this.remove(key)
  }

  /**
   * Stop showing every layer of a window.
   * @param window - the window whose page went away.
   */
  clear(window: BrowserWindow): void {
    for (const [key, layer] of [...this.shown]) if (layer.window === window) this.remove(key)
  }

  private remove(key: string): void {
    const layer = this.shown.get(key)
    if (layer === undefined) return
    this.shown.delete(key)
    ;(this.module as GameLayerModule).detach(layer.handle)
  }

  private watch(window: BrowserWindow): void {
    if (this.watched.has(window)) return
    this.watched.add(window)
    const clear = (): void => { this.clear(window) }
    window.once('closed', clear)
    window.webContents.on('render-process-gone', clear)
    window.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) clear()
    })
  }

  private moduleOrUndefined(): GameLayerModule | undefined {
    if (this.module !== undefined || this.unavailable) return this.module
    try {
      this.module = this.load()
    } catch (error) {
      this.unavailable = true
      this.warn('game layer: the native module did not load, so the Game tab streams frames instead', error)
    }
    return this.module
  }
}

/**
 * Load the Node-API module from beside the main bundle; inside the packaged `app.asar`, Electron loads the unpacked copy.
 * @returns the module.
 */
export function loadGameLayerModule(): GameLayerModule {
  return createRequire(import.meta.url)(fileURLToPath(new URL(`./${GAME_LAYER_MODULE}`, import.meta.url))) as GameLayerModule
}

/**
 * Serve `dshDesktop.gameLayer` for the primary window on macOS; other platforms register nothing.
 * @param ipc - the main process's IPC.
 * @param assertProductSender - authenticates a request from the primary window's application page.
 */
export function registerWasdengineGameLayers(ipc: Pick<IpcMain, 'handle'>, assertProductSender: (event: IpcMainInvokeEvent) => BrowserWindow): void {
  if (process.platform !== 'darwin') return
  const layers = new DesktopGameLayers(loadGameLayerModule, (message, error) => { console.warn(message, error) })
  ipc.handle(GAME_LAYER_IPC.show, (event, id: unknown, placement: unknown) => layers.show(assertProductSender(event), id, placement))
  ipc.handle(GAME_LAYER_IPC.hide, (event, id: unknown) => { layers.hide(assertProductSender(event), id) })
}
