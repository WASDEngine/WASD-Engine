/** Recordings capture a running game's frames on a steady clock while input plays, with one still. */
import { describe, expect, it } from 'vitest'
import { captureRecording, checkRecordRequest, type GodotRecordRequest, type RecordableRun, type RecordedScreenshot, type RecordingClock } from '../src/record.ts'
import type { GodotInputEvent } from '../src/types.ts'

const signal = new AbortController().signal

/** A clock whose waits pass at once and whose screenshots take no time unless the run says so. */
function fakeClock(): RecordingClock & { now(): number; time: number } {
  return {
    time: 0,
    now() { return this.time },
    sleep(milliseconds, sleepSignal) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The fake keeps the caller's cancellation reason.
      if (sleepSignal.aborted) return Promise.reject(sleepSignal.reason)
      this.time += milliseconds
      return Promise.resolve()
    },
  }
}

/** A fake run whose screenshots take `captureMs` of the fake clock. */
function fakeRun(options: { readonly captureMs?: number; readonly paused?: boolean; readonly clock?: { time: number } } = {}) {
  const shots: number[] = []
  const inputs: { events: readonly GodotInputEvent[]; signal: AbortSignal }[] = []
  let views = 0
  type Input = (events: readonly GodotInputEvent[], signal: AbortSignal) => Promise<unknown>
  let input: Input = (_events, inputSignal) => new Promise((_resolve, reject) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The fake keeps the caller's cancellation reason.
    inputSignal.addEventListener('abort', () => { reject(inputSignal.reason) }, { once: true })
  })
  const run: RecordableRun = {
    screenshot(maxWidth): Promise<RecordedScreenshot> {
      shots.push(maxWidth)
      if (options.clock !== undefined) options.clock.time += options.captureMs ?? 0
      const width = Math.min(640, maxWidth)
      return Promise.resolve({
        meta: { width, height: width * 9 / 16, windowWidth: 640, windowHeight: 360, paused: options.paused ?? false },
        png: new TextEncoder().encode(`frame-${shots.length}-${width}`),
      })
    },
    input(events, inputSignal) {
      inputs.push({ events, signal: inputSignal })
      return input(events, inputSignal)
    },
    show() {
      views += 1
      return () => { views -= 1 }
    },
  }
  return {
    run,
    shots,
    inputs,
    views: () => views,
    failInput(error: Error) {
      input = () => Promise.reject(error)
    },
  }
}

const request: GodotRecordRequest = {
  seconds: 4, frameMs: 80, maxWidth: 480, stillWidth: 1280, stillAt: 2, startSeconds: 1, stopStarted: false,
}

