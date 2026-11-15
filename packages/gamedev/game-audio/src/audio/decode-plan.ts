/**
 * How much audio a browser's decoder can make of a file, read from the file's own bytes before it is decoded, so that
 * a window refuses a sound past its caps instead of decoding all of it first. The plan goes by the file's content, as
 * the browser picks its decoder, whatever the file's name:
 *
 * - WAV: the samples run to the end of the file, as a streamed file's do, at the size of a sample frame its format
 *   chunk states; ADPCM yields at most two samples a byte. Other WAV encodings are not planned.
 * - FLAC: the samples of every frame header in the file whose CRC-8 matches, the headers a decoder can start a frame
 *   at, each by its own block size and sample rate; the length its STREAMINFO block states plays no part, since a
 *   decoder decodes the frames the file holds.
 * - MP3 (and MPEG layers I and II): the chain of frames a decoder follows from the first frame, each frame starting
 *   where the one before it ends, past bytes that are no frame of the stream; the decoder receives those frames alone.
 * - Ogg Vorbis and Opus: the pages of the first audio stream whose CRC-32 matches, which the decoder alone receives;
 *   Opus packets by the frames their table of contents states, Vorbis packets at half the long block size, the most
 *   one packet yields.
 *
 * AIFF is decoded by the audio tools' own reader and is not planned here.
 * @module
 */

import { mpegFrame, sameStream, type MpegFrame } from './probe.ts'

/** What a decoder can make of one file. */
export interface DecodePlan {
  /** The bytes to decode: the file itself, or for MP3 and Ogg the frames and pages the plan counts. */
  readonly data: Uint8Array
  /** The file's own sample rate, which the decode keeps. */
  readonly sampleRate: number
  /** The most channels the decoded sound has. */
  readonly channels: number
  /** The most seconds the decode yields; at least this long when {@link exact} is false and the count stopped early. */
  readonly seconds: number
  /**
   * Whether {@link seconds} counts the frames the decode yields, rather than the most a stream's packets can yield (Ogg
   * Vorbis and ADPCM) or the length at which the count stopped.
   */
  readonly exact: boolean
  /** Whether the count stopped at the plan's limit, so that the sound is longer than {@link seconds}. */
  readonly cut: boolean
}

/** Why a file has no plan: no container the plan reads, or one that holds no audio it counts. */
export class DecodePlanError extends Error {
  /**
   * @param reason - `unsupported` for content the plan does not read, `no-audio` for a file without a frame.
   * @param message - what the file holds, for the reader.
   */
  constructor(readonly reason: 'unsupported' | 'no-audio', message: string) {
    super(message)
    this.name = 'DecodePlanError'
  }
}

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

function u24be(bytes: Uint8Array, offset: number): number {
  return (byte(bytes, offset) << 16) | (byte(bytes, offset + 1) << 8) | byte(bytes, offset + 2)
}

/** WAV format codes whose samples take a fixed number of bytes: PCM, float, A-law, and μ-law. */
const WAV_FIXED = new Set([1, 3, 6, 7])

/** WAV format codes of ADPCM, four bits a sample. */
const WAV_ADPCM = new Set([2, 0x11])

/** Chunks of a WAV file the plan walks before it gives up finding the samples. */
const MAX_WAV_CHUNKS = 64

function wavPlan(bytes: Uint8Array): DecodePlan {
  let format: { code: number; channels: number; sampleRate: number; blockAlign: number; bitDepth: number } | undefined
  let offset = 12
  for (let chunks = 0; chunks < MAX_WAV_CHUNKS && offset + 8 <= bytes.length; chunks++) {
    const id = ascii(bytes, offset, 4)
    const length = u32le(bytes, offset + 4)
    if (id === 'fmt ' && length >= 16) {
      const tag = u16le(bytes, offset + 8)
      format = {
        code: tag === 0xfffe && length >= 40 ? u16le(bytes, offset + 32) : tag,
        channels: u16le(bytes, offset + 10),
        sampleRate: u32le(bytes, offset + 12),
        blockAlign: u16le(bytes, offset + 20),
        bitDepth: u16le(bytes, offset + 22),
      }
    } else if (id === 'data') {
      if (format === undefined) break
      // A streamed or RF64 file's samples run to the end of the file, and a decoder may read them all, so the rest of
      // the file counts whatever length the chunk states.
      const rest = Math.max(0, bytes.length - offset - 8)
      const { code, channels, sampleRate, blockAlign, bitDepth } = format
      if (channels === 0 || sampleRate === 0) throw new DecodePlanError('no-audio', 'The WAV file states no channels or no sample rate.')
      if (WAV_FIXED.has(code)) {
        // The smaller of the stated block and the frame its sample size gives yields the more frames.
        const frameBytes = [blockAlign, channels * Math.ceil(bitDepth / 8)].filter(size => size > 0)
        if (frameBytes.length === 0) throw new DecodePlanError('no-audio', 'The WAV file states no sample size.')
        const seconds = Math.floor(rest / Math.min(...frameBytes)) / sampleRate
        return { data: bytes, sampleRate, channels, seconds, exact: true, cut: false }
      }
      if (WAV_ADPCM.has(code)) {
        return { data: bytes, sampleRate, channels, seconds: Math.ceil((rest * 2) / channels) / sampleRate, exact: false, cut: false }
      }
      throw new DecodePlanError('unsupported', `The WAV file's encoding, format 0x${code.toString(16).padStart(4, '0')}, is not one the Audio panel decodes.`)
    }
    offset += 8 + length + (length % 2)
  }
  throw new DecodePlanError('no-audio', 'The WAV file has no format and data chunks.')
}

