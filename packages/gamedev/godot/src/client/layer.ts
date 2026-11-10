/**
 * Display of a run's layer through the macOS Desktop shell (`dshDesktop.gameLayer`): the rectangle that the layer
 * fills in the game view, the transparent holes that the application root leaves for the layers behind the page, and
 * the tracking of the game view's box while the layout changes.
 */
import type { DesktopGameLayerBridge, GodotRunLayer } from '../types.ts'
import type { PixelSize } from './input.ts'

/** A box in CSS pixels of the layout viewport. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Animation frames without a change after which box tracking stops following every frame. */
export const SETTLED_FRAMES = 10

/** Interval of the check that catches a box that moves without a resize, a window resize, or a drag. */
export const BOX_CHECK_MS = 500

/**
 * The mask layer that covers the application root and subtracts the hole layers below it. A mask, unlike a clip path,
 * leaves hit testing alone, so the game view under a hole still receives the pointer.
 */
const ROOT_MASK_LAYER = 'linear-gradient(#000 0 0) 0 0 / 100% 100% no-repeat subtract'

/**
 * The rectangle with the layer's aspect ratio centered in a box, its edges on device pixels.
 * @param box - the box to fill.
 * @param aspect - width over height of the layer.
 * @param pixelRatio - device pixels per CSS pixel.
 * @returns the rectangle, or undefined when the box is empty.
 */
