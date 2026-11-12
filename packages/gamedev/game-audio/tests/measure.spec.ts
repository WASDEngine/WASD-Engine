/** Audio measurements: levels, silence, loudness after BS.1770, the spectrum figures, the loop seam, and stereo. */
import { describe, expect, it } from 'vitest'
import {
  analyzeAudio, fft, integratedLoudness, loopSeam, magnitudeSpectrum, seamClicks, SILENCE_THRESHOLD, stereoImage,
} from '../src/audio/measure.ts'
import { sine } from './signals.ts'

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

  it('measures the DC offset of a constant signal, which has no spectrum beside it', () => {
    for (const sampleRate of [8000, 22_254.545_454_545_45, 44_100]) {
      const frames = Math.round(sampleRate)
      for (const level of [0.5, -0.25]) {
        const dc = analyzeAudio({ sampleRate, channels: 2, frames, samples: new Float32Array(frames * 2).fill(level) })
        expect(dc.channels[0]?.dcOffset).toBeCloseTo(level, 5)
        expect(dc).toMatchObject({ dominantFrequency: undefined, spectralCentroid: undefined })
        expect(dc.leadingSilence).toBe(0)
      }
    }
  })

  it('names the pitch of a sine on a DC offset, also where the offset outweighs a quiet, low sine', () => {
    for (const sampleRate of [8000, 22_050, 48_000]) {
      const signals = [{ frequency: 440, amplitude: 0.3, offset: 0.5 }, { frequency: 50, amplitude: 0.02, offset: 0.6 }]
      for (const { frequency, amplitude, offset } of signals) {
        const analysis = analyzeAudio(sine({ frequency, amplitude, seconds: 1.5, sampleRate, offset }))
        expect(analysis.channels[0]?.dcOffset).toBeCloseTo(offset, 2)
        expect(analysis.dominantFrequency).toBeCloseTo(frequency, -1)
        expect(analysis.dominantFrequency).toBeGreaterThan(0)
        expect(analysis.spectralCentroid).toBeGreaterThan(0)
      }
    }
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

describe('loopSeam and seamClicks', () => {
  it('finds no click where a whole number of cycles meets its start, and a click where a cycle is cut', () => {
    // 100 Hz at 8 kHz: 80 samples a cycle, so 0.5 s holds whole cycles and 0.5125 s cuts one at its peak.
    const whole = loopSeam(sine({ frequency: 100, amplitude: 0.5, seconds: 0.5, sampleRate: 8000 }))
    expect(whole?.jump).toBeLessThan(0.05)
    expect(seamClicks(whole ?? { jump: 1, step: 0 })).toBe(false)
    const cut = loopSeam(sine({ frequency: 100, amplitude: 0.5, seconds: 0.5125 - 1 / 8000, sampleRate: 8000 }))
    expect(cut?.jump).toBeGreaterThan(0.45)
    expect(cut?.step).toBeCloseTo(0.5 * 2 * Math.sin(Math.PI * 100 / 8000) / Math.SQRT2, 3)
    expect(seamClicks(cut ?? { jump: 0, step: 0 })).toBe(true)
  })

  it('does not call a jump a click inside a sound whose samples already jump that much', () => {
    expect(seamClicks({ jump: 0.3, step: 0.2 })).toBe(false)
    expect(seamClicks({ jump: 0.04, step: 0 })).toBe(false)
  })

  it('compares the level of the last and first 50 ms, and measures nothing for one frame', () => {
    const rising = sine({ frequency: 100, amplitude: 0.5, seconds: 1, sampleRate: 8000 })
    for (let frame = 0; frame < 400; frame++) rising.samples[frame] = (rising.samples[frame] ?? 0) / 4
    expect(loopSeam(rising)?.levelChange).toBeCloseTo(20 * Math.log10(4), 1)
    expect(loopSeam(sine({ frequency: 100, amplitude: 0.5, seconds: 0.05, sampleRate: 8000 }))?.levelChange).toBeUndefined()
    expect(loopSeam({ sampleRate: 8000, channels: 1, frames: 1, samples: Float32Array.of(0.5) })).toBeUndefined()
  })
})

describe('stereoImage', () => {
  it('finds identical channels, a balance between them, and channels in opposite phase', () => {
    expect(stereoImage(sine({ frequency: 440, amplitude: 0.5, seconds: 0.1, channels: 2 })))
      .toEqual({ correlation: 1, balance: 0, identical: true })
    const left = sine({ frequency: 440, amplitude: 0.5, seconds: 0.1, channels: 2 })
    for (let frame = 0; frame < left.frames; frame++) left.samples[frame * 2 + 1] = (left.samples[frame * 2 + 1] ?? 0) / 2
    expect(stereoImage(left)).toMatchObject({ identical: false, correlation: 1 })
    expect(stereoImage(left)?.balance).toBeCloseTo(6.02, 1)
    const opposite = sine({ frequency: 440, amplitude: 0.5, seconds: 0.1, channels: 2 })
    for (let frame = 0; frame < opposite.frames; frame++) opposite.samples[frame * 2 + 1] = -(opposite.samples[frame * 2 + 1] ?? 0)
    expect(stereoImage(opposite)?.correlation).toBeCloseTo(-1, 5)
  })

  it('measures only two-channel sound, and no correlation or balance with a silent side', () => {
    expect(stereoImage(sine({ frequency: 440, amplitude: 0.5, seconds: 0.1 }))).toBeUndefined()
    const silentRight = sine({ frequency: 440, amplitude: 0.5, seconds: 0.1, channels: 2 })
    for (let frame = 0; frame < silentRight.frames; frame++) silentRight.samples[frame * 2 + 1] = 0
    expect(stereoImage(silentRight)).toEqual({ correlation: undefined, balance: undefined, identical: false })
  })
})
