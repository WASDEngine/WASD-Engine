/**
 * PNG encoding of the RGB images that the audio tools draw, with `node:zlib` for compression and checksums.
 *
 * @module
 */

import { crc32, deflateSync } from 'node:zlib'

/** An 8-bit RGB image: `width * height` pixels of 3 bytes each, rows from top to bottom. */
export interface RgbImage {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG filter type "Up": each byte minus the byte above it, which compresses the drawings' vertical runs well. */
const FILTER_UP = 2

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0)
  return Buffer.concat([head, data, tail])
}

/**
 * Encode an RGB image as PNG.
 * @param image - pixels and dimensions.
 * @returns the PNG file bytes.
 * @throws RangeError when the pixel buffer does not hold `width * height * 3` bytes or a dimension is not positive.
 */
export function encodePng(image: RgbImage): Buffer {
  const { width, height, pixels } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 3) {
    throw new RangeError(`encodePng: a ${String(width)} x ${String(height)} RGB image needs ${String(width * height * 3)} bytes, got ${String(pixels.length)}`)
  }
  const stride = width * 3
  const filtered = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    filtered[row] = FILTER_UP
    for (let x = 0; x < stride; x++) {
      const above = y === 0 ? 0 : pixels[(y - 1) * stride + x] ?? 0
      filtered[row + 1 + x] = ((pixels[y * stride + x] ?? 0) - above) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // Bit depth 8, color type 2 (RGB), deflate compression, adaptive filtering, no interlace.
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(filtered, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}
