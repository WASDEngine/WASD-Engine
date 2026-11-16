/**
 * The image a review sends: the agent's PNG, JPEG, or WebP file, read within a size limit, turned upright, scaled down
 * to the reviewer's image limits, and a small image, such as pixel art, enlarged by whole pixels until it reaches the
 * reviewer route's pixel floor, below which the route would scale it up by a fraction and blur its pixels. It goes as
 * PNG, or as JPEG when it has no transparency and the PNG would be large. Sharp loads at the first review.
 * @module @deepseek-ai/dsh-graphics-review/src/image
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

/** Most pixels an image the tool reads may decode to. */
const MAX_INPUT_PIXELS = 16_384 * 16_384

/** The file types a review reads. */
const FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp'])

/** Above this size, an image without transparency goes as JPEG instead of PNG. */
const PNG_LIMIT_BYTES = 3 * 1024 * 1024

/** The sizes a review keeps an image within. */
export interface ImageLimits {
  /** Largest file read, in bytes. */
  readonly maxBytes: number
  /** Longest side in pixels of the image sent. */
  readonly maxEdge: number
  /** Most pixels of the image sent. */
  readonly maxPixels: number
  /**
   * Fewest pixels of the image sent: a smaller image is enlarged by the smallest whole factor that reaches them, or by
   * the largest one that the other limits allow.
   */
  readonly minPixels: number
}

/** The image of one review, as it is sent. */
export interface ReviewImage {
  /** PNG or JPEG bytes. */
  readonly data: Buffer
  readonly mediaType: 'image/png' | 'image/jpeg'
  /** The file's name. */
  readonly name: string
  /** Pixel size of the file's image, upright. */
  readonly width: number
  readonly height: number
  /** Pixel size of the image sent. */
  readonly sentWidth: number
  readonly sentHeight: number
}

/** A file the review cannot read; the message says what to pass instead. */
export class UnreadableImage extends Error {
  override name = 'UnreadableImage'
}

/**
 * The size to send an image at.
 * @param width - upright width of the file's image.
 * @param height - upright height of the file's image.
 * @param limits - the review's limits.
 * @returns the size, and whether it enlarges by whole pixels.
 */
export function sentSize(width: number, height: number, limits: ImageLimits): { width: number; height: number; enlarged: boolean } {
  const area = width * height
  const longest = Math.max(width, height)
  const down = Math.min(1, limits.maxEdge / longest, Math.sqrt(limits.maxPixels / area))
  if (down < 1) return { width: Math.max(1, Math.floor(width * down)), height: Math.max(1, Math.floor(height * down)), enlarged: false }
  if (area >= limits.minPixels) return { width, height, enlarged: false }
  // A whole factor keeps each source pixel a square block: the smallest that reaches the floor, within both upper limits.
  const factor = Math.min(
    Math.ceil(Math.sqrt(limits.minPixels / area)), Math.floor(limits.maxEdge / longest), Math.floor(Math.sqrt(limits.maxPixels / area)),
  )
  return { width: width * factor, height: height * factor, enlarged: factor > 1 }
}

/**
 * Read an image file for a review. Only a regular file is opened, so a device or a named pipe, which reports no size and
 * may never end, is refused without reading it.
 * @param path - absolute path of the file.
 * @param limits - the review's limits.
 * @param signal - cancellation, which stops the read and the steps after it.
 * @returns the image to send.
 * @throws UnreadableImage when the path is missing, a folder, not a regular file, too large, or not a PNG, JPEG, or
 *   WebP image.
 */
export async function readReviewImage(path: string, limits: ImageLimits, signal: AbortSignal): Promise<ReviewImage> {
  let found
  try {
    found = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnreadableImage(`${path} does not exist; pass the path of the image to review.`)
    throw error
  }
  if (found.isDirectory()) throw new UnreadableImage(`${path} is a folder; pass the path of a PNG, JPEG, or WebP image.`)
  if (!found.isFile()) {
    throw new UnreadableImage(`${path} is a device, pipe, or socket, not an image file; pass the path of a PNG, JPEG, or WebP image.`)
  }
  if (found.size > limits.maxBytes) {
    throw new UnreadableImage(`${path} is larger than ${Math.floor(limits.maxBytes / (1024 * 1024))} MB; pass a smaller image, such as a screenshot.`)
  }
  let file
  try {
    file = await readFile(path, { signal })
  } catch (error) {
    // A cancelled read ends with the call's own reason.
    signal.throwIfAborted()
    throw error
  }
  const load = requireSharp()
  let meta
  try {
    meta = await load(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch (error) {
    throw new UnreadableImage(`${path} is not an image WASD Engine can read; pass a PNG, JPEG, or WebP image.`, { cause: error })
  }
  signal.throwIfAborted()
  if (!FORMATS.has(meta.format)) throw new UnreadableImage(`${path} is a ${meta.format} file; pass a PNG, JPEG, or WebP image.`)
  const { width, height } = meta.autoOrient
  const size = sentSize(width, height, limits)
  let pipeline = load(file, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient()
  if (size.width !== width || size.height !== height) {
    pipeline = pipeline.resize({ width: size.width, height: size.height, fit: 'fill', kernel: size.enlarged ? 'nearest' : 'lanczos3' })
  }
  try {
    const png = await pipeline.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    if (meta.hasAlpha || png.data.byteLength <= PNG_LIMIT_BYTES) {
      return { data: png.data, mediaType: 'image/png', name: basename(path), width, height, sentWidth: png.info.width, sentHeight: png.info.height }
    }
    const jpeg = await pipeline.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true })
    return { data: jpeg.data, mediaType: 'image/jpeg', name: basename(path), width, height, sentWidth: jpeg.info.width, sentHeight: jpeg.info.height }
  } catch (error) {
    throw new UnreadableImage(`${path} could not be converted for the review; save it as PNG and try again.`, { cause: error })
  }
}
