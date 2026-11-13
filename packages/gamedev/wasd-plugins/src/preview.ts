/**
 * Game previews: a recording of the running game made into the three files that a release uploads as the game's
 * preview, saved in the project's `.wasdengine/preview/` folder: `preview.webp`, an animated WebP that Explore and the
 * game's page play; `preview.gif`, the GIF that link previews of its share link show; and `preview.png` or
 * `preview.jpg`, whichever holds the still in fewer bytes. The animation and the GIF keep the recording's timing, loop
 * forever, and shrink, first in width down to `minWidth` and then by dropping every other frame, until each fits its
 * byte limit.
 * @module @deepseek-ai/dsh-wasd-plugins/src/preview
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GodotRecordedImage, GodotRecording } from '@deepseek-ai/dsh-godot'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type sharp from 'sharp'
import { STATE_DIR } from './state.ts'

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

/** Each smaller width tried is this share of the previous one. */
const WIDTH_STEP = 0.75

/** JPEG quality of a still that encodes smaller as JPEG than as PNG. */
const STILL_JPEG_QUALITY = 88

/** How {@link encodePreview} encodes the GIF and the animation. */
export interface PreviewEncoding {
  /** Largest GIF width in pixels. */
  readonly gifWidth: number
  /** Largest GIF in bytes. */
  readonly maxGifBytes: number
  /** Largest animation width in pixels. */
  readonly webpWidth: number
  /** Largest animation in bytes. */
  readonly maxWebpBytes: number
  /** WebP quality of the animation, from 1 to 100. */
  readonly webpQuality: number
  /** Smallest width in pixels that a GIF or animation over its byte limit shrinks to before it drops frames. */
  readonly minWidth: number
  /** CPU effort of the GIF palette and frame optimization, from 1 (fastest) to 10 (smallest). */
  readonly effort: number
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

/** Encode frames, with their delays, at one size. */
type FrameEncoder = (frames: Sharp, delays: readonly number[]) => Promise<Buffer>

/** A Sharp image, as Sharp's factory returns it. */
type Sharp = ReturnType<typeof sharp>

/**
 * Encode frames as one looping image of a width, each frame fitted into the first frame's aspect ratio on black.
 * @param images - the frames.
 * @param delays - their delays in milliseconds.
 * @param width - image width.
 * @param height - image height.
 * @param encode - the format's encoder.
 * @returns the encoded bytes.
 */
async function encodeFrames(
  images: readonly GodotRecordedImage[], delays: readonly number[], width: number, height: number, encode: FrameEncoder,
): Promise<Buffer> {
  const sharp = requireSharp()
  const pixels = await Promise.all(images.map(image => sharp(image.image)
    .resize(width, height, { fit: 'contain', background: '#000000' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .raw()
    .toBuffer()))
  return await encode(
    sharp(Buffer.concat(pixels), { raw: { width, height: height * images.length, channels: 3, pageHeight: height } }),
    delays,
  )
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
 * Encode a recording's frames at most `maxWidth` wide, then narrower, then with every other frame dropped, until the
 * bytes fit `maxBytes`.
 * @param first - the first frame, whose aspect ratio every frame takes.
 * @param recorded - all frames.
 * @param maxWidth - largest width.
 * @param maxBytes - byte limit.
 * @param minWidth - smallest width before frames drop.
 * @param encode - the format's encoder.
 * @param signal - cancellation, checked between encodings.
 * @returns the last encoding, which may still exceed `maxBytes` when even two frames at `minWidth` do.
 */
async function fitAnimation(
  first: GodotRecordedImage, recorded: readonly GodotRecordedImage[], maxWidth: number, maxBytes: number, minWidth: number,
  encode: FrameEncoder, signal: AbortSignal,
): Promise<FittedAnimation> {
  let frames = recorded
  let delays = frameDelays(frames)
  let width = Math.min(first.width, maxWidth)
  for (;;) {
    signal.throwIfAborted()
    const height = Math.max(1, Math.round(first.height * width / first.width))
    const bytes = await encodeFrames(frames, delays, width, height, encode)
    const narrower = Math.round(width * WIDTH_STEP)
    if (bytes.length <= maxBytes || (width <= minWidth && frames.length <= 2)) {
      return { bytes, width, height, frames: frames.length, durationMs: delays.reduce((sum, delay) => sum + delay, 0) }
    }
    if (narrower >= minWidth) {
      width = narrower
    } else if (width > minWidth) {
      width = minWidth
    } else {
      ({ frames, delays } = halve(frames, delays))
    }
  }
}

/**
 * Encode a recording as a preview.
 * @param recording - frames and still.
 * @param encoding - the GIF's and the animation's widths and size limits, and the encoders' settings.
 * @param signal - cancellation, checked between encodings.
 * @returns the GIF, the animation, and the still; either animated image may still exceed its byte limit when even
 *   two frames at `minWidth` do.
 */
export async function encodePreview(recording: GodotRecording, encoding: PreviewEncoding, signal: AbortSignal): Promise<EncodedPreview> {
  const sharp = requireSharp()
  const first = recording.frames[0]
  if (first === undefined) throw new Error('The recording holds no frames.')
  const gif = await fitAnimation(
    first, recording.frames, encoding.gifWidth, encoding.maxGifBytes, encoding.minWidth,
    async (frames, delays) => await frames.gif({ delay: [...delays], loop: 0, effort: encoding.effort }).toBuffer(),
    signal,
  )
  const webp = await fitAnimation(
    first, recording.frames, encoding.webpWidth, encoding.maxWebpBytes, encoding.minWidth,
    async (frames, delays) => await frames.webp({ delay: [...delays], loop: 0, quality: encoding.webpQuality }).toBuffer(),
    signal,
  )
  signal.throwIfAborted()
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

async function writeReplacing(path: string, data: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
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
  await writeReplacing(gif, preview.gif)
  await writeReplacing(webp, preview.webp)
  await writeReplacing(image, preview.still)
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
