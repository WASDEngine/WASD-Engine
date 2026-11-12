/** PNG encoding of the audio picture: valid PNG bytes whose rows decode back to the pixels. */
import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { RgbImage } from '@deepseek-ai/dsh-game-audio/audio'
import { encodePng } from '../src/png.ts'

describe('encodePng', () => {
  it('writes a valid RGB PNG whose rows decode back to the pixels', () => {
    const pixels = Uint8Array.from([1, 2, 3, 250, 251, 252, 9, 8, 7, 0, 255, 0, 5, 5, 5, 200, 100, 50])
    const image: RgbImage = { width: 3, height: 2, pixels }
    const png = encodePng(image)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunks: { type: string; data: Buffer }[] = []
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset)
      const type = png.toString('latin1', offset + 4, offset + 8)
      const data = png.subarray(offset + 8, offset + 8 + length)
      expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)))
      chunks.push({ type, data })
      offset += 12 + length
    }
    expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const header = chunks[0]?.data ?? Buffer.alloc(0)
    expect([header.readUInt32BE(0), header.readUInt32BE(4), ...header.subarray(8)]).toEqual([3, 2, 8, 2, 0, 0, 0])
    const filtered = inflateSync(chunks[1]?.data ?? Buffer.alloc(0))
    const decoded: number[] = []
    for (let y = 0; y < 2; y++) {
      expect(filtered[y * 10]).toBe(2)
      for (let x = 0; x < 9; x++) decoded.push(((filtered[y * 10 + 1 + x] ?? 0) + (y === 0 ? 0 : decoded[(y - 1) * 9 + x] ?? 0)) & 0xff)
    }
    expect(decoded).toEqual(Array.from(image.pixels))
  })

  it('refuses pixel buffers that do not match the dimensions', () => {
    expect(() => encodePng({ width: 2, height: 2, pixels: new Uint8Array(11) })).toThrow(RangeError)
    expect(() => encodePng({ width: 0, height: 2, pixels: new Uint8Array(0) })).toThrow(RangeError)
    expect(() => encodePng({ width: 1.5, height: 2, pixels: new Uint8Array(9) })).toThrow(RangeError)
  })
})
