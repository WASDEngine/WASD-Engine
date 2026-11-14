/**
 * The pixel size an image file's header states, read before any of its pixels are decoded, so that the viewer can
 * refuse an image too large to decode. Each reader follows the decoder that will read the file: the browser's formats
 * by their content, as the browser picks its decoder, so a file named for another format is read as what it is: PNG,
 * JPEG (past the stray bytes libjpeg skips), GIF (its logical screen grown to its first frame, as browsers grow it),
 * WebP, BMP, ICO (its largest entry, a PNG entry by its own header), and AVIF (its largest image); and by name the
 * formats three.js decodes: TGA, Radiance HDR (its header lines as the loader reads them), and OpenEXR (the last data
 * window of its first header, as the loader keeps it). An SVG has no pixels until it is drawn; any other header this
 * reader cannot read states no size, and the viewer does not decode the file.
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

/** Markers that libjpeg reads past by their length before a frame: tables, restart interval, DNL, APPn, and comments. */
const JPEG_SEGMENTS: ReadonlySet<number> = new Set([
  0xc4, 0xcc, 0xdb, 0xdc, 0xdd, 0xfe, ...Array.from({ length: 16 }, (_, index) => 0xe0 + index),
])

/**
 * A JPEG's frame size, from its markers as libjpeg reads them: after the start of image, each marker is the next 0xFF
 * byte that is not followed by a 0x00 byte, after any other bytes, which libjpeg skips. A marker libjpeg fails on before
 * the frame states no size.
 */
function jpegSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.u8(0) !== 0xff || bytes.u8(1) !== 0xd8) return undefined
  let at = 2
  for (;;) {
    let marker = 0
    while (marker === 0) {
      while (at < bytes.length && bytes.u8(at) !== 0xff) at += 1
      while (at < bytes.length && bytes.u8(at) === 0xff) at += 1
      const next = bytes.u8(at)
      if (next === undefined) return undefined
      at += 1
      marker = next
    }
    // `at` is now at the marker's length, then its fields: a frame's precision, height, and width.
    if (JPEG_FRAMES.has(marker)) return sized(bytes.u16(at + 5, false), bytes.u16(at + 3, false))
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (!JPEG_SEGMENTS.has(marker)) return undefined
    const length = bytes.u16(at, false)
    if (length === undefined || length < 2) return undefined
    at += length
  }
}

/**
 * A GIF's size as browsers decode it: its logical screen, grown to the bounds of its first frame, which browsers show
 * whole however small the screen; later frames are cut to that size. A file that ends before its first frame or its
 * trailer states no size.
 */
function gifSize(bytes: Bytes): PixelSize | undefined {
  const magic = bytes.ascii(0, 6)
  const width = bytes.u16(6, true)
  const height = bytes.u16(8, true)
  const packed = bytes.u8(10)
  if ((magic !== 'GIF87a' && magic !== 'GIF89a') || width === undefined || height === undefined || packed === undefined) return undefined
  // The global color table, when the screen has one, follows the 13 bytes of the header and screen descriptor.
  let at = 13 + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 7) + 1))
  for (;;) {
    const block = bytes.u8(at)
    if (block === undefined) return undefined
    if (block === 0x2c) {
      const [left, top, frameWidth, frameHeight] = [1, 3, 5, 7].map(offset => bytes.u16(at + offset, true))
      if (left === undefined || top === undefined || frameWidth === undefined || frameHeight === undefined) return undefined
      return sized(Math.max(width, left + frameWidth), Math.max(height, top + frameHeight))
    }
    // The trailer, or a block no decoder reads past: no frame grows the screen.
    if (block !== 0x21) return sized(width, height)
    // An extension: its label, then data sub-blocks up to an empty one.
    at += 2
    for (let size = bytes.u8(at); size !== 0; size = bytes.u8(at)) {
      if (size === undefined) return undefined
      at += 1 + size
    }
    at += 1
  }
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

/** The boxes from an AVIF file's top level down to its item properties, which hold its `ispe` boxes. */
const AVIF_PROPERTIES = ['meta', 'iprp', 'ipco'] as const

