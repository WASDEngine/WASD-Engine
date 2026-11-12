/**
 * What an audio file's headers say without decoding it: its format and encoding, sample rate, channels, bit depth,
 * bit rate, length, and the loop points a WAV file stores. A probe reads a few small byte windows: the first 4 KiB,
 * the chunk headers of a WAV or AIFF file, the frame after an ID3 tag, and the last 64 KiB of an Ogg file, whose final
 * page holds the length. WAV and AIFF lengths come from their sample counts, FLAC lengths from STREAMINFO, MP3 lengths
 * from the Xing, Info, or VBRI frame count less the LAME encoder delay and padding, and Ogg lengths from the last
 * page's granule position; an MP3 without a frame count is estimated from its first frame's bit rate.
 *
 * @module
 */

/**
 * Read a byte window of the probed file.
 * @param offset - first byte.
 * @param length - most bytes to read.
 * @returns the bytes; fewer at the end of the file, none past it.
 */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>

/** What a file's headers say. Fields the headers do not state are absent. */
export interface AudioProbe {
  /** Container and codec, such as `WAV`, `AIFF`, `FLAC`, `MP3`, `Ogg Vorbis`, or `Ogg Opus`. */
  readonly format: string
  /** How samples are stored, such as `16-bit PCM`, `32-bit float`, or `IMA ADPCM`. */
  readonly encoding?: string
  /** Samples per second of each channel. */
  readonly sampleRate?: number
  readonly channels?: number
  /** Bits per stored sample of uncompressed and FLAC files. */
  readonly bitDepth?: number
  /** Average bits per second of compressed files. */
  readonly bitrate?: number
  /** Length in seconds. */
  readonly seconds?: number
  /** The length is an estimate from the bit rate of an MP3 file that states no frame count. */
  readonly estimated?: boolean
  /** The first loop a WAV file's sampler chunk stores, in sample frames, its end inclusive. */
  readonly loop?: { readonly start: number; readonly end: number }
}

/** Bytes of the first window, which holds every header but a WAV or AIFF file's later chunks and an ID3 tag's frames. */
export const PROBE_HEAD_BYTES = 4096

/** Bytes at the end of an Ogg file searched for its last page, more than one page can hold. */
export const PROBE_TAIL_BYTES = 65_536

/** Chunks of a WAV or AIFF file a probe walks before it stops. */
const MAX_CHUNKS = 64

function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let index = offset; index < offset + length; index++) text += String.fromCharCode(byte(bytes, index))
  return text
}

function u16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) | (byte(bytes, offset + 1) << 8)
}

function u32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + u16le(bytes, offset + 2) * 0x10000
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (byte(bytes, offset) << 8) | byte(bytes, offset + 1)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return u16be(bytes, offset) * 0x10000 + u16be(bytes, offset + 2)
}

/**
 * Read an IEEE 754 80-bit extended number, as AIFF stores its sample rate.
 * @param bytes - the bytes.
 * @param offset - first of the ten bytes, big-endian.
 * @returns the value; undefined for infinity and NaN.
 */
export function readExtended(bytes: Uint8Array, offset: number): number | undefined {
  const exponent = ((byte(bytes, offset) & 0x7f) << 8) | byte(bytes, offset + 1)
  const high = u32be(bytes, offset + 2)
  const low = u32be(bytes, offset + 6)
  if (exponent === 0x7fff) return undefined
  if (exponent === 0 && high === 0 && low === 0) return 0
  const sign = (byte(bytes, offset) & 0x80) === 0 ? 1 : -1
  return sign * (high * 2 ** (exponent - 16_383 - 31) + low * 2 ** (exponent - 16_383 - 63))
}

/** The format chunk of an AIFF file. */
export interface AiffFormat {
  readonly channels: number
  readonly frames: number
  readonly bitDepth: number
  readonly sampleRate: number
  /** AIFC compression type, such as `sowt`; `NONE` for plain AIFF. */
  readonly compression: string
}

