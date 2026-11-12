/** Test audio: interleaved samples of sines and silence, and 32-bit float WAV files as libsndfile writes them. */
import type { AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'

/** Options of {@link floatWav}. */
export interface FloatWavOptions {
  /** Write the format chunk as WAVE_FORMAT_EXTENSIBLE, as libsndfile does for some channel layouts. */
  readonly extensible?: boolean
  /** Put an odd-sized chunk, with its pad byte, between the format and data chunks. */
  readonly oddChunk?: boolean
}

/**
 * A 32-bit float WAV file.
 * @param audio - interleaved samples.
 * @param options - header variants.
 * @returns the file bytes.
 */
export function floatWav(audio: AudioSamples, options: FloatWavOptions = {}): Buffer {
  const format = Buffer.alloc(options.extensible === true ? 40 : 16)
  format.writeUInt16LE(options.extensible === true ? 0xfffe : 3, 0)
  format.writeUInt16LE(audio.channels, 2)
  format.writeUInt32LE(audio.sampleRate, 4)
  format.writeUInt32LE(audio.sampleRate * audio.channels * 4, 8)
  format.writeUInt16LE(audio.channels * 4, 12)
  format.writeUInt16LE(32, 14)
  if (options.extensible === true) {
    format.writeUInt16LE(22, 16)
    format.writeUInt16LE(32, 18)
    // Sub-format GUID: its first two bytes hold the format code, 3 for IEEE float.
    format.writeUInt16LE(3, 24)
  }
  const data = Buffer.alloc(audio.samples.length * 4)
  audio.samples.forEach((value, index) => { data.writeFloatLE(value, index * 4) })
  const chunk = (id: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32LE(body.length, 4)
    return Buffer.concat([head, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const chunks = [chunk('fmt ', format), ...options.oddChunk === true ? [chunk('LIST', Buffer.from('odd'))] : [], chunk('data', data)]
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/**
 * Samples of a sine in every channel, between optional silence.
 * @param options - frequency in Hz, linear amplitude, seconds of sound, sample rate, channels, and seconds of silence around the sound.
 * @returns the interleaved samples.
 */
export function sine(options: {
  readonly frequency: number
  readonly amplitude: number
  readonly seconds: number
  readonly sampleRate?: number
  readonly channels?: number
  readonly before?: number
  readonly after?: number
  readonly offset?: number
}): AudioSamples {
  const sampleRate = options.sampleRate ?? 44_100
  const channels = options.channels ?? 1
  const before = Math.round((options.before ?? 0) * sampleRate)
  const sound = Math.round(options.seconds * sampleRate)
  const frames = before + sound + Math.round((options.after ?? 0) * sampleRate)
  const samples = new Float32Array(frames * channels)
  for (let frame = before; frame < before + sound; frame++) {
    const value = options.amplitude * Math.sin(2 * Math.PI * options.frequency * (frame - before) / sampleRate) + (options.offset ?? 0)
    for (let channel = 0; channel < channels; channel++) samples[frame * channels + channel] = value
  }
  return { sampleRate, channels, frames, samples }
}
