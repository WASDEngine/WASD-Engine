/** Test audio: interleaved samples of sines between silence, and the bytes of small audio files. */
import type { AudioSamples } from '../src/audio/measure.ts'

/**
 * Samples of a sine in every channel, between optional silence.
 * @param options - frequency in Hz, linear amplitude, seconds of sound, sample rate, channels, seconds of silence around
 * the sound, and a constant offset.
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

/** A little-endian or big-endian byte writer for test files. */
export class Bytes {
  private readonly parts: number[] = []

  /** @returns the bytes written. */
  get bytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.parts)
  }

  /** @param text - Latin-1 characters to write. @returns this writer. */
  text(text: string): this {
    for (const character of text) this.parts.push(character.charCodeAt(0) & 0xff)
    return this
  }

  /** @param values - bytes to write. @returns this writer. */
  raw(...values: number[]): this {
    return this.append(values)
  }

  /** @param values - bytes to write, any number of them. @returns this writer. */
  append(values: ArrayLike<number>): this {
    for (let index = 0; index < values.length; index++) this.parts.push((values[index] ?? 0) & 0xff)
    return this
  }

  /** @param value - value. @param bytes - width. @param big - big-endian. @returns this writer. */
  int(value: number, bytes: number, big = false): this {
    const out: number[] = []
    // BigInt keeps 64-bit values such as an Ogg granule position of -1 exact.
    let rest = BigInt(value) < 0n ? (1n << BigInt(bytes * 8)) + BigInt(value) : BigInt(value)
    for (let index = 0; index < bytes; index++) {
      out.push(Number(rest & 0xffn))
      rest >>= 8n
    }
    this.parts.push(...big ? out.reverse() : out)
    return this
  }

  /** @param count - zero bytes to write. @returns this writer. */
  zeros(count: number): this {
    return this.append(new Uint8Array(count))
  }
}

/**
 * A reader over in-memory bytes, as the probe takes.
 * @param bytes - the file.
 * @returns the reader, which records each window it reads.
 */
export function memoryReader(bytes: Uint8Array): {
  readonly read: (offset: number, length: number) => Promise<Uint8Array>
  readonly reads: (readonly [number, number])[]
} {
  const reads: (readonly [number, number])[] = []
  return {
    reads,
    read: (offset, length) => {
      reads.push([offset, length])
      return Promise.resolve(bytes.subarray(offset, Math.min(bytes.length, offset + length)))
    },
  }
}

/**
 * A WAV file of silent PCM frames.
 * @param options - rate, channels, bits per sample, frames, format code, chunks before the format chunk, a sampler loop,
 * and a data length to write instead of the real one.
 * @returns the file bytes.
 */
export function pcmWav(options: {
  readonly sampleRate?: number
  readonly channels?: number
  readonly bits?: number
  readonly frames: number
  readonly code?: number
  readonly extensible?: boolean
  readonly before?: readonly (readonly [string, number])[]
  readonly loop?: readonly [number, number]
  readonly dataLength?: number
}): Uint8Array<ArrayBuffer> {
  const sampleRate = options.sampleRate ?? 48_000
  const channels = options.channels ?? 1
  const bits = options.bits ?? 16
  const block = channels * bits / 8
  const body = new Bytes().text('WAVE')
  for (const [id, length] of options.before ?? []) body.text(id).int(length, 4).zeros(length + (length % 2))
  const format = new Bytes()
    .int(options.extensible === true ? 0xfffe : options.code ?? 1, 2).int(channels, 2).int(sampleRate, 4)
    .int(sampleRate * block, 4).int(block, 2).int(bits, 2)
  if (options.extensible === true) format.int(22, 2).int(bits, 2).int(0, 4).int(options.code ?? 1, 2).zeros(14)
  body.text('fmt ').int(format.bytes.length, 4).append(format.bytes)
  body.text('data').int(options.dataLength ?? options.frames * block, 4).zeros(options.frames * block)
  if (options.loop !== undefined) {
    body.text('smpl').int(60, 4).zeros(28).int(1, 4).int(0, 4).int(0, 4).int(0, 4).int(options.loop[0], 4).int(options.loop[1], 4).int(0, 4).int(0, 4)
  }
  const finished = body.bytes
  return new Bytes().text('RIFF').int(finished.length, 4).append(finished).bytes
}

/**
 * The ten bytes of an IEEE 754 80-bit extended number, as AIFF stores its sample rate.
 * @param value - a positive integer.
 * @returns the bytes, big-endian.
 */
export function extended(value: number): number[] {
  const exponent = Math.floor(Math.log2(value))
  const mantissa = BigInt(value) << BigInt(63 - exponent)
  const bytes = [((exponent + 16_383) >> 8) & 0x7f, (exponent + 16_383) & 0xff]
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number((mantissa >> shift) & 0xffn))
  return bytes
}

/**
 * An AIFF or AIFC file.
 * @param options - rate, channels, bits, the compression type of an AIFC file, and the stored sample bytes.
 * @returns the file bytes.
 */
export function aiff(options: {
  readonly sampleRate: number
  readonly channels: number
  readonly bits: number
  readonly frames: number
  readonly compression?: string
  readonly samples: readonly number[]
}): Uint8Array<ArrayBuffer> {
  const comm = new Bytes().int(options.channels, 2, true).int(options.frames, 4, true).int(options.bits, 2, true)
    .append(extended(options.sampleRate))
  if (options.compression !== undefined) comm.text(options.compression).raw(0, 0)
  const sound = new Bytes().int(0, 4, true).int(0, 4, true).append(options.samples)
  const body = new Bytes().text(options.compression === undefined ? 'AIFF' : 'AIFC')
    .text('COMM').int(comm.bytes.length, 4, true).append(comm.bytes)
    .text('SSND').int(sound.bytes.length, 4, true).append(sound.bytes)
  if (sound.bytes.length % 2 === 1) body.raw(0)
  const finished = body.bytes
  return new Bytes().text('FORM').int(finished.length, 4, true).append(finished).bytes
}