export function fitLayer(box: Box, aspect: number, pixelRatio: number): Box | undefined {
  if (!(box.width > 0 && box.height > 0 && aspect > 0)) return undefined
  const width = Math.min(box.width, box.height * aspect)
  const height = width / aspect
  const snap = (value: number): number => Math.round(value * pixelRatio) / pixelRatio
  const left = snap(box.x + (box.width - width) / 2)
  const top = snap(box.y + (box.height - height) / 2)
  const right = snap(box.x + (box.width + width) / 2)
  const bottom = snap(box.y + (box.height + height) / 2)
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The transparent holes of the application root: while one is set, the root's mask leaves out each hole's box, so the
 * layer behind the page shows there, while the elements under a hole still receive the pointer. Overlays portaled to
 * `document.body` beside the root stay above the layers. The root keeps the mask it had before the first hole once
 * the last one is removed.
 */
export class LayerHoles {
  private readonly holes = new Map<string, Box>()
  private saved: string | undefined

  /** @param root - the application root, `#root`, which a page without one lacks. */
  constructor(private readonly root: () => HTMLElement | null) {}

  /**
   * Set or move one hole.
   * @param id - the hole's name.
   * @param box - the hole in CSS pixels of the layout viewport.
   */
  set(id: string, box: Box): void {
    this.holes.set(id, box)
    this.apply()
  }

  /**
   * Remove one hole; an unknown name is ignored.
   * @param id - the hole's name.
   */
  delete(id: string): void {
    if (this.holes.delete(id)) this.apply()
  }

  /** Remove every hole. */
  dispose(): void {
    this.holes.clear()
    this.apply()
  }

  private apply(): void {
    const root = this.root()
    if (root === null) return
    if (this.holes.size === 0) {
      if (this.saved !== undefined) root.style.mask = this.saved
      this.saved = undefined
      return
    }
    this.saved ??= root.style.mask
    const origin = root.getBoundingClientRect()
    const holes = [...this.holes.values()].map(box =>
      `linear-gradient(#000 0 0) ${String(round(box.x - origin.left))}px ${String(round(box.y - origin.top))}px / ${String(round(box.width))}px ${String(round(box.height))}px no-repeat`)
    root.style.mask = [ROOT_MASK_LAYER, ...holes].join(', ')
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Options of {@link watchBox}. */
export interface BoxWatchOptions {
  /**
   * Run a callback before the next repaint.
   * @param callback - the callback.
   * @returns a function that cancels it.
   */
  readonly schedule: (callback: () => void) => () => void
}

/**
 * Report an element's box in the layout viewport now and after each change. A resize of the element or the window
 * and a pointer drag anywhere start following the box every frame until it stays still for {@link SETTLED_FRAMES}
 * frames; a check every {@link BOX_CHECK_MS} milliseconds catches other moves. An idle box costs no frames.
 * @param element - the element to watch.
 * @param onBox - receives each new box.
 * @param options - the frame scheduler.
 * @returns the function that stops watching.
 */
export function watchBox(element: HTMLElement, onBox: (box: Box) => void, options: BoxWatchOptions): () => void {
  let last: Box | undefined
  let cancelFrame: (() => void) | undefined
  let still = 0
  const read = (): boolean => {
    const rect = element.getBoundingClientRect()
    const same = last !== undefined && rect.x === last.x && rect.y === last.y && rect.width === last.width && rect.height === last.height
    if (same) return false
    last = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    onBox(last)
    return true
  }
  const follow = (): void => {
    cancelFrame = undefined
    still = read() ? 0 : still + 1
    if (still < SETTLED_FRAMES) cancelFrame = options.schedule(follow)
  }
  const wake = (): void => {
    still = 0
    cancelFrame ??= options.schedule(follow)
  }
  const drag = (event: PointerEvent): void => {
    if (event.buttons !== 0) wake()
  }
  const resize = new ResizeObserver(wake)
  resize.observe(element)
  window.addEventListener('resize', wake)
  window.addEventListener('pointermove', drag, true)
  const check = setInterval(() => { if (read()) wake() }, BOX_CHECK_MS)
  read()
  return () => {
    resize.disconnect()
    window.removeEventListener('resize', wake)
    window.removeEventListener('pointermove', drag, true)
    clearInterval(check)
    cancelFrame?.()
    cancelFrame = undefined
  }
}

/** One layer to show in a game view; see {@link presentLayer}. */
export interface LayerPresentation {
  /** The page's name for the layer, unique within the page. */
  readonly id: string
  /** The game view whose box the layer fits into. */
  readonly view: HTMLElement
  /** The run's layer. */
  readonly layer: GodotRunLayer
  /** The game window's size in pixels, which gives the layer's size and aspect ratio. */
  readonly window: PixelSize
  /**
   * Receives the game view's box each time it changes, while the layer shows.
   * @param box - the view's box.
   */
  readonly onBox: (box: Box) => void
  /** The shell did not show the layer; the presentation has ended. */
  readonly onFailed: () => void
}

/** Services of {@link presentLayer}. */
export interface LayerServices {
  /** The Desktop shell's layer display. */
  readonly bridge: DesktopGameLayerBridge
  /** The application root's holes. */
  readonly holes: LayerHoles
  /** The frame scheduler of {@link watchBox}. */
  readonly schedule: BoxWatchOptions['schedule']
  /** @returns device pixels per CSS pixel. */
  readonly pixelRatio: () => number
}

/**
 * Show a run's layer fitted into a game view, behind a hole in the application root, until the returned function
 * runs. A hole opens only after the shell first shows the layer, so the page never shows an empty hole; later moves
 * update the hole and the layer together. When the shell answers false or fails, the presentation removes its hole
 * and the layer, stops, and calls `onFailed`.
 * @param services - the shell bridge, the holes, the frame scheduler, and the pixel ratio.
 * @param presentation - the layer, its view, and the callbacks.
 * @returns the function that ends the presentation.
 */
export function presentLayer(services: LayerServices, presentation: LayerPresentation): () => void {
  const { bridge, holes } = services
  const { id, layer, window: size } = presentation
  const placement = { context: layer.context, layerWidth: size.width / layer.scale, layerHeight: size.height / layer.scale }
  let ended = false
  let shown = false
  let current: Box | undefined
  const end = (): void => {
    if (ended) return
    ended = true
    stopWatching()
    holes.delete(id)
    bridge.hide(id)
  }
  const fail = (): void => {
    if (ended) return
    end()
    presentation.onFailed()
  }
  const place = (box: Box): void => {
    presentation.onBox(box)
    const fitted = fitLayer(box, size.width / size.height, services.pixelRatio())
    current = fitted
    if (fitted === undefined) {
      holes.delete(id)
      return
    }
    if (shown) holes.set(id, fitted)
    bridge.show(id, { ...placement, ...fitted }).then((ok) => {
      if (!ok) {
        fail()
        return
      }
      if (shown || ended) return
      shown = true
      if (current !== undefined) holes.set(id, current)
    }, fail)
  }
  const stopWatching = watchBox(presentation.view, place, { schedule: services.schedule })
  return end
}
