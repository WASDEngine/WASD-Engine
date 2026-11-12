/** The worker's analysis files: float WAV reading and the gain of a normalized render. */
import { describe, expect, it } from 'vitest'
import { applyGain, readFloatWav } from '../src/audio.ts'
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
