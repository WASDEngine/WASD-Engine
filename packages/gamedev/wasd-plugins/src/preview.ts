/**
 * Game previews: a recording of the running game made into the three files that a release uploads as the game's
 * preview, saved in the project's `.wasdengine/preview/` folder: `preview.webp`, an animated WebP that Explore and the
 * game's page play; `preview.gif`, the GIF that link previews of its share link show; and `preview.png` or
 * `preview.jpg`, whichever holds the still in fewer bytes. The animation and the GIF keep the recording's timing, loop
 * forever, fit every frame into the first frame's shape at most their size on its longer side, and shrink, first in
 * size down to `minWidth` and then by dropping every other frame, until each fits its byte limit. Each frame of the
 * animation is a whole lossy WebP image, so a slow change, such as a fade, reaches every frame. The GIF's frames decode
 * into one buffer of at most `frameBufferBytes`, at most `concurrency` frames decode or encode at once, and an encoding
 * starts only while the computer has the memory it needs available.
 * @module @deepseek-ai/dsh-wasd-plugins/src/preview
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GodotRecordedImage, GodotRecording } from '@deepseek-ai/dsh-godot'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type sharp from 'sharp'
import { STATE_DIR, writeWhole } from './state.ts'

/** Load Sharp on the first preview that needs it. */
const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

/** The preview's folder inside {@link STATE_DIR}. */
export const PREVIEW_DIR = 'preview'

/** File name of the preview GIF. */
export const PREVIEW_GIF = 'preview.gif'

/** File name of the preview animation. */
export const PREVIEW_WEBP = 'preview.webp'

/** File names of the preview still, by its type. */
export const PREVIEW_STILLS = { 'image/png': 'preview.png', 'image/jpeg': 'preview.jpg' } as const

/** Shortest delay of a GIF frame; browsers play shorter delays as 100 ms. */
const MIN_FRAME_DELAY_MS = 20

/** Each smaller size tried is at most this share of the previous one. */
const SIZE_STEP = 0.75

/**
 * Share of the size that an encoding over its byte limit says would just fit, which the next encoding tries: the
 * bytes grow with the pixels, as the square of the size.
 */
const FIT_MARGIN = 0.9

/** JPEG quality of a still that encodes smaller as JPEG than as PNG. */
const STILL_JPEG_QUALITY = 88

/** Color channels of a decoded frame: red, green, and blue. */
const CHANNELS = 3

/** Longest frame duration an animated WebP stores, in milliseconds: a 24-bit field. */
const MAX_WEBP_DURATION_MS = 0xFF_FFFF

/** VP8X flag of a WebP file whose image carries transparency. */
const WEBP_ALPHA = 0x10

/** VP8X flag of an animated WebP file. */
const WEBP_ANIMATION = 0x02

/** ANMF flag of a frame that replaces the canvas under it instead of blending with it. */
const WEBP_NO_BLEND = 0x02

/** Background color of an animation, opaque black, as the ANIM chunk stores it: blue, green, red, alpha. */
const WEBP_BACKGROUND = 0xFF00_0000

/** Chunk ids of the image inside a WebP file: its alpha, and its lossy or lossless bitstream. */
const WEBP_IMAGE_CHUNKS: ReadonlySet<string> = new Set(['ALPH', 'VP8 ', 'VP8L'])