/**
 * The `ispe` boxes of an AVIF file's item properties: the top-level `meta`, then `iprp`, then `ipco`. Only that path is
 * entered, so a file of nested boxes cannot make the walk deeper than it.
 */
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
      if (type === 'ispe' && path.length === AVIF_PROPERTIES.length) {
        largest = larger(largest, sized(bytes.u32(at + header + 4, false), bytes.u32(at + header + 8, false)))
      } else if (type === AVIF_PROPERTIES[path.length]) {
        // `meta` is a full box: four bytes of version and flags before its children.
        walk(at + header + (type === 'meta' ? 4 : 0), at + size, [...path, type])
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

/** Most bytes of a Radiance HDR header the reader reads; a longer header states no size. */
const HDR_HEADER_BYTES = 1024 * 1024

/**
 * One header line of a Radiance HDR file as three.js's HDRLoader reads it: in chunks of 128 characters up to a
 * newline found within 1024 characters, and the position the loader goes on from, which for a line longer than one
 * chunk lies past the line's end, as in the loader.
 * @param bytes - the file.
 * @param position - where the line starts.
 * @returns the line without its newline and the next position, or undefined where the loader stops reading lines.
 */
function hdrLine(bytes: Bytes, position: number): { readonly line: string; readonly next: number } | undefined {
  const chunkSize = 128
  let at = position
  let length = 0
  let line = ''
  let chunk = bytes.ascii(at, chunkSize)
  let newline = chunk.indexOf('\n')
  while (newline < 0 && length < 1024 && at < bytes.length) {
    line += chunk
    length += chunk.length
    at += chunkSize
    chunk += bytes.ascii(at, chunkSize)
    newline = chunk.indexOf('\n')
  }
  return newline < 0 ? undefined : { line: line + chunk.slice(0, newline), next: position + length + newline + 1 }
}

/**
 * Radiance HDR, as three.js's HDRLoader reads its header: a `#?` line, then lines up to the one where both a `FORMAT=`
 * line and a `-Y height +X width` line have been read, skipping comment lines; the size is the last such resolution.
 */
function hdrSize(bytes: Bytes): PixelSize | undefined {
  const first = hdrLine(bytes, 0)
  if (first === undefined || !/^#\?\S/u.test(first.line)) return undefined
  let format = false
  let resolution: RegExpExecArray | undefined
  for (let at = first.next; at < HDR_HEADER_BYTES;) {
    const read = hdrLine(bytes, at)
    if (read === undefined) return undefined
    at = read.next
    if (read.line.startsWith('#')) continue
    if (/^\s*FORMAT=\S+\s*$/u.test(read.line)) format = true
    resolution = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/u.exec(read.line) ?? resolution
    if (format && resolution !== undefined) return sized(Number.parseInt(resolution[2] ?? '', 10), Number.parseInt(resolution[1] ?? '', 10))
  }
  return undefined
}

/** OpenEXR's magic number, the first four bytes of every file. */
const EXR_MAGIC = 20_000_630

/** Bytes that three.js's EXRLoader reads for each attribute type whose value has a fixed length, whatever the file says. */
const EXR_FIXED: ReadonlyMap<string, number> = new Map([
  ['chromaticities', 32], ['compression', 1], ['box2i', 16], ['envmap', 1], ['tiledesc', 9], ['lineOrder', 1], ['float', 4],
  ['v2f', 8], ['v3f', 12], ['int', 4], ['rational', 8], ['timecode', 8],
])

/** Attribute types whose values EXRLoader keeps in the header, so that one replaces an earlier attribute of its name. */
const EXR_KEPT: ReadonlySet<string> = new Set([
  ...EXR_FIXED.keys(), 'string', 'stringvector', 'iccProfile', 'chlist', 'preview', 'deepImageState', 'idmanifest',
])

/**
 * A null-terminated string of an OpenEXR header.
 * @param bytes - the file.
 * @param at - where the string starts.
 * @returns its text and where the next field starts, or undefined when no null byte ends it, where EXRLoader would read
 * on without end.
 */
function exrString(bytes: Bytes, at: number): { readonly text: string; readonly end: number } | undefined {
  const end = at < bytes.length ? bytes.data.indexOf(0, at) : -1
  return end < 0 ? undefined : { text: bytes.ascii(at, end - at), end: end + 1 }
}

/**
 * Where EXRLoader stops reading a channel list: it reads channels, each a name and 16 bytes, while it is before the
 * list's last byte, then that byte.
 * @param bytes - the file.
 * @param start - the list's first byte.
 * @param size - the list's length as the file states it.
 * @returns the position after the list, or undefined when a name has no end.
 */
function exrChannelsEnd(bytes: Bytes, start: number, size: number): number | undefined {
  let at = start
  while (at < start + size - 1) {
    const name = exrString(bytes, at)
    if (name === undefined) return undefined
    at = name.end + 16
  }
  return at + 1
}

/** One OpenEXR header as EXRLoader reads it. */
interface ExrHeader {
  /** Where the header ends. */
  readonly end: number
  /** Whether it has no attribute, which ends the list of a multi-part file's headers. */
  readonly empty: boolean
  /** Its data window's size: that of the last attribute named `dataWindow` the loader keeps, when that is a `box2i`. */
  readonly size: PixelSize | undefined
}

/**
 * One header of an OpenEXR file as three.js's EXRLoader reads it: attributes up to an empty name, each a name, a type,
 * a length, and a value of the length the loader reads for its type.
 * @param bytes - the file.
 * @param start - where the header starts.
 * @returns the header, or undefined where the loader would read past the file or without end.
 */
function exrHeader(bytes: Bytes, start: number): ExrHeader | undefined {
  let at = start
  let empty = true
  let size: PixelSize | undefined
  for (;;) {
    const name = exrString(bytes, at)
    if (name === undefined) return undefined
    if (name.text === '') return { end: name.end, empty, size }
    empty = false
    const type = exrString(bytes, name.end)
    const length = type === undefined ? undefined : bytes.u32(type.end, true)
    if (type === undefined || length === undefined) return undefined
    const value = type.end + 4
    const end = type.text === 'chlist' ? exrChannelsEnd(bytes, value, length) : value + (EXR_FIXED.get(type.text) ?? length)
    if (end === undefined || end > bytes.length) return undefined
    if (name.text === 'dataWindow' && EXR_KEPT.has(type.text)) {
      const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map(offset => bytes.i32le(value + offset))
      size = type.text !== 'box2i' || xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined
        ? undefined
        : sized(xMax - xMin + 1, yMax - yMin + 1)
    }
    at = end
  }
}

/**
 * OpenEXR, as three.js's EXRLoader reads it: the data window of the first part's header, which the loader decodes,
 * after every header of a multi-part file, all of which it reads first.
 */
function exrSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.u32(0, true) !== EXR_MAGIC) return undefined
  const first = exrHeader(bytes, 8)
  if (first === undefined) return undefined
  const multiPart = ((bytes.u8(5) ?? 0) & 0x10) !== 0
  for (let header = first; multiPart && !header.empty;) {
    const next = exrHeader(bytes, header.end)
    if (next === undefined) return undefined
    header = next
  }
  return first.size
}

