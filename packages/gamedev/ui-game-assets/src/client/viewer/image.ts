/**
 * Images the browser cannot decode, decoded with three.js loaders in a chunk the 2D view loads on first use: TGA as
 * stored, and Radiance HDR and OpenEXR tone mapped (ACES filmic, at exposure 1) and encoded as sRGB for the screen.
 */
import { FloatType, RedFormat } from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The image decoders this module implements. */
export type DecodedImageFormat = 'tga' | 'hdr' | 'exr'

/**
 * Narkowicz's fit of the ACES filmic curve, applied to one linear channel.
 * @param value - linear radiance.
 * @returns the tone-mapped value in 0–1.
 */
function aces(value: number): number {
  const mapped = (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14)
  return Math.min(1, Math.max(0, mapped))
}

/**
 * Encode a 0–1 linear value with the sRGB transfer function.
 * @param value - linear value.
 * @returns the 8-bit sRGB value.
 */
function srgb8(value: number): number {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/**
 * Tone map floating-point pixels into 8-bit RGBA rows, top row first.
 * @param data - linear pixels, `channels` per pixel.
 * @param width - pixels per row.
 * @param height - rows.
 * @param channels - 4 for RGBA, 1 for luminance.
 * @param bottomUp - whether the first row of `data` is the image's bottom row.
 * @returns the RGBA bytes.
 */
function toneMapped(
  data: Float32Array,
  width: number,
  height: number,
  channels: number,
  bottomUp: boolean,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const source = bottomUp ? height - 1 - row : row
    for (let column = 0; column < width; column += 1) {
      const from = (source * width + column) * channels
      const to = (row * width + column) * 4
      const red = data[from] ?? 0
      const green = channels === 1 ? red : data[from + 1] ?? 0
      const blue = channels === 1 ? red : data[from + 2] ?? 0
      const alpha = channels === 4 ? data[from + 3] ?? 1 : 1
      out[to] = srgb8(aces(red))
      out[to + 1] = srgb8(aces(green))
      out[to + 2] = srgb8(aces(blue))
      out[to + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    }
  }
  return out
}

/**
 * Decode an image the browser cannot.
 * @param format - the decoder to use.
 * @param bytes - the complete file.
 * @returns a bitmap of the image, top row first; the caller closes it.
 * @throws {Error} when the file is not a valid image of the format.
 */
export async function decodeImage(format: DecodedImageFormat, bytes: Uint8Array<ArrayBuffer>): Promise<ImageBitmap> {
  // A copy in this page's own ArrayBuffer, which the loaders test with `instanceof`.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const buffer = copy.buffer
  let pixels: ImageData
  switch (format) {
    case 'tga': {
      const decoded = new TGALoader().parse(buffer)
      const data = decoded.data
      if (!(data instanceof Uint8Array) || decoded.width === undefined || decoded.height === undefined) throw new Error('not a TGA image')
      pixels = new ImageData(new Uint8ClampedArray(data), decoded.width, decoded.height)
      break
    }
    case 'hdr': {
      const decoded = new HDRLoader().setDataType(FloatType).parse(buffer)
      if (!(decoded.data instanceof Float32Array) || decoded.width === undefined || decoded.height === undefined) throw new Error('not a Radiance HDR image')
      pixels = new ImageData(toneMapped(decoded.data, decoded.width, decoded.height, 4, false), decoded.width, decoded.height)
      break
    }
    case 'exr': {
      const decoded = new EXRLoader().setDataType(FloatType).parse(buffer)
      if (!(decoded.data instanceof Float32Array) || decoded.width === undefined || decoded.height === undefined) throw new Error('not an OpenEXR image')
      const channels = decoded.format === RedFormat ? 1 : 4
      pixels = new ImageData(toneMapped(decoded.data, decoded.width, decoded.height, channels, true), decoded.width, decoded.height)
      break
    }
    default:
      return assertNever(format)
  }
  return createImageBitmap(pixels)
}