/** How {@link encodePreview} encodes the GIF and the animation. */
export interface PreviewEncoding {
  /** Largest width or height of the GIF in pixels: the size of its longer side. */
  readonly gifWidth: number
  /** Largest GIF in bytes. */
  readonly maxGifBytes: number
  /** Largest width or height of the animation in pixels: the size of its longer side. */
  readonly webpWidth: number
  /** Largest animation in bytes. */
  readonly maxWebpBytes: number
  /** WebP quality of each frame of the animation, from 1 to 100. */
  readonly webpQuality: number
  /** Smallest longer side in pixels that a GIF or animation over its byte limit shrinks to before it drops frames. */
  readonly minWidth: number
  /** CPU effort of the GIF palette and frame optimization, from 1 (fastest) to 10 (smallest). */
  readonly effort: number
  /**
   * Largest size in bytes of the decoded frames that a GIF encoding holds; a recording whose frames would take more
   * at `gifWidth` starts at the largest size that keeps them within it.
   */
  readonly frameBufferBytes: number
  /** Most frames that decode or encode at once. */
  readonly concurrency: number
  /** Memory in bytes that must stay available besides the GIF's decoded frames for an encoding to start. */
  readonly minAvailableMemoryBytes: number
  /** @returns the memory in bytes available to this process now. */
  readonly availableMemory: () => number
}

/** A preview encoded from a recording. */
export interface EncodedPreview {
  /** GIF bytes. */
  readonly gif: Buffer
  /** GIF width in pixels. */
  readonly gifWidth: number
  /** GIF height in pixels. */
  readonly gifHeight: number
  /** Frames in the GIF. */
  readonly frames: number
  /** Playing time of one loop of the GIF in milliseconds. */
  readonly durationMs: number
  /** Animated WebP bytes. */
  readonly webp: Buffer
  /** Animation width in pixels. */
  readonly webpWidth: number
  /** Animation height in pixels. */
  readonly webpHeight: number
  /** Frames in the animation. */
  readonly webpFrames: number
  /** Still bytes. */
  readonly still: Buffer
  /** Still type. */
  readonly stillType: keyof typeof PREVIEW_STILLS
  /** Still width in pixels. */
  readonly stillWidth: number
  /** Still height in pixels. */
  readonly stillHeight: number
}

/** The preview files of a project, as absolute paths. */
export interface PreviewFiles {
  /** The GIF, when the project has one. */
  readonly gif?: string
  /** The still, when the project has one. */
  readonly image?: string
  /** The animation, when the project has one. */
  readonly webp?: string
}

/** The computer has too little memory available to encode a preview. */
export class PreviewMemoryError extends Error {
  override name = 'PreviewMemoryError'
}

/** A frame size in pixels. */
interface FrameSize {
  readonly width: number
  readonly height: number
}

/** A Sharp image, as Sharp's factory returns it. */
type Sharp = ReturnType<typeof sharp>

/**
 * The delays of the frames from their capture times: each frame shows until the next was captured, rounded to the
 * 10 ms that GIF stores, and the last as long as the others on average.
 * @param frames - captured frames in order.
 * @returns one delay in milliseconds per frame.
 */
export function frameDelays(frames: readonly Pick<GodotRecordedImage, 'atMs'>[]): number[] {
  const gaps = frames.slice(1).map((frame, index) => frame.atMs - (frames[index] as Pick<GodotRecordedImage, 'atMs'>).atMs)
  const average = gaps.length === 0 ? 100 : gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  return [...gaps, average].map(gap => Math.max(MIN_FRAME_DELAY_MS, Math.round(gap / 10) * 10))
}

/**
 * Keep every other frame, each showing for the time of both.
 * @param frames - frames in order.
 * @param delays - their delays.
 * @returns the halved frames and delays.
 */
function halve<T>(frames: readonly T[], delays: readonly number[]): { readonly frames: T[]; readonly delays: number[] } {
  const kept: T[] = []
  const merged: number[] = []
  for (let index = 0; index < frames.length; index += 2) {
    kept.push(frames[index] as T)
    merged.push((delays[index] as number) + (delays[index + 1] ?? 0))
  }
  return { frames: kept, delays: merged }
}

/** The longer side of a size. */
function longerSide(size: FrameSize): number {
  return Math.max(size.width, size.height)
}

/**
 * The size of a frame of `source`'s shape whose longer side is `side`, never larger than `source`.
 * @param source - the shape.
 * @param side - the longer side in pixels.
 * @returns the size.
 */
function sizeAt(source: FrameSize, side: number): FrameSize {
  const scale = Math.min(1, side / longerSide(source))
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) }
}

