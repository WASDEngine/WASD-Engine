/** Recordings on the Host: the frame stream a window reads, its upload, the saved video, and the failures on the way. */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessRecordFrame } from '../src/protocol.ts'
import type { GodotRun, RecordingParams, RecordingSink, RecordStopReply } from '../src/run.ts'
import type { GodotVideoEncodeRequest, GodotVideoEncodeResult } from '../src/types.ts'
import { GodotVideoError, GodotVideoRecorder, RECORD_HEADER_BYTES, RECORDINGS_GITIGNORE, videoPath, type VideoContext } from '../src/video.ts'

const LIMITS = { quality: 0.9, bufferBytes: 1024 * 1024, maxBytes: 1024, windowTimeoutMs: 2000 }

function frame(index: number, timeMs: number, bytes = 4): HarnessRecordFrame {
  return { recording: 1, index, timeMs, width: 64, height: 36, image: Buffer.alloc(bytes, index) }
}

/**
 * A running game of the project in `root/game` whose recording sends `before` at its start and `after` when it stops,
 * and which counts the holds on reading its connection.
 */
function fakeRun(before: readonly HarnessRecordFrame[], after: readonly HarnessRecordFrame[] = []) {
  const calls: string[] = []
  const started: RecordingParams[] = []
  const reading = { holds: 0, releases: 0 }
  let sink: RecordingSink | undefined
  let shown = 0
  const run = {
    id: 'run-1',
    project: { dir: join(root, 'game') },
    view: () => ({ launch: {} }),
    show() {
      shown += 1
      return () => { shown -= 1 }
    },
    holdReading() {
      reading.holds += 1
      return () => { reading.releases += 1 }
    },
    async startRecording(_id: number, params: RecordingParams, receiver: RecordingSink) {
      calls.push('start')
      started.push(params)
      sink = receiver
      for (const item of before) receiver.frame(item)
    },
    async stopRecording(_id: number, _signal: AbortSignal, wait = false): Promise<RecordStopReply> {
      calls.push(wait ? 'stop at the end' : 'stop')
      for (const item of after) sink?.frame(item)
      return { recording: 1, frames: before.length + after.length, skipped: 2, seconds: 0.1, width: 64, height: 36 }
    },
    async input() {
      calls.push('input')
      return { events: 1, frames: 1, seconds: 0, frame: 1, timedOut: false, cancelled: false }
    },
  }
  // The recorder uses only these members of a run.
  const typed: GodotRun = run as never
  return { run: typed, calls, started, reading, shown: () => shown }
}

/** A window that reads every frame, uploads `video`, and answers. */
function window(recorder: GodotVideoRecorder, video: Buffer | undefined, read: Buffer[] = []) {
  const requests: GodotVideoEncodeRequest[] = []
  const encode = async (request: GodotVideoEncodeRequest): Promise<GodotVideoEncodeResult> => {
    requests.push(request)
    const url = `http://127.0.0.1/api/godot.recording?session=${request.sessionId}&run=${request.runId}&recording=${request.recording}`
    const response = recorder.serve(new Request(url))
    read.push(Buffer.from(await response.arrayBuffer()))
    if (video !== undefined) expect((await recorder.receive(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new Uint8Array(video) }))).status).toBe(204)
    return { codec: 'H.264', frames: 3, seconds: 0.1, width: 64, height: 36, bytes: video?.length ?? 0, sheet: { data: 'AAAA', width: 2, height: 2, times: [0, 0.1] } }
  }
  return { encode, requests, read }
}

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-godot-video-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function context(run: GodotRun, encode: VideoContext['encode'], path = join(root, 'game', 'recordings', 'clip.mp4'), extra: Partial<VideoContext> = {}): VideoContext {
  return { sessionId: 's1', run, path, replace: false, encode, ...extra }
}

const REQUEST = { seconds: 0.05, fps: 20, maxWidth: 1280, sheetFrames: 2, replace: false }

