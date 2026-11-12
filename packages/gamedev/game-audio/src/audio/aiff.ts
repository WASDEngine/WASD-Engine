/**
 * Decoding of AIFF and AIFC files, which browsers do not decode: big-endian integer PCM of 8 to 32 bits, AIFC's
 * little-endian `sowt` and unsigned 8-bit `raw ` PCM, and 32-bit and 64-bit floating point.
 *
 * @module
 */
import type { AudioSamples } from './measure.ts'
import { readAiffFormat, type AiffFormat } from './probe.ts'

/** Why an AIFF file did not decode, for the message a reader shows. */
export class AiffDecodeError extends Error {
  /** @param message - what is wrong with the file. */
  constructor(message: string) {
    super(message)
    this.name = 'AiffDecodeError'
  }
}

function text(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0)
}

/** How one stored sample becomes a value from -1 to 1. */
type SampleReader = (view: DataView, offset: number) => number

function sampleReader(format: AiffFormat): { readonly read: SampleReader; readonly bytes: number } {
  const bits = format.bitDepth
  const width = Math.ceil(bits / 8)
  switch (format.compression) {
    case 'fl32':
    case 'FL32':
      return { read: (view, offset) => view.getFloat32(offset, false), bytes: 4 }
    case 'fl64':
    case 'FL64':
      return { read: (view, offset) => view.getFloat64(offset, false), bytes: 8 }
    case 'raw ':
      if (width !== 1) break
      return { read: (view, offset) => (view.getUint8(offset) - 128) / 128, bytes: 1 }
    case 'NONE':
    case 'twos':
    case 'sowt': {
      if (width < 1 || width > 4) break
      const little = format.compression === 'sowt'
      const scale = 2 ** (width * 8 - 1)
      return {
        read: (view, offset) => {
          let value = 0
          for (let index = 0; index < width; index++) value = value * 256 + view.getUint8(offset + (little ? width - 1 - index : index))
          return (value >= scale ? value - 2 * scale : value) / scale
        },
        bytes: width,
      }
    }
    default:
      break
  }
  throw new AiffDecodeError(`the AIFF file stores ${format.compression === 'NONE' ? `${String(bits)}-bit` : `"${format.compression.trim()}"`} samples, which the decoder does not read`)
}

/** An AIFF file's sound, located and readable sample by sample without decoding it whole. */
export interface AiffSound {
  /** Frames per second, as the file's format chunk states it; it may have a fraction. */
  readonly sampleRate: number
  readonly channels: number
  /** Frames the file holds: as many as its format chunk names and its sound chunk has bytes for. */
  readonly frames: number
  /**
   * Read one sample.
   * @param frame - frame index, below `frames`.
   * @param channel - channel index, below `channels`.
   * @returns the sample from -1 to 1.
   */
  sample(frame: number, channel: number): number
}

/**
 * Locate the sound of a complete AIFF or AIFC file, allocating nothing for its samples.
 * @param bytes - the file.
 * @returns the sound's format and a reader of its samples.
 * @throws {AiffDecodeError} for a file that is not AIFF, lacks its format or sound chunk, or stores another encoding.
 */
export function openAiff(bytes: Uint8Array): AiffSound {
  if (bytes.length < 12 || text(bytes, 0) !== 'FORM' || (text(bytes, 8) !== 'AIFF' && text(bytes, 8) !== 'AIFC')) {
    throw new AiffDecodeError('the file is not an AIFF file')
  }
  const aifc = text(bytes, 8) === 'AIFC'
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let format: AiffFormat | undefined
  let sound: { readonly start: number; readonly end: number } | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = text(bytes, offset)
    const length = view.getUint32(offset + 4, false)
    const body = offset + 8
    if (id === 'COMM') format = readAiffFormat(bytes.subarray(body, Math.min(bytes.length, body + length)), aifc)
    else if (id === 'SSND' && length >= 8) {
      // The sound chunk starts with an offset to the first sample and a block size.
      sound = { start: body + 8 + view.getUint32(body, false), end: Math.min(bytes.length, body + length) }
    }
    offset = body + length + (length % 2)
  }
  if (format === undefined || format.channels < 1) throw new AiffDecodeError('the AIFF file has no usable format chunk')
  if (sound === undefined) throw new AiffDecodeError('the AIFF file has no sound chunk')
  const { read, bytes: width } = sampleReader(format)
  const channels = format.channels
  const start = sound.start
  const frames = Math.max(0, Math.min(format.frames, Math.floor((sound.end - start) / (width * channels))))
  return {
    sampleRate: format.sampleRate,
    channels,
    frames,
    sample: (frame, channel) => read(view, start + (frame * channels + channel) * width),
  }
}

/**
 * Decode a complete AIFF or AIFC file.
 * @param bytes - the file.
 * @returns its samples, interleaved as the file stores them.
 * @throws {AiffDecodeError} for a file that is not AIFF, lacks its format or sound chunk, or stores another encoding.
 */
export function decodeAiff(bytes: Uint8Array): AudioSamples {
  const sound = openAiff(bytes)
  const samples = new Float32Array(sound.frames * sound.channels)
  for (let frame = 0; frame < sound.frames; frame++) {
    for (let channel = 0; channel < sound.channels; channel++) samples[frame * sound.channels + channel] = sound.sample(frame, channel)
  }
  return { sampleRate: sound.sampleRate, channels: sound.channels, frames: sound.frames, samples }
}
