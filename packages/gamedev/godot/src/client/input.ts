/**
 * Panel input for a running game: DOM key codes and mouse buttons mapped to
 * Godot input events, client points mapped from the letterboxed canvas to
 * game window pixels, and an ordered queue that sends events in batches.
 */
import type { GodotInputEvent, GodotInputModifiers, GodotMouseButton } from '../types.ts'

/** Most events one `godot.input` call carries. */
export const MAX_INPUT_EVENTS = 256

/** Godot `Input.MouseMode` value of a captured (pointer-locked) mouse. */
export const MOUSE_MODE_CAPTURED = 2

/** Godot `Key.ALT`; its key name is platform-specific (`Option` on macOS), so the keycode is sent. */
const GODOT_KEY_ALT = 4194328

/** Godot `Key.META`; its key name is platform-specific (`Command` on macOS, `Windows` on Windows), so the keycode is sent. */
const GODOT_KEY_META = 4194327

/** A Godot key: a name `OS.find_keycode_from_string` accepts, or a keycode where Godot's names differ per platform. */
export type GodotKeyRef = { readonly key: string } | { readonly keycode: number }

/** `KeyboardEvent.code` values whose Godot names do not follow the letter, digit, keypad, or function-key patterns. */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ['Escape', 'Escape'], ['Tab', 'Tab'], ['Backspace', 'BackSpace'], ['Enter', 'Enter'], ['Space', 'Space'],
  ['Insert', 'Insert'], ['Delete', 'Delete'], ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
  ['ArrowLeft', 'Left'], ['ArrowUp', 'Up'], ['ArrowRight', 'Right'], ['ArrowDown', 'Down'],
  ['ShiftLeft', 'Shift'], ['ShiftRight', 'Shift'], ['ControlLeft', 'Ctrl'], ['ControlRight', 'Ctrl'],
  ['CapsLock', 'CapsLock'], ['NumLock', 'NumLock'], ['ScrollLock', 'ScrollLock'], ['Pause', 'Pause'],
  ['PrintScreen', 'Print'], ['ContextMenu', 'Menu'], ['Help', 'Help'],
  ['Minus', 'Minus'], ['Equal', 'Equal'], ['BracketLeft', 'BracketLeft'], ['BracketRight', 'BracketRight'],
  ['Backslash', 'BackSlash'], ['IntlBackslash', 'BackSlash'], ['Semicolon', 'Semicolon'], ['Quote', 'Apostrophe'],
  ['Backquote', 'QuoteLeft'], ['Comma', 'Comma'], ['Period', 'Period'], ['Slash', 'Slash'], ['IntlYen', 'Yen'],
  ['NumpadAdd', 'Kp Add'], ['NumpadSubtract', 'Kp Subtract'], ['NumpadMultiply', 'Kp Multiply'], ['NumpadDivide', 'Kp Divide'],
  ['NumpadDecimal', 'Kp Period'], ['NumpadEnter', 'Kp Enter'], ['NumpadEqual', 'Equal'],
])

/** `KeyboardEvent.code` values of the Meta key; older Firefox reports `OSLeft` and `OSRight`. */
const META_CODES: ReadonlySet<string> = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'])

const KEYCODES: ReadonlyMap<string, number> = new Map([
  ['AltLeft', GODOT_KEY_ALT], ['AltRight', GODOT_KEY_ALT], ...[...META_CODES].map(code => [code, GODOT_KEY_META] as const),
])

/**
 * Map a physical key to the Godot key the game receives, following Godot's own web platform table.
 * @param code - `KeyboardEvent.code`.
 * @returns the Godot key, or undefined for keys the game does not receive.
 */
export function godotKey(code: string): GodotKeyRef | undefined {
  const named = NAMED_KEYS.get(code)
  if (named !== undefined) return { key: named }
  const keycode = KEYCODES.get(code)
  if (keycode !== undefined) return { keycode }
  if (/^Key[A-Z]$/u.test(code) || /^Digit\d$/u.test(code)) return { key: code.slice(-1) }
  if (/^Numpad\d$/u.test(code)) return { key: `Kp ${code.slice(-1)}` }
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(code)) return { key: code }
  return undefined
}

/**
 * Map a DOM mouse button to a Godot mouse button.
 * @param button - `MouseEvent.button`.
 * @returns the Godot button, or undefined for buttons the game does not receive.
 */
