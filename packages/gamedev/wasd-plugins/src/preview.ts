/**
 * Game previews: a recording of the running game made into the animated GIF and the still image that a release
 * uploads as the game's preview, saved in the project's `.wasdengine/preview/` folder as `preview.gif` and
 * `preview.png` or `preview.jpg`, whichever holds the still in fewer bytes. The GIF keeps the recording's timing, loops
 * forever, and shrinks, first in width down to `minWidth` and then by dropping every other frame, until it fits
 * `maxGifBytes`.
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

/** File names of the preview still, by its type. */
export const PREVIEW_STILLS = { 'image/png': 'preview.png', 'image/jpeg': 'preview.jpg' } as const

/** Shortest delay of a GIF frame; browsers play shorter delays as 100 ms. */
const MIN_FRAME_DELAY_MS = 20

/** Each smaller GIF width tried is this share of the previous one. */
const WIDTH_STEP = 0.75

/** JPEG quality of a still that encodes smaller as JPEG than as PNG. */
const STILL_JPEG_QUALITY = 88

/** How {@link encodePreview} encodes the GIF. */
export interface PreviewEncoding {
  /** Largest GIF in bytes. */
  readonly maxGifBytes: number
  /** Smallest GIF width in pixels that a GIF over `maxGifBytes` shrinks to before it drops frames. */
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
  /** Playing time of one loop in milliseconds. */
  readonly durationMs: number
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

/**
 * Encode frames as one looping GIF of a width, each frame fitted into the first frame's aspect ratio on black.
 * @param images - the frames.
 * @param delays - their delays in milliseconds.
 * @param width - GIF width.
 * @param height - GIF height.
 * @param effort - encoder effort.
 * @returns the GIF bytes.
 */
async function encodeGif(
  images: readonly GodotRecordedImage[], delays: readonly number[], width: number, height: number, effort: number,
): Promise<Buffer> {
  const sharp = requireSharp()
  const pixels = await Promise.all(images.map(image => sharp(image.png)
    .resize(width, height, { fit: 'contain', background: '#000000' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .raw()
    .toBuffer()))
  return await sharp(Buffer.concat(pixels), { raw: { width, height: height * images.length, channels: 3, pageHeight: height } })
    .gif({ delay: [...delays], loop: 0, effort })
    .toBuffer()
}

/**
 * Encode a recording as a preview.
 * @param recording - frames and still.
 * @param encoding - GIF size limit, smallest width, and effort.
 * @param signal - cancellation, checked between encodings.
 * @returns the GIF and the still; the GIF may still exceed `maxGifBytes` when even two frames at `minWidth` do.
 */
export async function encodePreview(recording: GodotRecording, encoding: PreviewEncoding, signal: AbortSignal): Promise<EncodedPreview> {
  const sharp = requireSharp()
  const first = recording.frames[0]
  if (first === undefined) throw new Error('The recording holds no frames.')
  let frames: readonly GodotRecordedImage[] = recording.frames
  let delays = frameDelays(frames)
  let width = first.width
  let gif: Buffer
  let height: number
  for (;;) {
    signal.throwIfAborted()
    height = Math.max(1, Math.round(first.height * width / first.width))
    gif = await encodeGif(frames, delays, width, height, encoding.effort)
    if (gif.length <= encoding.maxGifBytes) break
    const narrower = Math.round(width * WIDTH_STEP)
    if (narrower >= encoding.minWidth) {
      width = narrower
    } else if (width > encoding.minWidth && first.width > encoding.minWidth) {
      width = encoding.minWidth
    } else if (frames.length > 2) {
      ({ frames, delays } = halve(frames, delays))
    } else {
      break
    }
  }
  signal.throwIfAborted()
  const png = await sharp(recording.still.png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  const jpeg = await sharp(recording.still.png).flatten({ background: '#000000' })
    .jpeg({ quality: STILL_JPEG_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer()
  const stillType = png.length <= jpeg.length ? 'image/png' : 'image/jpeg'
  return {
    gif,
    gifWidth: width,
    gifHeight: height,
    frames: frames.length,
    durationMs: delays.reduce((sum, delay) => sum + delay, 0),
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
  const image = join(folder, PREVIEW_STILLS[preview.stillType])
  await writeReplacing(gif, preview.gif)
  await writeReplacing(image, preview.still)
  for (const name of Object.values(PREVIEW_STILLS)) {
    if (name !== PREVIEW_STILLS[preview.stillType]) await rm(join(folder, name), { force: true })
  }
  return { gif, image }
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
 * @returns the GIF and the still that exist.
 */
export async function savedPreview(projectDir: string): Promise<PreviewFiles> {
  const folder = join(projectDir, STATE_DIR, PREVIEW_DIR)
  const gif = join(folder, PREVIEW_GIF)
  let image: string | undefined
  for (const name of Object.values(PREVIEW_STILLS)) {
    if (image === undefined && await isFile(join(folder, name))) image = join(folder, name)
  }
  return { ...await isFile(gif) ? { gif } : {}, ...image === undefined ? {} : { image } }
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