/** Sample rates of FLAC frame headers by their four-bit code; 0 takes STREAMINFO's, 12 to 14 follow the header. */
const FLAC_RATES: readonly number[] = [0, 88_200, 176_400, 192_000, 8000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 96_000]

/** CRC-8 with polynomial 0x07, as FLAC frame headers carry it. */
const CRC8 = Uint8Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  return crc
})

/**
 * The block size and sample rate of the FLAC frame header at an offset, when its fields are ones a decoder reads and
 * its CRC-8 matches.
 * @param bytes - the file.
 * @param at - the offset of a 0xFFF8 or 0xFFF9 sync code.
 * @param streamRate - STREAMINFO's sample rate, which a header can name.
 * @returns the frame's samples, rate, and channels, or undefined.
 */
function flacFrame(
  bytes: Uint8Array, at: number, streamRate: number,
): { readonly blockSize: number; readonly rate: number; readonly channels: number } | undefined {
  const sizeCode = byte(bytes, at + 2) >> 4
  const rateCode = byte(bytes, at + 2) & 0x0f
  const channelCode = byte(bytes, at + 3) >> 4
  const depthCode = (byte(bytes, at + 3) >> 1) & 0x07
  if (sizeCode === 0 || rateCode === 15 || channelCode > 10 || depthCode === 3) return undefined
  // The coded frame or sample number: a UTF-8 style number of one to seven bytes.
  let position = at + 4
  const lead = byte(bytes, position)
  let extra = 0
  if (lead >= 0x80) {
    if (lead < 0xc0 || lead === 0xff) return undefined
    for (let mask = 0x40; (lead & mask) !== 0; mask >>= 1) extra++
  }
  for (let index = 1; index <= extra; index++) if ((byte(bytes, position + index) & 0xc0) !== 0x80) return undefined
  position += 1 + extra
  let blockSize: number
  if (sizeCode === 1) blockSize = 192
  else if (sizeCode <= 5) blockSize = 576 * 2 ** (sizeCode - 2)
  else if (sizeCode === 6) blockSize = byte(bytes, position++) + 1
  else if (sizeCode === 7) {
    blockSize = ((byte(bytes, position) << 8) | byte(bytes, position + 1)) + 1
    position += 2
  } else blockSize = 256 * 2 ** (sizeCode - 8)
  let rate: number
  if (rateCode === 0) rate = streamRate
  else if (rateCode < 12) rate = FLAC_RATES[rateCode] ?? 0
  else if (rateCode === 12) rate = byte(bytes, position++) * 1000
  else {
    rate = ((byte(bytes, position) << 8) | byte(bytes, position + 1)) * (rateCode === 14 ? 10 : 1)
    position += 2
  }
  if (position >= bytes.length || rate === 0) return undefined
  let crc = 0
  for (let index = at; index < position; index++) crc = CRC8[crc ^ byte(bytes, index)] ?? 0
  // Codes 0 to 7 name 1 to 8 independent channels; 8 to 10 are stereo pairs.
  return crc === byte(bytes, position) ? { blockSize, rate, channels: channelCode < 8 ? channelCode + 1 : 2 } : undefined
}

