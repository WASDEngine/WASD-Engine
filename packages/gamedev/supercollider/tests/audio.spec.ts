/** Audio measurements: float WAV reading, levels, silence, loudness after BS.1770, and the spectrum figures. */
import { describe, expect, it } from 'vitest'
import { analyzeAudio, applyGain, fft, integratedLoudness, magnitudeSpectrum, readFloatWav, SILENCE_THRESHOLD } from '../src/audio.ts'
import { floatWav, sine } from './wav.ts'

describe('readFloatWav', () => {
  it('reads the samples of plain and extensible float WAV files and skips padded chunks', () => {
    const audio = sine({ frequency: 100, amplitude: 0.5, seconds: 0.01, channels: 2 })
    for (const options of [{}, { extensible: true }, { oddChunk: true }]) {
      const read = readFloatWav(floatWav(audio, options))
      expect(read).toMatchObject({ sampleRate: 44_100, channels: 2, frames: audio.frames })
      expect(Array.from(read.samples)).toEqual(Array.from(audio.samples))
    }
  })

  it('stops at the end of a truncated data chunk', () => {
    const bytes = floatWav(sine({ frequency: 100, amplitude: 0.5, seconds: 0.01 }))
    expect(readFloatWav(bytes.subarray(0, bytes.length - 6)).frames).toBe(Math.round(0.01 * 44_100) - 2)
  })

  it('names what makes a file unreadable', () => {
    const audio = sine({ frequency: 100, amplitude: 0.5, seconds: 0.01 })
    const valid = floatWav(audio)
    expect(() => readFloatWav(Buffer.from('not a wave file'))).toThrow('not a RIFF WAVE file')
    const integer = Buffer.from(valid)
    integer.writeUInt16LE(1, 20)
    expect(() => readFloatWav(integer)).toThrow('does not hold 32-bit float samples')
    const sixteenBit = Buffer.from(valid)
    sixteenBit.writeUInt16LE(16, 34)
    expect(() => readFloatWav(sixteenBit)).toThrow('does not hold 32-bit float samples')
    const dataFirst = Buffer.from(valid)
    dataFirst.write('junk', 12, 'latin1')
    expect(() => readFloatWav(dataFirst)).toThrow('no usable format chunk')
    const noChannels = Buffer.from(valid)
    noChannels.writeUInt16LE(0, 22)
    expect(() => readFloatWav(noChannels)).toThrow('no usable format chunk')
    expect(() => readFloatWav(valid.subarray(0, 44 - 8))).toThrow('no data chunk')
  })
})

describe('applyGain', () => {
  it('scales every sample and leaves a unit gain alone', () => {
    const audio = { sampleRate: 8000, channels: 1, frames: 2, samples: Float32Array.from([0.25, -0.5]) }
    applyGain(audio, 1)
    expect(Array.from(audio.samples)).toEqual([0.25, -0.5])
    applyGain(audio, 2)
    expect(Array.from(audio.samples)).toEqual([0.5, -1])
  })
})

describe('analyzeAudio', () => {
  it('measures levels, silence around the sound, and the dominant frequency', () => {
    const analysis = analyzeAudio(sine({ frequency: 440, amplitude: 0.5, seconds: 1, channels: 2, before: 0.25, after: 0.5 }))
    expect(analysis.seconds).toBeCloseTo(1.75, 5)
    expect(analysis.channels).toHaveLength(2)
    expect(analysis.peak).toBeCloseTo(0.5, 3)
    expect(analysis.channels[0]?.rms).toBeCloseTo(0.5 / Math.SQRT2 * Math.sqrt(1 / 1.75), 3)
    expect(analysis.rms).toBeCloseTo(analysis.channels[0]?.rms ?? 0, 6)
    expect(analysis.channels[0]?.clipped).toBe(0)
    expect(analysis.leadingSilence).toBeCloseTo(0.25, 3)
    expect(analysis.trailingSilence).toBeCloseTo(0.5, 3)
    expect(analysis.dominantFrequency).toBeCloseTo(440, 0)
    expect(analysis.spectralCentroid).toBeGreaterThan(400)
    expect(analysis.spectralCentroid).toBeLessThan(600)
  })

  it('counts clipped samples and reports a DC offset', () => {
    const analysis = analyzeAudio(sine({ frequency: 100, amplitude: 1.2, seconds: 0.5, offset: 0.1 }))
    expect(analysis.channels[0]?.clipped).toBeGreaterThan(0)
    expect(analysis.channels[0]?.dcOffset).toBeCloseTo(0.1, 2)
  })

  it('reports a silent window as silence throughout, without loudness or spectrum', () => {
    const quiet = new Float32Array(44_100).fill(SILENCE_THRESHOLD / 2)
    const silent = analyzeAudio({ sampleRate: 44_100, channels: 1, frames: 44_100, samples: quiet })
    expect(silent).toMatchObject({ seconds: 1, leadingSilence: 1, trailingSilence: 1 })
    expect(silent).toMatchObject({ dominantFrequency: undefined, spectralCentroid: undefined })
    const empty = analyzeAudio({ sampleRate: 44_100, channels: 2, frames: 0, samples: new Float32Array(0) })
    expect(empty).toMatchObject({ seconds: 0, peak: 0, rms: 0, loudness: undefined })
    expect(empty.channels).toEqual([{ peak: 0, rms: 0, dcOffset: 0, clipped: 0 }, { peak: 0, rms: 0, dcOffset: 0, clipped: 0 }])
  })

  it('measures the DC offset of a constant signal', () => {
    const dc = analyzeAudio({ sampleRate: 8000, channels: 1, frames: 8000, samples: new Float32Array(8000).fill(0.5) })
    expect(dc.dominantFrequency).toBeDefined()
    expect(dc.channels[0]?.dcOffset).toBeCloseTo(0.5, 5)
  })
})