/** Bytes of `count` decoded frames of a size. */
function decodedBytes(size: FrameSize, count: number): number {
  return size.width * size.height * CHANNELS * count
}

/**
 * The longer side a GIF encoding starts at: `maxSide`, or the source's own when smaller, unless `count` frames decoded
 * at that size would pass `budget` bytes; then the largest side that keeps them within it.
 * @param source - the first frame's size.
 * @param maxSide - the largest longer side.
 * @param count - frames to decode.
 * @param budget - largest size of the decoded frames in bytes.
 * @returns the longer side in pixels.
 */
function startingSide(source: FrameSize, maxSide: number, count: number, budget: number): number {
  const shape = Math.min(source.width, source.height) / longerSide(source)
  let side = Math.min(maxSide, longerSide(source), Math.max(1, Math.floor(Math.sqrt(budget / (count * CHANNELS * shape)))))
  while (side > 1 && decodedBytes(sizeAt(source, side), count) > budget) side--
  return side
}

/**
 * Refuse an encoding while the computer has less memory available than it needs.
 * @param requiredBytes - the memory the encoding needs.
 * @param available - reads the memory available now.
 * @throws {PreviewMemoryError} when less is available.
 */
function requireMemory(requiredBytes: number, available: () => number): void {
  const availableBytes = available()
  if (availableBytes >= requiredBytes) return
  throw new PreviewMemoryError(`The computer has ${formatBytes(availableBytes)} of memory available, less than the ${formatBytes(requiredBytes)} `
    + 'that encoding the preview needs, so the recording was not saved. Stop games you no longer need, wait for other work to '
    + 'finish, or ask the user to close programs they are not using, then record again.')
}

