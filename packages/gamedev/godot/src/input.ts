/**
 * Validation of input events at the tool and Remote boundaries, and mapping of agent coordinates from
 * screenshot pixels to game window pixels.
 * @module @deepseek-ai/dsh-godot/src/input
 */
import { z } from 'zod'
import type { ScreenshotFrame } from './runs.ts'
import type { GodotInputEvent } from './types.ts'

// Zod 4 numbers exclude NaN and the infinities.
const coordinate = z.number()
const hold = z.number().min(0).optional()
const device = z.number().int().min(0).optional()
const modifiers = {
  shift: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  meta: z.boolean().optional(),
}

const WaitEvent = z.strictObject({ wait: z.number().min(0) })

const KindEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('key'), key: z.string().min(1).optional(), keycode: z.number().int().positive().optional(), pressed: z.boolean(),
    echo: z.boolean().optional(), unicode: z.number().int().min(0).optional(), hold, ...modifiers,
  }).refine(event => event.key !== undefined || event.keycode !== undefined, 'a key event needs key or keycode'),
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('mouse_button'), button: z.enum(['left', 'right', 'middle', 'wheel_up', 'wheel_down', 'wheel_left', 'wheel_right']),
    pressed: z.boolean(), x: coordinate, y: coordinate, double: z.boolean().optional(), factor: z.number().optional(), hold, ...modifiers,
  }),
  z.strictObject({ kind: z.literal('mouse_motion'), x: coordinate, y: coordinate, dx: coordinate.optional(), dy: coordinate.optional(), ...modifiers }),
  z.strictObject({ kind: z.literal('action'), action: z.string().min(1), pressed: z.boolean(), strength: z.number().min(0).max(1).optional(), hold }),
  z.strictObject({ kind: z.literal('joy_button'), device, button: z.number().int().min(0), pressed: z.boolean() }),
  z.strictObject({ kind: z.literal('joy_axis'), device, axis: z.number().int().min(0), value: z.number().min(-1).max(1) }),
  z.strictObject({ kind: z.literal('focus'), focused: z.boolean() }),
])

/** An input event that fails validation. */
export class GodotInputError extends Error {
  override name = 'GodotInputError'
}

/**
 * Validate events from a tool call or the Game tab.
 * @param events - candidate events.
 * @param limit - most events accepted.
 * @returns the events.
 * @throws {GodotInputError} naming the first invalid event and field.
 */
export function parseInputEvents(events: readonly unknown[], limit: number): GodotInputEvent[] {
  if (events.length === 0) throw new GodotInputError('events must contain at least one event.')
  if (events.length > limit) throw new GodotInputError(`events may contain at most ${limit} events; split the sequence into several calls.`)
  return events.map((event, index) => {
    const schema = typeof event === 'object' && event !== null && 'wait' in event ? WaitEvent : KindEvent
    const parsed = schema.safeParse(event)
    if (!parsed.success) {
      const problems = parsed.error.issues.map(issue => issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`)
      throw new GodotInputError(`events[${index}] is invalid: ${problems.join('; ')}`)
    }
    // Zod types absent optional fields as `| undefined`; parsed objects omit them, as GodotInputEvent requires.
    return parsed.data as GodotInputEvent
  })
}

/** A game window size in pixels. */
export interface WindowSize {
  /** Width in pixels. */
  readonly width: number
  /** Height in pixels. */
  readonly height: number
}

/** Largest window side Godot renders: its maximum texture size. */
const MAX_WINDOW_SIDE = 16_384

/**
 * Validate the window size of a run request.
 * @param width - requested width in pixels, or undefined.
 * @param height - requested height in pixels, or undefined.
 * @returns the size, or undefined when neither is given.
 * @throws {GodotInputError} when only one is given or either is not an integer from 1 to 16384.
 */
export function parseWindowSize(width: number | undefined, height: number | undefined): WindowSize | undefined {
  if (width === undefined && height === undefined) return undefined
  if (width === undefined || height === undefined) throw new GodotInputError('Give width and height together.')
  for (const side of [width, height]) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_WINDOW_SIDE) {
      throw new GodotInputError(`width and height must be integers from 1 to ${MAX_WINDOW_SIDE}.`)
    }
  }
  return { width, height }
}

/**
 * Whether any event carries a pointer position.
 * @param events - validated events.
 * @returns true when a mouse button or motion event is present.
 */
export function hasPointerEvents(events: readonly GodotInputEvent[]): boolean {
  return events.some(event => 'kind' in event && (event.kind === 'mouse_button' || event.kind === 'mouse_motion'))
}

/**
 * Scale pointer coordinates from a screenshot's pixels to game window pixels.
 * @param events - validated events in screenshot pixels.
 * @param frame - the screenshot they refer to.
 * @returns the events in window pixels.
 */
export function screenshotToWindow(events: readonly GodotInputEvent[], frame: ScreenshotFrame): GodotInputEvent[] {
  const scaleX = frame.windowWidth / frame.width
  const scaleY = frame.windowHeight / frame.height
  return events.map((event) => {
    if (!('kind' in event)) return event
    if (event.kind === 'mouse_button') return { ...event, x: event.x * scaleX, y: event.y * scaleY }
    if (event.kind !== 'mouse_motion') return event
    return {
      ...event,
      x: event.x * scaleX,
      y: event.y * scaleY,
      ...event.dx === undefined ? {} : { dx: event.dx * scaleX },
      ...event.dy === undefined ? {} : { dy: event.dy * scaleY },
    }
  })
}