describe('integratedLoudness', () => {
  it('reads a full-scale 997 Hz sine in one channel as -3.01 LUFS at 48 kHz and 44.1 kHz', () => {
    for (const sampleRate of [48_000, 44_100]) {
      expect(integratedLoudness(sine({ frequency: 997, amplitude: 1, seconds: 2, sampleRate }))).toBeCloseTo(-3.01, 1)
    }
  })

  it('adds the energy of both channels', () => {
    const amplitude = 10 ** (-20 / 20)
    expect(integratedLoudness(sine({ frequency: 997, amplitude, seconds: 2, sampleRate: 48_000, channels: 2 }))).toBeCloseTo(-20, 1)
  })

  it('gates out quiet blocks, and measures nothing without a full block or above the gates', () => {
    const loud = sine({ frequency: 997, amplitude: 0.5, seconds: 1, sampleRate: 48_000, after: 3 })
    const plain = sine({ frequency: 997, amplitude: 0.5, seconds: 1, sampleRate: 48_000 })
    // Without gating, three seconds of silence would lower the reading by 6 dB; only the blocks at the sound's end lower it.
    const gated = integratedLoudness(loud) ?? -Infinity
    const reference = integratedLoudness(plain) ?? Infinity
    expect(gated).toBeLessThan(reference)
    expect(gated).toBeGreaterThan(reference - 2)
    expect(integratedLoudness(sine({ frequency: 997, amplitude: 1, seconds: 0.3 }))).toBeUndefined()
    expect(integratedLoudness(sine({ frequency: 997, amplitude: 1e-5, seconds: 1 }))).toBeUndefined()
    expect(integratedLoudness({ sampleRate: 1, channels: 1, frames: 0, samples: new Float32Array(0) })).toBeUndefined()
  })
})

describe('fft and magnitudeSpectrum', () => {
  it('transforms in place', () => {
    const close = (actual: Float64Array, expected: readonly number[]): void => {
      expect(actual).toHaveLength(expected.length)
      expected.forEach((value, index) => { expect(actual[index]).toBeCloseTo(value, 10) })
    }
    const real = Float64Array.from([1, 2, 3, 4])
    const imaginary = new Float64Array(4)
    fft(real, imaginary)
    close(real, [10, -2, -2, -2])
    close(imaginary, [0, 2, 0, -2])
    const impulseReal = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0])
    const impulseImaginary = new Float64Array(8)
    fft(impulseReal, impulseImaginary)
    close(impulseReal, new Array<number>(8).fill(1))
    close(impulseImaginary, new Array<number>(8).fill(0))
  })

  it('peaks at about a quarter of the size for a full-scale sine on its bin', () => {
    const size = 1024
    const sampleRate = 8192
    const spectrum = magnitudeSpectrum(sine({ frequency: 1024, amplitude: 1, seconds: 1, sampleRate }), sampleRate / 2, size)
    expect(spectrum).toHaveLength(size / 2 + 1)
    expect(spectrum[size / 8]).toBeCloseTo(size / 4, 0)
    // Frames outside the audio count as silence.
    const outside = magnitudeSpectrum(sine({ frequency: 1024, amplitude: 1, seconds: 0.01, sampleRate }), -size, size)
    expect(outside.every(value => value === 0)).toBe(true)
  })
})
