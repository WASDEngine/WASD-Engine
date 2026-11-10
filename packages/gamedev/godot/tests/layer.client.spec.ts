// @vitest-environment jsdom
/**
 * Display of a run's layer through the Desktop shell: the fitted rectangle, the application root's holes, the
 * tracking of the game view's box, and the presentation that ties them to the shell's bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopGameLayerBridge } from '../src/types.ts'
import { BOX_CHECK_MS, fitLayer, LayerHoles, presentLayer, SETTLED_FRAMES, watchBox, type Box, type LayerPresentation } from '../src/client/layer.ts'

/** A frame scheduler whose callbacks run when the test advances it. */
function frames() {
  let queue: (() => void)[] = []
  const schedule = vi.fn((callback: () => void) => {
    queue.push(callback)
    return () => { queue = queue.filter(entry => entry !== callback) }
  })
  const run = (count = 1): void => {
    for (let i = 0; i < count; i++) {
      const due = queue
      queue = []
      for (const callback of due) callback()
    }
  }
  return { schedule, run, pending: () => queue.length }
}

let resizeCallbacks: (() => void)[]

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe(): void { resizeCallbacks.push(this.callback) }
    disconnect(): void { resizeCallbacks = resizeCallbacks.filter(entry => entry !== this.callback) }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** An element whose box the test sets. */
function boxed(initial: Box): { element: HTMLElement; move: (box: Box) => void } {
  const element = document.createElement('div')
  let box = initial
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => new DOMRect(box.x, box.y, box.width, box.height))
  return { element, move: (next) => { box = next } }
}

describe('fitLayer', () => {
  it('centers the layer’s aspect ratio in the box and puts its edges on device pixels', () => {
    expect(fitLayer({ x: 0, y: 0, width: 400, height: 400 }, 16 / 9, 1)).toEqual({ x: 0, y: 88, width: 400, height: 225 })
    expect(fitLayer({ x: 10, y: 20, width: 800, height: 225 }, 16 / 9, 1)).toEqual({ x: 210, y: 20, width: 400, height: 225 })
    expect(fitLayer({ x: 0.3, y: 0, width: 101, height: 101 }, 1, 2)).toEqual({ x: 0.5, y: 0, width: 101, height: 101 })
  })

  it('fits nothing into an empty box', () => {
    expect(fitLayer({ x: 0, y: 0, width: 0, height: 100 }, 1, 1)).toBeUndefined()
    expect(fitLayer({ x: 0, y: 0, width: 100, height: 0.1 }, 100, 1)).toBeUndefined()
  })
})

describe('LayerHoles', () => {
  it('masks each hole out of the application root relative to its box and restores the root’s mask after the last', () => {
    const root = document.createElement('div')
    root.style.mask = 'none'
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 0, 1000, 800))
    const holes = new LayerHoles(() => root)
    holes.set('a', { x: 105, y: 20, width: 300.5, height: 200 })
    const cover = 'linear-gradient(#000 0 0) 0 0 / 100% 100% no-repeat subtract'
    expect(root.style.mask).toBe(`${cover}, linear-gradient(#000 0 0) 100px 20px / 300.5px 200px no-repeat`)
    holes.set('b', { x: 5, y: 0, width: 10, height: 10 })
    expect(root.style.mask).toBe(`${cover}, linear-gradient(#000 0 0) 100px 20px / 300.5px 200px no-repeat, linear-gradient(#000 0 0) 0px 0px / 10px 10px no-repeat`)
    holes.delete('a')
    holes.delete('unknown')
    expect(root.style.mask).toBe(`${cover}, linear-gradient(#000 0 0) 0px 0px / 10px 10px no-repeat`)
    holes.dispose()
    expect(root.style.mask).toBe('none')
  })

  it('does nothing in a page without an application root', () => {
    const holes = new LayerHoles(() => null)
    holes.set('a', { x: 0, y: 0, width: 1, height: 1 })
    holes.dispose()
  })
})

