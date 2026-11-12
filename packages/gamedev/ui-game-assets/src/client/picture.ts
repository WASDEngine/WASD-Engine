/**
 * Decoding the images the 2D view shows and the agent's pictures draw. An image's header is read first, and one that
 * states more pixels than the viewer decodes is refused before any pixel is decoded. The browser's formats decode into
 * an image element, whose pixels the browser keeps as it keeps those of the images it shows, so a picture drawn from
 * it at a smaller size holds no full-size copy of its own, and the 2D view's element and its player share one decoded
 * image; TGA, HDR, and EXR decode into a bitmap through the viewer chunk. The pixel facts, transparency and colors,
 * are measured on a copy of at most four million pixels.
 */
import type { AssetTransparency } from '@deepseek-ai/dsh-game-assets/types'
import type { AssetFormat, ImageDecoder } from './formats.ts'
import { imageSize, type PixelSize } from './image-size.ts'
import type { Picture } from './render2d.ts'

type ViewerModule = typeof import('./viewer/index.ts')

/** Largest image area measured pixel by pixel; larger images are measured at a smaller size. */
const MEASURED_PIXELS = 4_000_000

/** Edge used for an image without an intrinsic size, such as an SVG with only a viewBox. */
export const FALLBACK_EDGE = 512

/**
 * Memory one pixel of an image takes while it is decoded, by decoder: the browser's RGBA, and the three.js decoders'
 * own pixels before the RGBA bitmap, floating-point for HDR and EXR.
 */
export const DECODED_BYTES_PER_PIXEL: Readonly<Record<ImageDecoder, number>> = { browser: 4, tga: 12, hdr: 24, exr: 24 }

/** A decoded picture and how to release it. */
export interface Decoded {
  readonly picture: Picture
  readonly close: () => void
}

/** An image whose header states more pixels than the viewer decodes. */
export class ImageTooLargeError extends Error {
  /**
   * @param size - the size the header states.
   * @param limit - the most pixels the viewer decodes.
   */
  constructor(readonly size: PixelSize, readonly limit: number) {
    super(`the image is ${String(size.width)} × ${String(size.height)} pixels, more than the ${String(limit)} pixels the viewer decodes`)
    this.name = 'ImageTooLargeError'
  }
}

/**
 * The size an image's header states, checked against the most pixels the viewer decodes.
 * @param data - the file, or its first bytes.
 * @param format - its format.
 * @param maxPixels - the most pixels the viewer decodes.
 * @returns the stated size, or undefined for an image whose header states none.
 * @throws {ImageTooLargeError} when the header states more pixels.
 */
export function checkedImageSize(data: Uint8Array, format: AssetFormat, maxPixels: number): PixelSize | undefined {
  const size = imageSize(data, format)
  if (size !== undefined && size.width * size.height > maxPixels) throw new ImageTooLargeError(size, maxPixels)
  return size
}

/**
 * Decode an image element from a URL.
 * @param url - an object URL of the file.
 * @returns the decoded element.
 * @throws {Error} when the browser cannot decode it.
 */
export async function decodeElement(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

/**
 * The picture of a decoded image element.
 * @param image - the element.
 * @returns the picture at the element's natural size, or {@link FALLBACK_EDGE} for an image without one.
 */
export function elementPicture(image: HTMLImageElement): Picture {
  return { source: image, width: image.naturalWidth || FALLBACK_EDGE, height: image.naturalHeight || FALLBACK_EDGE }
}

/**
 * Decode an image whose size the caller has checked.
 * @param data - the file.
 * @param format - its format, an image.
 * @param viewer - loads the viewer chunk for TGA, HDR, and EXR.
 * @param url - an object URL of the file to decode from, which the caller owns; one is made for the decode otherwise.
 * @returns the picture and its release.
 * @throws {Error} when the file is not an image or does not decode.
 */
export async function decodePicture(
  data: Uint8Array<ArrayBuffer>,
  format: AssetFormat,
  viewer: () => Promise<ViewerModule>,
  url?: string,
): Promise<Decoded> {
  if (format.kind !== 'image') throw new Error('not an image')
  if (format.decoder !== 'browser') {
    const bitmap = await (await viewer()).decodeImage(format.decoder, data)
    return { picture: { source: bitmap, width: bitmap.width, height: bitmap.height }, close: () => { bitmap.close() } }
  }
  const source = url ?? URL.createObjectURL(new Blob([data], format.mediaType === undefined ? {} : { type: format.mediaType }))
  try {
    const image = await decodeElement(source)
    // An element whose source is cleared lets the browser release its pixels.
    return { picture: elementPicture(image), close: () => { image.removeAttribute('src') } }
  } finally {
    // A decoded element keeps its pixels after its URL is revoked.
    if (source !== url) URL.revokeObjectURL(source)
  }
}

/**
 * How an image's pixels use transparency, and how many colors it has, counted up to 257.
 * @param picture - the image.
 * @returns the facts.
 */
export function pixelFacts(picture: Picture): { readonly transparency: AssetTransparency; readonly colors: number } {
  const scale = Math.min(1, Math.sqrt(MEASURED_PIXELS / Math.max(1, picture.width * picture.height)))
  const width = Math.max(1, Math.round(picture.width * scale))
  const height = Math.max(1, Math.round(picture.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return { transparency: 'opaque', colors: 0 }
  context.imageSmoothingEnabled = false
  context.drawImage(picture.source, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  let transparent = false
  let translucent = false
  const colors = new Set<number>()
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] ?? 255
    if (alpha === 0) transparent = true
    else if (alpha < 255) translucent = true
    if (colors.size > 256) continue
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    colors.add(((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0)
  }
  return { transparency: translucent ? 'translucent' : transparent ? 'cutout' : 'opaque', colors: Math.min(257, colors.size) }
}
