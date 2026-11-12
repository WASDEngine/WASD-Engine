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

/**
 * Decode a complete AIFF or AIFC file.
 * @param bytes - the file.
 * @returns its samples, interleaved as the file stores them.
 * @throws {AiffDecodeError} for a file that is not AIFF, lacks its format or sound chunk, or stores another encoding.
 */
export function decodeAiff(bytes: Uint8Array): AudioSamples {
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
  const frames = Math.max(0, Math.min(format.frames, Math.floor((sound.end - sound.start) / (width * format.channels))))
  const samples = new Float32Array(frames * format.channels)
  for (let index = 0; index < samples.length; index++) samples[index] = read(view, sound.start + index * width)
  return { sampleRate: format.sampleRate, channels: format.channels, frames, samples }
}
