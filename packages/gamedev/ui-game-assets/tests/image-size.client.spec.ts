/**
 * Image sizes read from file headers before any pixel is decoded, for every image format the Assets tab lists that
 * has pixels, including a small file that states a huge size, and headers that are cut short or damaged.
 */
import { describe, expect, it } from 'vitest'
import { formatOf, type AssetFormat } from '../src/client/formats.ts'
import { imageSize } from '../src/client/image-size.ts'
import { decodedPixelLimit } from '../src/client/picture.ts'

/** Bytes from numbers and text. */
function bytes(...parts: readonly (ArrayLike<number> | string)[]): Uint8Array {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') for (const character of part) out.push(character.charCodeAt(0))
    else out.push(...Array.from(part))
  }
  return Uint8Array.from(out)
}

const u16be = (value: number) => [value >> 8, value & 0xff]
const u16le = (value: number) => [value & 0xff, value >> 8]
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, value >> 16]
const u32be = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const u32le = (value: number) => [...u32be(value)].reverse()

/** A PNG signature and IHDR chunk stating a size. */
const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(width), u32be(height), [8, 6, 0, 0, 0], u32be(0))

/** An ISO media box. */
const box = (type: string, ...content: readonly (readonly number[] | string)[]) => {
  const inner = bytes(...content)
  return [...u32be(inner.length + 8), ...Array.from(new TextEncoder().encode(type)), ...inner]
}

const size = (name: string, data: Uint8Array) => {
  const format = formatOf(name)
  if (format === undefined) throw new Error(name)
  return imageSize(data, format)
}