/** Bytes in megabytes, or in gigabytes from one gigabyte on. */
function formatBytes(bytes: number): string {
  return bytes < 1024 ** 3 ? `${String(Math.round(bytes / 1024 ** 2))} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * Run a task for each index below `count`, at most `limit` at once; after the first failure, no further task starts.
 * @param count - number of tasks.
 * @param limit - most tasks that run at once.
 * @param signal - cancellation, checked before each task.
 * @param task - runs one task.
 * @returns once every task ended.
 * @throws the first task's failure, or the signal's reason.
 */
async function forEachLimited(count: number, limit: number, signal: AbortSignal, task: (index: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const work = async (): Promise<void> => {
    while (!failed && next < count) {
      const index = next++
      try {
        signal.throwIfAborted()
        await task(index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, work))
}

/**
 * A frame fitted into a size on black, without transparency, as sRGB.
 * @param image - the recorded frame.
 * @param size - the size.
 * @returns the Sharp pipeline, not run.
 */
function fitted(image: GodotRecordedImage, size: FrameSize): Sharp {
  return requireSharp()(image.image)
    .resize(size.width, size.height, { fit: 'contain', background: '#000000' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .toColourspace('srgb')
}

/** Encode frames, with their delays, at one size as one looping image. */
type AnimationEncoder = (
  frames: readonly GodotRecordedImage[], delays: readonly number[], size: FrameSize, signal: AbortSignal,
) => Promise<Buffer>

/**
 * The GIF encoder of one recording. Each encoding decodes its frames into one buffer, kept for the encodings after it,
 * which are smaller or have fewer frames; Sharp reads the buffer's frames as the GIF's pages.
 * @param encoding - the GIF's effort and the frames that decode at once.
 * @returns the encoder.
 */
function gifEncoder(encoding: PreviewEncoding): AnimationEncoder {
  let buffer: Buffer | undefined
  return async (frames, delays, size, signal) => {
    const frameSize = decodedBytes(size, 1)
    if (buffer === undefined || buffer.length < frameSize * frames.length) buffer = Buffer.allocUnsafe(frameSize * frames.length)
    const pixels = buffer.subarray(0, frameSize * frames.length)
    await forEachLimited(frames.length, encoding.concurrency, signal, async (index) => {
      const { data, info } = await fitted(frames[index] as GodotRecordedImage, size).raw().toBuffer({ resolveWithObject: true })
      if (data.length !== frameSize) {
        throw new Error(`A frame of the recording decoded to ${String(info.width)}x${String(info.height)} with ${String(info.channels)} channels, not ${String(size.width)}x${String(size.height)} with ${String(CHANNELS)}.`)
      }
      data.copy(pixels, index * frameSize)
    })
    signal.throwIfAborted()
    const raw = { width: size.width, height: size.height * frames.length, channels: CHANNELS, pageHeight: size.height } as const
    return await requireSharp()(pixels, { raw })
      .gif({ delay: [...delays], loop: 0, effort: encoding.effort })
      .toBuffer()
  }
}

/**
 * The animated WebP encoder of one recording. Each frame is encoded as a whole lossy WebP image and the animation holds
 * those images as they are: an animation encoder that stores only what changed since the frame before leaves out
 * changes below its quality's threshold, so a fade, or a color that drifts by a level or two a frame, would never reach
 * the file. The frames of the latest size stay encoded for an encoding with fewer frames.
 * @param encoding - the frames' WebP quality and the frames that encode at once.
 * @returns the encoder.
 */
function webpEncoder(encoding: PreviewEncoding): AnimationEncoder {
  let encoded: { readonly size: FrameSize; readonly stills: Map<GodotRecordedImage, Buffer> } | undefined
  return async (frames, delays, size, signal) => {
    if (encoded === undefined || encoded.size.width !== size.width || encoded.size.height !== size.height) {
      encoded = { size, stills: new Map() }
    }
    const stills = encoded.stills
    const images: Buffer[] = []
    await forEachLimited(frames.length, encoding.concurrency, signal, async (index) => {
      const frame = frames[index] as GodotRecordedImage
      let still = stills.get(frame)
      if (still === undefined) {
        still = await fitted(frame, size).webp({ quality: encoding.webpQuality }).toBuffer()
        stills.set(frame, still)
      }
      images[index] = still
    })
    return animatedWebp(images, delays, size)
  }
}

/**
 * One RIFF chunk: its four-character id, its payload's size, the payload, and a pad byte after an odd payload.
 * @param id - the chunk id.
 * @param payload - the chunk's data.
 * @returns the chunk.
 */
function riffChunk(id: string, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(8)
  header.write(id, 0, 4, 'latin1')
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat(payload.length % 2 === 0 ? [header, payload] : [header, payload, Buffer.alloc(1)])
}

/**
 * The chunks of a still WebP file that hold its image, as a frame of an animation holds them.
 * @param webp - a WebP file Sharp wrote.
 * @returns the chunks, each with its header and padding, and whether they may carry transparency.
 * @throws when the file holds no lossy or lossless bitstream.
 */
function webpImage(webp: Buffer): { readonly chunks: readonly Buffer[]; readonly alpha: boolean } {
  const chunks: Buffer[] = []
  let alpha = false
  let bitstream = false
  if (webp.toString('latin1', 0, 4) === 'RIFF' && webp.toString('latin1', 8, 12) === 'WEBP') {
    for (let at = 12; at + 8 <= webp.length;) {
      const id = webp.toString('latin1', at, at + 4)
      const size = webp.readUInt32LE(at + 4)
      if (at + 8 + size > webp.length) break
      if (WEBP_IMAGE_CHUNKS.has(id)) {
        chunks.push(riffChunk(id, webp.subarray(at + 8, at + 8 + size)))
        alpha ||= id !== 'VP8 '
        bitstream ||= id !== 'ALPH'
      }
      at += 8 + size + size % 2
    }
  }
  if (!bitstream) throw new Error('A frame of the preview animation encoded to no WebP image.')
  return { chunks, alpha }
}

/**
 * An animated WebP file of whole images: each frame covers the canvas at its top left corner, shows for its delay,
 * replaces the frame before it without blending, and stays when the next one comes; the animation loops forever.
 * @param stills - the frames, each a still WebP file of `size`.
 * @param delays - each frame's delay in milliseconds.
 * @param size - the canvas size.
 * @returns the file.
 */
function animatedWebp(stills: readonly Buffer[], delays: readonly number[], size: FrameSize): Buffer {
  const images = stills.map(webpImage)
  const canvas = Buffer.alloc(10)
  canvas.writeUInt8(WEBP_ANIMATION | (images.some(image => image.alpha) ? WEBP_ALPHA : 0), 0)
  canvas.writeUIntLE(size.width - 1, 4, 3)
  canvas.writeUIntLE(size.height - 1, 7, 3)
  const animation = Buffer.alloc(6)
  animation.writeUInt32LE(WEBP_BACKGROUND, 0)
  // A loop count of 0 plays the animation forever.
  animation.writeUInt16LE(0, 4)
  const chunks = [riffChunk('VP8X', canvas), riffChunk('ANIM', animation), ...images.map((image, index) => {
    // The frame's offsets, both 0, its width and height less one, its duration, and its blending and disposal.
    const frame = Buffer.alloc(16)
    frame.writeUIntLE(size.width - 1, 6, 3)
    frame.writeUIntLE(size.height - 1, 9, 3)
    frame.writeUIntLE(Math.min(MAX_WEBP_DURATION_MS, delays[index] as number), 12, 3)
    frame.writeUInt8(WEBP_NO_BLEND, 15)
    return riffChunk('ANMF', Buffer.concat([frame, ...image.chunks]))
  })]
  const form = Buffer.from('WEBP', 'latin1')
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 4, 'latin1')
  header.writeUInt32LE(form.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, form, ...chunks])
}

/** An animated image fitted to a byte limit. */
interface FittedAnimation {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly durationMs: number
}

/**
 * Encode a recording's frames with a longer side of `side`, then smaller, then with every other frame dropped, until
 * the bytes fit `maxBytes`. An encoding over the limit sets the size of the next: about the size whose pixels would
 * have fit, and at most three quarters of its own.
 * @param source - the first frame's size, whose shape every frame takes.
 * @param recorded - all frames.
 * @param side - the longer side of the first encoding.
 * @param maxBytes - byte limit.
 * @param minSide - smallest longer side before frames drop.
 * @param encode - the format's encoder.
 * @param signal - cancellation, checked between encodings.
 * @returns the last encoding, which may still exceed `maxBytes` when even two frames at `minSide` do.
 */
async function fitAnimation(
  source: FrameSize, recorded: readonly GodotRecordedImage[], side: number, maxBytes: number, minSide: number,
  encode: AnimationEncoder, signal: AbortSignal,
): Promise<FittedAnimation> {
  let frames = recorded
  let delays = frameDelays(frames)
  let current = side
  for (;;) {
    signal.throwIfAborted()
    const size = sizeAt(source, current)
    const bytes = await encode(frames, delays, size, signal)
    if (bytes.length <= maxBytes || (current <= minSide && frames.length <= 2)) {
      const durationMs = delays.reduce((sum, delay) => sum + delay, 0)
      return { bytes, width: size.width, height: size.height, frames: frames.length, durationMs }
    }
    if (current > minSide) {
      const fits = Math.floor(current * Math.sqrt(maxBytes / bytes.length) * FIT_MARGIN)
      current = Math.max(minSide, Math.min(current - 1, Math.round(current * SIZE_STEP), fits))
    } else {
      ({ frames, delays } = halve(frames, delays))
    }
  }
}

/**
 * Encode a recording as a preview, once the computer has the memory the encoding needs available.
 * @param recording - frames and still.
 * @param encoding - the GIF's and the animation's sizes and byte limits, the encoders' settings, and the memory bounds.
 * @param signal - cancellation, checked between encodings and frames.
 * @returns the GIF, the animation, and the still; either animated image may still exceed its byte limit when even
 *   two frames at `minWidth` do.
 * @throws {PreviewMemoryError} when less memory is available than the GIF's decoded frames and
 *   `minAvailableMemoryBytes` take.
 */
export async function encodePreview(recording: GodotRecording, encoding: PreviewEncoding, signal: AbortSignal): Promise<EncodedPreview> {
  const first = recording.frames[0]
  if (first === undefined) throw new Error('The recording holds no frames.')
  const gifSide = startingSide(first, encoding.gifWidth, recording.frames.length, encoding.frameBufferBytes)
  requireMemory(decodedBytes(sizeAt(first, gifSide), recording.frames.length) + encoding.minAvailableMemoryBytes, encoding.availableMemory)
  const gif = await fitAnimation(first, recording.frames, gifSide, encoding.maxGifBytes, encoding.minWidth, gifEncoder(encoding), signal)
  const webpSide = Math.min(encoding.webpWidth, longerSide(first))
  const webp = await fitAnimation(
    first, recording.frames, webpSide, encoding.maxWebpBytes, encoding.minWidth, webpEncoder(encoding), signal,
  )
  signal.throwIfAborted()
  const sharp = requireSharp()
  const png = await sharp(recording.still.image).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  const jpeg = await sharp(recording.still.image).flatten({ background: '#000000' })
    .jpeg({ quality: STILL_JPEG_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer()
  const stillType = png.length <= jpeg.length ? 'image/png' : 'image/jpeg'
  return {
    gif: gif.bytes,
    gifWidth: gif.width,
    gifHeight: gif.height,
    frames: gif.frames,
    durationMs: gif.durationMs,
    webp: webp.bytes,
    webpWidth: webp.width,
    webpHeight: webp.height,
    webpFrames: webp.frames,
    still: stillType === 'image/png' ? png : jpeg,
    stillType,
    stillWidth: recording.still.width,
    stillHeight: recording.still.height,
  }
}

/**
 * Save a preview in a project's preview folder, replacing the one before, and remove a still of the other type.
 * @param projectDir - absolute project folder.
 * @param preview - the encoded preview.
 * @returns the saved files.
 */
export async function savePreview(projectDir: string, preview: EncodedPreview): Promise<Required<PreviewFiles>> {
  const folder = join(projectDir, STATE_DIR, PREVIEW_DIR)
  await mkdir(folder, { recursive: true })
  const gif = join(folder, PREVIEW_GIF)
  const webp = join(folder, PREVIEW_WEBP)
  const image = join(folder, PREVIEW_STILLS[preview.stillType])
  await writeWhole(gif, preview.gif)
  await writeWhole(webp, preview.webp)
  await writeWhole(image, preview.still)
  for (const name of Object.values(PREVIEW_STILLS)) {
    if (name !== PREVIEW_STILLS[preview.stillType]) await rm(join(folder, name), { force: true })
  }
  return { gif, image, webp }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable file is no preview.
    return false
  }
}

/**
 * The preview files saved in a project.
 * @param projectDir - absolute project folder.
 * @returns the GIF, the animation, and the still that exist.
 */
export async function savedPreview(projectDir: string): Promise<PreviewFiles> {
  const folder = join(projectDir, STATE_DIR, PREVIEW_DIR)
  const gif = join(folder, PREVIEW_GIF)
  const webp = join(folder, PREVIEW_WEBP)
  let image: string | undefined
  for (const name of Object.values(PREVIEW_STILLS)) {
    if (image === undefined && await isFile(join(folder, name))) image = join(folder, name)
  }
  return {
    ...await isFile(gif) ? { gif } : {},
    ...await isFile(webp) ? { webp } : {},
    ...image === undefined ? {} : { image },
  }
}

/**
 * The SHA-256 digest of a file.
 * @param path - absolute file path.
 * @param signal - cancellation.
 * @returns the lowercase hex digest.
 */
export async function fileDigest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