/**
 * Read an AIFF or AIFC `COMM` chunk.
 * @param body - the chunk's body.
 * @param aifc - whether the file is AIFC, whose chunk names a compression type.
 * @returns the format, or undefined for a chunk too short or without a usable sample rate.
 */
export function readAiffFormat(body: Uint8Array, aifc: boolean): AiffFormat | undefined {
  if (body.length < 18) return undefined
  const sampleRate = readExtended(body, 8)
  if (sampleRate === undefined || sampleRate <= 0) return undefined
  return {
    channels: u16be(body, 0),
    frames: u32be(body, 2),
    bitDepth: u16be(body, 6),
    sampleRate,
    compression: aifc && body.length >= 22 ? ascii(body, 18, 4) : 'NONE',
  }
}

/**
 * The encoding an AIFC compression type names.
 * @param format - the format chunk.
 * @returns the encoding, such as `16-bit PCM`.
 */
function aiffEncoding(format: AiffFormat): string {
  switch (format.compression) {
    case 'NONE':
    case 'twos':
    case 'sowt':
    case 'raw ':
      return `${String(format.bitDepth)}-bit PCM`
    case 'fl32':
    case 'FL32':
      return '32-bit float'
    case 'fl64':
    case 'FL64':
      return '64-bit float'
    case 'ulaw':
    case 'ULAW':
      return 'μ-law'
    case 'alaw':
    case 'ALAW':
      return 'A-law'
    case 'ima4':
      return 'IMA ADPCM'
    default:
      return `${format.compression.trim()} compression`
  }
}

/**
 * The encoding of a WAV format code.
 * @param code - the format tag, or an extensible file's sub-format.
 * @param bitDepth - bits per stored sample.
 * @returns the encoding.
 */
function wavEncoding(code: number, bitDepth: number): string {
  switch (code) {
    case 1:
      return `${String(bitDepth)}-bit PCM`
    case 3:
      return `${String(bitDepth)}-bit float`
    case 2:
      return 'MS ADPCM'
    case 6:
      return 'A-law'
    case 7:
      return 'μ-law'
    case 0x11:
      return 'IMA ADPCM'
    case 0x55:
      return 'MP3'
    default:
      return `format 0x${code.toString(16).padStart(4, '0')}`
  }
}

async function probeWav(read: ByteReader, size: number, rf64: boolean): Promise<AudioProbe | undefined> {
  let format: { code: number; channels: number; sampleRate: number; byteRate: number; bitDepth: number } | undefined
  let dataBytes: number | undefined
  let longDataBytes: number | undefined
  let loop: AudioProbe['loop']
  let offset = 12
  for (let chunks = 0; chunks < MAX_CHUNKS && offset + 8 <= size; chunks++) {
    const chunk = await read(offset, 48)
    if (chunk.length < 8) break
    const id = ascii(chunk, 0, 4)
    let length = u32le(chunk, 4)
    if (id === 'ds64' && chunk.length >= 24) {
      longDataBytes = u32le(chunk, 16) + u32le(chunk, 20) * 0x1_0000_0000
    } else if (id === 'fmt ' && length >= 16 && chunk.length >= 24) {
      const tag = u16le(chunk, 8)
      format = {
        code: tag === 0xfffe && length >= 40 && chunk.length >= 34 ? u16le(chunk, 32) : tag,
        channels: u16le(chunk, 10),
        sampleRate: u32le(chunk, 12),
        byteRate: u32le(chunk, 16),
        bitDepth: u16le(chunk, 22),
      }
    } else if (id === 'data') {
      if (rf64 && length === 0xffff_ffff && longDataBytes !== undefined) length = longDataBytes
      // A writer that streams leaves the length 0 or at its largest value; the samples then run to the end of the file.
      const rest = Math.max(0, size - offset - 8)
      dataBytes = length === 0 ? rest : Math.min(length, rest)
    } else if (id === 'smpl' && length >= 60) {
      const sampler = await read(offset + 8, 60)
      if (sampler.length >= 60 && u32le(sampler, 28) > 0) loop = { start: u32le(sampler, 44), end: u32le(sampler, 48) }
    }
    offset += 8 + length + (length % 2)
  }
  if (format === undefined) return undefined
  const uncompressed = format.code === 1 || format.code === 3
  const seconds = dataBytes !== undefined && format.byteRate > 0 ? dataBytes / format.byteRate : undefined
  return {
    format: 'WAV',
    encoding: wavEncoding(format.code, format.bitDepth),
    ...format.sampleRate > 0 ? { sampleRate: format.sampleRate } : {},
    ...format.channels > 0 ? { channels: format.channels } : {},
    ...uncompressed && format.bitDepth > 0 ? { bitDepth: format.bitDepth } : {},
    ...!uncompressed && format.byteRate > 0 ? { bitrate: format.byteRate * 8 } : {},
    ...seconds === undefined ? {} : { seconds },
    ...loop === undefined ? {} : { loop },
  }
}

