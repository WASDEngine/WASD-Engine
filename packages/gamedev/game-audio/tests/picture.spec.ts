/** The audio picture: panel layout, clipping color, grid spacing, and the description text. */
import { describe, expect, it } from 'vitest'
import { describeAudioImage, drawAudioImage, IMAGE_WIDTH, type RgbImage } from '../src/audio/picture.ts'
import { sine } from './signals.ts'

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
