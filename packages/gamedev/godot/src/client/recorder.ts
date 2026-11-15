/**
 * This window's answer to the Host's `godot/record` request: it reads a recording's JPEG frames from the Host's
 * `api/godot.recording` stream while the game records, encodes them with WebCodecs into H.264, or VP9 where the
 * browser has no H.264 encoder, writes an MP4 file, uploads it to `api/godot.video`, and answers with the video's
 * facts and a sheet of frames from across the recording, which the agent sees to judge motion.
 */
import type { GodotVideoEncodeRequest, GodotVideoEncodeResult } from '../types.ts'
import { mp4File, type Mp4Sample, type Mp4Track } from './mp4.ts'

/** Bytes of one record header: u32 LE image length, u32 LE frame index, u32 LE milliseconds into the video, u16 LE width, u16 LE height. */
export const RECORD_HEADER_BYTES = 16

/** Largest image one record may announce; a larger length means the stream is corrupt. */
const MAX_RECORD_IMAGE_BYTES = 64 * 1024 * 1024

/** Time units per second of the video's sample times. */
const TIMESCALE = 90_000

/** Seconds between key frames. */
const KEY_FRAME_SECONDS = 2

/** Bits per pixel of each frame that the encoder aims for. */
const BITS_PER_PIXEL = 0.15

/** Frames the encoder may hold before the reader waits for it. */
const ENCODE_QUEUE = 6

/** Widest the frame sheet draws. */
const SHEET_WIDTH = 1536

/**
 * Codecs in the order the encoder tries them: H.264 High, Main, and Baseline profiles at levels for 4K down to
 * 1080p, then VP9 profile 0.
 */
const CODECS: ReadonlyArray<{ readonly codec: string; readonly kind: Mp4Track['codec'] }> = [
  { codec: 'avc1.640034', kind: 'avc' },
  { codec: 'avc1.640033', kind: 'avc' },
  { codec: 'avc1.64002a', kind: 'avc' },
  { codec: 'avc1.4d0033', kind: 'avc' },
  { codec: 'avc1.42002a', kind: 'avc' },
  { codec: 'vp09.00.51.08', kind: 'vp9' },
  { codec: 'vp09.00.41.08', kind: 'vp9' },
]

/** One frame of a recording. */
export interface RecordingFrame {
  /** Index among the recording's captured frames. */
  readonly index: number
  /** Milliseconds into the video. */
  readonly timeMs: number
  /** Image size in pixels. */
  readonly width: number
  readonly height: number
  /** Bytes of a JPEG file. */
  readonly image: Uint8Array<ArrayBuffer>
}

/** The recording stream carried bytes that do not form a record. */
export class RecordingStreamError extends Error {
  override readonly name = 'RecordingStreamError'
}

/**
 * Incremental record parser; chunk boundaries may fall anywhere, including inside a header. It keeps the chunks of an
 * incomplete record as they arrived and copies each image once, when its record is complete, so parsing a frame costs
 * time in proportion to its size however many chunks carry it.
 */
export class RecordingParser {
  /** Chunks that hold the bytes not yet parsed, from `offset` into the first one. */
  private readonly chunks: Uint8Array[] = []
  private offset = 0
  private buffered = 0
  /** The header of the record whose image is incomplete. */
  private header: Omit<RecordingFrame, 'image'> & { readonly bytes: number } | undefined

  /**
   * Append one body chunk.
   * @param chunk - the next bytes of the response body.
   * @returns the records this chunk completed, in stream order.
   * @throws {RecordingStreamError} when a header announces an empty or oversized image.
   */
  push(chunk: Uint8Array): RecordingFrame[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.byteLength
    }
    const frames: RecordingFrame[] = []
    for (;;) {
      if (this.header === undefined) {
        if (this.buffered < RECORD_HEADER_BYTES) break
        const view = new DataView(this.take(RECORD_HEADER_BYTES).buffer)
        const bytes = view.getUint32(0, true)
        if (bytes < 1 || bytes > MAX_RECORD_IMAGE_BYTES) throw new RecordingStreamError(`A recording frame announced ${bytes} bytes.`)
        this.header = {
          bytes,
          index: view.getUint32(4, true),
          timeMs: view.getUint32(8, true),
          width: view.getUint16(12, true),
          height: view.getUint16(14, true),
        }
      }
      if (this.buffered < this.header.bytes) break
      const { bytes, ...header } = this.header
      this.header = undefined
      frames.push({ ...header, image: this.take(bytes) })
    }
    return frames
  }

  /** Copy the next `count` buffered bytes out of the chunks, which must hold them, and drop the chunks they used up. */
  private take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count)
    let filled = 0
    while (filled < count) {
      const first = this.chunks[0] as Uint8Array
      const part = Math.min(first.byteLength - this.offset, count - filled)
      out.set(first.subarray(this.offset, this.offset + part), filled)
      filled += part
      this.offset += part
      if (this.offset === first.byteLength) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    this.buffered -= count
    return out
  }
}

