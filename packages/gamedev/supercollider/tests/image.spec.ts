/** The audio picture and its PNG encoding: panel layout, clipping color, grid spacing, the description text, and valid PNG bytes. */
import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { describeAudioImage, drawAudioImage, IMAGE_WIDTH } from '../src/image.ts'
import { encodePng, type RgbImage } from '../src/png.ts'
import { sine } from './wav.ts'

function pixel(image: RgbImage, x: number, y: number): number[] {
  return Array.from(image.pixels.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3))
}

function hasBright(image: RgbImage): boolean {
  for (let index = 0; index < image.pixels.length; index += 3) {
    if ((image.pixels[index] ?? 0) > 240 && (image.pixels[index + 1] ?? 0) > 180) return true
  }
  return false
}

function hasColor(image: RgbImage, color: readonly number[]): boolean {
  for (let index = 0; index < image.pixels.length; index += 3) {
    if (image.pixels[index] === color[0] && image.pixels[index + 1] === color[1] && image.pixels[index + 2] === color[2]) return true
  }
  return false
}

describe('drawAudioImage', () => {
  it('stacks one waveform panel per channel up to two, then a mix panel, above the spectrogram', () => {
    const mono = drawAudioImage(sine({ frequency: 440, amplitude: 0.5, seconds: 1 }))
    expect(mono.layout).toEqual({ width: IMAGE_WIDTH, height: 418, waveformPanels: 'channels', timeStep: 0.1, nyquist: 22_050 })
    expect(mono.image.pixels).toHaveLength(IMAGE_WIDTH * 418 * 3)
    expect(drawAudioImage(sine({ frequency: 440, amplitude: 0.5, seconds: 30, sampleRate: 8000, channels: 2 })).layout)
      .toEqual({ width: IMAGE_WIDTH, height: 536, waveformPanels: 'channels', timeStep: 5, nyquist: 4000 })
    expect(drawAudioImage(sine({ frequency: 440, amplitude: 0.5, seconds: 0.2, sampleRate: 8000, channels: 3 })).layout)
      .toMatchObject({ height: 418, waveformPanels: 'mix' })
  })

  it('draws the waveform in blue, clipped columns in red, and a bright spectrogram line for a loud tone', () => {
    const clean = drawAudioImage(sine({ frequency: 440, amplitude: 0.5, seconds: 0.5 })).image
    expect(hasColor(clean, [96, 200, 240])).toBe(true)
    expect(hasColor(clean, [255, 82, 82])).toBe(false)
    expect(hasBright(clean)).toBe(true)
    expect(hasBright(drawAudioImage(sine({ frequency: 440, amplitude: 0.0001, seconds: 0.5 })).image)).toBe(false)
    expect(pixel(clean, 0, 0)).toEqual([17, 19, 24])
    const clipped = drawAudioImage(sine({ frequency: 440, amplitude: 1.5, seconds: 0.5 })).image
    expect(hasColor(clipped, [255, 82, 82])).toBe(true)
  })

  it('draws short windows with at least one frame per column, and long windows with the longest grid spacing', () => {
    const short = { sampleRate: 8000, channels: 1, frames: 10, samples: new Float32Array(10).fill(0.5) }
    expect(drawAudioImage(short).layout.timeStep).toBe(0.01)
    const long = { sampleRate: 100, channels: 1, frames: 200_000, samples: new Float32Array(200_000) }
    expect(drawAudioImage(long).layout.timeStep).toBe(120)
  })
})

describe('describeAudioImage', () => {
  it('names the panels, the frequency lines below the Nyquist frequency, and the grid spacing', () => {
    expect(describeAudioImage({ width: 1024, height: 418, waveformPanels: 'channels', timeStep: 0.1, nyquist: 22_050 })).toBe(
      'Image (1024 x 418): the waveform of each channel at the top (full scale is the panel height; red columns reach full scale), and below it '
      + 'the spectrogram of the channel mix (time runs left to right; frequency rises from 20 Hz at the bottom to 22.05 kHz at the top on a '
      + 'logarithmic axis, with dotted lines at 100 Hz, 1 kHz, 10 kHz; brighter is louder over a 90 dB range). Dotted vertical lines mark every 100 ms.',
    )
    const text = describeAudioImage({ width: 1024, height: 418, waveformPanels: 'mix', timeStep: 5, nyquist: 4000 })
    expect(text).toContain('the waveform of the channel mix')
    expect(text).toContain('to 4 kHz at the top on a logarithmic axis, with dotted lines at 100 Hz, 1 kHz;')
    expect(text).toContain('mark every 5 s.')
    expect(describeAudioImage({ width: 1024, height: 418, waveformPanels: 'mix', timeStep: 1, nyquist: 50 }))
      .toContain('to 50 Hz at the top on a logarithmic axis; brighter')
  })
})

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
