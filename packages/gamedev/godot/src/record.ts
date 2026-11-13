/**
 * Recordings of a running game for other Host plugins, such as WASD Engine Plugins, which turn them into animated
 * previews: screenshots at a steady interval for a number of real seconds, while an optional input sequence plays,
 * and one larger still at a chosen moment. Each frame is a screenshot request, so a recording needs no frame stream
 * and leaves the Game tab's stream as it is.
 * @module @deepseek-ai/dsh-godot/src/record
 */
import { delay } from './abort.ts'
import { GodotInputError } from './input.ts'
import type { GodotInputEvent } from './types.ts'

/** Longest recording, in seconds. */
export const MAX_RECORD_SECONDS = 30

/** What a recording captures; the plugin validates it, including `events`, which the model writes. */
export interface GodotRecordRequest {
  /**
   * Game project folder, absolute or relative to the Session's working directory; undefined for the nearest project.
   * The recording starts this project's game when the Session runs no game, or a game of another project.
   */
  readonly project?: string
  /** Real seconds to record, from 0.5 to {@link MAX_RECORD_SECONDS}. */
  readonly seconds: number
  /** Milliseconds from the start of one frame's capture to the next, from 10 to 1000. */
  readonly frameMs: number
  /** Largest width in pixels of the frames, from 64 to 4096; smaller windows keep their size. */
  readonly maxWidth: number
  /** Largest width in pixels of the still, from 64 to 4096. */
  readonly stillWidth: number
  /** Seconds into the recording at which the still is captured, from 0 to `seconds`. */
  readonly stillAt: number
  /** Real seconds that a game the recording starts runs before the recording begins, from 0 to 60. */
  readonly startSeconds: number
  /** Stop the game afterwards when the recording started it. */
  readonly stopStarted: boolean
  /**
   * Input events the game receives from the recording's start, as the `godot_input` tool takes them; pointer
   * coordinates are pixels of the Session's latest screenshot unless `coordinateSpace` is `window`. The events still
   * running when the recording ends are cancelled, and the game releases what they held.
   */
  readonly events?: readonly unknown[]
  /** Unit of the events' pointer coordinates. Default: `screenshot`. */
  readonly coordinateSpace?: 'screenshot' | 'window'
}

/**
 * Check the numbers of a recording request against their ranges.
 * @param request - the request.
 * @throws {GodotInputError} for a number outside its range.
 */
export function checkRecordRequest(request: GodotRecordRequest): void {
  const within = (name: string, value: number, min: number, max: number): void => {
    if (!Number.isFinite(value) || value < min || value > max) throw new GodotInputError(`${name} must be from ${min} to ${max}.`)
  }
  within('seconds', request.seconds, 0.5, MAX_RECORD_SECONDS)
  within('frameMs', request.frameMs, 10, 1000)
  within('maxWidth', request.maxWidth, 64, 4096)
  within('stillWidth', request.stillWidth, 64, 4096)
  within('stillAt', request.stillAt, 0, request.seconds)
  within('startSeconds', request.startSeconds, 0, 60)
}

/** One captured image. */
export interface GodotRecordedImage {
  /** PNG bytes. */
  readonly png: Uint8Array
  /** Width in pixels. */
  readonly width: number
  /** Height in pixels. */
  readonly height: number
  /** Milliseconds from the recording's start to the end of the capture. */
  readonly atMs: number
}

/** A finished recording. */
export interface GodotRecording {
  /** The frames in order; at least one. */
  readonly frames: readonly GodotRecordedImage[]
  /** The still. */
  readonly still: GodotRecordedImage
  /** Game window width in pixels. */
  readonly windowWidth: number
  /** Game window height in pixels. */
  readonly windowHeight: number
  /** Whether the recording started the game, because the Session ran none or a game of another project. */
  readonly started: boolean
  /** Whether the game was paused in every frame, so the frames show no motion. */
  readonly paused: boolean
}

/** A screenshot as the run returns it. */
export interface RecordedScreenshot {
  /** Metadata of the image. */
  readonly meta: {
    readonly width: number
    readonly height: number
    readonly windowWidth: number
    readonly windowHeight: number
    readonly paused: boolean
  }
  /** PNG bytes. */
  readonly png: Uint8Array
}

/** What a recording uses of a run. */
export interface RecordableRun {
  /**
   * Capture the game window.
   * @param maxWidth - largest image width.
   * @param signal - cancellation.
   * @returns the image.
   */
  screenshot(maxWidth: number, signal: AbortSignal): Promise<RecordedScreenshot>
  /**
   * Play an input sequence.
   * @param events - events in window pixels.
   * @param signal - cancellation; the game drops the sequence and releases what it held.
   * @returns once the sequence ended.
   */
  input(events: readonly GodotInputEvent[], signal: AbortSignal): Promise<unknown>
  /**
   * Count a view of the run, which keeps a windowless game at its own frame rate.
   * @returns the release.
   */
  show(): () => void
}