/** How the encoder reaches the Host. */
export interface RecordingTransport {
  /**
   * Open the recording's frame stream.
   * @param signal - cancellation.
   * @returns the Host's response.
   */
  open(signal: AbortSignal): Promise<Response>
  /**
   * Upload the encoded video.
   * @param video - the MP4 file.
   * @param signal - cancellation.
   * @returns the Host's response.
   */
  upload(video: Blob, signal: AbortSignal): Promise<Response>
}

/**
 * Columns of a sheet of `count` frames: one row up to three, two by two for four, three across up to six, else four.
 * @param count - frames on the sheet, at least 1.
 * @returns the columns.
 */
function sheetColumns(count: number): number {
  if (count <= 3) return count
  if (count === 4) return 2
  return count <= 6 ? 3 : 4
}

/**
 * The frames of a recording that the sheet may show: evenly spaced in time, thinned as the recording grows, and the
 * latest frame, so the sheet ends where the recording does.
 */
class SheetFrames {
  private kept: Array<{ readonly time: number; readonly bitmap: ImageBitmap }> = []
  private latest: { readonly time: number; readonly bitmap: ImageBitmap } | undefined
  private spacing = 0

  constructor(private readonly count: number, private readonly thumbWidth: number) {}

  /** Keep a small copy of a frame when it falls far enough from the last kept one, else as the latest frame. */
  async offer(source: ImageBitmap, time: number): Promise<void> {
    if (this.count === 0) return
    const width = Math.min(this.thumbWidth, source.width)
    const height = Math.max(1, Math.round(source.height * width / source.width))
    const thumb = { time, bitmap: await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' }) }
    const last = this.kept.at(-1)
    if (last !== undefined && time - last.time < this.spacing) {
      this.latest?.bitmap.close()
      this.latest = thumb
      return
    }
    this.latest?.bitmap.close()
    this.latest = undefined
    this.kept.push(thumb)
    if (this.kept.length > this.count * 4) {
      const thinned: typeof this.kept = []
      for (const [index, entry] of this.kept.entries()) {
        if (index % 2 === 0) thinned.push(entry)
        else entry.bitmap.close()
      }
      this.kept = thinned
      this.spacing = Math.max(this.spacing * 2, (time / Math.max(1, thinned.length)))
    }
  }

  /**
   * Draw the sheet: `count` kept frames evenly spread from the first to the last, left to right, top to bottom, each
   * labeled with its time.
   * @returns the JPEG file, its size, and each frame's seconds into the video; undefined without frames.
   */
  async draw(): Promise<{ readonly jpeg: Blob; readonly width: number; readonly height: number; readonly times: number[] } | undefined> {
    if (this.count === 0 || this.kept.length === 0) return undefined
    if (this.latest !== undefined) {
      this.kept.push(this.latest)
      this.latest = undefined
    }
    const end = (this.kept.at(-1) as { readonly time: number }).time
    const picks: Array<{ readonly time: number; readonly bitmap: ImageBitmap }> = []
    const shown = Math.min(this.count, this.kept.length)
    for (let slot = 0; slot < shown; slot += 1) {
      const target = shown === 1 ? 0 : end * slot / (shown - 1)
      let best = this.kept[0] as { readonly time: number; readonly bitmap: ImageBitmap }
      for (const entry of this.kept) {
        if (!picks.includes(entry) && Math.abs(entry.time - target) < Math.abs(best.time - target)) best = entry
      }
      picks.push(best)
    }
    const columns = sheetColumns(shown)
    const rows = Math.ceil(shown / columns)
    const first = (picks[0] as { readonly bitmap: ImageBitmap }).bitmap
    const cellWidth = Math.min(Math.floor(SHEET_WIDTH / columns), first.width)
    const cellHeight = Math.max(1, Math.round(first.height * cellWidth / first.width))
    const canvas = new OffscreenCanvas(cellWidth * columns, cellHeight * rows)
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const fontSize = Math.max(11, Math.round(cellHeight / 14))
    context.font = `600 ${fontSize}px system-ui, sans-serif`
    context.textBaseline = 'top'
    for (const [index, pick] of picks.entries()) {
      const x = (index % columns) * cellWidth
      const y = Math.floor(index / columns) * cellHeight
      context.drawImage(pick.bitmap, x, y, cellWidth, cellHeight)
      const stamp = `${(pick.time / 1000).toFixed(2)} s`
      const stampWidth = context.measureText(stamp).width + fontSize
      context.fillStyle = 'rgba(0, 0, 0, 0.65)'
      context.fillRect(x, y, stampWidth, fontSize * 1.6)
      context.fillStyle = '#fff'
      context.fillText(stamp, x + fontSize / 2, y + fontSize * 0.3)
    }
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    return { jpeg, width: canvas.width, height: canvas.height, times: picks.map(pick => Math.round(pick.time) / 1000) }
  }

  close(): void {
    for (const entry of this.kept) entry.bitmap.close()
    this.latest?.bitmap.close()
    this.kept = []
    this.latest = undefined
  }
}

/**
 * The first codec this browser encodes at a size and frame rate.
 * @param width - even frame width.
 * @param height - even frame height.
 * @param fps - frames per second.
 * @returns the encoder configuration and the track's codec, or undefined when no codec is supported.
 */
async function chooseCodec(width: number, height: number, fps: number): Promise<{ readonly config: VideoEncoderConfig; readonly kind: Mp4Track['codec'] } | undefined> {
  const bitrate = Math.round(Math.min(60_000_000, Math.max(2_000_000, width * height * fps * BITS_PER_PIXEL)))
  for (const candidate of CODECS) {
    const config: VideoEncoderConfig = {
      codec: candidate.codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      ...candidate.kind === 'avc' ? { avc: { format: 'avc' } } : {},
    }
    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported === true) return { config, kind: candidate.kind }
    } catch {
      // TypeError: the browser does not know the codec string; the next candidate follows.
    }
  }
  return undefined
}