describe('GodotVideoRecorder', () => {
  it('streams the frames to the window that reads them in order, and saves its upload in the recordings folder', async () => {
    const recorder = new GodotVideoRecorder(LIMITS)
    const game = fakeRun([frame(0, 0), frame(1, 50)], [frame(2, 100, 6)])
    const read: Buffer[] = []
    const screen = window(recorder, Buffer.from('mp4 bytes'), read)
    const video = await recorder.record(context(game.run, screen.encode), { ...REQUEST, events: [{ kind: 'key', key: 'W', pressed: true }] }, new AbortController().signal)
    expect(video).toMatchObject({ path: join(root, 'game', 'recordings', 'clip.mp4'), bytes: 9, codec: 'H.264', frames: 3, skipped: 2, fps: 20, fixedFps: false })
    expect(video.sheet?.times).toEqual([0, 0.1])
    expect(await readFile(video.path, 'utf8')).toBe('mp4 bytes')
    // The project's recordings folder keeps its videos from Godot's import and from git.
    expect(existsSync(join(root, 'game', 'recordings', '.gdignore'))).toBe(true)
    expect(await readFile(join(root, 'game', 'recordings', '.gitignore'), 'utf8')).toBe(RECORDINGS_GITIGNORE)
    expect(game.reading).toEqual({ holds: 0, releases: 0 })
    expect(game.calls).toEqual(['start', 'input', 'stop'])
    expect(game.started).toEqual([{ fps: 20, maxWidth: 1280, quality: 0.9, frameStep: 0, frameMs: 0, frames: 0, seconds: 5.05 }])
    expect(screen.requests).toEqual([{ sessionId: 's1', runId: 'run-1', recording: 1, fps: 20, sheetFrames: 2, maxBytes: 1024 }])
    const stream = read[0] as Buffer
    const records: number[][] = []
    for (let offset = 0; offset < stream.length; offset += RECORD_HEADER_BYTES + stream.readUInt32LE(offset)) {
      const header = [stream.readUInt32LE(offset + 4), stream.readUInt32LE(offset + 8)]
      header.push(stream.readUInt16LE(offset + 12), stream.readUInt16LE(offset + 14))
      records.push([...header, stream.readUInt32LE(offset)])
    }
    expect(records).toEqual([[0, 0, 64, 36, 4], [1, 50, 64, 36, 4], [2, 100, 64, 36, 6]])
    expect(game.shown()).toBe(0)
  })

  it('captures every few game frames of a run with a fixed frame rate', async () => {
    const recorder = new GodotVideoRecorder(LIMITS)
    const game = fakeRun([frame(0, 0)])
    const screen = window(recorder, Buffer.from('x'))
    const video = await recorder.record(context(game.run, screen.encode, join(root, 'fixed.mp4'), { fixedFps: 120 }), { ...REQUEST, fps: 30 }, new AbortController().signal)
    // The game runs as fast as it draws, so the recording counts 0.05 s of video at 30 fps in frames and lets the game reach them.
    expect(game.started[0]).toMatchObject({ frameStep: 4, frameMs: 1000 / 120, frames: 2, seconds: 3600 })
    expect(game.calls).toEqual(['start', 'stop at the end'])
    expect(screen.requests[0]?.fps).toBe(30)
    expect(video).toMatchObject({ fps: 30, fixedFps: true })
    expect(existsSync(join(root, '.gdignore'))).toBe(false)
  })

  it('marks only the project\'s own recordings folder, and leaves files that it already holds', async () => {
    const recorder = new GodotVideoRecorder(LIMITS)
    // Another folder named recordings, such as one of the game's sounds, keeps its assets visible to Godot.
    const sounds = join(root, 'game', 'audio', 'recordings', 'clip.mp4')
    await recorder.record(context(fakeRun([frame(0, 0)]).run, window(recorder, Buffer.from('x')).encode, sounds), REQUEST, new AbortController().signal)
    expect(existsSync(join(root, 'game', 'audio', 'recordings', '.gdignore'))).toBe(false)
    expect(existsSync(join(root, 'game', 'audio', 'recordings', '.gitignore'))).toBe(false)
    const own = join(root, 'game', 'recordings')
    await mkdir(own, { recursive: true })
    await writeFile(join(own, '.gitignore'), '*\n')
    await recorder.record(context(fakeRun([frame(0, 0)]).run, window(recorder, Buffer.from('x')).encode, join(own, 'clip.mp4')), REQUEST, new AbortController().signal)
    expect(await readFile(join(own, '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(join(own, '.gdignore'))).toBe(true)
  })

  it('stops reading the game while the window has not read half the buffer, and reads again once it caught up', async () => {
    const recorder = new GodotVideoRecorder({ ...LIMITS, bufferBytes: 64 })
    const frames = Array.from({ length: 6 }, (_unused, index) => frame(index, index * 50, 10))
    const game = fakeRun(frames)
    const read: Buffer[] = []
    await recorder.record(context(game.run, window(recorder, Buffer.from('x'), read).encode), REQUEST, new AbortController().signal)
    // The fourth frame brought 40 bytes, past the 32 at which the Host stops reading; the window read them down to 16.
    expect(game.reading).toEqual({ holds: 1, releases: 1 })
    const stream = read[0] as Buffer
    expect(stream.length).toBe(6 * (RECORD_HEADER_BYTES + 10))
  })

  it('stops the recording when the window reads no frame while the Host stopped reading the game', async () => {
    const recorder = new GodotVideoRecorder({ ...LIMITS, bufferBytes: 64, windowTimeoutMs: 1000 })
    const game = fakeRun(Array.from({ length: 4 }, (_unused, index) => frame(index, index * 50, 10)))
    // The window opens the stream but reads nothing.
    const stalled = async (request: GodotVideoEncodeRequest): Promise<GodotVideoEncodeResult> => {
      recorder.serve(new Request(`http://127.0.0.1/api/godot.recording?session=s1&run=run-1&recording=${request.recording}`))
      return await new Promise(() => {})
    }
    await expect(recorder.record(context(game.run, stalled), { ...REQUEST, seconds: 5 }, new AbortController().signal))
      .rejects.toThrow(new GodotVideoError('The WASD Engine window read no frame of the recording for 1 s, so the recording stopped.'))
    expect(game.reading).toEqual({ holds: 1, releases: 1 })
    expect(game.calls).toEqual(['start', 'stop'])
  })

  it('fails before the game records when no window reads the frames in time', async () => {
    const recorder = new GodotVideoRecorder({ ...LIMITS, windowTimeoutMs: 20 })
    const game = fakeRun([])
    const never = (): Promise<GodotVideoEncodeResult> => new Promise(() => {})
    await expect(recorder.record(context(game.run, never), REQUEST, new AbortController().signal)).rejects.toThrow(
      new GodotVideoError('No WASD Engine window started encoding the recording; godot_record needs the WASD Engine window open.'),
    )
    expect(game.calls).toEqual([])
    expect(game.shown()).toBe(0)
  })

  it('fails with the window\'s error, and when the window answers without an upload', async () => {
    const refused = fakeRun([])
    const failing = async (): Promise<GodotVideoEncodeResult> => { throw new Error('This WASD Engine window has no H.264 or VP9 video encoder.') }
    await expect(new GodotVideoRecorder(LIMITS).record(context(refused.run, failing), REQUEST, new AbortController().signal))
      .rejects.toThrow('This WASD Engine window has no H.264 or VP9 video encoder.')
    const recorder = new GodotVideoRecorder(LIMITS)
    const game = fakeRun([frame(0, 0)])
    await expect(recorder.record(context(game.run, window(recorder, undefined).encode), REQUEST, new AbortController().signal))
      .rejects.toThrow(new GodotVideoError('The WASD Engine window answered without uploading the video.'))
    expect(game.calls).toEqual(['start', 'stop'])
  })

  it('stops the recording when the window falls behind, and saves nothing', async () => {
    const recorder = new GodotVideoRecorder({ ...LIMITS, bufferBytes: 6 })
    const game = fakeRun([frame(0, 0), frame(1, 50), frame(2, 100)])
    // The window opens the stream but does not read it until the recording failed.
    const slow = async (request: GodotVideoEncodeRequest): Promise<GodotVideoEncodeResult> => {
      recorder.serve(new Request(`http://127.0.0.1/api/godot.recording?session=s1&run=run-1&recording=${request.recording}`))
      return await new Promise(() => {})
    }
    await expect(recorder.record(context(game.run, slow), { ...REQUEST, seconds: 0.2 }, new AbortController().signal))
      .rejects.toThrow(/encodes the video more slowly than the game records it/u)
    expect(game.calls).toEqual(['start', 'stop'])
    expect(existsSync(join(root, 'game'))).toBe(false)
  })

  it('refuses an existing file unless the call replaces it', async () => {
    const path = join(root, 'clip.mp4')
    await writeFile(path, 'old')
    const recorder = new GodotVideoRecorder(LIMITS)
    await expect(recorder.record(context(fakeRun([]).run, window(recorder, Buffer.from('new')).encode, path), REQUEST, new AbortController().signal))
      .rejects.toThrow(new GodotVideoError(`${path} exists; pass replace: true to replace it, or another path.`))
    await recorder.record(context(fakeRun([frame(0, 0)]).run, window(recorder, Buffer.from('new')).encode, path, { replace: true }), REQUEST, new AbortController().signal)
    expect(await readFile(path, 'utf8')).toBe('new')
  })

  it('answers missing parameters, unknown recordings, a second reader, and a large upload with their statuses', async () => {
    const recorder = new GodotVideoRecorder({ ...LIMITS, maxBytes: 4 })
    expect(recorder.serve(new Request('http://127.0.0.1/api/godot.recording?session=s1')).status).toBe(400)
    expect(recorder.serve(new Request('http://127.0.0.1/api/godot.recording?session=s1&run=run-1&recording=9')).status).toBe(404)
    const statuses: number[] = []
    const greedy = async (request: GodotVideoEncodeRequest): Promise<GodotVideoEncodeResult> => {
      const url = `http://127.0.0.1/api/godot.recording?session=s1&run=run-1&recording=${request.recording}`
      const first = recorder.serve(new Request(url))
      statuses.push(recorder.serve(new Request(url)).status)
      await first.arrayBuffer()
      statuses.push((await recorder.receive(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new TextEncoder().encode('too large') }))).status)
      statuses.push((await recorder.receive(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new TextEncoder().encode('x') }))).status)
      return { codec: 'H.264', frames: 1, seconds: 0.05, width: 64, height: 36, bytes: 1 }
    }
    await expect(recorder.record(context(fakeRun([frame(0, 0)]).run, greedy), REQUEST, new AbortController().signal)).rejects.toThrow('answered without uploading')
    expect(statuses).toEqual([409, 413, 409])
  })
})

describe('videoPath', () => {
  const project = { dir: '/work/game', name: 'My Game!' }

  it('names a new file in the project\'s recordings folder after the project and the time', () => {
    expect(videoPath(undefined, '/work', project, new Date(2026, 10, 14, 9, 5, 3, 250))).toBe('/work/game/recordings/My-Game_2026-11-14_09-05-03.mp4')
    expect(videoPath(undefined, '/work', { dir: '/work/game' }, new Date(2026, 10, 14, 9, 5, 3, 250))).toBe('/work/game/recordings/game_2026-11-14_09-05-03.mp4')
  })

  it('takes an .mp4 path inside the working directory or the project folder', () => {
    expect(videoPath('films/intro.mp4', '/work', project, new Date())).toBe('/work/films/intro.mp4')
    expect(videoPath('/work/game/clip.MP4', '/elsewhere', project, new Date())).toBe('/work/game/clip.MP4')
    expect(() => videoPath('clip.mov', '/work', project, new Date())).toThrow(new GodotVideoError('path must name an .mp4 file, got "clip.mov".'))
    expect(() => videoPath('../outside.mp4', '/work', project, new Date())).toThrow(new GodotVideoError('path must lie inside the working directory or the project folder, got "../outside.mp4".'))
  })
})
