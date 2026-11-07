// @vitest-environment jsdom
/** Key and mouse mapping, letterbox scaling, batched ordered delivery, and DOM capture of the game view. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GodotInputEvent } from '../src/types.ts'
import {
  bindGameInput, godotKey, godotMouseButton, InputQueue, MAX_INPUT_EVENTS, MOUSE_MODE_CAPTURED, toGamePoint, wheelButton,
  type GameInputTarget,
} from '../src/client/input.ts'

/** Key names of Godot's `core/os/keyboard.cpp` table that the panel may send; Godot matches them case-insensitively. */
const GODOT_KEY_NAMES = new Set([
  'Escape', 'Tab', 'Backspace', 'Enter', 'Kp Enter', 'Insert', 'Delete', 'Pause', 'Print', 'Home', 'End', 'Left', 'Up', 'Right',
  'Down', 'PageUp', 'PageDown', 'Shift', 'Ctrl', 'CapsLock', 'NumLock', 'ScrollLock', 'Kp Multiply', 'Kp Divide', 'Kp Subtract',
  'Kp Period', 'Kp Add', 'Menu', 'Help', 'Space', 'Apostrophe', 'Comma', 'Minus', 'Period', 'Slash', 'Semicolon', 'Equal',
  'BracketLeft', 'BackSlash', 'BracketRight', 'QuoteLeft', 'Yen',
  ...Array.from({ length: 35 }, (_, index) => `F${String(index + 1)}`),
  ...Array.from({ length: 10 }, (_, index) => `Kp ${String(index)}`),
  ...Array.from({ length: 10 }, (_, index) => String(index)),
  ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)),
].map(name => name.toLowerCase()))

