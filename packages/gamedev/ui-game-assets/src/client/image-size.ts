/**
 * The pixel size an image file's header states, read before any of its pixels are decoded, so that the viewer can
 * refuse an image too large to decode: PNG, JPEG, GIF (its logical screen), WebP, BMP, ICO (its largest entry, a PNG
 * entry by its own header), AVIF (its largest image), TGA, Radiance HDR, and OpenEXR (its data window). An SVG has no
 * pixels until it is drawn, and a header this reader cannot read states no size; the decoder then reports the file.
 */
import type { AssetFormat } from './formats.ts'

/** A size in pixels. */
export interface PixelSize {
  readonly width: number
  readonly height: number
}

/** The bytes of a file, read without going past their end. */
class Bytes {
  private readonly view: DataView

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  get length(): number {
    return this.data.byteLength
  }

  u8(at: number): number | undefined {
    return at >= 0 && at < this.length ? this.view.getUint8(at) : undefined
  }

  u16(at: number, little: boolean): number | undefined {
    return at >= 0 && at + 2 <= this.length ? this.view.getUint16(at, little) : undefined
  }

  u24le(at: number): number | undefined {
    const low = this.u16(at, true)
    const high = this.u8(at + 2)
    return low === undefined || high === undefined ? undefined : low + high * 0x10000
  }

  u32(at: number, little: boolean): number | undefined {
    return at >= 0 && at + 4 <= this.length ? this.view.getUint32(at, little) : undefined
  }

  i32le(at: number): number | undefined {
    return at >= 0 && at + 4 <= this.length ? this.view.getInt32(at, true) : undefined
  }

  ascii(at: number, length: number): string {
    let text = ''
    for (let index = at; index < at + length && index < this.length; index += 1) text += String.fromCharCode(this.view.getUint8(index))
    return text
  }
}

/** A size of positive whole pixels, or undefined. */
function sized(width: number | undefined, height: number | undefined): PixelSize | undefined {
  if (width === undefined || height === undefined || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined
  return width >= 1 && height >= 1 ? { width, height } : undefined
}

/** The larger of two sizes by area. */
function larger(left: PixelSize | undefined, right: PixelSize | undefined): PixelSize | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return right.width * right.height > left.width * left.height ? right : left
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngSize(bytes: Bytes, at = 0): PixelSize | undefined {
  if (!PNG_SIGNATURE.every((value, index) => bytes.u8(at + index) === value) || bytes.ascii(at + 12, 4) !== 'IHDR') return undefined
  return sized(bytes.u32(at + 16, false), bytes.u32(at + 20, false))
}

/** The start-of-frame markers of baseline, progressive, lossless, and arithmetic JPEG. */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.u8(0) !== 0xff || bytes.u8(1) !== 0xd8) return undefined
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes.u8(at) !== 0xff) return undefined
    const marker = bytes.u8(at + 1) ?? 0
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = bytes.u16(at + 2, false)
    if (length === undefined || length < 2) return undefined
    if (JPEG_FRAMES.has(marker)) return sized(bytes.u16(at + 7, false), bytes.u16(at + 5, false))
    at += 2 + length
  }
  return undefined
}

function gifSize(bytes: Bytes): PixelSize | undefined {
  const magic = bytes.ascii(0, 6)
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return undefined
  return sized(bytes.u16(6, true), bytes.u16(8, true))
}

function webpSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.ascii(0, 4) !== 'RIFF' || bytes.ascii(8, 4) !== 'WEBP') return undefined
  const chunk = bytes.ascii(12, 4)
  const data = 20
  if (chunk === 'VP8X') return sized((bytes.u24le(data + 4) ?? -1) + 1, (bytes.u24le(data + 7) ?? -1) + 1)
  if (chunk === 'VP8 ') {
    const width = bytes.u16(data + 6, true)
    const height = bytes.u16(data + 8, true)
    return sized(width === undefined ? undefined : width & 0x3fff, height === undefined ? undefined : height & 0x3fff)
  }
  if (chunk === 'VP8L') {
    const bits = bytes.u32(data + 1, true)
    if (bytes.u8(data) !== 0x2f || bits === undefined) return undefined
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  return undefined
}

function bmpSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.ascii(0, 2) !== 'BM') return undefined
  const header = bytes.u32(14, true)
  if (header === 12) return sized(bytes.u16(18, true), bytes.u16(20, true))
  const width = bytes.i32le(18)
  const height = bytes.i32le(22)
  // A negative height stores the rows top down.
  return sized(width, height === undefined ? undefined : Math.abs(height))
}