/** The time a recording keeps: a millisecond clock and a wait on it. */
export interface RecordingClock {
  /** @returns milliseconds since an arbitrary start. */
  now(): number
  /**
   * Wait on the clock.
   * @param milliseconds - the wait.
   * @param signal - cancellation; the wait rejects with its reason.
   */
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
}

/** Real time. */
const REAL_TIME: RecordingClock = { now: () => performance.now(), sleep: delay }

/** How {@link captureRecording} captures. */
export interface CapturePlan {
  /** Real milliseconds to record. */
  readonly durationMs: number
  /** Milliseconds between frame captures. */
  readonly frameMs: number
  /** Largest frame width. */
  readonly maxWidth: number
  /** Largest still width. */
  readonly stillWidth: number
  /** Milliseconds into the recording at which the still is captured. */
  readonly stillAtMs: number
  /** Input played from the start, in window pixels. */
  readonly events?: readonly GodotInputEvent[]
}

/**
 * Capture frames of a running game for a duration, with an input sequence playing from the start. A capture that ends
 * after the next interval boundary has passed is followed at once by the latest boundary's capture, and the
 * boundaries in between are skipped, so the frames keep real time; their `atMs` say when each was taken. The still is
 * the frame of the first boundary at or after `stillAtMs` when its width suffices, else a capture of its own right
 * after that frame; without such a boundary it is the last frame or a capture after it.
 * @param run - the running game.
 * @param plan - duration, interval, sizes, still, and input.
 * @param signal - cancellation; it also cancels the input.
 * @param clock - the time the recording keeps; real time unless given.
 * @returns the frames, the still, the window size, and whether every frame showed the game paused.
 * @throws the input sequence's failure, other than the cancellation that ends it with the recording.
 */
export async function captureRecording(
  run: RecordableRun,
  plan: CapturePlan,
  signal: AbortSignal,
  clock: RecordingClock = REAL_TIME,
): Promise<Omit<GodotRecording, 'started'>> {
  const now = (): number => clock.now()
  const release = run.show()
  const input = new AbortController()
  const cancelInput = (): void => { input.abort(signal.reason) }
  signal.addEventListener('abort', cancelInput, { once: true })
  let failure: { readonly error: unknown } | undefined
  let played: Promise<void> = Promise.resolve()
  try {
    const frames: GodotRecordedImage[] = []
    let still: GodotRecordedImage | undefined
    let window = { width: 0, height: 0 }
    let paused = true
    const start = now()
    if (plan.events !== undefined && plan.events.length > 0) {
      played = run.input(plan.events, input.signal).then(() => {}, (error: unknown) => {
        // The recording cancels the input it outlasts; any other failure ends the recording.
        if (!input.signal.aborted) failure = { error }
      })
    }
    for (let slot = 0; slot * plan.frameMs < plan.durationMs; slot += 1) {
      const wait = start + slot * plan.frameMs - now()
      if (wait > 0) await clock.sleep(wait, signal)
      const shot = await run.screenshot(plan.maxWidth, signal)
      const frame = { png: shot.png, width: shot.meta.width, height: shot.meta.height, atMs: now() - start }
      frames.push(frame)
      window = { width: shot.meta.windowWidth, height: shot.meta.windowHeight }
      paused &&= shot.meta.paused
      if (still === undefined && slot * plan.frameMs >= plan.stillAtMs) {
        still = plan.stillWidth <= plan.maxWidth ? frame : await captureStill(run, plan.stillWidth, start, now, signal)
      }
      if (failure !== undefined) throw failure.error
      slot = Math.max(slot, Math.floor((now() - start) / plan.frameMs) - 1)
    }
    // The loop captured at least the first boundary's frame.
    const last = frames[frames.length - 1] as GodotRecordedImage
    still ??= plan.stillWidth <= plan.maxWidth ? last : await captureStill(run, plan.stillWidth, start, now, signal)
    return { frames, still, windowWidth: window.width, windowHeight: window.height, paused }
  } finally {
    signal.removeEventListener('abort', cancelInput)
    input.abort(new Error('The recording ended.'))
    await played
    release()
  }
}

async function captureStill(
  run: RecordableRun, width: number, start: number, now: () => number, signal: AbortSignal,
): Promise<GodotRecordedImage> {
  const shot = await run.screenshot(width, signal)
  return { png: shot.png, width: shot.meta.width, height: shot.meta.height, atMs: now() - start }
}