describe('watchBox', () => {
  it('reports the box at once and follows it every frame after a resize until it stays still', () => {
    const view = boxed({ x: 0, y: 0, width: 100, height: 100 })
    const f = frames()
    const boxes: Box[] = []
    const stop = watchBox(view.element, (box) => { boxes.push(box) }, { schedule: f.schedule })
    expect(boxes).toEqual([{ x: 0, y: 0, width: 100, height: 100 }])
    expect(f.pending()).toBe(0)
    view.move({ x: 0, y: 0, width: 120, height: 100 })
    for (const callback of resizeCallbacks) callback()
    f.run()
    view.move({ x: 0, y: 0, width: 140, height: 100 })
    f.run()
    expect(boxes.map(box => box.width)).toEqual([100, 120, 140])
    f.run(SETTLED_FRAMES)
    expect(f.pending()).toBe(0)
    stop()
    expect(resizeCallbacks).toEqual([])
  })

  it('follows the box during a pointer drag and on a window resize, but not on a hover', () => {
    const view = boxed({ x: 0, y: 0, width: 100, height: 100 })
    const f = frames()
    const stop = watchBox(view.element, () => {}, { schedule: f.schedule })
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 0 }))
    expect(f.pending()).toBe(0)
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1 }))
    expect(f.pending()).toBe(1)
    f.run(SETTLED_FRAMES)
    expect(f.pending()).toBe(0)
    window.dispatchEvent(new Event('resize'))
    expect(f.pending()).toBe(1)
    stop()
    expect(f.pending()).toBe(0)
    window.dispatchEvent(new Event('resize'))
    expect(f.pending()).toBe(0)
  })

  it('catches a move without a resize at its periodic check and checks nothing after it stops', () => {
    vi.useFakeTimers()
    const view = boxed({ x: 0, y: 0, width: 100, height: 100 })
    const f = frames()
    const boxes: Box[] = []
    const stop = watchBox(view.element, (box) => { boxes.push(box) }, { schedule: f.schedule })
    vi.advanceTimersByTime(BOX_CHECK_MS)
    expect(f.pending()).toBe(0)
    view.move({ x: 40, y: 0, width: 100, height: 100 })
    vi.advanceTimersByTime(BOX_CHECK_MS)
    expect(boxes.at(-1)).toEqual({ x: 40, y: 0, width: 100, height: 100 })
    expect(f.pending()).toBe(1)
    stop()
    view.move({ x: 80, y: 0, width: 100, height: 100 })
    vi.advanceTimersByTime(BOX_CHECK_MS * 2)
    expect(boxes).toHaveLength(2)
  })
})

describe('presentLayer', () => {
  function setup(answer: (call: number) => Promise<boolean>) {
    const root = document.createElement('div')
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
    const holes = new LayerHoles(() => root)
    let calls = 0
    const bridge = { show: vi.fn<DesktopGameLayerBridge['show']>(() => answer(calls++)), hide: vi.fn<DesktopGameLayerBridge['hide']>() }
    const view = boxed({ x: 100, y: 50, width: 400, height: 400 })
    const f = frames()
    const onBox = vi.fn<LayerPresentation['onBox']>()
    const onFailed = vi.fn<() => void>()
    const end = presentLayer({ bridge, holes, schedule: f.schedule, pixelRatio: () => 2 }, {
      id: 'game', view: view.element, layer: { context: 77, scale: 2 }, window: { width: 1600, height: 900 }, onBox, onFailed,
    })
    return { root, bridge, view, f, onBox, onFailed, end }
  }

  it('opens the hole once the shell shows the layer, then moves both together, and closes both at the end', async () => {
    const s = setup(async () => true)
    expect(s.onBox).toHaveBeenCalledWith({ x: 100, y: 50, width: 400, height: 400 })
    expect(s.bridge.show).toHaveBeenCalledWith('game', { context: 77, layerWidth: 800, layerHeight: 450, x: 100, y: 137.5, width: 400, height: 225 })
    expect(s.root.style.mask).toBe('')
    await vi.waitFor(() => { expect(s.root.style.mask).toContain('100px 137.5px / 400px 225px') })
    s.view.move({ x: 0, y: 0, width: 800, height: 450 })
    for (const callback of resizeCallbacks) callback()
    s.f.run()
    expect(s.root.style.mask).toContain('0px 0px / 800px 450px')
    expect(s.bridge.show).toHaveBeenLastCalledWith('game', { context: 77, layerWidth: 800, layerHeight: 450, x: 0, y: 0, width: 800, height: 450 })
    s.view.move({ x: 0, y: 0, width: 0, height: 450 })
    for (const callback of resizeCallbacks) callback()
    s.f.run()
    expect(s.root.style.mask).toBe('')
    expect(s.bridge.show).toHaveBeenCalledTimes(2)
    s.end()
    s.end()
    expect(s.bridge.hide).toHaveBeenCalledOnce()
    expect(s.bridge.hide).toHaveBeenCalledWith('game')
    expect(s.onFailed).not.toHaveBeenCalled()
  })

  it('ends with onFailed when the shell refuses or fails to show the layer', async () => {
    const refused = setup(async () => false)
    await vi.waitFor(() => { expect(refused.onFailed).toHaveBeenCalledOnce() })
    expect(refused.bridge.hide).toHaveBeenCalledOnce()
    expect(refused.root.style.mask).toBe('')
    expect(resizeCallbacks).toEqual([])
    refused.end()
    expect(refused.bridge.hide).toHaveBeenCalledOnce()

    const failing = setup(async call => call === 0 ? true : Promise.reject(new Error('main process gone')))
    await vi.waitFor(() => { expect(failing.root.style.mask).not.toBe('') })
    failing.view.move({ x: 0, y: 0, width: 800, height: 450 })
    for (const callback of resizeCallbacks) callback()
    failing.f.run()
    await vi.waitFor(() => { expect(failing.onFailed).toHaveBeenCalledOnce() })
    expect(failing.root.style.mask).toBe('')
  })

  it('opens no hole for a layer the shell shows after the presentation ended', async () => {
    let resolve: (shown: boolean) => void = () => {}
    const s = setup(() => new Promise((settle) => { resolve = settle }))
    s.end()
    resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(s.root.style.mask).toBe('')
    expect(s.onFailed).not.toHaveBeenCalled()
  })
})