function flacPlan(bytes: Uint8Array, start: number, maxSeconds: number): DecodePlan {
  let at = start + 4
  let info: { rate: number; channels: number } | undefined
  for (;;) {
    if (at + 4 > bytes.length) throw new DecodePlanError('no-audio', 'The FLAC file ends inside its metadata.')
    const header = byte(bytes, at)
    const length = u24be(bytes, at + 1)
    if ((header & 0x7f) === 0 && length >= 34) {
      const body = at + 4
      info = {
        rate: (byte(bytes, body + 10) << 12) | (byte(bytes, body + 11) << 4) | (byte(bytes, body + 12) >> 4),
        channels: ((byte(bytes, body + 12) >> 1) & 0x7) + 1,
      }
    }
    at += 4 + length
    if ((header & 0x80) !== 0) break
  }
  if (info === undefined) throw new DecodePlanError('no-audio', 'The FLAC file has no STREAMINFO block.')
  let seconds = 0
  let frames = 0
  let channels = info.channels
  const sampleRate = info.rate === 0 ? 48_000 : info.rate
  for (let position = at; position + 5 < bytes.length; position++) {
    if (byte(bytes, position) !== 0xff || (byte(bytes, position + 1) & 0xfe) !== 0xf8) continue
    const frame = flacFrame(bytes, position, info.rate)
    if (frame === undefined) continue
    frames++
    seconds += frame.blockSize / frame.rate
    channels = Math.max(channels, frame.channels)
    if (seconds > maxSeconds) return { data: bytes, sampleRate, channels, seconds, exact: false, cut: true }
  }
  if (frames === 0) throw new DecodePlanError('no-audio', 'The FLAC file holds no audio frames.')
  return { data: bytes, sampleRate, channels, seconds, exact: true, cut: false }
}

/**
 * Whether a frame belongs to the chain a decoder follows: one stream, one channel count, and the whole frame inside
 * the file.
 */
function chained(bytes: Uint8Array, at: number, stream: MpegFrame): MpegFrame | undefined {
  const frame = mpegFrame(bytes, at)
  if (frame === undefined || frame.bytes <= 4 || !sameStream(frame, stream) || frame.channels !== stream.channels) return undefined
  return at + frame.bytes <= bytes.length ? frame : undefined
}

/**
 * The next frame of a stream at or after an offset: one the frame after it follows, or that ends the file.
 * @returns its offset, or undefined when the rest of the file holds none.
 */
function resync(bytes: Uint8Array, from: number, stream: MpegFrame): number | undefined {
  for (let at = from; at + 4 <= bytes.length; at++) {
    const frame = chained(bytes, at, stream)
    if (frame === undefined) continue
    const next = at + frame.bytes
    if (next === bytes.length || chained(bytes, next, stream) !== undefined) return at
  }
  return undefined
}

/** Bytes joined from parts of a file, without a copy when there is one part. */
function joined(bytes: Uint8Array, parts: readonly (readonly [number, number])[]): Uint8Array {
  const [only] = parts
  if (parts.length === 1 && only !== undefined) return bytes.subarray(only[0], only[1])
  const out = new Uint8Array(parts.reduce((total, [begin, end]) => total + end - begin, 0))
  let offset = 0
  for (const [begin, end] of parts) {
    out.set(bytes.subarray(begin, end), offset)
    offset += end - begin
  }
  return out
}

function mpegPlan(bytes: Uint8Array, start: number, maxSeconds: number): DecodePlan {
  let first: number | undefined
  let stream: MpegFrame | undefined
  for (let at = start; at + 4 <= bytes.length && first === undefined; at++) {
    const frame = mpegFrame(bytes, at)
    // A false sync inside a tag or junk is passed unless the frame after it syncs too, or it ends the file.
    if (frame === undefined || frame.bytes <= 4 || at + frame.bytes > bytes.length) continue
    const next = at + frame.bytes
    if (next === bytes.length || chained(bytes, next, frame) !== undefined) {
      first = at
      stream = frame
    }
  }
  if (first === undefined || stream === undefined) throw new DecodePlanError('no-audio', 'The file holds no MPEG audio frames.')
  const parts: [number, number][] = []
  let seconds = 0
  let at: number | undefined = first
  while (at !== undefined && at + 4 <= bytes.length) {
    const begin: number = at
    let end = begin
    for (let frame = chained(bytes, end, stream); frame !== undefined; frame = chained(bytes, end, stream)) {
      end += frame.bytes
      seconds += frame.samplesPerFrame / frame.sampleRate
      if (seconds > maxSeconds) {
        parts.push([begin, end])
        return { data: joined(bytes, parts), sampleRate: stream.sampleRate, channels: stream.channels, seconds, exact: false, cut: true }
      }
    }
    if (end > begin) parts.push([begin, end])
    at = resync(bytes, end + (end === begin ? 1 : 0), stream)
  }
  return { data: joined(bytes, parts), sampleRate: stream.sampleRate, channels: stream.channels, seconds, exact: true, cut: false }
}

