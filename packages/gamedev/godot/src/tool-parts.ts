/**
 * What the Godot tool groups share: the argument and result schemas, the limits and wording of their arguments, and
 * the steps every call takes: find the calling Agent's Session and its running game, run the operation with the
 * digest of the run's new errors, and send input events and screenshot regions to the game window.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { hasPointerEvents, screenshotToWindow } from './input.ts'
import { isErrorEntry } from './logs.ts'
import type { GodotRun, ScreenshotRegion } from './run.ts'
import type { GodotSession } from './runs.ts'
import { formatDigest, toolLogEntry, type Digest } from './tool-text.ts'
import type { GodotToolHost, GodotToolWording } from './tools.ts'
import type { GodotInputEvent } from './types.ts'

/** Most error entries listed in a result's new-error report. */
export const DIGEST_ENTRIES = 10

/** The `web` parameter of `godot_run`. */
export const WEB_RUN_DESCRIPTION = 'true runs the game as its Web build plays: with the Compatibility renderer (WebGL 2 in browsers), whose shading, '
  + 'shadows, and limits differ from Forward+, so what you see is what players of the released game see. Default: false, the project\'s renderer.'

/** Most errors and warnings listed in a `godot_run` result. */
export const STARTUP_ENTRIES = 20

/** How long `godot_run` keeps collecting startup logs after the game runs. */
export const STARTUP_LOG_WINDOW_MS = 1000

/** Width a small screenshot region grows toward, by a whole factor, so its detail is large enough to see. */
export const REGION_MIN_WIDTH = 768

/** Default, shortest, and longest real seconds that `godot_eval` code may await. */
export const CODE_SECONDS = { default: 10, min: 1, max: 300 } as const

/** Default and largest sides in pixels of a `godot_view` image. */
export const VIEW_SIZE = { width: 1280, height: 720, max: 4096 } as const

/** Default, shortest, and longest real seconds that `godot_performance` measures. */
export const PERFORMANCE_SECONDS = { default: 2, min: 0.25, max: 20 } as const

/** Default, shortest, and longest seconds of audio that `godot_audio` captures. */
export const AUDIO_SECONDS = { default: 3, min: 0.25, max: 30 } as const

/** The log levels a log query may name. */
export const LEVELS = ['stdout', 'stderr', 'warning', 'error', 'script_error', 'shader_error'] as const

/** A required string field. */
export const STRING = { type: 'string', required: true } as const

/** A required number field. */
export const NUMBER = { type: 'number', required: true } as const

/** A required integer field. */
export const INTEGER = { type: 'integer', required: true } as const

/** A required boolean field. */
export const BOOLEAN = { type: 'boolean', required: true } as const

/** A size in pixels. */
const SIZE = { width: INTEGER, height: INTEGER } as const

/** The schema of one log entry in a result value. */
export const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: INTEGER,
    source: STRING,
    level: STRING,
    message: STRING,
    file: { type: 'string' },
    line: { type: 'integer' },
    function: { type: 'string' },
  },
} as const

/** The schema of the errors a run logged since the Session's previous Godot tool call. */
export const DIGEST_SCHEMA = {
  newErrors: { type: 'array', items: ENTRY_SCHEMA },
  moreNewErrors: { type: 'integer' },
} as const

/** The stored image: the attachment reference that the attachment store returned for it. */
export const IMAGE_OBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    ...SIZE,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: SIZE },
  },
} as const

const IMAGE_SCHEMA = { ...IMAGE_OBJECT, required: true } as const

/** The fields of a screenshot in a result value. */
export const SCREENSHOT_PROPERTIES = {
  width: { ...INTEGER, description: 'Image width in pixels; mouse coordinates refer to this size.' },
  height: INTEGER,
  windowWidth: INTEGER,
  windowHeight: INTEGER,
  x: { type: 'integer', description: 'Window pixels from the left edge to the region the image shows.' },
  y: { type: 'integer', description: 'Window pixels from the top edge to the region the image shows.' },
  regionWidth: { type: 'integer', description: 'Width in window pixels of the region the image shows.' },
  regionHeight: { type: 'integer', description: 'Height in window pixels of the region the image shows.' },
  frame: INTEGER,
  paused: BOOLEAN,
  image: IMAGE_SCHEMA,
} as const

/** The schema of a screenshot in a result value. */
export const SCREENSHOT_SCHEMA = { type: 'object', additionalProperties: false, properties: SCREENSHOT_PROPERTIES } as const

/** A screenshot as a result value holds it: its size, the game window it shows, and the stored image. */
export type ScreenshotValue = InferValue<typeof SCREENSHOT_SCHEMA>

/** A screenshot without its stored image, as a call that saves the image holds it for callers that receive no images. */
export type CapturedScreenshot = Omit<ScreenshotValue, 'image'>

