/**
 * The worker's analysis files and their level: the worker class writes every rendered or decoded window as a 32-bit
 * float WAV file, which {@link readFloatWav} reads into interleaved samples for the measurements and the picture of
 * `@deepseek-ai/dsh-game-audio/audio`, and {@link applyGain} scales them as a normalized render does.
 *
 * @module
 */
import type { AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'

const WAVE_FORMAT_IEEE_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

/**
 * Read a 32-bit float WAV file, as libsndfile writes it for the `WAV` header and `float` sample format.
 * @param bytes - the whole file.
 * @returns its samples.
 * @throws Error when the file is not a RIFF WAVE file with 32-bit float samples.
 */
export function readFloatWav(bytes: Buffer): AudioSamples {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('the analysis file is not a RIFF WAVE file')
  }
  let format: { channels: number; sampleRate: number } | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16) {
      const tag = bytes.readUInt16LE(body)
      const code = tag === WAVE_FORMAT_EXTENSIBLE && size >= 26 ? bytes.readUInt16LE(body + 24) : tag
      if (code !== WAVE_FORMAT_IEEE_FLOAT || bytes.readUInt16LE(body + 14) !== 32) throw new Error('the analysis file does not hold 32-bit float samples')
      format = { channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4) }
    } else if (id === 'data') {
      if (format === undefined || format.channels < 1) throw new Error('the analysis file has no usable format chunk before its data')
      const length = Math.min(size, bytes.length - body)
      const frames = Math.floor(length / 4 / format.channels)
      const samples = new Float32Array(frames * format.channels)
      for (let index = 0; index < samples.length; index++) samples[index] = bytes.readFloatLE(body + index * 4)
      return { sampleRate: format.sampleRate, channels: format.channels, frames, samples }
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2)
  }
  throw new Error('the analysis file has no data chunk')
}

/**
 * Multiply every sample by a gain, in place.
 * @param audio - the samples.
 * @param gain - linear factor.
 */
export function applyGain(audio: AudioSamples, gain: number): void {
  if (gain === 1) return
  for (let index = 0; index < audio.samples.length; index++) audio.samples[index] = (audio.samples[index] ?? 0) * gain
}