/** `KeyboardEvent.code` values of a full keyboard. */
const DOM_CODES = [
  'Escape', 'Tab', 'Backspace', 'Enter', 'Space', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'CapsLock', 'NumLock', 'ScrollLock', 'Pause', 'PrintScreen', 'ContextMenu', 'Help', 'Minus', 'Equal', 'BracketLeft',
  'BracketRight', 'Backslash', 'IntlBackslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlYen',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumpadEqual',
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${String(index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Numpad${String(index)}`),
  ...Array.from({ length: 24 }, (_, index) => `F${String(index + 1)}`),
]

describe('godotKey', () => {
  it.each([
    ['KeyW', 'W'], ['Space', 'Space'], ['ArrowLeft', 'Left'], ['Enter', 'Enter'], ['Escape', 'Escape'], ['ShiftLeft', 'Shift'],
    ['Digit1', '1'], ['F1', 'F1'], ['Backspace', 'BackSpace'], ['Tab', 'Tab'], ['ShiftRight', 'Shift'], ['ControlRight', 'Ctrl'],
    ['Numpad7', 'Kp 7'], ['NumpadEnter', 'Kp Enter'], ['NumpadDecimal', 'Kp Period'], ['Quote', 'Apostrophe'],
    ['Backquote', 'QuoteLeft'], ['IntlBackslash', 'BackSlash'], ['F24', 'F24'], ['KeyA', 'A'], ['Digit0', '0'],
  ])('maps %s to the Godot key %s', (code, key) => {
    expect(godotKey(code)).toEqual({ key })
  })

  it('sends keycodes for Alt and Meta, whose Godot names depend on the platform', () => {
    for (const code of ['AltLeft', 'AltRight']) expect(godotKey(code)).toEqual({ keycode: 4194328 })
    for (const code of ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']) expect(godotKey(code)).toEqual({ keycode: 4194327 })
  })

  it.each(['Fn', 'F25', 'Key1', 'KeyAB', 'Digit10', 'Unidentified', 'constructor', '__proto__', ''])('drops %j', (code) => {
    expect(godotKey(code)).toBeUndefined()
  })

  it('names only keys Godot recognizes', () => {
    for (const code of DOM_CODES) {
      const mapped = godotKey(code)
      expect(mapped, code).toBeDefined()
      if (mapped !== undefined && 'key' in mapped) expect(GODOT_KEY_NAMES.has(mapped.key.toLowerCase()), `${code} -> ${mapped.key}`).toBe(true)
    }
  })
})

describe('pointer mapping', () => {
  it('maps primary, middle, and secondary buttons and drops the rest', () => {
    expect([0, 1, 2, 3, 4].map(godotMouseButton)).toEqual(['left', 'middle', 'right', undefined, undefined])
  })

  it('maps wheel deltas like Godot’s web platform', () => {
    expect(wheelButton({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toEqual({ button: 'wheel_up', factor: 3 })
    expect(wheelButton({ deltaX: 40, deltaY: 2, deltaMode: 1 })).toEqual({ button: 'wheel_down', factor: 0.6 })
    expect(wheelButton({ deltaX: -2, deltaY: 0, deltaMode: 2 })).toEqual({ button: 'wheel_left', factor: 2 })
    expect(wheelButton({ deltaX: 10, deltaY: 0, deltaMode: 1 })).toEqual({ button: 'wheel_right', factor: 3 })
    expect(wheelButton({ deltaX: 0, deltaY: 0, deltaMode: 0 })).toBeUndefined()
  })

  it('scales a letterboxed point to window pixels and clamps points in the bars', () => {
    const box = { left: 10, top: 20, width: 400, height: 300 }
    const image = { width: 1280, height: 720 }
    expect(toGamePoint(box, image, image, 210, 170)).toEqual({ x: 640, y: 360, inside: true, scale: 3.2 })
    expect(toGamePoint(box, image, image, 210, 30)).toEqual({ x: 640, y: 0, inside: false, scale: 3.2 })
    expect(toGamePoint(box, image, image, 410, 282.5)).toEqual({ x: 1280, y: 720, inside: true, scale: 3.2 })
    expect(toGamePoint(box, image, image, 210, 300)).toMatchObject({ y: 720, inside: false })
    expect(toGamePoint(box, { width: 640, height: 360 }, image, 110, 113.75)).toEqual({ x: 320, y: 180, inside: true, scale: 3.2 })
  })

  it('pillarboxes a frame narrower than the box', () => {
    const box = { left: 0, top: 0, width: 400, height: 300 }
    const square = { width: 300, height: 300 }
    expect(toGamePoint(box, square, square, 50, 0)).toEqual({ x: 0, y: 0, inside: true, scale: 1 })
    expect(toGamePoint(box, square, square, 20, 150)).toEqual({ x: 0, y: 150, inside: false, scale: 1 })
    expect(toGamePoint(box, square, square, 380, 150)).toEqual({ x: 300, y: 150, inside: false, scale: 1 })
    expect(toGamePoint(box, square, square, 200, 333.333)).toMatchObject({ x: 150, y: 300 })
  })

  it.each([
    [{ left: 0, top: 0, width: 0, height: 300 }, { width: 10, height: 10 }],
    [{ left: 0, top: 0, width: 300, height: 0 }, { width: 10, height: 10 }],
    [{ left: 0, top: 0, width: 300, height: 300 }, { width: 0, height: 10 }],
    [{ left: 0, top: 0, width: 300, height: 300 }, { width: 10, height: 0 }],
    [{ left: 0, top: 0, width: Number.NaN, height: 300 }, { width: 10, height: 10 }],
  ])('maps nothing while the box %j or the frame %j is empty', (box, image) => {
    expect(toGamePoint(box, image, { width: 10, height: 10 }, 1, 1)).toBeUndefined()
  })
})

function key(name: string, pressed = true): GodotInputEvent {
  return { kind: 'key', key: name, pressed }
}

function queue() {
  const sends: { events: GodotInputEvent[]; done: PromiseWithResolvers<undefined> }[] = []
  const flushes: (() => void)[] = []
  const cancels: ReturnType<typeof vi.fn>[] = []
  const send = vi.fn((events: GodotInputEvent[]) => {
    const done = Promise.withResolvers<undefined>()
    sends.push({ events, done })
    return done.promise
  })
  const schedule = vi.fn((callback: () => void) => {
    flushes.push(callback)
    const cancel = vi.fn()
    cancels.push(cancel)
    return cancel
  })
  return { instance: new InputQueue(send, schedule), sends, flushes, cancels, send, schedule }
}

describe('InputQueue', () => {
  it('sends one batch per repaint in push order', () => {
    const q = queue()
    q.instance.push(key('W'))
    q.instance.push(key('A'))
    expect(q.schedule).toHaveBeenCalledOnce()
    expect(q.send).not.toHaveBeenCalled()
    q.flushes[0]!()
    expect(q.sends[0]?.events).toEqual([key('W'), key('A')])
  })

  it('merges consecutive motions into the latest position with summed deltas', () => {
    const q = queue()
    q.instance.push({ kind: 'mouse_motion', x: 1, y: 1, dx: 1, dy: 2 })
    q.instance.push({ kind: 'mouse_motion', x: 3, y: 4, dx: 2, dy: 2 })
    q.instance.push({ kind: 'mouse_motion', x: 5, y: 6 })
    q.instance.push({ kind: 'mouse_button', button: 'left', pressed: true, x: 5, y: 6 })
    q.instance.push({ kind: 'mouse_motion', x: 7, y: 8, dx: 2 })
    q.instance.push({ wait: 0.5 })
    q.instance.push({ kind: 'mouse_motion', x: 9, y: 9, dx: 1, dy: 1 })
    q.instance.push({ kind: 'text', text: 'hi' })
    q.instance.push({ kind: 'mouse_motion', x: 10, y: 10 })
    q.instance.push({ kind: 'mouse_motion', x: 11, y: 12, dx: 1, dy: 2 })
    q.instance.flush()
    expect(q.sends[0]?.events).toEqual([
      { kind: 'mouse_motion', x: 5, y: 6, dx: 3, dy: 4 },
      { kind: 'mouse_button', button: 'left', pressed: true, x: 5, y: 6 },
      { kind: 'mouse_motion', x: 7, y: 8, dx: 2 },
      { wait: 0.5 },
      { kind: 'mouse_motion', x: 9, y: 9, dx: 1, dy: 1 },
      { kind: 'text', text: 'hi' },
      { kind: 'mouse_motion', x: 11, y: 12, dx: 1, dy: 2 },
    ])
    expect(q.cancels[0]).toHaveBeenCalledOnce()
  })

  it('holds new events while a batch is in flight and sends them as soon as it settles', async () => {
    const q = queue()
    q.instance.push(key('W'))
    q.flushes[0]!()
    q.instance.push(key('W', false))
    q.instance.push(key('S'))
    expect(q.schedule).toHaveBeenCalledOnce()
    q.instance.flush()
    expect(q.send).toHaveBeenCalledOnce()
    q.sends[0]!.done.resolve(undefined)
    await vi.waitFor(() => { expect(q.send).toHaveBeenCalledTimes(2) })
    expect(q.sends[1]?.events).toEqual([key('W', false), key('S')])
    q.sends[1]!.done.resolve(undefined)
    await Promise.resolve()
    q.instance.flush()
    expect(q.send).toHaveBeenCalledTimes(2)
  })

  it('splits a burst into batches of at most the Host limit', async () => {
    const q = queue()
    const burst = Array.from({ length: MAX_INPUT_EVENTS + 44 }, (_, index) => key(String(index % 10), index % 2 === 0))
    for (const event of burst) q.instance.push(event)
    q.instance.flush()
    expect(q.sends[0]?.events).toHaveLength(MAX_INPUT_EVENTS)
    q.sends[0]!.done.resolve(undefined)
    await vi.waitFor(() => { expect(q.sends[1]?.events).toHaveLength(44) })
    expect([...q.sends[0]!.events, ...q.sends[1]!.events]).toEqual(burst)
  })

  it('reports a rejected delivery and keeps sending later batches', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = queue()
    q.instance.push(key('W'))
    q.instance.flush()
    q.instance.push(key('A'))
    q.sends[0]!.done.reject(new Error('Remote method is no longer mounted'))
    await vi.waitFor(() => { expect(q.send).toHaveBeenCalledTimes(2) })
    expect(q.sends[1]?.events).toEqual([key('A')])
    expect(error).toHaveBeenCalledWith('Godot input delivery failed:', expect.objectContaining({ message: 'Remote method is no longer mounted' }))
  })

  it('sends the key and button releases of a rejected batch again, first and once each, with the next batch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = queue()
    const left = { kind: 'mouse_button', button: 'left', pressed: false, x: 1, y: 2 } as const
    const wheel = { kind: 'mouse_button', button: 'wheel_up', pressed: false, x: 1, y: 2, factor: 1 } as const
    const alt = { kind: 'key', keycode: 4194328, pressed: false } as const
    const lost = [key('W', false), key('S'), left, wheel, alt, { kind: 'mouse_motion', x: 1, y: 2 } as const]
    for (const event of lost) q.instance.push(event)
    q.instance.flush()
    q.sends[0]!.done.reject(new Error('carrier lost'))
    await settle()
    // Held releases alone wait for the next event, so a lasting failure is not retried in a loop.
    expect(q.send).toHaveBeenCalledOnce()
    q.instance.push(key('D'))
    q.instance.flush()
    expect(q.sends[1]?.events).toEqual([key('W', false), left, alt, key('D')])
    q.sends[1]!.done.reject(new Error('carrier lost'))
    await settle()
    q.instance.push(key('W', false))
    q.instance.flush()
    expect(q.sends[2]?.events).toEqual([key('W', false), left, alt, key('W', false)])
    expect(error).toHaveBeenCalledOnce()
    q.sends[2]!.done.resolve(undefined)
    await settle()
    q.instance.flush()
    expect(q.send).toHaveBeenCalledTimes(3)
    q.instance.push(key('A'))
    q.instance.flush()
    q.sends[3]!.done.reject(new Error('carrier lost again'))
    await settle()
    expect(error).toHaveBeenCalledTimes(2)
    // An explicit flush sends held releases without a new event.
    q.instance.push(key('A', false))
    q.instance.flush()
    q.sends[4]!.done.reject(new Error('carrier lost again'))
    await settle()
    q.instance.flush()
    expect(q.sends[5]?.events).toEqual([key('A', false)])
  })

  it('fills a batch with queued events after the held releases, within the Host limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = queue()
    q.instance.push(key('W', false))
    q.instance.flush()
    q.sends[0]!.done.reject(new Error('carrier lost'))
    await settle()
    const burst = Array.from({ length: MAX_INPUT_EVENTS }, (_, index) => key(String(index % 10)))
    for (const event of burst) q.instance.push(event)
    q.instance.flush()
    expect(q.sends[1]?.events).toEqual([key('W', false), ...burst.slice(0, MAX_INPUT_EVENTS - 1)])
    q.sends[1]!.done.resolve(undefined)
    await vi.waitFor(() => { expect(q.sends[2]?.events).toEqual(burst.slice(MAX_INPUT_EVENTS - 1)) })
  })

  it('sends what is queued on close and accepts nothing afterwards', () => {
    const q = queue()
    q.instance.push(key('W'))
    q.instance.close()
    expect(q.sends[0]?.events).toEqual([key('W')])
    q.instance.push(key('A'))
    expect(q.schedule).toHaveBeenCalledOnce()
    q.instance.close()
    expect(q.send).toHaveBeenCalledOnce()
  })
})

interface Harness {
  readonly element: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  readonly sent: () => GodotInputEvent[]
  readonly flush: () => void
  readonly flushes: (() => void)[]
  target: GameInputTarget
  readonly dispose: () => void
  readonly captureKeyboard: ReturnType<typeof vi.fn<() => () => void>>
  readonly releaseKeyboard: ReturnType<typeof vi.fn<() => void>>
}

let lockTarget: Element | null = null
let exitPointerLock: ReturnType<typeof vi.fn>
let requestPointerLock: ReturnType<typeof vi.fn>

beforeEach(() => {
  lockTarget = null
  exitPointerLock = vi.fn(() => { lockTarget = null })
  requestPointerLock = vi.fn(async () => {})
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockTarget })
  Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exitPointerLock })
  Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', { configurable: true, value: requestPointerLock })
})

afterEach(() => {
  Reflect.deleteProperty(document, 'pointerLockElement')
  Reflect.deleteProperty(document, 'exitPointerLock')
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'requestPointerLock')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function harness(options: { focused?: boolean; send?: (events: GodotInputEvent[]) => Promise<void> } = {}): Harness {
  const element = document.createElement('div')
  element.tabIndex = 0
  const canvas = document.createElement('canvas')
  element.append(canvas)
  document.body.append(element)
  if (options.focused === true) element.focus()
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  const batches: GodotInputEvent[][] = []
  const flushes: (() => void)[] = []
  const state: { target: GameInputTarget } = {
    target: { window: { width: 1280, height: 720 }, image: { width: 1280, height: 720 }, mouseMode: 0 },
  }
  const releaseKeyboard = vi.fn<() => void>()
  const captureKeyboard = vi.fn<() => () => void>(() => releaseKeyboard)
  const dispose = bindGameInput({
    element,
    canvas,
    target: () => state.target,
    send: options.send ?? (async (events) => { batches.push(events) }),
    schedule: (callback) => {
      flushes.push(callback)
      return () => { flushes.splice(flushes.indexOf(callback), 1) }
    },
    captureKeyboard,
  })
  return {
    element, canvas, flushes, dispose, captureKeyboard, releaseKeyboard,
    get target() { return state.target },
    set target(next) { state.target = next },
    flush: () => { for (const callback of flushes.splice(0)) callback() },
    sent: () => batches.flat(),
  }
}

function keyboard(target: EventTarget, type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function mouse(target: EventTarget, type: string, init: MouseEventInit): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

/** Let settled batch promises run their follow-up flushes. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('bindGameInput keyboard', () => {
  it('forwards mapped keys with text, modifiers, and repeats, and keeps them from the page', () => {
    const h = harness()
    const press = keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w' })
    const repeat = keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w', repeat: true })
    const shifted = keyboard(h.element, 'keydown', { code: 'KeyA', key: 'A', shiftKey: true })
    const control = keyboard(h.element, 'keydown', { code: 'KeyC', key: 'c', ctrlKey: true })
    const option = keyboard(h.element, 'keydown', { code: 'AltLeft', key: 'Alt', altKey: true })
    const space = keyboard(h.element, 'keydown', { code: 'Space', key: ' ' })
    const release = keyboard(h.element, 'keyup', { code: 'KeyW', key: 'w' })
    for (const event of [press, repeat, shifted, control, option, space, release]) expect(event.defaultPrevented).toBe(true)
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'key', key: 'W', pressed: true, unicode: 119 },
      { kind: 'key', key: 'W', pressed: true, echo: true, unicode: 119 },
      { kind: 'key', key: 'A', pressed: true, shift: true, unicode: 65 },
      { kind: 'key', key: 'C', pressed: true, ctrl: true },
      { kind: 'key', keycode: 4194328, pressed: true, alt: true },
      { kind: 'key', key: 'Space', pressed: true, unicode: 32 },
      { kind: 'key', key: 'W', pressed: false },
    ])
    h.dispose()
  })

  it('leaves unmapped keys, composition, Meta shortcuts, and keys it never pressed to the page', () => {
    const h = harness()
    const events = [
      keyboard(h.element, 'keydown', { code: 'Fn', key: 'Fn' }),
      keyboard(h.element, 'keydown', { code: 'KeyN', key: 'n', isComposing: true }),
      keyboard(h.element, 'keydown', { code: 'KeyQ', key: 'q', metaKey: true }),
      keyboard(h.element, 'keyup', { code: 'KeyQ', key: 'q', metaKey: true }),
      keyboard(h.element, 'keyup', { code: 'KeyZ', key: 'z' }),
    ]
    for (const event of events) expect(event.defaultPrevented).toBe(false)
    const meta = keyboard(h.element, 'keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true })
    const repeatedRelease = keyboard(h.element, 'keyup', { code: 'MetaLeft', key: 'Meta' })
    expect([meta.defaultPrevented, repeatedRelease.defaultPrevented]).toEqual([true, true])
    const repeatAfterFocus = keyboard(h.element, 'keydown', { code: 'KeyD', key: 'd', repeat: true })
    expect(repeatAfterFocus.defaultPrevented).toBe(true)
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'key', keycode: 4194327, pressed: true, meta: true },
      { kind: 'key', keycode: 4194327, pressed: false },
      { kind: 'key', key: 'D', pressed: true, unicode: 100 },
    ])
    h.dispose()
  })

  it('releases every held key and button at once when the view or the window loses focus', async () => {
    const h = harness()
    keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w' })
    keyboard(h.element, 'keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 })
    h.flush()
    h.element.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(h.flushes).toHaveLength(0)
    expect(h.sent().slice(3)).toEqual([
      { kind: 'key', key: 'W', pressed: false },
      { kind: 'key', key: 'Shift', pressed: false },
      { kind: 'mouse_button', button: 'left', pressed: false, x: 640, y: 360 },
    ])
    keyboard(h.element, 'keydown', { code: 'KeyS', key: 's' })
    h.flush()
    window.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(h.sent().slice(-1)).toEqual([{ kind: 'key', key: 'S', pressed: false }])
    window.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(h.sent()).toHaveLength(8)
    h.dispose()
  })

  it('types the text of AltGr characters, which Windows reports as Ctrl+Alt, and of Option characters', () => {
    const h = harness()
    // AltGr+Q and AltGr+7 on a German layout, as Windows reports them.
    keyboard(h.element, 'keydown', { code: 'KeyQ', key: '@', ctrlKey: true, altKey: true })
    keyboard(h.element, 'keydown', { code: 'Digit7', key: '{', ctrlKey: true, altKey: true })
    // AltGr+E reported with the AltGraph modifier and Ctrl only, or with AltGraph alone as on Linux; Option+E on macOS.
    keyboard(h.element, 'keydown', { code: 'KeyE', key: '€', ctrlKey: true, modifierAltGraph: true })
    keyboard(h.element, 'keydown', { code: 'KeyE', key: '€', modifierAltGraph: true })
    keyboard(h.element, 'keydown', { code: 'KeyE', key: '´', altKey: true })
    // A Ctrl chord without AltGr types nothing.
    keyboard(h.element, 'keydown', { code: 'KeyV', key: 'v', ctrlKey: true, shiftKey: true })
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'key', key: 'Q', pressed: true, ctrl: true, alt: true, unicode: 64 },
      { kind: 'key', key: '7', pressed: true, ctrl: true, alt: true, unicode: 123 },
      { kind: 'key', key: 'E', pressed: true, ctrl: true, unicode: 8364 },
      { kind: 'key', key: 'E', pressed: true, unicode: 8364 },
      { kind: 'key', key: 'E', pressed: true, alt: true, unicode: 180 },
      { kind: 'key', key: 'V', pressed: true, shift: true, ctrl: true },
    ])
    h.dispose()
  })

  it('gives the keyboard back on Shift+Escape, which the game never receives', async () => {
    const h = harness()
    h.element.focus()
    keyboard(h.element, 'keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    keyboard(h.element, 'keydown', { code: 'KeyW', key: 'W', shiftKey: true })
    const others = [
      keyboard(h.element, 'keydown', { code: 'Escape', key: 'Escape' }),
      keyboard(h.element, 'keydown', { code: 'Escape', key: 'Escape', shiftKey: true, ctrlKey: true }),
      keyboard(h.element, 'keydown', { code: 'Escape', key: 'Escape', shiftKey: true, altKey: true }),
    ]
    expect(others.map(event => event.defaultPrevented)).toEqual([true, true, true])
    expect(document.activeElement).toBe(h.element)
    const chord = keyboard(h.element, 'keydown', { code: 'Escape', key: 'Escape', shiftKey: true })
    expect(chord.defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(h.element)
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
    await settle()
    const sent = h.sent()
    expect(sent.filter(event => 'kind' in event && event.kind === 'key' && event.key === 'Escape' && event.shift === true
      && event.ctrl === undefined && event.alt === undefined)).toEqual([])
    expect(sent.slice(-3)).toEqual([
      { kind: 'key', key: 'Shift', pressed: false },
      { kind: 'key', key: 'W', pressed: false },
      { kind: 'key', key: 'Escape', pressed: false },
    ])
    h.dispose()
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
  })

  it('holds the keyboard from application shortcuts exactly while the view has focus', () => {
    const h = harness()
    expect(h.captureKeyboard).not.toHaveBeenCalled()
    h.element.focus()
    h.element.dispatchEvent(new FocusEvent('focus'))
    expect(h.captureKeyboard).toHaveBeenCalledOnce()
    h.element.blur()
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
    h.element.dispatchEvent(new FocusEvent('blur'))
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
    h.element.focus()
    expect(h.captureKeyboard).toHaveBeenCalledTimes(2)
    h.dispose()
    expect(h.releaseKeyboard).toHaveBeenCalledTimes(2)
    h.element.blur()
    h.element.focus()
    expect(h.captureKeyboard).toHaveBeenCalledTimes(2)
  })

  it('holds the keyboard at once when the view already has focus and lets it go on disposal', () => {
    const h = harness({ focused: true })
    expect(h.captureKeyboard).toHaveBeenCalledOnce()
    h.dispose()
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
  })

  it('sends a release again that a failed delivery lost, when the view loses focus', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const delivered: GodotInputEvent[][] = []
    let failures = 0
    const h = harness({
      send: async (events) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('carrier lost')
        }
        delivered.push(events)
      },
    })
    h.element.focus()
    keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w' })
    h.flush()
    await settle()
    failures = 1
    keyboard(h.element, 'keyup', { code: 'KeyW', key: 'w' })
    h.flush()
    await settle()
    expect(delivered).toEqual([[{ kind: 'key', key: 'W', pressed: true, unicode: 119 }]])
    h.element.blur()
    await settle()
    expect(delivered.at(-1)).toEqual([{ kind: 'key', key: 'W', pressed: false }])
    h.dispose()
  })
})

describe('bindGameInput mouse', () => {
  it('focuses the view, presses on the image, drags through window motion, and releases', async () => {
    const h = harness()
    const press = mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 })
    expect(press.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(h.element)
    mouse(window, 'mousemove', { clientX: 210, clientY: 160 })
    mouse(h.element, 'mousemove', { clientX: 220, clientY: 160 })
    mouse(window, 'mousemove', { clientX: 900, clientY: 160 })
    mouse(window, 'mouseup', { button: 0, clientX: 900, clientY: 160, shiftKey: true })
    mouse(window, 'mousemove', { clientX: 230, clientY: 160 })
    mouse(window, 'mouseup', { button: 0, clientX: 230, clientY: 160 })
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'mouse_button', button: 'left', pressed: true, x: 640, y: 360 },
      { kind: 'mouse_motion', x: 1280, y: 392, dx: 640, dy: 32 },
      { kind: 'mouse_button', button: 'left', pressed: false, x: 1280, y: 392, shift: true },
    ])
    h.dispose()
  })

  it('reports double presses and hover over the image, and ignores bars, foreign buttons, and stray releases', () => {
    const h = harness()
    h.target = { window: { width: 1280, height: 720 }, image: { width: 1280, height: 720 }, mouseMode: 0 }
    vi.spyOn(h.canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400))
    const bar = mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 10 })
    const back = mouse(h.canvas, 'mousedown', { button: 3, clientX: 200, clientY: 200 })
    expect([bar.defaultPrevented, back.defaultPrevented]).toEqual([false, false])
    mouse(h.element, 'mousemove', { clientX: 200, clientY: 10 })
    mouse(h.element, 'mousemove', { clientX: 100, clientY: 200 })
    mouse(window, 'mouseup', { button: 2, clientX: 100, clientY: 200 })
    mouse(h.canvas, 'mousedown', { button: 2, detail: 2, clientX: 100, clientY: 200, ctrlKey: true })
    mouse(window, 'mouseup', { button: 4, clientX: 100, clientY: 200 })
    mouse(window, 'mouseup', { button: 0, clientX: 100, clientY: 200 })
    mouse(window, 'mouseup', { button: 2, clientX: 100, clientY: 200 })
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'mouse_motion', x: 320, y: 360, dx: 320, dy: 360 },
      { kind: 'mouse_button', button: 'right', pressed: true, x: 320, y: 360, double: true, ctrl: true },
      { kind: 'mouse_button', button: 'right', pressed: false, x: 320, y: 360 },
    ])
    h.dispose()
  })

  it('keeps dragging until the last held button is released', () => {
    const h = harness()
    mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 })
    mouse(h.canvas, 'mousedown', { button: 2, clientX: 200, clientY: 150 })
    mouse(window, 'mouseup', { button: 0, clientX: 200, clientY: 150 })
    mouse(window, 'mousemove', { clientX: 100, clientY: 150 })
    mouse(window, 'mouseup', { button: 2, clientX: 100, clientY: 150 })
    mouse(window, 'mousemove', { clientX: 120, clientY: 150 })
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'mouse_button', button: 'left', pressed: true, x: 640, y: 360 },
      { kind: 'mouse_button', button: 'right', pressed: true, x: 640, y: 360 },
      { kind: 'mouse_button', button: 'left', pressed: false, x: 640, y: 360 },
      { kind: 'mouse_motion', x: 320, y: 360, dx: -320, dy: 0 },
      { kind: 'mouse_button', button: 'right', pressed: false, x: 320, y: 360 },
    ])
    h.dispose()
  })

  it('sends a wheel step as a press and release at the pointer and keeps it from scrolling the page', () => {
    const h = harness()
    const step = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: 200, clientY: 150, altKey: true })
    h.canvas.dispatchEvent(step)
    const still = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 150 })
    h.canvas.dispatchEvent(still)
    vi.spyOn(h.canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400))
    const bar = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: 200, clientY: 350 })
    h.canvas.dispatchEvent(bar)
    const menu = mouse(h.canvas, 'contextmenu', { button: 2 })
    expect([step.defaultPrevented, still.defaultPrevented, bar.defaultPrevented, menu.defaultPrevented]).toEqual([true, false, false, true])
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'mouse_button', button: 'wheel_down', pressed: true, x: 640, y: 360, factor: 3, alt: true },
      { kind: 'mouse_button', button: 'wheel_down', pressed: false, x: 640, y: 360, factor: 3, alt: true },
    ])
    h.dispose()
  })

  it('drops pointer input while the canvas has no size', () => {
    const h = harness()
    vi.spyOn(h.canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0))
    const press = mouse(h.canvas, 'mousedown', { button: 0, clientX: 1, clientY: 1 })
    mouse(h.element, 'mousemove', { clientX: 1, clientY: 1 })
    h.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1 }))
    expect(press.defaultPrevented).toBe(false)
    h.flush()
    expect(h.sent()).toEqual([])
    h.dispose()
  })

  it('locks the pointer while the game captures the mouse and sends scaled deltas from the press position', () => {
    const h = harness()
    h.target = { window: { width: 1280, height: 720 }, image: { width: 1280, height: 720 }, mouseMode: MOUSE_MODE_CAPTURED }
    mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 })
    expect(requestPointerLock).toHaveBeenCalledOnce()
    lockTarget = h.canvas
    mouse(h.canvas, 'mousemove', { clientX: 200, clientY: 150, movementX: 5, movementY: -2 })
    mouse(h.canvas, 'mousemove', { clientX: 200, clientY: 150, movementX: 1, movementY: 1 })
    mouse(window, 'mouseup', { button: 0, clientX: 300, clientY: 150 })
    mouse(h.element, 'mousemove', { clientX: 200, clientY: 150, movementX: 2, movementY: 0 })
    mouse(h.canvas, 'mousedown', { button: 0, clientX: 10, clientY: 150 })
    expect(requestPointerLock).toHaveBeenCalledOnce()
    h.flush()
    expect(h.sent()).toEqual([
      { kind: 'mouse_button', button: 'left', pressed: true, x: 640, y: 360 },
      { kind: 'mouse_motion', x: 640, y: 360, dx: 19.2, dy: -3.2 },
      { kind: 'mouse_button', button: 'left', pressed: false, x: 640, y: 360 },
      { kind: 'mouse_motion', x: 640, y: 360, dx: 6.4, dy: 0 },
      { kind: 'mouse_button', button: 'left', pressed: true, x: 640, y: 360 },
    ])
    h.dispose()
    expect(exitPointerLock).toHaveBeenCalledOnce()
  })

  it('tolerates a refused pointer lock', async () => {
    requestPointerLock.mockRejectedValueOnce(new DOMException('lock refused', 'NotAllowedError'))
    const h = harness()
    h.target = { window: { width: 1280, height: 720 }, image: { width: 1280, height: 720 }, mouseMode: MOUSE_MODE_CAPTURED }
    mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 })
    await settle()
    expect(requestPointerLock).toHaveBeenCalledOnce()
    h.dispose()
    expect(exitPointerLock).not.toHaveBeenCalled()
  })
})

describe('bindGameInput disposal', () => {
  it('releases held input, sends it, and stops listening', () => {
    const h = harness()
    keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w' })
    mouse(h.canvas, 'mousedown', { button: 1, clientX: 200, clientY: 150 })
    h.dispose()
    expect(h.sent()).toEqual([
      { kind: 'key', key: 'W', pressed: true, unicode: 119 },
      { kind: 'mouse_button', button: 'middle', pressed: true, x: 640, y: 360 },
      { kind: 'key', key: 'W', pressed: false },
      { kind: 'mouse_button', button: 'middle', pressed: false, x: 640, y: 360 },
    ])
    const ignored = [
      keyboard(h.element, 'keydown', { code: 'KeyW', key: 'w' }),
      mouse(h.canvas, 'mousedown', { button: 0, clientX: 200, clientY: 150 }),
      mouse(h.canvas, 'contextmenu', { button: 2 }),
    ]
    mouse(window, 'mousemove', { clientX: 210, clientY: 150 })
    window.dispatchEvent(new FocusEvent('blur'))
    for (const event of ignored) expect(event.defaultPrevented).toBe(false)
    h.flush()
    expect(h.sent()).toHaveLength(4)
  })
})