/**
 * The size an image file states for the browser's decoder, which it picks by the file's first bytes, whatever the
 * file's name.
 */
function browserSize(bytes: Bytes): PixelSize | undefined {
  if (bytes.u8(0) === 0x89 && bytes.ascii(1, 3) === 'PNG') return pngSize(bytes)
  if (bytes.u8(0) === 0xff && bytes.u8(1) === 0xd8) return jpegSize(bytes)
  if (bytes.ascii(0, 3) === 'GIF') return gifSize(bytes)
  if (bytes.ascii(0, 4) === 'RIFF' && bytes.ascii(8, 4) === 'WEBP') return webpSize(bytes)
  if (bytes.ascii(0, 2) === 'BM') return bmpSize(bytes)
  const iconType = bytes.u16(2, true)
  if (bytes.u16(0, true) === 0 && (iconType === 1 || iconType === 2)) return icoSize(bytes)
  if (bytes.ascii(4, 4) === 'ftyp') return avifSize(bytes)
  return undefined
}

/**
 * Whether the viewer reads an image format's size from its header before decoding it: every image format but SVG,
 * which has no pixels until it is drawn.
 * @param format - the format.
 * @returns whether a header states the format's size.
 */
export function statesPixels(format: AssetFormat): boolean {
  return format.kind === 'image' && format.mediaType !== 'image/svg+xml'
}

/**
 * The size in pixels an image file states before it is decoded, as its decoder will read it.
 * @param data - the file, or its first bytes; a size past them is not found.
 * @param format - the file's format, which names the three.js decoders; the browser's formats are read by content.
 * @returns the size, or undefined for an SVG and for a header that states none this reader can read.
 */
export function imageSize(data: Uint8Array, format: AssetFormat): PixelSize | undefined {
  if (!statesPixels(format)) return undefined
  const bytes = new Bytes(data)
  // The three.js decoders' formats; this module imports no value the viewer chunk also imports, which would split it.
  if (format.decoder === 'tga') return tgaSize(bytes)
  if (format.decoder === 'hdr') return hdrSize(bytes)
  if (format.decoder === 'exr') return exrSize(bytes)
  return browserSize(bytes)
}