/** A stored image as a result value holds it: the attachment reference, or the image id for connected agents. */
export type ImageValue = InferValue<typeof IMAGE_SCHEMA>

/** The `save` parameter of `godot_screenshot` and `godot_view`. */
const SAVE_DESCRIPTION = 'true also saves the image as a new .png file in the project\'s .wasdengine/screenshots folder, which Godot '
  + 'neither imports nor exports, for a tool that takes an image file; the result names the file. Not with path.'

/** The sentence of a result that saved its image and leaves the image out for callers that receive no images. */
export const IMAGE_LEFT_OUT = 'You receive no images in this Session, so this result leaves the image out; the saved file holds it.'

/** The sentence of a recording's result that leaves the sheet of frames out for callers that receive no images. */
export const SHEET_LEFT_OUT = 'You receive no images in this Session, so this result leaves the sheet of frames out; the saved video holds them.'

function takeDigest(session: GodotSession): Digest {
  const run = session.run
  if (run === undefined) return {}
  const fresh = run.logs.filter(entry => entry.seq > session.digestCursor && isErrorEntry(entry))
  session.digestCursor = Math.max(session.digestCursor, run.logs.lastSeq)
  if (fresh.length === 0) return {}
  return {
    newErrors: fresh.slice(0, DIGEST_ENTRIES).map(toolLogEntry),
    ...fresh.length > DIGEST_ENTRIES ? { moreNewErrors: fresh.length - DIGEST_ENTRIES } : {},
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('Godot tools run only inside a Session.')
  return exec.agent
}

/**
 * The arguments that save a tool's image as a PNG file: its path, whether it may overwrite one, and whether it goes in
 * the project.
 * @param wording - the tool family's words, for where the path may point.
 * @returns the argument properties.
 */
export function imageFileProperties(wording: GodotToolWording): {
  readonly path: { readonly type: 'string'; readonly description: string }
  readonly replace: { readonly type: 'boolean'; readonly description: string }
  readonly save: { readonly type: 'boolean'; readonly description: string }
} {
  return {
    path: { type: 'string', description: `Also save the image as a .png file at this path, ${wording.savePath}.` },
    replace: { type: 'boolean', description: 'Overwrite the file at path when it exists. Default: false.' },
    save: { type: 'boolean', description: SAVE_DESCRIPTION },
  } as const
}

/**
 * Input events as the game window takes them: pointer events in screenshot pixels, unless `coordinateSpace` is
 * `window`, map to the window through the running game's latest screenshot.
 * @param session - the Session, with its latest screenshot.
 * @param run - the running game.
 * @param events - the events, if any.
 * @param coordinateSpace - the tool's `coordinate_space` argument.
 * @returns the events in window pixels.
 * @throws {Error} when pointer events are in screenshot pixels and the game has no screenshot yet.
 */
export function windowEvents(session: GodotSession, run: GodotRun, events: GodotInputEvent[], coordinateSpace: unknown): GodotInputEvent[]

/**
 * Input events in the game window's pixels, or none when the call sends none.
 * @param session - the calling Session's Godot state.
 * @param run - the running game.
 * @param events - the call's events, if any.
 * @param coordinateSpace - the tool's `coordinate_space` argument.
 * @returns the events in window pixels, or undefined.
 */
export function windowEvents(
  session: GodotSession, run: GodotRun, events: GodotInputEvent[] | undefined, coordinateSpace: unknown,
): GodotInputEvent[] | undefined

export function windowEvents(
  session: GodotSession, run: GodotRun, events: GodotInputEvent[] | undefined, coordinateSpace: unknown,
): GodotInputEvent[] | undefined {
  if (events === undefined || coordinateSpace === 'window' || !hasPointerEvents(events)) return events
  const frame = session.screenshot
  if (frame === undefined || frame.runId !== run.id) {
    throw new Error('Mouse coordinates are screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
  }
  return screenshotToWindow(events, frame)
}

/**
 * The Session's game, when it runs and takes requests.
 * @param session - the calling Session's Godot state.
 * @returns the running game.
 * @throws {Error} that tells the model to start the game, or to wait while it starts or stops.
 */
export function requireRunning(session: GodotSession): GodotRun {
  const run = session.run
  if (run === undefined) throw new Error('No game is running in this Session; call godot_run first.')
  if (run.terminal) {
    const view = run.view()
    throw new Error(`The game is not running (${view.phase}); call godot_run to start it again.${view.message === undefined ? '' : `\n${view.message}`}`)
  }
  if (!run.connected) throw new Error('The game is starting or stopping; call godot_run to wait for it.')
  return run
}

/**
 * Run a tool body against the calling Session and add its new-error report. A failure's message carries the
 * report too.
 * @param host - plugin operations the tools call.
 * @param exec - the tool call.
 * @param body - the work of the call, given the calling Agent and its Session's Godot state.
 * @returns the body's value with the report.
 */
export async function invoke<T extends object>(
  host: GodotToolHost,
  exec: ToolRunContext,
  body: (agent: Agent, session: GodotSession) => T | Promise<T>,
): Promise<T & Digest> {
  const agent = requireAgent(exec)
  const session = host.sessions.session(agent)
  let value: T
  try {
    value = await body(agent, session)
  } catch (error) {
    const report = formatDigest(takeDigest(session))
    if (report === '') throw error
    throw new Error(`${(error as Error).message}\n\n${report}`, { cause: error })
  }
  return { ...value, ...takeDigest(session) }
}

/** The schema of one input event of `godot_input` and the tools that send input. */
export const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['key', 'text', 'mouse_button', 'mouse_motion', 'action', 'joy_button', 'joy_axis'], description: 'Event kind; omit it for a wait.' },
    wait: { type: 'number', description: 'Seconds to wait before the next event; use alone.' },
    key: { type: 'string', description: 'key: Godot key name such as W, Space, Left, Enter, Escape, Shift.' },
    keycode: { type: 'integer', description: 'key: Godot keycode, instead of key.' },
    pressed: { type: 'boolean', description: 'key, mouse_button, action, joy_button: true presses, false releases.' },
    hold: { type: 'number', description: 'key, mouse_button, action: seconds until an automatic release.' },
    echo: { type: 'boolean' },
    unicode: { type: 'integer' },
    text: { type: 'string', description: 'text: characters to type.' },
    button: { type: 'string', enum: ['left', 'right', 'middle', 'wheel_up', 'wheel_down', 'wheel_left', 'wheel_right'] },
    x: { type: 'number', description: 'mouse_button, mouse_motion: horizontal position.' },
    y: { type: 'number', description: 'mouse_button, mouse_motion: vertical position.' },
    dx: { type: 'number', description: 'mouse_motion: relative motion.' },
    dy: { type: 'number' },
    double: { type: 'boolean', description: 'mouse_button: double click.' },
    factor: { type: 'number' },
    action: { type: 'string', description: 'action: input map action such as ui_accept or ui_left.' },
    strength: { type: 'number', description: 'action: 0 to 1.' },
    device: { type: 'integer', description: 'joy_button, joy_axis: joypad index.' },
    axis: { type: 'integer' },
    value: { type: 'number', description: 'joy_axis: -1 to 1.' },
    shift: { type: 'boolean' },
    ctrl: { type: 'boolean' },
    alt: { type: 'boolean' },
    meta: { type: 'boolean' },
  },
} as const

