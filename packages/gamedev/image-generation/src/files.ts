/**
 * The image files of the image tool: each image a call sends, fitted to what the WASD Engine API takes, and the image
 * a call saves, in the file type its path names. Sharp loads at the first call that reads or converts an image.
 * @module @deepseek-ai/dsh-image-generation/src/files
 */
import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type { GeneratedImage, ImageFormat, SentImage } from './types.ts'

const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

/** Longest side of an image the tool sends; a larger image is scaled down to it. */
export const MAX_SENT_SIDE = 2048

/** Largest image file the API takes. */
export const MAX_SENT_BYTES = 7 * 1024 * 1024

/** Largest total of one call's image files that the API takes. */
export const MAX_SENT_TOTAL_BYTES = 14 * 1024 * 1024

/** Largest file the tool reads as an image to send. */
export const MAX_READ_BYTES = 100 * 1024 * 1024

/** Most pixels an image the tool reads may decode to. */
const MAX_INPUT_PIXELS = 16_384 * 16_384

/** Longest side an SVG image is drawn at before it is sent. */
const SVG_SIDE = 1024

/** The file types the API takes as they are. */
const SENT_FORMATS: ReadonlySet<string> = new Set<ImageFormat>(['png', 'jpeg', 'webp'])

/** An image file as the tool saves it. */
export interface SavedImage {
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/** A file the tool cannot send; the message completes "<file> ...". */
export class UnreadableImage extends Error {
  override name = 'UnreadableImage'
}

/**
 * An image file fitted to what the API takes. A PNG, JPEG, or WebP file that is upright, one frame, at most
 * {@link MAX_SENT_SIDE} pixels on its longest side, and at most {@link MAX_SENT_BYTES} is sent unchanged. Any other
 * image sharp reads, such as a GIF, a TIFF, an SVG, or a larger photo, is turned upright, scaled down to fit, and saved
 * as PNG when it has transparency and as JPEG otherwise, or as WebP when that file is still too large.
 * @param file - the file's bytes.
 * @returns the image to send.
 * @throws UnreadableImage when sharp cannot read the file, or it cannot be made small enough.
 */
export async function fitForSending(file: Buffer): Promise<SentImage> {
  const load = requireSharp()
  let meta
  try {
    meta = await load(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch (error) {
    throw new UnreadableImage('is not an image file WASD Engine can read; use a PNG, JPEG, or WebP file.', { cause: error })
  }
  const { width, height } = meta.autoOrient
  const upright = meta.orientation === undefined || meta.orientation === 1
  const small = Math.max(width, height) <= MAX_SENT_SIDE && file.byteLength <= MAX_SENT_BYTES
  if (SENT_FORMATS.has(meta.format) && upright && (meta.pages ?? 1) === 1 && small) {
    return { mimeType: `image/${meta.format as ImageFormat}`, data: file, width, height }
  }
  const density = meta.format === 'svg' ? Math.min(100_000, Math.max(1, (72 * SVG_SIDE) / Math.max(width, height))) : undefined
  const fitted = load(file, { limitInputPixels: MAX_INPUT_PIXELS, ...density === undefined ? {} : { density } })
    .autoOrient()
    .resize({ width: MAX_SENT_SIDE, height: MAX_SENT_SIDE, fit: 'inside', withoutEnlargement: true })
  try {
    let mimeType: SentImage['mimeType'] = meta.hasAlpha ? 'image/png' : 'image/jpeg'
    const first = meta.hasAlpha
      ? fitted.clone().png({ compressionLevel: 9 })
      : fitted.clone().jpeg({ quality: 90, mozjpeg: true })
    let encoded = await first.toBuffer({ resolveWithObject: true })
    if (encoded.data.byteLength > MAX_SENT_BYTES) {
      mimeType = 'image/webp'
      encoded = await fitted.clone().webp({ quality: 90 }).toBuffer({ resolveWithObject: true })
    }
    if (encoded.data.byteLength > MAX_SENT_BYTES) throw new UnreadableImage(`is larger than ${MAX_SENT_BYTES / (1024 * 1024)} MB even scaled down; pass a smaller image.`)
    return { mimeType, data: encoded.data, width: encoded.info.width, height: encoded.info.height }
  } catch (error) {
    if (error instanceof UnreadableImage) throw error
    throw new UnreadableImage('could not be converted to an image WASD Engine can send; save it as PNG or JPEG.', { cause: error })
  }
}

/**
 * A generated image in the file type a path names: the API's file unchanged when it already is that type, else
 * converted, with JPEG drawn over white wherever the image is transparent.
 * @param image - the image the API returned.
 * @param format - the file type to save.
 * @returns the file's bytes and its pixel size.
 */
export async function encodeForSaving(image: GeneratedImage, format: ImageFormat): Promise<SavedImage> {
  if (image.format === format) return { data: image.data, width: image.width, height: image.height }
  const decoded = requireSharp()(image.data, { limitInputPixels: MAX_INPUT_PIXELS })
  const encoded = format === 'png'
    ? decoded.png({ compressionLevel: 9, adaptiveFiltering: true })
    : format === 'jpeg'
      ? decoded.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true })
      : decoded.webp({ quality: 92 })
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}