/**
 * Whether this window can encode recordings.
 * @returns true where WebCodecs' VideoEncoder and OffscreenCanvas exist.
 */
export function canEncodeRecordings(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(text)
}

/**
 * Encode a recording: read its frames until the Host ends the stream, encode and write the video, upload it, and
 * draw the sheet.
 * @param request - the recording's frame rate, sheet, and size limit.
 * @param transport - the Host's frame stream and upload.
 * @param signal - cancellation of the request.
 * @returns the video's facts and the sheet.
 * @throws {Error} when the Host refuses the stream or the upload, the stream is malformed or empty, no codec encodes
 * the frames, or the video exceeds the size limit.
 */
export async function encodeRecording(
  request: Pick<GodotVideoEncodeRequest, 'fps' | 'sheetFrames' | 'maxBytes'>,
  transport: RecordingTransport,
  signal: AbortSignal,
): Promise<GodotVideoEncodeResult> {
  const response = await transport.open(signal)
  if (!response.ok || response.body === null) throw new Error(`The Host refused the recording's frames (HTTP ${response.status}).`)
  const reader = response.body.getReader()
  const parser = new RecordingParser()
  const sheet = new SheetFrames(request.sheetFrames, Math.floor(SHEET_WIDTH / sheetColumns(Math.max(1, request.sheetFrames))))
  const samples: Mp4Sample[] = []
  let encoder: VideoEncoder | undefined
  let track: Omit<Mp4Track, 'lastDuration'> | undefined
  // The encoder reports its error through a callback, so the loop reads it from this list.
  const failures: Error[] = []
  let start: number | undefined
  let lastTime = 0
  let frames = 0
  const keyEvery = Math.max(1, Math.round(request.fps * KEY_FRAME_SECONDS))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parser.push(value)) {
        if (failures[0] !== undefined) throw failures[0]
        signal.throwIfAborted()
        start ??= frame.timeMs
        const time = frame.timeMs - start
        if (encoder === undefined) {
          const width = frame.width - (frame.width % 2)
          const height = frame.height - (frame.height % 2)
          if (width < 2 || height < 2) throw new Error(`The recording's frames are ${frame.width}x${frame.height} px, too small to encode.`)
          const chosen = await chooseCodec(width, height, request.fps)
          if (chosen === undefined) throw new Error('This WASD Engine window has no H.264 or VP9 video encoder.')
          const kind = chosen.kind
          const level = Number(/^vp09\.\d\d\.(\d\d)/u.exec(chosen.config.codec)?.[1] ?? '51')
          track = { codec: kind, width, height, timescale: TIMESCALE, ...kind === 'vp9' ? { vp9: { profile: 0, level } } : {} }
          encoder = new VideoEncoder({
            output(chunk, metadata) {
              const description = metadata?.decoderConfig?.description
              if (description !== undefined && track !== undefined && track.description === undefined) {
                const view = ArrayBuffer.isView(description)
                  ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
                  : new Uint8Array(description)
                track = { ...track, description: new Uint8Array(view) }
              }
              const data = new Uint8Array(chunk.byteLength)
              chunk.copyTo(data)
              samples.push({ data, time: Math.round(chunk.timestamp * TIMESCALE / 1_000_000), key: chunk.type === 'key' })
            },
            error(error) {
              failures.push(error instanceof Error ? error : new Error(String(error)))
            },
          })
          encoder.configure(chosen.config)
        }
        const configured = track as Omit<Mp4Track, 'lastDuration'>
        const resize = frame.width - (frame.width % 2) !== configured.width || frame.height - (frame.height % 2) !== configured.height
        const bitmap = await createImageBitmap(new Blob([frame.image], { type: 'image/jpeg' }), resize ? { resizeWidth: configured.width, resizeHeight: configured.height } : {})
        try {
          const videoFrame = new VideoFrame(bitmap, {
            timestamp: Math.round(time * 1000),
            visibleRect: { x: 0, y: 0, width: configured.width, height: configured.height },
          })
          encoder.encode(videoFrame, { keyFrame: frames % keyEvery === 0 })
          videoFrame.close()
          frames += 1
          lastTime = time
          await sheet.offer(bitmap, time)
        } finally {
          bitmap.close()
        }
        while (encoder.encodeQueueSize > ENCODE_QUEUE && failures.length === 0) {
          await new Promise<void>((resolve) => { (encoder as VideoEncoder).addEventListener('dequeue', () => { resolve() }, { once: true }) })
        }
      }
    }
    if (encoder === undefined || track === undefined || frames === 0) throw new Error('The recording has no frames.')
    await encoder.flush()
    if (failures[0] !== undefined) throw failures[0]
    if (samples.length === 0) throw new Error('The video encoder produced no frames.')
    const file = mp4File({ ...track, lastDuration: Math.round(TIMESCALE / request.fps) }, samples)
    if (file.byteLength > request.maxBytes) throw new Error(`The video takes ${file.byteLength} bytes, more than the ${request.maxBytes} the Host accepts; record fewer seconds or a smaller max_width.`)
    // The Blob copies the parts, whose sample data are the encoded frames themselves; once it holds them, the frames
    // can go.
    const video = new Blob(file.parts, { type: 'video/mp4' })
    const encoded = samples.length
    samples.length = 0
    const uploaded = await transport.upload(video, signal)
    if (!uploaded.ok) throw new Error(`The Host refused the video (HTTP ${uploaded.status}): ${await uploaded.text()}`)
    const drawn = await sheet.draw()
    return {
      codec: track.codec === 'avc' ? 'H.264' : 'VP9',
      frames: encoded,
      seconds: (lastTime + 1000 / request.fps) / 1000,
      width: track.width,
      height: track.height,
      bytes: file.byteLength,
      ...drawn === undefined ? {} : {
        sheet: {
          data: base64(new Uint8Array(await drawn.jpeg.arrayBuffer())),
          width: drawn.width,
          height: drawn.height,
          times: drawn.times,
        },
      },
    }
  } finally {
    sheet.close()
    if (encoder !== undefined && encoder.state !== 'closed') encoder.close()
    await reader.cancel().catch(() => {})
  }
}