async function probeAiff(read: ByteReader, size: number, aifc: boolean): Promise<AudioProbe | undefined> {
  let offset = 12
  for (let chunks = 0; chunks < MAX_CHUNKS && offset + 8 <= size; chunks++) {
    const header = await read(offset, 8)
    if (header.length < 8) break
    const length = u32be(header, 4)
    if (ascii(header, 0, 4) === 'COMM') {
      const format = readAiffFormat(await read(offset + 8, Math.min(length, 64)), aifc)
      if (format === undefined) return undefined
      return {
        format: 'AIFF',
        encoding: aiffEncoding(format),
        sampleRate: format.sampleRate,
        ...format.channels > 0 ? { channels: format.channels } : {},
        ...format.bitDepth > 0 ? { bitDepth: format.bitDepth } : {},
        seconds: format.frames / format.sampleRate,
      }
    }
    offset += 8 + length + (length % 2)
  }
  return undefined
}

function probeFlac(first: Uint8Array, start: number, size: number): AudioProbe {
  // The STREAMINFO block comes first: a 4-byte block header, then 34 bytes.
  if ((byte(first, 4) & 0x7f) !== 0 || first.length < 8 + 18) return { format: 'FLAC' }
  const info = 8
  const sampleRate = (byte(first, info + 10) << 12) | (byte(first, info + 11) << 4) | (byte(first, info + 12) >> 4)
  const channels = ((byte(first, info + 12) >> 1) & 0x7) + 1
  const bitDepth = (((byte(first, info + 12) & 1) << 4) | (byte(first, info + 13) >> 4)) + 1
  const samples = (byte(first, info + 13) & 0xf) * 0x1_0000_0000 + u32be(first, info + 14)
  const seconds = samples > 0 && sampleRate > 0 ? samples / sampleRate : undefined
  return {
    format: 'FLAC',
    encoding: `${String(bitDepth)}-bit FLAC`,
    ...sampleRate > 0 ? { sampleRate } : {},
    channels,
    bitDepth,
    ...seconds === undefined ? {} : { seconds, bitrate: Math.round((size - start) * 8 / seconds) },
  }
}

/** Kilobits per second by bit rate index: MPEG-1 layers I, II, and III, then MPEG-2 and 2.5 layer I, then II and III. */
const MPEG_BITRATES: readonly (readonly number[])[] = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
]

/** Sample rates by version bits (MPEG 2.5, reserved, MPEG-2, MPEG-1) and rate index. */
const MPEG_RATES: readonly (readonly number[])[] = [[11_025, 12_000, 8000], [], [22_050, 24_000, 16_000], [44_100, 48_000, 32_000]]

/** One MPEG audio frame header. */
interface MpegFrame {
  readonly mpeg1: boolean
  readonly layer: 1 | 2 | 3
  readonly sampleRate: number
  readonly kbps: number
  readonly channels: 1 | 2
  readonly samplesPerFrame: number
  readonly bytes: number
}