/**
 * The window region a `godot_screenshot` call names, in window pixels.
 * @param region - the rectangle as the call gives it.
 * @param space - the rectangle's unit.
 * @param session - the calling Session's state, whose latest screenshot screenshot pixels refer to.
 * @param run - the running game.
 * @param maxWidth - the call's largest image width, which a small region grows toward at most.
 * @returns the region with the width a small region grows toward.
 * @throws when the rectangle is empty, or in screenshot pixels while this game has no screenshot.
 */
export function windowRegion(
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  space: 'screenshot' | 'window',
  session: GodotSession,
  run: GodotRun,
  maxWidth: number,
): ScreenshotRegion {
  if (region.width < 1 || region.height < 1) throw new Error('region width and height must be at least 1.')
  const minWidth = Math.min(REGION_MIN_WIDTH, maxWidth)
  if (space === 'window') return { x: region.x, y: region.y, width: region.width, height: region.height, minWidth }
  const frame = session.screenshot
  if (frame === undefined || frame.runId !== run.id) {
    throw new Error('region is in screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
  }
  const scaleX = (frame.regionWidth ?? frame.windowWidth) / frame.width
  const scaleY = (frame.regionHeight ?? frame.windowHeight) / frame.height
  return {
    x: (frame.x ?? 0) + Math.floor(region.x * scaleX),
    y: (frame.y ?? 0) + Math.floor(region.y * scaleY),
    width: Math.max(1, Math.ceil(region.width * scaleX)),
    height: Math.max(1, Math.ceil(region.height * scaleY)),
    minWidth,
  }
}

/**
 * An integer argument within its bounds.
 * @param value - the argument, or undefined when the call leaves it out.
 * @param name - the argument's name, for the refusal.
 * @param fallback - the value when the call leaves it out.
 * @param min - the smallest value.
 * @param max - the largest value.
 * @returns the argument or the fallback.
 * @throws {Error} when the argument lies outside the bounds.
 */
export function boundedInteger(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (value < min || value > max) throw new Error(`${name} must be from ${min} to ${max}.`)
  return value
}
