/** Audio measurements: levels, silence, loudness after BS.1770, the spectrum figures, the loop seam, and stereo. */
import { describe, expect, it } from 'vitest'
import {
  analyzeAudio, fft, integratedLoudness, loopSeam, magnitudeSpectrum, seamClicks, seamFrames, SILENCE_THRESHOLD, stereoImage,
  type AudioSamples,
} from '../src/audio/measure.ts'
import { drawAudioImage } from '../src/audio/picture.ts'
import { sine, slice } from './signals.ts'

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
    const nothing = { peak: 0, rms: 0, dcOffset: 0, clipped: 0, nonFinite: 0 }
    expect(empty.channels).toEqual([nothing, nothing])
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

  it('counts NaN and infinite samples as silence, so every figure stays finite', () => {
    const audio = sine({ frequency: 440, amplitude: 0.5, seconds: 1, sampleRate: 8000, channels: 2 })
    // Left: NaN at frame 1000 and -infinity at frame 3000; right: +infinity at frame 2000.
    audio.samples[2000] = Number.NaN
    audio.samples[6000] = Number.NEGATIVE_INFINITY
    audio.samples[4001] = Number.POSITIVE_INFINITY
    const analysis = analyzeAudio(audio)
    expect(analysis.channels.map(level => level.nonFinite)).toEqual([2, 1])
    expect(analysis.peak).toBeCloseTo(0.5, 3)
    expect(analysis.dominantFrequency).toBeCloseTo(440, -1)
    const seam = loopSeam(slice(audio, 7600, 8000), slice(audio, 0, 400))
    const stereo = stereoImage(audio)
    const figures = [
      analysis.rms, analysis.loudness, analysis.spectralCentroid,
      ...analysis.channels.flatMap(level => [level.peak, level.rms, level.dcOffset]),
      seam?.jump, seam?.step, seam?.levelChange, stereo?.correlation, stereo?.balance,
    ]
    for (const figure of figures) expect(Number.isFinite(figure), String(figure)).toBe(true)
    expect(drawAudioImage(audio).image.pixels.every(value => Number.isInteger(value))).toBe(true)
  })

  it('measures samples far beyond full scale, up to the largest 32-bit float, as finite figures', () => {
    const audio = sine({ frequency: 440, amplitude: 0.5, seconds: 1, sampleRate: 8000 })
    audio.samples[1000] = 2e6
    audio.samples[3000] = -3.4028234663852886e38
    const analysis = analyzeAudio(audio)
    expect(analysis.peak).toBe(3.4028234663852886e38)
    expect(analysis.channels[0]?.clipped).toBe(2)
    expect(analysis.channels[0]?.nonFinite).toBe(0)
    const figures = [analysis.rms, analysis.loudness, analysis.dominantFrequency, analysis.spectralCentroid, analysis.channels[0]?.dcOffset]
    for (const figure of figures) expect(Number.isFinite(figure), String(figure)).toBe(true)
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

describe('loopSeam, seamFrames, and seamClicks', () => {
  /** The two sides of a loop's seam, as a window reads them from the whole sound. */
  function sides(audio: AudioSamples, first = 0, end = audio.frames): readonly [AudioSamples, AudioSamples] {
    const frames = seamFrames(first, end, audio.sampleRate)
    if (frames === undefined) throw new Error('the loop has no seam')
    return [slice(audio, ...frames.tail), slice(audio, ...frames.head)]
  }

  it('finds no click where a whole number of cycles meets its start, and a click where a cycle is cut', () => {
    // 100 Hz at 8 kHz: 80 samples a cycle, so 0.5 s holds whole cycles and 0.5125 s cuts one at its peak.
    const whole = loopSeam(...sides(sine({ frequency: 100, amplitude: 0.5, seconds: 0.5, sampleRate: 8000 })))
    expect(whole?.jump).toBeLessThan(0.05)
    expect(seamClicks(whole ?? { jump: 1, step: 0 })).toBe(false)
    const cut = loopSeam(...sides(sine({ frequency: 100, amplitude: 0.5, seconds: 0.5125 - 1 / 8000, sampleRate: 8000 })))
    expect(cut?.jump).toBeGreaterThan(0.45)
    expect(cut?.step).toBeCloseTo(0.5 * 2 * Math.sin(Math.PI * 100 / 8000) / Math.SQRT2, 3)
    expect(seamClicks(cut ?? { jump: 0, step: 0 })).toBe(true)
  })

  it('measures a loop inside a sound at its own frames, whatever the sound does past them', () => {
    const audio = sine({ frequency: 100, amplitude: 0.5, seconds: 1, sampleRate: 8000 })
    // From frame 1000 to 5000, whole cycles; then a held level that would click if the whole sound repeated.
    audio.samples.fill(0.8, 7000)
    expect(loopSeam(...sides(audio, 1000, 5000))?.jump).toBeLessThan(0.05)
    expect(loopSeam(...sides(audio))?.jump).toBeCloseTo(0.8, 5)
    // From frame 1020, at a trough three quarters into a cycle, to frame 5000: the jump from about 0 to -0.5 clicks.
    expect(seamClicks(loopSeam(...sides(audio, 1020, 5000)) ?? { jump: 0, step: 0 })).toBe(true)
  })

  it('does not call a jump a click inside a sound whose samples already jump that much', () => {
    expect(seamClicks({ jump: 0.3, step: 0.2 })).toBe(false)
    expect(seamClicks({ jump: 0.04, step: 0 })).toBe(false)
  })

  it('compares the levels of the last and first 50 ms of the loop, and reads no further from the seam', () => {
    const rising = sine({ frequency: 100, amplitude: 0.5, seconds: 1, sampleRate: 8000 })
    for (let frame = 0; frame < 400; frame++) rising.samples[frame] = (rising.samples[frame] ?? 0) / 4
    expect(loopSeam(...sides(rising))?.levelChange).toBeCloseTo(20 * Math.log10(4), 1)
    expect(seamFrames(0, 8000, 8000)).toEqual({ tail: [7600, 8000], head: [0, 400] })
    // A loop shorter than both 50 ms stretches splits between them, with no level change to compare.
    expect(seamFrames(100, 500, 8000)).toEqual({ tail: [300, 500], head: [100, 300] })
    expect(loopSeam(...sides(sine({ frequency: 100, amplitude: 0.5, seconds: 0.05, sampleRate: 8000 })))?.levelChange).toBeUndefined()
    expect(seamFrames(10, 11, 8000)).toBeUndefined()
    expect(loopSeam(slice(rising, 0, 0), slice(rising, 0, 10))).toBeUndefined()
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