export function godotMouseButton(button: number): GodotMouseButton | undefined {
  switch (button) {
    case 0: return 'left'
    case 1: return 'middle'
    case 2: return 'right'
    default: return undefined
  }
}

/**
 * Map one wheel event to a Godot wheel button and factor, as Godot's web
 * platform does: the vertical axis wins, and the factor scales the delta by
 * 0.03 per pixel, 0.3 per line, or 1 per page.
 * @param event - the wheel deltas and their unit.
 * @returns the button and factor, or undefined for an event without movement.
 */
export function wheelButton(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): { readonly button: GodotMouseButton; readonly factor: number } | undefined {
  const scale = event.deltaMode === 1 ? 0.3 : event.deltaMode === 2 ? 1 : 0.03
  if (event.deltaY < 0) return { button: 'wheel_up', factor: -event.deltaY * scale }
  if (event.deltaY > 0) return { button: 'wheel_down', factor: event.deltaY * scale }
  if (event.deltaX < 0) return { button: 'wheel_left', factor: -event.deltaX * scale }
  if (event.deltaX > 0) return { button: 'wheel_right', factor: event.deltaX * scale }
  return undefined
}

/** A pixel size. */
export interface PixelSize {
  readonly width: number
  readonly height: number
}

/** A client rectangle. */
export interface ClientBox extends PixelSize {
  readonly left: number
  readonly top: number
}

/** A client point mapped to the game window. */
export interface GamePoint {
  /** Window x in pixels, clamped to the window. */
  readonly x: number
  /** Window y in pixels, clamped to the window. */
  readonly y: number
  /** Whether the client point lies on the drawn image rather than a letterbox bar. */
  readonly inside: boolean
  /** Window pixels per client pixel. */
  readonly scale: number
}

/**
 * Map a client point over the canvas to game window pixels. The canvas draws
 * its frame aspect-fit, so a point in a letterbox bar maps to the nearest edge.
 * @param box - the canvas client rectangle.
 * @param image - the drawn frame size.
 * @param gameWindow - the game window size.
 * @param clientX - client x of the point.
 * @param clientY - client y of the point.
 * @returns the window point, or undefined while the box or the image is empty.
 */
