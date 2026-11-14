/**
 * Recordings of the running game into a video, for `godot_record`. The harness captures JPEG frames, which the Host
 * queues for the WASD Engine window that encodes them: the window reads them from the
 * `GET /api/godot.recording?session=<SessionId>&run=<runId>&recording=<id>` stream while the game records, uploads the
 * encoded video with `POST /api/godot.video` and the same parameters, and then answers the forwarded `godot/record`
 * request; the Host moves the upload to the video's path.
 *
 * Each record of the frame stream is a u32 little-endian image length, u32 little-endian frame index, u32 little-endian
 * milliseconds into the video, u16 little-endian width, u16 little-endian height, then the bytes of a JPEG file. The
 * stream ends once the recording stopped and the window read every frame; frames never replace one another.
 * @module @deepseek-ai/dsh-godot/src/video
 */
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { delay } from './abort.ts'
import type { HarnessRecordFrame } from './protocol.ts'
import type { GodotRun, RecordingSink, RecordStopReply } from './run.ts'
import type { GodotVideo, GodotVideoRequest } from './tools.ts'
import type { GodotInputEvent, GodotVideoEncodeRequest, GodotVideoEncodeResult } from './types.ts'

/** Longest recording, in seconds. */
export const MAX_VIDEO_SECONDS = 120

/** Bytes before the image in one record of the frame stream. */
export const RECORD_HEADER_BYTES = 16

/** Real seconds after which the game ends a recording by game frames that has not reached its frames. */
const FRAME_RECORDING_SECONDS = 3600

/** Folder of a project that holds the videos saved without a path; a `.gdignore` file keeps Godot from importing them. */
export const RECORDINGS_FOLDER = 'recordings'