function icoSize(bytes: Bytes): PixelSize | undefined {
  const type = bytes.u16(2, true)
  const count = bytes.u16(4, true)
  if (bytes.u16(0, true) !== 0 || (type !== 1 && type !== 2) || count === undefined || count === 0) return undefined
  let largest: PixelSize | undefined
  for (let entry = 0; entry < count; entry += 1) {
    const at = 6 + entry * 16
    const width = bytes.u8(at)
    const height = bytes.u8(at + 1)
    const offset = bytes.u32(at + 12, true)
    if (width === undefined || height === undefined || offset === undefined) return largest
    // A PNG entry states its own size, which may exceed the directory's 256.
    largest = larger(largest, pngSize(bytes, offset) ?? sized(width === 0 ? 256 : width, height === 0 ? 256 : height))
  }
  return largest
}

/** The `ispe` boxes of an AVIF file's item properties: `meta`, then `iprp`, then `ipco`. */
function avifSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.ascii(4, 4) !== 'ftyp') return undefined
  let largest: PixelSize | undefined
  const walk = (start: number, end: number, path: readonly string[]): void => {
    let at = start
    while (at + 8 <= end) {
      const size32 = bytes.u32(at, false)
      const type = bytes.ascii(at + 4, 4)
      if (size32 === undefined) return
      let header = 8
      let size = size32
      if (size32 === 1) {
        const high = bytes.u32(at + 8, false)
        const low = bytes.u32(at + 12, false)
        if (high === undefined || low === undefined) return
        size = high * 0x1_0000_0000 + low
        header = 16
      } else if (size32 === 0) {
        size = end - at
      }
      if (size < header || at + size > end) return
      const inside = [...path, type]
      if (type === 'ispe' && inside.join('/') === 'meta/iprp/ipco/ispe') {
        largest = larger(largest, sized(bytes.u32(at + header + 4, false), bytes.u32(at + header + 8, false)))
      } else if (type === 'meta') {
        // A full box: four bytes of version and flags before its children.
        walk(at + header + 4, at + size, inside)
      } else if (type === 'iprp' || type === 'ipco') {
        walk(at + header, at + size, inside)
      }
      at += size
    }
  }
  walk(0, bytes.length, [])
  return largest
}

function tgaSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.length < 18) return undefined
  return sized(bytes.u16(12, true), bytes.u16(14, true))
}

/** Radiance HDR: text lines up to an empty line, then a resolution such as `-Y 512 +X 1024`. */
function hdrSize(bytes: Bytes): PixelSize | undefined {
  const head = bytes.ascii(0, Math.min(bytes.length, 64 * 1024))
  if (!head.startsWith('#?')) return undefined
  const match = /\n\n([-+])([XY]) (\d+) ([-+])([XY]) (\d+)/u.exec(head.replaceAll('\r', ''))
  if (match === null) return undefined
  const first = Number(match[3])
  const second = Number(match[6])
  return match[2] === 'Y' ? sized(second, first) : sized(first, second)
}

/** OpenEXR: named attributes after the magic and version, until an empty name; `dataWindow` is a `box2i`. */
function exrSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.u32(0, true) !== 20000630) return undefined
  let at = 8
  for (let attributes = 0; attributes < 1024 && at < bytes.length; attributes += 1) {
    const nameEnd = bytes.data.indexOf(0, at)
    if (nameEnd < 0 || nameEnd === at) return undefined
    const name = bytes.ascii(at, nameEnd - at)
    const typeEnd = bytes.data.indexOf(0, nameEnd + 1)
    if (typeEnd < 0) return undefined
    const size = bytes.u32(typeEnd + 1, true)
    if (size === undefined) return undefined
    const value = typeEnd + 5
    if (name === 'dataWindow' && size === 16) {
      const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map(offset => bytes.i32le(value + offset))
      if (xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined) return undefined
      return sized(xMax - xMin + 1, yMax - yMin + 1)
    }
    at = value + size
  }
  return undefined
}

/**
 * The size in pixels an image file states before it is decoded.
 * @param data - the file, or its first bytes; a size past them is not found.
 * @param format - the file's format.
 * @returns the size, or undefined for an SVG and for a header this reader cannot read.
 */
export function imageSize(data: Uint8Array, format: AssetFormat): PixelSize | undefined {
  if (format.kind !== 'image') return undefined
  const bytes = new Bytes(data)
  // The three.js decoders' formats; this module imports no value the viewer chunk also imports, which would split it.
  if (format.decoder === 'tga') return tgaSize(bytes)
  if (format.decoder === 'hdr') return hdrSize(bytes)
  if (format.decoder === 'exr') return exrSize(bytes)
  // The browser's formats by media type; an SVG states no pixels.
  switch (format.mediaType) {
    case 'image/png': return pngSize(bytes)
    case 'image/jpeg': return jpegSize(bytes)
    case 'image/gif': return gifSize(bytes)
    case 'image/webp': return webpSize(bytes)
    case 'image/bmp': return bmpSize(bytes)
    case 'image/x-icon': return icoSize(bytes)
    case 'image/avif': return avifSize(bytes)
    default: return undefined
  }
}