describe('imageSize', () => {
  it('reads the size each listed raster format states', () => {
    expect(size('a.png', png(640, 480))).toEqual({ width: 640, height: 480 })
    // A JPEG states its size in its frame header, after any number of other segments.
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0], u16be(16), 'JFIF', Array.from({ length: 10 }, () => 0), [0xff, 0xe1], u16be(1002), Array.from({ length: 1000 }, () => 7), [0xff, 0xc2], u16be(17), [8], u16be(300), u16be(400), [3])
    expect(size('a.jpg', jpeg)).toEqual({ width: 400, height: 300 })
    expect(size('a.gif', bytes('GIF89a', u16le(320), u16le(200), [0, 0, 0], [0x2c], u16le(0), u16le(0), u16le(320), u16le(200), [0]))).toEqual({ width: 320, height: 200 })
    expect(size('a.gif', bytes('GIF89a', u16le(320), u16le(200), [0, 0, 0], [0x3b]))).toEqual({ width: 320, height: 200 })
    expect(size('a.webp', bytes('RIFF', u32le(30), 'WEBP', 'VP8X', u32le(10), [0, 0, 0, 0], u24le(1023), u24le(767)))).toEqual({ width: 1024, height: 768 })
    expect(size('a.webp', bytes('RIFF', u32le(30), 'WEBP', 'VP8L', u32le(10), [0x2f], u32le((99 << 14) | 49)))).toEqual({ width: 50, height: 100 })
    expect(size('a.webp', bytes('RIFF', u32le(30), 'WEBP', 'VP8 ', u32le(10), [0, 0, 0, 0x9d, 0x01, 0x2a], u16le(256), u16le(128)))).toEqual({ width: 256, height: 128 })
    expect(size('a.bmp', bytes('BM', Array.from({ length: 12 }, () => 0), u32le(40), u32le(64), u32le(-32 >>> 0)))).toEqual({ width: 64, height: 32 })
    // An icon's largest entry, a PNG entry by its own header.
    const pngEntry = png(512, 512)
    const icon = bytes(
      u16le(0), u16le(1), u16le(2),
      [32, 32, 0, 0], u16le(1), u16le(32), u32le(100), u32le(6 + 32),
      [0, 0, 0, 0], u16le(1), u16le(32), u32le(pngEntry.length), u32le(6 + 32 + 100),
    )
    expect(size('a.ico', bytes(icon, Array.from({ length: 100 }, () => 0), [...pngEntry]))).toEqual({ width: 512, height: 512 })
    // An AVIF's largest image property.
    const avif = bytes(box('ftyp', 'avif', u32be(0), 'avifmif1'), box('meta', u32be(0), box('hdlr', u32be(0), u32be(0), 'pict'), box('iprp', box('ipco', box('ispe', u32be(0), u32be(64), u32be(64)), box('ispe', u32be(0), u32be(2048), u32be(1024))))))
    expect(size('a.avif', avif)).toEqual({ width: 2048, height: 1024 })
    expect(size('a.tga', bytes([0, 0, 2], Array.from({ length: 9 }, () => 0), u16le(128), u16le(64), [32, 8]))).toEqual({ width: 128, height: 64 })
    expect(size('a.hdr', bytes('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 600 +X 800\n'))).toEqual({ width: 800, height: 600 })
    const exr = bytes(u32le(20000630), u32le(2), 'compression\0compression\0', u32le(1), [0], 'dataWindow\0box2i\0', u32le(16), u32le(0), u32le(0), u32le(1023), u32le(511), [0])
    expect(size('a.exr', exr)).toEqual({ width: 1024, height: 512 })
  })

  it('reads a huge size from a small file, before anything is decoded', () => {
    const bomb = png(50_000, 50_000)
    expect(bomb.byteLength).toBeLessThan(64)
    expect(size('bomb.png', bomb)).toEqual({ width: 50_000, height: 50_000 })
  })

  it('reads each header as the decoder that reads the file does', () => {
    // libjpeg skips stray bytes, fill bytes, and stuffed zeros before a marker.
    const frame = [[0xff, 0xc0], u16be(17), [8], u16be(30_000), u16be(30_000), [3]]
    expect(size('a.jpg', bytes([0xff, 0xd8], [0x00, 0x13], ...frame))).toEqual({ width: 30_000, height: 30_000 })
    expect(size('a.jpg', bytes([0xff, 0xd8], [0xff, 0x00, 0x42, 0xff, 0xff], ...frame))).toEqual({ width: 30_000, height: 30_000 })
    // A marker libjpeg fails on before the frame, such as a second start of image, states no size.
    expect(size('a.jpg', bytes([0xff, 0xd8, 0xff, 0xd8], ...frame))).toBeUndefined()
    // Browsers grow a GIF's screen to its first frame's bounds, past a color table and extensions.
    const table = Array.from({ length: 6 }, () => 0)
    const extension = [0x21, 0xf9, 4, 0, 0, 0, 0, 0]
    const grown = bytes('GIF89a', u16le(1), u16le(1), [0x80, 0, 0], table, extension, [0x2c], u16le(100), u16le(50), u16le(30_000), u16le(20_000), [0])
    expect(size('a.gif', grown)).toEqual({ width: 30_100, height: 20_050 })
    // A GIF that ends before its first frame or its trailer states no size.
    expect(size('a.gif', bytes('GIF89a', u16le(1), u16le(1), [0, 0, 0], extension))).toBeUndefined()
    // HDRLoader takes the resolution from any header line once FORMAT is read, with any spaces, and skips comments.
    expect(size('a.hdr', bytes('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n-Y 30000 +X 20000\n'))).toEqual({ width: 20_000, height: 30_000 })
    expect(size('a.hdr', bytes('#?RADIANCE\r\n# -Y 1 +X 1\r\nFORMAT=32-bit_rle_rgbe\r\n-Y  600\t+X 800\r\n'))).toEqual({ width: 800, height: 600 })
    // A resolution before FORMAT is the one the loader keeps: it stops at the line where it has both.
    expect(size('a.hdr', bytes('#?RADIANCE\n-Y 4 +X 4\nFORMAT=32-bit_rle_rgbe\n-Y 600 +X 800\n'))).toEqual({ width: 4, height: 4 })
    // EXRLoader keeps the last data window, and an attribute of a type it does not read replaces nothing.
    const exr = (...attributes: readonly (readonly number[] | string)[]) => bytes(u32le(20000630), u32le(2), ...attributes, [0])
    const dataWindow = (side: number) => ['dataWindow\0box2i\0', u32le(16), u32le(0), u32le(0), u32le(side - 1), u32le(side - 1)] as const
    expect(size('a.exr', exr(...dataWindow(1), ...dataWindow(30_000)))).toEqual({ width: 30_000, height: 30_000 })
    expect(size('a.exr', exr(...dataWindow(64), 'dataWindow\0custom\0', u32le(2), [1, 2]))).toEqual({ width: 64, height: 64 })
    expect(size('a.exr', exr(...dataWindow(64), 'dataWindow\0string\0', u32le(2), 'ab'))).toBeUndefined()
    // A header without its closing empty name, which the loader would read without end, states no size.
    expect(size('a.exr', bytes(u32le(20000630), u32le(2), ...dataWindow(64)))).toBeUndefined()
    // The browser decodes the format the content names, whatever the file's name.
    expect(size('named.png', bytes('GIF89a', u16le(1), u16le(1), [0, 0, 0], [0x2c], u16le(0), u16le(0), u16le(9000), u16le(9000), [0]))).toEqual({ width: 9000, height: 9000 })
  })

  it('states no size for an SVG, a header cut short, or a file that is not of its format', () => {
    expect(size('a.svg', bytes('<svg width="100000" height="100000"/>'))).toBeUndefined()
    expect(size('a.png', png(640, 480).subarray(0, 20))).toBeUndefined()
    expect(size('a.png', bytes('not a png at all, just some text'))).toBeUndefined()
    expect(size('a.jpg', bytes([0xff, 0xd8], [0xff, 0xe1], u16be(1000)))).toBeUndefined()
    expect(size('a.gif', bytes('GIF89a', u16le(0), u16le(10)))).toBeUndefined()
    expect(size('a.exr', bytes(u32le(20000630), u32le(2), 'channels\0chlist\0', u32le(1_000_000)))).toBeUndefined()
    expect(size('a.hdr', bytes('#?RADIANCE\nno resolution\n'))).toBeUndefined()
    expect(size('a.glb', png(1, 1))).toBeUndefined()
  })

  it('reads an AVIF only along meta, iprp, and ipco, however deep its other boxes nest', () => {
    // Thirty thousand nested `meta` boxes, which a walk entering every `meta` box would follow until the stack ends.
    const ftyp = box('ftyp', 'avif', u32be(0), 'avifmif1')
    const ispe = box('ispe', u32be(0), u32be(4096), u32be(4096))
    const levels = 30_000
    const deep = new Uint8Array(ftyp.length + levels * 12 + ispe.length)
    deep.set(ftyp)
    for (let level = 0, at = ftyp.length; level < levels; level += 1, at += 12) {
      // Each `meta` box holds the rest of the file: its size, its type, and four bytes of version and flags.
      deep.set([...u32be(deep.length - at), ...Array.from('meta', character => character.charCodeAt(0)), 0, 0, 0, 0], at)
    }
    deep.set(ispe, ftyp.length + levels * 12)
    expect(size('deep.avif', deep)).toBeUndefined()
    // An `ispe` box outside the item properties states no image's size.
    const stray = bytes(box('ftyp', 'avif', u32be(0), 'avifmif1'), box('meta', u32be(0), box('ispe', u32be(0), u32be(4096), u32be(4096)), box('iprp', box('ipco', box('ispe', u32be(0), u32be(32), u32be(16))))))
    expect(size('stray.avif', stray)).toEqual({ width: 32, height: 16 })
  })
})

describe('decodedPixelLimit', () => {
  it('gives TGA, HDR, and EXR images as many pixels as take a browser image\'s memory decoded', () => {
    const limit = 8192 * 8192
    expect(decodedPixelLimit(formatOf('a.png') as AssetFormat, limit)).toBe(limit)
    expect(decodedPixelLimit(formatOf('a.tga') as AssetFormat, limit)).toBe(Math.floor(limit / 3))
    for (const name of ['sky.hdr', 'sky.exr']) expect(decodedPixelLimit(formatOf(name) as AssetFormat, limit)).toBe(Math.floor(limit / 6))
  })
})