const COMMON_HEADERS = { 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' }

/** Longest base64 text of the frame sheet: 16 MiB of JPEG bytes. */
const MAX_SHEET_BASE64 = Math.ceil((16 * 1024 * 1024) / 3) * 4

const EncodeResult = z.strictObject({
  codec: z.enum(['H.264', 'VP9']),
  frames: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  width: z.number().int().nonnegative().max(16_384),
  height: z.number().int().nonnegative().max(16_384),
  bytes: z.number().int().nonnegative(),
  sheet: z.strictObject({
    data: z.string().min(1).max(MAX_SHEET_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    times: z.array(z.number().nonnegative()).max(24),
  }).optional(),
})

/** Limits and settings of recordings. */
export interface VideoLimits {
  /** JPEG quality of the captured frames, 0.1 to 1. */
  readonly quality: number
  /** Bytes of captured frames the Host keeps for a window that reads them more slowly than the game captures them. */
  readonly bufferBytes: number
  /** Largest video the window may upload, in bytes. */
  readonly maxBytes: number
  /**
   * Milliseconds a window has to start reading the frames, and to answer once the recording stopped beyond the time the
   * frames take to encode.
   */
  readonly windowTimeoutMs: number
}

/** What one recording needs besides its request. */
export interface VideoContext {
  /** The Session whose game records. */
  readonly sessionId: string
  /** The running game. */
  readonly run: GodotRun
  /** Absolute path the video is saved to. */
  readonly path: string
  /** Whether an existing file at `path` may be replaced. */
  readonly replace: boolean
  /** Godot's fixed frames per second, when the run started with `--fixed-fps`. */
  readonly fixedFps?: number
  /**
   * Ask a window to encode the recording.
   * @param request - the recording and its video settings.
   * @param signal - ends the request when the recording fails or is cancelled.
   * @returns the window's answer, after it uploaded the video.
   */
  encode(request: GodotVideoEncodeRequest, signal: AbortSignal): Promise<GodotVideoEncodeResult>
}

/** A recording failed; the message tells the agent why. */
export class GodotVideoError extends Error {
  override name = 'GodotVideoError'
}

/** One recording from its start until its video is saved or it failed. */
class Recording implements RecordingSink {
  private readonly queue: HarnessRecordFrame[] = []
  private queued = 0
  private ended = false
  private failure: Error | undefined
  private wake: (() => void) | undefined
  private readonly reading = Promise.withResolvers<void>()
  /** Whether a window opened the frame stream. */
  streaming = false
  /** The uploaded video: its temporary file and size, once the upload completed. */
  upload: { readonly file: string; readonly bytes: number } | undefined
  /** Whether an upload began. */
  uploading = false

  /**
   * @param id - the recording's id.
   * @param sessionId - the Session whose game records.
   * @param runId - the run that records.
   * @param folder - folder of the video's path, which also holds the upload until it moves there.
   * @param bufferBytes - bytes of frames kept for a window that reads them more slowly than the game captures them.
   * @param stopped - called once when the recording fails, to end the steps that wait for it.
   */
  constructor(
    readonly id: number,
    readonly sessionId: string,
    readonly runId: string,
    readonly folder: string,
    private readonly bufferBytes: number,
    private readonly stopped: () => void,
  ) {
    this.reading.promise.catch(() => {})
  }

  frame(frame: HarnessRecordFrame): void {
    if (this.ended || this.failure !== undefined) return
    this.queue.push(frame)
    this.queued += frame.image.length
    if (this.queued > this.bufferBytes) {
      this.fail(new GodotVideoError('The WASD Engine window encodes the video more slowly than the game records it, so the recording stopped; record fewer frames per second or a smaller max_width.'))
      return
    }
    this.notify()
  }

  /** Resolves once a window opened the frame stream; rejects when the recording failed first. */
  whenReading(): Promise<void> {
    return this.reading.promise
  }

  /** The window opened the frame stream. */
  read(): void {
    this.streaming = true
    this.reading.resolve()
  }

  /** The game captures no further frames; the stream ends after the queued ones. */
  end(): void {
    this.ended = true
    this.notify()
  }

  /** Stop the recording's stream with an error, which the next step of the recording reports. */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.reading.reject(error)
    this.notify()
    this.stopped()
  }

  /** The error that stopped the recording, if one did. */
  get failed(): Error | undefined {
    return this.failure
  }

  /**
   * The next frame of the stream.
   * @returns the frame, or undefined once the stream ended or failed.
   */
  async next(): Promise<HarnessRecordFrame | undefined> {
    while (this.queue.length === 0 && !this.ended && this.failure === undefined) {
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    if (this.failure !== undefined) return undefined
    const frame = this.queue.shift()
    if (frame !== undefined) this.queued -= frame.image.length
    return frame
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Encode one record of the frame stream.
 * @param frame - a frame of the recording.
 * @returns the record bytes.
 */
export function encodeRecordFrame(frame: HarnessRecordFrame): Uint8Array {
  const record = Buffer.allocUnsafe(RECORD_HEADER_BYTES + frame.image.length)
  record.writeUInt32LE(frame.image.length, 0)
  record.writeUInt32LE(frame.index, 4)
  record.writeUInt32LE(frame.timeMs, 8)
  record.writeUInt16LE(frame.width, 12)
  record.writeUInt16LE(frame.height, 14)
  frame.image.copy(record, RECORD_HEADER_BYTES)
  return record
}

function refusal(status: 400 | 404 | 409 | 413, text: string): Response {
  return new Response(text, { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } })
}

/**
 * The path a video is saved to: the call's path, relative to the working directory, inside the working directory or
 * the project folder; or a new file in the project's `recordings` folder.
 * @param requested - the call's path, or undefined.
 * @param workingDirectory - absolute Session working directory.
 * @param project - absolute project folder and its name.
 * @param now - the time that names a new file, in the computer's time zone.
 * @returns the absolute path.
 * @throws {GodotVideoError} for a path that does not end with `.mp4` or lies outside both folders.
 */
export function videoPath(
  requested: string | undefined, workingDirectory: string, project: { readonly dir: string; readonly name?: string }, now: Date,
): string {
  if (requested === undefined) {
    const two = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
    const stem = (project.name ?? basename(project.dir)).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'game'
    return join(project.dir, RECORDINGS_FOLDER, `${stem}_${stamp}.mp4`)
  }
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workingDirectory, requested)
  if (!path.toLowerCase().endsWith('.mp4')) throw new GodotVideoError(`path must name an .mp4 file, got ${JSON.stringify(requested)}.`)
  const inside = (folder: string): boolean => {
    const rest = relative(folder, path)
    return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
  }
  if (!inside(workingDirectory) && !inside(project.dir)) {
    throw new GodotVideoError(`path must lie inside the working directory or the project folder, got ${JSON.stringify(requested)}.`)
  }
  return path
}

/** The recordings in progress, their frame streams, and their uploads. */
export class GodotVideoRecorder {
  private serial = 0
  private readonly recordings = new Map<string, Recording>()

  /**
   * @param limits - quality, buffer, size, and time limits.
   */
  constructor(private readonly limits: VideoLimits) {}

  /**
   * Record the running game: a window starts reading the frames, the game records for `request.seconds` while the
   * events play, and the window's video is saved to the context's path.
   * @param context - the game, the path, and the window request.
   * @param request - duration, frame rate, size, events, and sheet.
   * @param signal - cancellation; it stops the recording and saves nothing.
   * @returns the saved video and its frame sheet.
   * @throws {GodotVideoError} when no window reads the frames in time, the window falls behind or fails, or the file
   * cannot be saved.
   */
  async record(context: VideoContext, request: GodotVideoRequest, signal: AbortSignal): Promise<GodotVideo> {
    const { run } = context
    if (!context.replace && await exists(context.path)) {
      throw new GodotVideoError(`${context.path} exists; pass replace: true to replace it, or another path.`)
    }
    this.serial += 1
    const id = this.serial
    const local = new AbortController()
    const recording = new Recording(id, context.sessionId, run.id, dirname(context.path), this.limits.bufferBytes, () => { local.abort() })
    const key = recordingKey(context.sessionId, run.id, id)
    this.recordings.set(key, recording)
    const linked = AbortSignal.any([signal, local.signal])
    const step = context.fixedFps === undefined ? 0 : Math.max(1, Math.round(context.fixedFps / request.fps))
    const fps = context.fixedFps === undefined ? request.fps : context.fixedFps / step
    // A recording uses the game the whole time, so a game nobody shows keeps its own frame rate.
    const hide = run.show()
    let started = false
    let input: Promise<Error | undefined> | undefined
    const inputStop = new AbortController()
    try {
      const encoded = context.encode({
        sessionId: context.sessionId as GodotVideoEncodeRequest['sessionId'],
        runId: run.id,
        recording: id,
        fps,
        sheetFrames: request.sheetFrames,
        maxBytes: this.limits.maxBytes,
      }, linked)
      encoded.catch((error: unknown) => { recording.fail(asError(error)) })
      await withTimeout(recording.whenReading(), this.limits.windowTimeoutMs, linked, () => new GodotVideoError('No WASD Engine window started encoding the recording; godot_record needs the WASD Engine window open.'))
      // A game with a fixed frame rate runs as fast as it draws rather than in real time, so its recording counts frames.
      const frames = step === 0 ? 0 : Math.max(1, Math.round(request.seconds * fps))
      await run.startRecording(id, {
        fps,
        maxWidth: request.maxWidth,
        quality: this.limits.quality,
        frameStep: step,
        frameMs: context.fixedFps === undefined ? 0 : 1000 / context.fixedFps,
        frames,
        seconds: step === 0 ? request.seconds + 5 : FRAME_RECORDING_SECONDS,
      }, recording, linked)
      started = true
      if (request.events !== undefined) {
        input = playEvents(run, request.events, AbortSignal.any([linked, inputStop.signal])).then(() => undefined, asError)
      }
      if (step === 0) await delay(request.seconds * 1000, linked)
      const stopped: RecordStopReply = await run.stopRecording(id, linked, step > 0)
      if (recording.failed !== undefined) throw recording.failed
      inputStop.abort()
      started = false
      recording.end()
      const result = EncodeResult.safeParse(await withTimeout(encoded, this.limits.windowTimeoutMs + request.seconds * 2000, linked, () => new GodotVideoError('The WASD Engine window did not finish encoding the video in time.')))
      if (!result.success) throw new GodotVideoError(`The WASD Engine window answered with malformed video facts: ${result.error.issues[0]?.message ?? 'unknown field'}.`)
      const upload = recording.upload
      if (upload === undefined) throw new GodotVideoError('The WASD Engine window answered without uploading the video.')
      await mkdir(dirname(context.path), { recursive: true })
      await markRecordingsFolder(context.path)
      await rename(upload.file, context.path)
      const video = result.data
      const inputError = await input
      return {
        path: context.path,
        bytes: upload.bytes,
        codec: video.codec,
        frames: video.frames,
        skipped: stopped.skipped,
        seconds: video.seconds,
        fps,
        width: video.width,
        height: video.height,
        fixedFps: context.fixedFps !== undefined,
        ...inputError === undefined ? {} : { inputError: inputError.message },
        ...video.sheet === undefined ? {} : { sheet: { data: Buffer.from(video.sheet.data, 'base64'), width: video.sheet.width, height: video.sheet.height, times: video.sheet.times } },
      }
    } catch (error) {
      signal.throwIfAborted()
      throw recording.failed ?? error
    } finally {
      inputStop.abort()
      local.abort()
      if (started) await run.stopRecording(id, new AbortController().signal).catch(() => {})
      recording.fail(new GodotVideoError('The recording ended.'))
      hide()
      this.recordings.delete(key)
      if (recording.upload !== undefined) await rm(recording.upload.file, { force: true })
      await input
    }
  }

  /**
   * Answer the window's `GET` of a recording's frames.
   * @param request - authenticated owner request.
   * @returns the frame stream, or 400, 404, or 409 for missing parameters, an unknown recording, or a second reader.
   */
  serve(request: Request): Response {
    const recording = this.find(request)
    if (recording instanceof Response) return recording
    if (recording.streaming) return refusal(409, 'the recording already has a reader')
    recording.read()
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const frame = await recording.next()
        if (frame === undefined) {
          controller.close()
          return
        }
        controller.enqueue(encodeRecordFrame(frame))
      },
      cancel() {
        recording.fail(new GodotVideoError('The WASD Engine window stopped reading the recording.'))
      },
    }, { highWaterMark: 0 }), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/octet-stream' } })
  }

  /**
   * Receive the window's `POST /api/godot.video` of a recording's video into a temporary file in the folder of the
   * video's path, from which the recording moves it to the path.
   * @param request - authenticated owner request whose body is the video.
   * @returns 204 once the video is stored, or 400, 404, 409, or 413.
   */
  async receive(request: Request): Promise<Response> {
    const recording = this.find(request)
    if (recording instanceof Response) return recording
    if (recording.uploading) return refusal(409, 'the recording already has an upload')
    if (request.body === null) return refusal(400, 'the upload has no body')
    recording.uploading = true
    await mkdir(recording.folder, { recursive: true })
    const file = join(recording.folder, `.wasd-recording-${randomBytes(8).toString('hex')}.part`)
    const output = createWriteStream(file)
    let bytes = 0
    try {
      const reader = request.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.limits.maxBytes) {
          await reader.cancel()
          await closeStream(output)
          await rm(file, { force: true })
          return refusal(413, `the video is larger than ${this.limits.maxBytes} bytes`)
        }
        if (!output.write(value)) await new Promise<void>((resolve) => { output.once('drain', resolve) })
      }
      await closeStream(output)
    } catch (error) {
      await closeStream(output).catch(() => {})
      await rm(file, { force: true })
      throw error
    }
    if (recording.failed !== undefined && !this.recordings.has(recordingKey(recording.sessionId, recording.runId, recording.id))) {
      await rm(file, { force: true })
      return refusal(404, 'the recording ended')
    }
    recording.upload = { file, bytes }
    return new Response(null, { status: 204, headers: COMMON_HEADERS })
  }

  private find(request: Request): Recording | Response {
    const params = new URL(request.url).searchParams
    const session = params.get('session')
    const run = params.get('run')
    const id = Number(params.get('recording'))
    if (session === null || session === '' || run === null || run === '' || !Number.isInteger(id)) return refusal(400, 'session, run, and recording are required')
    return this.recordings.get(recordingKey(session, run, id)) ?? refusal(404, 'no such recording')
  }
}