export function toGamePoint(
  box: ClientBox, image: PixelSize, gameWindow: PixelSize, clientX: number, clientY: number,
): GamePoint | undefined {
  if (!(box.width > 0 && box.height > 0 && image.width > 0 && image.height > 0)) return undefined
  const fit = Math.min(box.width / image.width, box.height / image.height)
  const drawnWidth = image.width * fit
  const drawnHeight = image.height * fit
  const u = (clientX - box.left - (box.width - drawnWidth) / 2) / drawnWidth
  const v = (clientY - box.top - (box.height - drawnHeight) / 2) / drawnHeight
  return {
    x: round(clamp(u) * gameWindow.width),
    y: round(clamp(v) * gameWindow.height),
    inside: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    scale: gameWindow.width / drawnWidth,
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Mouse buttons that stay held between their press and release; a wheel step sends both in one batch. */
const HELD_BUTTONS: ReadonlySet<GodotMouseButton> = new Set(['left', 'right', 'middle'])

/**
 * Identify the key or button an event releases.
 * @param event - a queued event.
 * @returns the identity of a key or held-button release, or undefined for other events.
 */
function releaseOf(event: GodotInputEvent): string | undefined {
  if (!('pressed' in event) || event.pressed) return undefined
  if (event.kind === 'key') return `key:${event.key ?? `#${String(event.keycode)}`}`
  return event.kind === 'mouse_button' && HELD_BUTTONS.has(event.button) ? `button:${event.button}` : undefined
}

/**
 * Ordered input queue. Pushed events wait for the next scheduled flush, so a
 * burst becomes one batch; consecutive mouse motions merge into one with the
 * latest position and summed deltas. One batch of at most
 * {@link MAX_INPUT_EVENTS} events is in flight at a time, and events queued
 * meanwhile follow as soon as it settles. A rejected delivery means the game
 * may not have received the batch: the failure is reported on the console
 * once until a delivery succeeds again, the batch's key and mouse button
 * releases go first in the next batch, one per key or button, so that the
 * game holds nothing the user let go, and its other events are dropped. The
 * next batch leaves with the next pushed event or {@link flush}.
 */
export class InputQueue {
  private queued: GodotInputEvent[] = []
  /** Releases of rejected batches, sent before the queued events. */
  private releases: GodotInputEvent[] = []
  private cancelFlush: (() => void) | undefined
  private sending = false
  private closed = false
  private failing = false

  /**
   * @param send - deliver one batch; the next batch waits for it to settle, and a rejection means the batch may be lost.
   * @param schedule - run a callback before the next repaint and return its cancel function.
   */
  constructor(
    private readonly send: (events: GodotInputEvent[]) => Promise<void>,
    private readonly schedule: (callback: () => void) => () => void,
  ) {}

  /**
   * Queue one event for the next batch; ignored after {@link close}.
   * @param event - the event.
   */
  push(event: GodotInputEvent): void {
    if (this.closed) return
    const last = this.queued.at(-1)
    if ('kind' in event && event.kind === 'mouse_motion' && last !== undefined && 'kind' in last && last.kind === 'mouse_motion') {
      this.queued[this.queued.length - 1] = { ...event, dx: (last.dx ?? 0) + (event.dx ?? 0), dy: (last.dy ?? 0) + (event.dy ?? 0) }
    } else {
      this.queued.push(event)
    }
    if (this.sending || this.cancelFlush !== undefined) return
    this.cancelFlush = this.schedule(() => {
      this.cancelFlush = undefined
      this.flush()
    })
  }

  /** Send held releases and queued events now unless a batch is in flight, in which case they follow it. */
  flush(): void {
    this.cancelFlush?.()
    this.cancelFlush = undefined
    if (this.sending || (this.queued.length === 0 && this.releases.length === 0)) return
    const releases = this.releases.splice(0, MAX_INPUT_EVENTS)
    const batch = [...releases, ...this.queued.splice(0, MAX_INPUT_EVENTS - releases.length)]
    this.sending = true
    void this.send(batch).then(() => {
      this.failing = false
      this.sending = false
      this.flush()
    }, (error: unknown) => {
      if (!this.failing) console.error('Godot input delivery failed:', error)
      this.failing = true
      this.sending = false
      this.hold(batch)
      // Held releases alone wait for the next event or flush, so a lasting failure is not retried in a loop.
      if (this.queued.length > 0) this.flush()
    })
  }

  private hold(batch: readonly GodotInputEvent[]): void {
    const held = new Set(this.releases.map(releaseOf))
    for (const event of batch) {
      const release = releaseOf(event)
      if (release === undefined || held.has(release)) continue
      held.add(release)
      this.releases.push(event)
    }
  }

  /** Accept no more events and send the queued ones without waiting for a repaint. */
  close(): void {
    this.closed = true
    this.flush()
  }
}

/** What the panel reads about the game while it handles an event. */
export interface GameInputTarget {
  /** Game window size; pointer positions are scaled to it. */
  readonly window: PixelSize
  /** Size of the frame the canvas draws. */
  readonly image: PixelSize
  /** Godot mouse mode; {@link MOUSE_MODE_CAPTURED} locks the pointer to the canvas on the next press. */
  readonly mouseMode: number
}

/** Options of {@link bindGameInput}. */
export interface GameInputOptions {
  /** Focusable element that receives keyboard input, and pointer input over the canvas, while focused. */
  readonly element: HTMLElement
  /** Canvas whose letterboxed drawing maps to the game window. */
  readonly canvas: HTMLCanvasElement
  /**
   * Read the current game window, frame size, and mouse mode.
   * @returns the values at event time.
   */
  readonly target: () => GameInputTarget
  /**
   * Deliver one ordered batch of events.
   * @param events - at most {@link MAX_INPUT_EVENTS} events.
   * @returns once the batch is settled.
   */
  readonly send: (events: GodotInputEvent[]) => Promise<void>
  /**
   * Run a callback before the next repaint.
   * @param callback - the batch flush.
   * @returns a function that cancels it.
   */
  readonly schedule: (callback: () => void) => () => void
  /**
   * Keep application shortcuts from taking keys while `element` has focus.
   * @returns the release, called once when `element` loses focus or the binding ends.
   */
  readonly captureKeyboard: () => () => void
}

/** The chord that gives the keyboard back to the page: Shift+Escape without other modifiers, which games rarely bind. */
function isReleaseChord(event: KeyboardEvent): boolean {
  return event.code === 'Escape' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
}

/**
 * Forward input to the game while `element` has focus: mapped keys, and mouse
 * buttons, motion, and wheel steps over the canvas. A press on the canvas
 * focuses `element` and reaches the game. Without focus, pointer motion over
 * the canvas only moves the position that the next motion starts from, so the
 * pointer crosses the game without moving it. Mapped keys do not reach the
 * page, except presses with the Meta modifier, which stay with the
 * application. Shift+Escape never reaches the game: it removes focus from
 * `element`, so the keyboard and the mouse return to the page. While
 * `element` has focus, `captureKeyboard` holds the keys from application
 * shortcuts. A press locks the pointer while the game captures the mouse, and
 * locked motion sends deltas; a lock that ends while the game still captures
 * the mouse, as when the user presses Escape, also removes focus from
 * `element`. Losing focus releases every held key and button and the lock.
 * @param options - elements, game geometry, the batch sender, and the keyboard capture.
 * @returns a disposer that releases held keys, buttons, and the keyboard, sends what is queued, and detaches every listener.
 */
export function bindGameInput(options: GameInputOptions): () => void {
  const { element, canvas } = options
  const queue = new InputQueue(options.send, options.schedule)
  const keys = new Map<string, GodotKeyRef>()
  const buttons = new Set<GodotMouseButton>()
  let position = { x: 0, y: 0 }
  let dragging = false
  let hadLock = false
  let releaseKeyboard: (() => void) | undefined

  const locate = (event: MouseEvent): GamePoint | undefined => {
    const target = options.target()
    return toGamePoint(canvas.getBoundingClientRect(), target.image, target.window, event.clientX, event.clientY)
  }
  const locked = (): boolean => document.pointerLockElement === canvas
  const focused = (): boolean => document.activeElement === element
  const setDragging = (next: boolean): void => {
    if (next === dragging) return
    dragging = next
    if (next) {
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', release)
    } else {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', release)
    }
  }
  const releaseAll = (): void => {
    for (const key of keys.values()) queue.push({ kind: 'key', ...key, pressed: false })
    for (const button of buttons) queue.push({ kind: 'mouse_button', button, pressed: false, ...position })
    keys.clear()
    buttons.clear()
    setDragging(false)
    queue.flush()
  }
  const capture = (): void => {
    releaseKeyboard ??= options.captureKeyboard()
  }
  const uncapture = (): void => {
    const release = releaseKeyboard
    releaseKeyboard = undefined
    release?.()
  }
  const blur = (): void => {
    releaseAll()
    uncapture()
    if (locked()) document.exitPointerLock()
  }
  const lockChange = (): void => {
    const lockedNow = locked()
    // The game did not release the mouse, so the user or the browser ended the lock, and the pointer leaves the game.
    if (hadLock && !lockedNow && options.target().mouseMode === MOUSE_MODE_CAPTURED) element.blur()
    hadLock = lockedNow
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || (event.metaKey && !META_CODES.has(event.code))) return
    if (isReleaseChord(event)) {
      event.preventDefault()
      element.blur()
      return
    }
    const key = godotKey(event.code)
    if (key === undefined) return
    event.preventDefault()
    const echo = event.repeat && keys.has(event.code)
    keys.set(event.code, key)
    const codePoint = event.key.codePointAt(0)
    // A printable key names exactly one code point; named keys such as `Enter` are longer. A Ctrl chord types no text,
    // except AltGr, which Windows reports as Ctrl+Alt.
    const typed = !event.ctrlKey || event.altKey || event.getModifierState('AltGraph')
    const unicode = codePoint !== undefined && String.fromCodePoint(codePoint) === event.key && typed ? codePoint : undefined
    queue.push({
      kind: 'key', ...key, pressed: true, ...modifiers(event),
      ...echo ? { echo: true } : {}, ...unicode === undefined ? {} : { unicode },
    })
  }
  const keyup = (event: KeyboardEvent): void => {
    const key = keys.get(event.code)
    if (key === undefined) return
    event.preventDefault()
    keys.delete(event.code)
    queue.push({ kind: 'key', ...key, pressed: false, ...modifiers(event) })
  }
  const press = (event: MouseEvent): void => {
    element.focus({ preventScroll: true })
    const button = godotMouseButton(event.button)
    const point = locate(event)
    if (button === undefined || point === undefined || !point.inside) return
    event.preventDefault()
    if (options.target().mouseMode === MOUSE_MODE_CAPTURED && !locked()) requestLock(canvas)
    if (!locked()) position = { x: point.x, y: point.y }
    buttons.add(button)
    setDragging(true)
    queue.push({ kind: 'mouse_button', button, pressed: true, ...position, ...event.detail >= 2 ? { double: true } : {}, ...modifiers(event) })
  }
  const release = (event: MouseEvent): void => {
    const button = godotMouseButton(event.button)
    if (button === undefined || !buttons.delete(button)) return
    const point = locked() ? undefined : locate(event)
    if (point !== undefined) position = { x: point.x, y: point.y }
    queue.push({ kind: 'mouse_button', button, pressed: false, ...position, ...modifiers(event) })
    if (buttons.size === 0) setDragging(false)
  }
  const move = (event: MouseEvent): void => {
    const point = locate(event)
    if (point === undefined) return
    if (locked()) {
      queue.push({ kind: 'mouse_motion', ...position, dx: round(event.movementX * point.scale), dy: round(event.movementY * point.scale), ...modifiers(event) })
      return
    }
    if (!point.inside && buttons.size === 0) return
    const dx = round(point.x - position.x)
    const dy = round(point.y - position.y)
    position = { x: point.x, y: point.y }
    queue.push({ kind: 'mouse_motion', ...position, dx, dy, ...modifiers(event) })
  }
  const hover = (event: MouseEvent): void => {
    // While a button is held, the window listener reports motion everywhere.
    if (dragging) return
    if (focused()) {
      move(event)
      return
    }
    const point = locate(event)
    if (point?.inside === true) position = { x: point.x, y: point.y }
  }
  const wheel = (event: WheelEvent): void => {
    if (!focused()) return
    const step = wheelButton(event)
    const point = locate(event)
    if (step === undefined || point === undefined || !point.inside) return
    event.preventDefault()
    const at = { x: point.x, y: point.y, factor: round(step.factor), ...modifiers(event) }
    queue.push({ kind: 'mouse_button', button: step.button, pressed: true, ...at })
    queue.push({ kind: 'mouse_button', button: step.button, pressed: false, ...at })
  }
  const menu = (event: MouseEvent): void => { event.preventDefault() }

  element.addEventListener('keydown', keydown)
  element.addEventListener('keyup', keyup)
  element.addEventListener('mousedown', press)
  element.addEventListener('mousemove', hover)
  element.addEventListener('wheel', wheel, { passive: false })
  element.addEventListener('contextmenu', menu)
  element.addEventListener('focus', capture)
  element.addEventListener('blur', blur)
  window.addEventListener('blur', releaseAll)
  document.addEventListener('pointerlockchange', lockChange)
  if (focused()) capture()
  return () => {
    releaseAll()
    queue.close()
    uncapture()
    element.removeEventListener('keydown', keydown)
    element.removeEventListener('keyup', keyup)
    element.removeEventListener('mousedown', press)
    element.removeEventListener('mousemove', hover)
    element.removeEventListener('wheel', wheel)
    element.removeEventListener('contextmenu', menu)
    element.removeEventListener('focus', capture)
    element.removeEventListener('blur', blur)
    window.removeEventListener('blur', releaseAll)
    document.removeEventListener('pointerlockchange', lockChange)
    if (locked()) document.exitPointerLock()
  }
}

function modifiers(event: KeyboardEvent | MouseEvent): GodotInputModifiers {
  return {
    ...event.shiftKey ? { shift: true } : {},
    ...event.ctrlKey ? { ctrl: true } : {},
    ...event.altKey ? { alt: true } : {},
    ...event.metaKey ? { meta: true } : {},
  }
}

function requestLock(canvas: HTMLCanvasElement): void {
  // The browser refuses a lock it cannot grant, such as one requested too soon after the user left a previous lock.
  void Promise.resolve(canvas.requestPointerLock()).catch((refused: unknown) => { void refused })
}