/** CRC-32 with polynomial 0x04C11DB7, unreflected, as Ogg pages carry it. */
const CRC32 = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24
  for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000_0000) !== 0 ? ((crc << 1) ^ 0x04c1_1db7) >>> 0 : (crc << 1) >>> 0
  return crc >>> 0
})

/** One Ogg page whose length and CRC-32 a decoder accepts. */
interface OggPage {
  readonly at: number
  readonly end: number
  readonly serial: number
  /** The page's number within its logical stream. */
  readonly sequence: number
  /** The page continues a packet begun on the page before. */
  readonly continued: boolean
  /** The page begins a logical stream. */
  readonly begins: boolean
  /** Segment lengths, from the lacing table. */
  readonly segments: Uint8Array
  /** Where the segments' data starts. */
  readonly body: number
}

/** The pages of an Ogg file, read in order; a page whose length or CRC-32 fails is passed over, as a decoder passes it. */
class OggPages {
  /** Bytes whose CRC-32 the reader may compute, so that a file of false capture patterns costs a bounded scan. */
  private budget: number

  constructor(private readonly bytes: Uint8Array) {
    this.budget = 2 * bytes.length + 65_536
  }

  /**
   * The next page at or after an offset.
   * @param from - where to look.
   * @returns the page, or undefined at the end of the file.
   * @throws {DecodePlanError} `no-audio` once false pages have cost more checking than twice the file's size.
   */
  next(from: number): OggPage | undefined {
    const { bytes } = this
    for (let at = bytes.indexOf(0x4f, from); at >= 0 && at + 27 <= bytes.length; at = bytes.indexOf(0x4f, at + 1)) {
      const page = this.read(at)
      if (page !== undefined) return page
    }
    return undefined
  }

  private read(at: number): OggPage | undefined {
    const { bytes } = this
    if (ascii(bytes, at, 4) !== 'OggS' || byte(bytes, at + 4) !== 0) return undefined
    const count = byte(bytes, at + 26)
    const body = at + 27 + count
    if (body > bytes.length) return undefined
    const segments = bytes.subarray(at + 27, body)
    const end = body + segments.reduce((total, length) => total + length, 0)
    if (end > bytes.length) return undefined
    this.budget -= end - at
    if (this.budget < 0) throw new DecodePlanError('no-audio', 'The Ogg file is damaged: too many of its pages fail their checksum.')
    let crc = 0
    for (let index = at; index < end; index++) {
      // The CRC field itself counts as zeros.
      const value = index >= at + 22 && index < at + 26 ? 0 : byte(bytes, index)
      crc = ((crc << 8) ^ (CRC32[((crc >>> 24) ^ value) & 0xff] ?? 0)) >>> 0
    }
    if (crc !== u32le(bytes, at + 22)) return undefined
    const flags = byte(bytes, at + 5)
    return {
      at, end, serial: u32le(bytes, at + 14), sequence: u32le(bytes, at + 18),
      continued: (flags & 1) !== 0, begins: (flags & 2) !== 0, segments, body,
    }
  }
}

/** Milliseconds of one Opus frame by the configuration number of its packet's table of contents. */
function opusFrameMs(config: number): number {
  if (config < 12) return [10, 20, 40, 60][config % 4] ?? 60
  if (config < 16) return config % 2 === 0 ? 10 : 20
  return [2.5, 5, 10, 20][config % 4] ?? 20
}

/** The longest Opus packet in seconds, which a packet without a table of contents counts as: 120 ms. */
const OPUS_LONGEST_PACKET = 0.12

/** A codec of an Ogg stream and the most seconds one of its packets yields. */
interface OggCodec {
  readonly kind: 'vorbis' | 'opus'
  readonly rate: number
  readonly channels: number
  /**
   * Seconds of audio a packet yields at most.
   * @param bytes - the file.
   * @param at - where the packet starts.
   * @param length - bytes of the packet's first segment.
   * @returns the seconds; 0 for a header packet.
   */
  readonly seconds: (bytes: Uint8Array, at: number, length: number) => number
}