function recordingKey(sessionId: string, runId: string, id: number): string {
  return `${sessionId}\n${runId}\n${id}`
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new GodotVideoError(String(error))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // ENOENT or ENOTDIR: nothing is there.
    return false
  }
}

/** Keep Godot from importing the videos of a project's recordings folder, so its editor and exports skip them. */
async function markRecordingsFolder(path: string): Promise<void> {
  if (basename(dirname(path)) !== RECORDINGS_FOLDER) return
  const marker = join(dirname(path), '.gdignore')
  if (!await exists(marker)) await writeFile(marker, '')
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => { if (error) reject(error); else resolve() })
  })
}

/**
 * Wait for a promise until a time limit.
 * @param promise - the awaited work.
 * @param ms - the limit.
 * @param signal - cancellation.
 * @param late - the error after the limit.
 * @returns the promise's value.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal, late: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(late()) }, ms)
        abort = () => { reject(asError(signal.reason)) }
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort !== undefined) signal.removeEventListener('abort', abort)
  }
}

/** Play a recording's events; the recording's end cancels the ones still running, and the game releases what they held. */
async function playEvents(run: GodotRun, events: readonly GodotInputEvent[], signal: AbortSignal): Promise<void> {
  try {
    await run.input(events, signal)
  } catch (error) {
    if (!signal.aborted) throw error
  }
}