function mpegFrame(bytes: Uint8Array, offset: number): MpegFrame | undefined {
  if (offset + 4 > bytes.length || byte(bytes, offset) !== 0xff || (byte(bytes, offset + 1) & 0xe0) !== 0xe0) return undefined
  const version = (byte(bytes, offset + 1) >> 3) & 3
  const layerBits = (byte(bytes, offset + 1) >> 1) & 3
  const bitrateIndex = byte(bytes, offset + 2) >> 4
  const rateIndex = (byte(bytes, offset + 2) >> 2) & 3
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined
  const mpeg1 = version === 3
  const layer = (4 - layerBits) as 1 | 2 | 3
  const sampleRate = MPEG_RATES[version]?.[rateIndex] ?? 0
  const kbps = MPEG_BITRATES[mpeg1 ? layer - 1 : layer === 1 ? 3 : 4]?.[bitrateIndex] ?? 0
  const padding = (byte(bytes, offset + 2) >> 1) & 1
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576
  const frameBytes = layer === 1
    ? (Math.floor(12 * kbps * 1000 / sampleRate) + padding) * 4
    : Math.floor(samplesPerFrame / 8 * kbps * 1000 / sampleRate) + padding
  return { mpeg1, layer, sampleRate, kbps, channels: byte(bytes, offset + 3) >> 6 === 3 ? 1 : 2, samplesPerFrame, bytes: frameBytes }
}

/** The frame count and encoder offsets of a Xing, Info, or VBRI frame. */
interface FrameCount {
  readonly frames: number
  readonly bytes?: number
  /** Samples the encoder added at the start and the end, from a LAME tag. */
  readonly trimmed: number
}

function frameCount(bytes: Uint8Array, offset: number, frame: MpegFrame): FrameCount | undefined {
  const sideInfo = frame.mpeg1 ? (frame.channels === 1 ? 17 : 32) : (frame.channels === 1 ? 9 : 17)
  const xing = offset + 4 + sideInfo
  const tag = ascii(bytes, xing, 4)
  if (tag === 'Xing' || tag === 'Info') {
    const flags = u32be(bytes, xing + 4)
    let field = xing + 8
    if ((flags & 1) === 0) return undefined
    const frames = u32be(bytes, field)
    field += 4
    let total: number | undefined
    if ((flags & 2) !== 0) {
      total = u32be(bytes, field)
      field += 4
    }
    if ((flags & 4) !== 0) field += 100
    if ((flags & 8) !== 0) field += 4
    const encoder = ascii(bytes, field, 4)
    // Twelve bits of encoder delay, then twelve of padding, 21 bytes into the LAME tag.
    const delay = (byte(bytes, field + 21) << 4) | (byte(bytes, field + 22) >> 4)
    const padding = ((byte(bytes, field + 22) & 0xf) << 8) | byte(bytes, field + 23)
    const trimmed = encoder === 'LAME' || encoder === 'Lavc' || encoder === 'Lavf' ? delay + padding : 0
    return { frames, ...total === undefined ? {} : { bytes: total }, trimmed }
  }
  const vbri = offset + 4 + 32
  if (ascii(bytes, vbri, 4) === 'VBRI') return { frames: u32be(bytes, vbri + 14), bytes: u32be(bytes, vbri + 10), trimmed: 0 }
  return undefined
}

function probeMpeg(first: Uint8Array, start: number, size: number): AudioProbe | undefined {
  for (let offset = 0; offset + 4 <= first.length; offset++) {
    const frame = mpegFrame(first, offset)
    // A false sync inside a tag or junk is rejected unless the frame after it, when in the window, syncs too.
    if (frame === undefined || frame.bytes <= 4) continue
    if (offset + frame.bytes + 4 <= first.length && mpegFrame(first, offset + frame.bytes) === undefined) continue
    const label = frame.layer === 3 ? 'MP3' : `MPEG layer ${frame.layer === 1 ? 'I' : 'II'}`
    const count = frameCount(first, offset, frame)
    if (count !== undefined && count.frames > 0) {
      const seconds = Math.max(0, count.frames * frame.samplesPerFrame - count.trimmed) / frame.sampleRate
      const audioBytes = count.bytes ?? size - start - offset
      return {
        format: label, sampleRate: frame.sampleRate, channels: frame.channels, seconds,
        ...seconds > 0 ? { bitrate: Math.round(audioBytes * 8 / seconds) } : {},
      }
    }
    const seconds = (size - start - offset) * 8 / (frame.kbps * 1000)
    return { format: label, sampleRate: frame.sampleRate, channels: frame.channels, bitrate: frame.kbps * 1000, seconds, estimated: true }
  }
  return undefined
}

