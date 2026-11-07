/** Input validation names the first invalid event; screenshot coordinates scale to window pixels. */
import { describe, expect, it } from 'vitest'
import { GodotInputError, hasPointerEvents, parseInputEvents, screenshotToWindow } from '../src/input.ts'

describe('parseInputEvents', () => {
  it('accepts every event kind', () => {
    const events = [
      { wait: 0.5 },
      { kind: 'key', key: 'W', pressed: true, hold: 0.2, shift: true },
      { kind: 'key', keycode: 69, pressed: false, echo: false, unicode: 101 },
      { kind: 'text', text: 'hi' },
      { kind: 'mouse_button', button: 'left', pressed: true, x: 1, y: 2, double: true, factor: 1 },
      { kind: 'mouse_motion', x: 3, y: 4, dx: 1, dy: -1 },
      { kind: 'action', action: 'ui_accept', pressed: true, strength: 0.5 },
      { kind: 'joy_button', device: 0, button: 1, pressed: true },
      { kind: 'joy_axis', axis: 0, value: -1 },
      { kind: 'focus', focused: false },
    ]
    expect(parseInputEvents(events, 16)).toEqual(events)
  })

  it.each([
    [[], 'at least one event'],
    [[{ wait: 1 }, { wait: 1 }], 'at most 1 events'],
  ])('bounds the number of events: %j', (events, message) => {
    expect(() => parseInputEvents(events, 1)).toThrow(message)
  })

  it.each([
    [{ kind: 'key', pressed: true }, 'events[0] is invalid: a key event needs key or keycode'],
    [{ kind: 'key', key: 'W' }, 'events[0] is invalid: pressed:'],
    [{ kind: 'mouse_button', button: 'side', pressed: true, x: 0, y: 0 }, 'button:'],
    [{ kind: 'teleport' }, 'events[0] is invalid'],
    [{ wait: -1 }, 'wait:'],
    [{ wait: 1, kind: 'key' }, 'events[0] is invalid'],
    ['W', 'events[0] is invalid'],
  ])('rejects %j', (event, message) => {
    expect(() => parseInputEvents([event], 4)).toThrow(GodotInputError)
    expect(() => parseInputEvents([event], 4)).toThrow(message)
  })
})

describe('coordinates', () => {
  const frame = { runId: 'r', width: 320, height: 180, windowWidth: 640, windowHeight: 360 }

  it('scales pointer events from screenshot to window pixels', () => {
    const events = parseInputEvents([
      { wait: 1 },
      { kind: 'key', key: 'A', pressed: true },
      { kind: 'mouse_button', button: 'left', pressed: true, x: 10, y: 20 },
      { kind: 'mouse_motion', x: 1, y: 2, dx: 3, dy: 4 },
      { kind: 'mouse_motion', x: 5, y: 6 },
    ], 8)
    expect(screenshotToWindow(events, frame)).toEqual([
      { wait: 1 },
      { kind: 'key', key: 'A', pressed: true },
      { kind: 'mouse_button', button: 'left', pressed: true, x: 20, y: 40 },
      { kind: 'mouse_motion', x: 2, y: 4, dx: 6, dy: 8 },
      { kind: 'mouse_motion', x: 10, y: 12 },
    ])
    expect(hasPointerEvents(events)).toBe(true)
    expect(hasPointerEvents(parseInputEvents([{ wait: 1 }, { kind: 'text', text: 'x' }], 2))).toBe(false)
    expect(hasPointerEvents(parseInputEvents([{ kind: 'mouse_motion', x: 0, y: 0 }], 1))).toBe(true)
  })
})