describe('captureRecording', () => {
  it('captures a frame on every interval boundary of the duration and reuses a frame wide enough as the still', async () => {
    const fake = fakeRun()
    const recording = await captureRecording(
      fake.run, { durationMs: 100, frameMs: 20, maxWidth: 320, stillWidth: 320, stillAtMs: 40 },
      signal, fakeClock(),
    )
    expect(recording.frames.map(frame => frame.atMs)).toEqual([0, 20, 40, 60, 80])
    expect(fake.shots).toEqual([320, 320, 320, 320, 320])
    expect(recording.still).toBe(recording.frames[2])
    expect(recording).toMatchObject({ windowWidth: 640, windowHeight: 360, paused: false })
    expect(fake.views()).toBe(0)
  })

  it('records in real time without a clock of its own', async () => {
    const recording = await captureRecording(
      fakeRun().run, { durationMs: 60, frameMs: 20, maxWidth: 320, stillWidth: 320, stillAtMs: 0 },
      signal,
    )
    expect(recording.frames.length).toBeGreaterThanOrEqual(1)
    expect(recording.frames.at(-1)?.atMs).toBeLessThan(1000)
  })

  it('captures a wider still of its own after the frame at its moment, or after the last frame', async () => {
    const fake = fakeRun()
    const recording = await captureRecording(
      fake.run, { durationMs: 60, frameMs: 20, maxWidth: 320, stillWidth: 1280, stillAtMs: 20 },
      signal, fakeClock(),
    )
    expect(fake.shots).toEqual([320, 320, 1280, 320])
    expect(recording.still.width).toBe(640)
    const late = fakeRun()
    await captureRecording(
      late.run, { durationMs: 40, frameMs: 20, maxWidth: 320, stillWidth: 1280, stillAtMs: 40 }, signal, fakeClock(),
    )
    expect(late.shots).toEqual([320, 320, 1280])
  })

  it('follows a capture that overran the next boundaries with the latest one at once, keeping real time', async () => {
    const clock = fakeClock()
    const fake = fakeRun({ captureMs: 25, clock })
    const recording = await captureRecording(
      fake.run, { durationMs: 100, frameMs: 10, maxWidth: 320, stillWidth: 320, stillAtMs: 0 },
      signal, clock,
    )
    expect(recording.frames.map(frame => frame.atMs)).toEqual([25, 50, 75, 100])
  })

  it('plays the input from the start and cancels what still runs when the recording ends', async () => {
    const fake = fakeRun()
    const events: GodotInputEvent[] = [{ kind: 'key', key: 'Right', pressed: true, hold: 5 }]
    await captureRecording(
      fake.run, { durationMs: 40, frameMs: 20, maxWidth: 320, stillWidth: 320, stillAtMs: 0, events },
      signal, fakeClock(),
    )
    expect(fake.inputs).toHaveLength(1)
    expect(fake.inputs[0]?.events).toBe(events)
    expect(fake.inputs[0]?.signal.aborted).toBe(true)
  })

  it('fails when the input fails, and reports a game paused in every frame', async () => {
    const fake = fakeRun()
    fake.failInput(new Error('unknown key BadKey'))
    await expect(captureRecording(fake.run, {
      durationMs: 200, frameMs: 20, maxWidth: 320, stillWidth: 320, stillAtMs: 0, events: [{ kind: 'key', key: 'BadKey', pressed: true }],
    }, signal, fakeClock())).rejects.toThrow('unknown key BadKey')
    expect(fake.views()).toBe(0)
    const paused = await captureRecording(
      fakeRun({ paused: true }).run, { durationMs: 40, frameMs: 20, maxWidth: 320, stillWidth: 320, stillAtMs: 0 }, signal, fakeClock(),
    )
    expect(paused.paused).toBe(true)
  })

  it('stops at cancellation and cancels the input with it', async () => {
    const fake = fakeRun()
    const controller = new AbortController()
    const recording = captureRecording(fake.run, {
      durationMs: 10_000, frameMs: 1000, maxWidth: 320, stillWidth: 320, stillAtMs: 0, events: [{ kind: 'key', key: 'Up', pressed: true, hold: 9 }],
    }, controller.signal, fakeClock())
    controller.abort(new Error('stopped'))
    await expect(recording).rejects.toThrow('stopped')
    expect(fake.inputs[0]?.signal.aborted).toBe(true)
    expect(fake.views()).toBe(0)
  })
})

describe('checkRecordRequest', () => {
  it('accepts numbers within their ranges and names the first one outside', () => {
    expect(() => { checkRecordRequest(request) }).not.toThrow()
    expect(() => { checkRecordRequest({ ...request, seconds: 0.2 }) }).toThrow('seconds must be from 0.5 to 30.')
    expect(() => { checkRecordRequest({ ...request, frameMs: 5 }) }).toThrow('frameMs must be from 10 to 1000.')
    expect(() => { checkRecordRequest({ ...request, maxWidth: 32 }) }).toThrow('maxWidth must be from 64 to 4096.')
    expect(() => { checkRecordRequest({ ...request, stillWidth: 5000 }) }).toThrow('stillWidth must be from 64 to 4096.')
    expect(() => { checkRecordRequest({ ...request, stillAt: 5 }) }).toThrow('stillAt must be from 0 to 4.')
    expect(() => { checkRecordRequest({ ...request, startSeconds: Number.NaN }) }).toThrow('startSeconds must be from 0 to 60.')
  })
})