async function probeOgg(head: Uint8Array, read: ByteReader, size: number): Promise<AudioProbe> {
  const serial = u32le(head, 14)
  const packet = 27 + byte(head, 26)
  let format = 'Ogg'
  let rate: number | undefined
  let channels: number | undefined
  let preSkip = 0
  if (byte(head, packet) === 1 && ascii(head, packet + 1, 6) === 'vorbis') {
    format = 'Ogg Vorbis'
    channels = byte(head, packet + 11)
    rate = u32le(head, packet + 12)
  } else if (ascii(head, packet, 8) === 'OpusHead') {
    format = 'Ogg Opus'
    channels = byte(head, packet + 9)
    preSkip = u16le(head, packet + 10)
    // Opus always decodes at 48 kHz; the header's rate is the source's, for information.
    rate = 48_000
  } else if (byte(head, packet) === 0x7f && ascii(head, packet + 1, 4) === 'FLAC') {
    format = 'Ogg FLAC'
  }
  const facts: AudioProbe = {
    format,
    ...rate === undefined || rate <= 0 ? {} : { sampleRate: rate },
    ...channels === undefined || channels <= 0 ? {} : { channels },
  }
  if (rate === undefined || rate <= 0) return facts
  const from = Math.max(0, size - PROBE_TAIL_BYTES)
  const tail = await read(from, size - from)
  for (let offset = tail.length - 27; offset >= 0; offset--) {
    if (byte(tail, offset) !== 0x4f || ascii(tail, offset, 4) !== 'OggS' || u32le(tail, offset + 14) !== serial) continue
    const high = u32le(tail, offset + 10)
    // A granule position of -1 marks a page on which no packet ends.
    if (high >= 0x8000_0000) continue
    const granule = high * 0x1_0000_0000 + u32le(tail, offset + 6)
    const seconds = Math.max(0, granule - preSkip) / rate
    return { ...facts, seconds, ...seconds > 0 ? { bitrate: Math.round(size * 8 / seconds) } : {} }
  }
  return facts
}

/**
 * Read what an audio file's headers say.
 * @param read - reads byte windows of the file.
 * @param size - the file's size in bytes.
 * @returns the facts, or undefined for a file whose headers name no format the probe reads.
 */
export async function probeAudio(read: ByteReader, size: number): Promise<AudioProbe | undefined> {
  const head = await read(0, PROBE_HEAD_BYTES)
  if (head.length < 12) return undefined
  const magic = ascii(head, 0, 4)
  const form = ascii(head, 8, 4)
  if ((magic === 'RIFF' || magic === 'RF64') && form === 'WAVE') return await probeWav(read, size, magic === 'RF64')
  if (magic === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return await probeAiff(read, size, form === 'AIFC')
  if (magic === 'OggS') return await probeOgg(head, read, size)
  let start = 0
  let first = head
  if (ascii(head, 0, 3) === 'ID3') {
    // An ID3v2 tag: a 10-byte header whose size is four 7-bit bytes, and a 10-byte footer when its flag is set.
    let tagBytes = 0
    for (let index = 6; index < 10; index++) tagBytes = (tagBytes << 7) | (byte(head, index) & 0x7f)
    start = 10 + tagBytes + ((byte(head, 5) & 0x10) === 0 ? 0 : 10)
    first = await read(start, PROBE_HEAD_BYTES)
  }
  if (ascii(first, 0, 4) === 'fLaC') return probeFlac(first, start, size)
  return probeMpeg(first, start, size)
}