/** The codec a stream's identification header names: Vorbis or Opus. */
function oggCodec(bytes: Uint8Array, packet: number): OggCodec | undefined {
  if (byte(bytes, packet) === 1 && ascii(bytes, packet + 1, 6) === 'vorbis') {
    const rate = u32le(bytes, packet + 12)
    const longBlock = 2 ** (byte(bytes, packet + 28) >> 4)
    return {
      kind: 'vorbis',
      rate,
      channels: byte(bytes, packet + 11),
      // An audio packet, whose first bit is 0, yields at most half a long block; header packets are odd.
      seconds: (data, at) => ((byte(data, at) & 1) === 0 ? longBlock / 2 / rate : 0),
    }
  }
  if (ascii(bytes, packet, 8) === 'OpusHead') {
    return {
      kind: 'opus',
      rate: 48_000,
      channels: byte(bytes, packet + 9),
      seconds: (data, at, length) => {
        const name = ascii(data, at, 8)
        if (name === 'OpusHead' || name === 'OpusTags') return 0
        // An empty packet stands for a lost one, which a decoder may fill with up to a packet of audio.
        if (length === 0) return OPUS_LONGEST_PACKET
        const toc = byte(data, at)
        const code = toc & 3
        const frames = code === 0 ? 1 : code === 3 ? byte(data, at + 1) & 0x3f : 2
        return (frames * opusFrameMs(toc >> 3)) / 1000
      },
    }
  }
  return undefined
}

function oggPlan(bytes: Uint8Array, maxSeconds: number): DecodePlan {
  const pages = new OggPages(bytes)
  // The first stream whose first packet is a Vorbis or Opus identification header.
  let serial: number | undefined
  let codec: OggCodec | undefined
  for (let page = pages.next(0); page !== undefined && page.begins && codec === undefined; page = pages.next(page.end)) {
    codec = oggCodec(bytes, page.body)
    if (codec !== undefined) serial = page.serial
  }
  if (codec === undefined || serial === undefined || codec.rate === 0 || codec.channels === 0) {
    throw new DecodePlanError('unsupported', 'The Ogg file holds no Vorbis or Opus stream the Audio panel decodes.')
  }
  const parts: [number, number][] = []
  let seconds = 0
  let packets = 0
  // Whether the last page of the stream ended inside a packet, and its number.
  let open = false
  let sequence: number | undefined
  for (let page = pages.next(0); page !== undefined; page = pages.next(page.end)) {
    if (page.serial !== serial) continue
    parts.push([page.at, page.end])
    // A page continues the open packet only when it follows the stream's last page; after a missing page, a decoder
    // may start a packet where the continuation starts, so it counts as one.
    const continues: boolean = page.continued && open && sequence !== undefined && page.sequence === ((sequence + 1) >>> 0)
    sequence = page.sequence
    let at = page.body
    let starting: boolean = !continues
    for (const length of page.segments) {
      if (starting) {
        packets++
        seconds += codec.seconds(bytes, at, length)
      }
      at += length
      starting = length < 255
    }
    open = !starting
    if (seconds > maxSeconds) {
      return { data: joined(bytes, parts), sampleRate: codec.rate, channels: codec.channels, seconds, exact: false, cut: true }
    }
  }
  if (seconds === 0) throw new DecodePlanError('no-audio', `The Ogg file holds no audio packets (${String(packets)} header packets).`)
  return { data: joined(bytes, parts), sampleRate: codec.rate, channels: codec.channels, seconds, exact: codec.kind === 'opus', cut: false }
}

/**
 * Plan the decode of an audio file by its content.
 * @param data - the complete file.
 * @param maxSeconds - where to stop counting: a plan that reaches it is `cut`, its sound longer than the window
 * decodes.
 * @returns the plan.
 * @throws {DecodePlanError} for content the plan does not read, or a file without an audio frame.
 */
export function decodePlan(data: Uint8Array, maxSeconds: number): DecodePlan {
  const magic = ascii(data, 0, 4)
  if ((magic === 'RIFF' || magic === 'RF64') && ascii(data, 8, 4) === 'WAVE') return wavPlan(data)
  if (magic === 'OggS') return oggPlan(data, maxSeconds)
  let start = 0
  if (ascii(data, 0, 3) === 'ID3') {
    // An ID3v2 tag: a 10-byte header whose size is four 7-bit bytes, and a 10-byte footer when its flag is set.
    let tagBytes = 0
    for (let index = 6; index < 10; index++) tagBytes = (tagBytes << 7) | (byte(data, index) & 0x7f)
    start = 10 + tagBytes + ((byte(data, 5) & 0x10) === 0 ? 0 : 10)
  }
  if (ascii(data, start, 4) === 'fLaC') return flacPlan(data, start, maxSeconds)
  if (magic === 'FORM') throw new DecodePlanError('unsupported', 'The file is AIFF, which the Audio panel reads by its own decoder for files named .aif, .aiff, or .aifc.')
  // Any other content is MPEG audio when a decoder finds frames in it, as it looks for them past leading bytes.
  return mpegPlan(data, start, maxSeconds)
}
