/**
 * The decode plan: how much audio a browser's decoder can make of a file, counted from all of its bytes, whatever its
 * headers state, and the bytes the decoder receives: WAV to the end of the file, every FLAC frame header whose CRC-8
 * matches, the chain of MPEG frames a decoder follows, and the Ogg pages whose CRC-32 matches.
 */
import { describe, expect, it } from 'vitest'
import { decodePlan, DecodePlanError } from '../src/audio/decode-plan.ts'
import { Bytes, pcmWav } from './signals.ts'

/** CRC-8, polynomial 0x07, bit by bit. */
function crc8(bytes: readonly number[]): number {
  let crc = 0
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

/** CRC-32, polynomial 0x04C11DB7 unreflected, bit by bit. */
function crc32(bytes: Uint8Array): number {
  let crc = 0
  for (const value of bytes) {
    crc = (crc ^ (value << 24)) >>> 0
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000_0000) !== 0 ? ((crc << 1) ^ 0x04c1_1db7) >>> 0 : (crc << 1) >>> 0
  }
  return crc >>> 0
}

/** A FLAC file: STREAMINFO at 48 kHz stereo with the total it is given, then the bytes after the metadata. */
function flac(totalSamples: number, after: readonly number[]): Uint8Array {
  const info = new Bytes().raw(0x10, 0x00, 0xff, 0xff).zeros(6)
  const rate = 48_000
  info.raw((rate >> 12) & 0xff, (rate >> 4) & 0xff, ((rate & 0xf) << 4) | (1 << 1) | 0, (15 << 4) | Math.floor(totalSamples / 2 ** 32))
  info.raw((totalSamples >>> 24) & 0xff, (totalSamples >>> 16) & 0xff, (totalSamples >>> 8) & 0xff, totalSamples & 0xff).zeros(16)
  return Uint8Array.from([...new Bytes().text('fLaC').raw(0x80, 0, 0, 34).bytes, ...info.bytes, ...after])
}

/** A FLAC frame header of 4096 samples at STREAMINFO's rate, stereo, with its CRC-8, then a body of zeros. */
function flacFrame(number: number, body = 40): number[] {
  const header = [0xff, 0xf8, 0xc0, 0x18, number & 0x7f]
  return [...header, crc8(header), ...new Array<number>(body).fill(0)]
}

/** One MPEG-1 layer III frame at 128 kbps and 44.1 kHz, stereo: 417 bytes, 1152 samples. */
function mp3Frame(body: readonly number[] = []): number[] {
  return [0xff, 0xfb, 0x90, 0x00, ...body, ...new Array<number>(413 - body.length).fill(0)]
}

/** An Ogg page of one stream: its segments as packets that each end on this page unless `open`. */
function oggPage(options: {
  readonly serial: number
  readonly sequence: number
  readonly packets: readonly (readonly number[])[]
  readonly begins?: boolean
  readonly continued?: boolean
  /** The last packet goes on to the next page: its lacing ends with 255. */
  readonly open?: boolean
}): Uint8Array {
  const lacing: number[] = []
  options.packets.forEach((packet, index) => {
    let left = packet.length
    while (left >= 255) {
      lacing.push(255)
      left -= 255
    }
    if (!(options.open === true && index === options.packets.length - 1)) lacing.push(left)
  })
  const flags = (options.continued === true ? 1 : 0) | (options.begins === true ? 2 : 0)
  const page = new Bytes().text('OggS').raw(0, flags).int(0, 8).int(options.serial, 4).int(options.sequence, 4).int(0, 4)
    .raw(lacing.length, ...lacing).raw(...options.packets.flat()).bytes
  new DataView(page.buffer).setUint32(22, crc32(page), true)
  return page
}

const OPUS_HEAD = [...new Bytes().text('OpusHead').raw(1, 2).int(312, 2).int(48_000, 4).int(0, 2).raw(0).bytes]
const OPUS_TAGS = [...new Bytes().text('OpusTags').int(0, 4).int(0, 4).bytes]

function join(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flatMap(part => [...part]))
}

function refusal(run: () => unknown): DecodePlanError | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof DecodePlanError) return error
    throw error
  }
  return undefined
}

describe('decodePlan', () => {
  it('counts a WAV file\'s samples to the end of the file, whatever length its data chunk states', () => {
    const wav = pcmWav({ sampleRate: 48_000, channels: 2, frames: 48_000 })
    expect(decodePlan(wav, 1200)).toMatchObject({ seconds: 1, sampleRate: 48_000, channels: 2, exact: true, cut: false })
    expect(decodePlan(wav, 1200).data).toBe(wav)
    // A data chunk that states a fraction of the samples after it does not shorten what a decoder may read.
    expect(decodePlan(pcmWav({ sampleRate: 8000, frames: 8000, dataLength: 2 }), 1200).seconds).toBe(1)
    // ADPCM yields at most two samples a byte: 4000 bytes, 8000 samples.
    expect(decodePlan(pcmWav({ sampleRate: 8000, frames: 4000, code: 0x11, bits: 8 }), 1200)).toMatchObject({ seconds: 1, exact: false })
    // An encoding the plan cannot bound is not decoded.
    expect(refusal(() => decodePlan(pcmWav({ frames: 10, code: 0x55 }), 1200))).toMatchObject({ reason: 'unsupported' })
  })

  it('counts every FLAC frame the file holds, whatever total its STREAMINFO states', () => {
    const frames = Array.from({ length: 30 }, (_, index) => flacFrame(index)).flat()
    for (const total of [0, 1, 30 * 4096]) {
      const plan = decodePlan(flac(total, frames), 1200)
      expect(plan).toMatchObject({ sampleRate: 48_000, channels: 2, exact: true, cut: false })
      expect(plan.seconds).toBeCloseTo((30 * 4096) / 48_000, 9)
    }
    // Frames past a stretch of other bytes count too, as a decoder finds them.
    const hidden = flac(1, [...flacFrame(0), ...new Array<number>(10_000).fill(0x5a), ...flacFrame(1), ...flacFrame(2)])
    expect(decodePlan(hidden, 1200).seconds).toBeCloseTo((3 * 4096) / 48_000, 9)
    // A sync code whose header CRC-8 does not match starts no frame.
    const damaged = flacFrame(3)
    damaged[5] = (damaged[5] ?? 0) ^ 0xff
    expect(decodePlan(flac(0, [...flacFrame(0), ...damaged]), 1200).seconds).toBeCloseTo(4096 / 48_000, 9)
  })

  it('refuses a FLAC file without frames, and stops counting at the limit', () => {
    // The review's crafted file: STREAMINFO and a megabyte of zeros, which once passed a length check with a total of 0.
    const zeros = new Uint8Array(1024 * 1024)
    zeros.set(flac(0, []))
    expect(refusal(() => decodePlan(zeros, 1200))).toMatchObject({ reason: 'no-audio', message: 'The FLAC file holds no audio frames.' })
    // A megabyte of tiny frames, about 2.3 hours, stops once it passes the limit.
    const many = Array.from({ length: 24_000 }, (_, index) => flacFrame(index, 4)).flat()
    const plan = decodePlan(flac(1, many), 60)
    expect(plan).toMatchObject({ cut: true, exact: false })
    expect(plan.seconds).toBeGreaterThan(60)
    expect(plan.seconds).toBeLessThan(61)
  })

  it('counts the MPEG frames a decoder follows, past an Info frame that understates them', () => {
    // An Info frame that counts 2 frames, at the head of 2,397 more.
    const info = mp3Frame([...new Array<number>(32).fill(0), ...Array.from('Info', character => character.charCodeAt(0)), 0, 0, 0, 1, 0, 0, 0, 2])
    const file = new Uint8Array(2398 * 417)
    file.set(info)
    for (let at = 417; at < file.length; at += 417) file.set(mp3Frame(), at)
    const plan = decodePlan(file, 1200)
    expect(plan).toMatchObject({ sampleRate: 44_100, channels: 2, exact: true, cut: false })
    expect(plan.seconds).toBeCloseTo((2398 * 1152) / 44_100, 9)
    // The whole chain is one stretch of the file, which the decoder receives without a copy.
    expect(plan.data.byteLength).toBe(file.byteLength)
  })

  it('hands the decoder only the frames it counted: no tag, junk, other stream, or cut frame', () => {
    const tag = new Bytes().text('ID3').raw(3, 0, 0, 0, 0, 0, 20).zeros(20).bytes
    // A 22.05 kHz frame belongs to another stream than the 44.1 kHz frames.
    const other = [0xff, 0xf3, 0x80, 0xc4, ...new Array<number>(204).fill(0)]
    const junk = new Array<number>(5000).fill(0x11)
    const file = join(tag, mp3Frame(), mp3Frame(), junk, other, mp3Frame(), mp3Frame(), mp3Frame().slice(0, 200))
    const plan = decodePlan(file, 1200)
    expect(plan.seconds).toBeCloseTo((4 * 1152) / 44_100, 9)
    expect(plan.data).toEqual(join(mp3Frame(), mp3Frame(), mp3Frame(), mp3Frame()))
  })

  it('stops counting MPEG frames at the limit, and refuses content without frames', () => {
    // 47 MB of 32 kbps frames at 32 kHz, 11,750 s, stops at the limit before it reaches the end.
    const frame = [0xff, 0xfb, 0x18, 0x00, ...new Array<number>(140).fill(0)]
    const long = new Uint8Array(326_389 * 144)
    for (let at = 0; at < long.length; at += 144) long.set(frame, at)
    const plan = decodePlan(long, 1200)
    expect(plan).toMatchObject({ cut: true, exact: false })
    expect(plan.seconds).toBeLessThan(1201)
    expect(refusal(() => decodePlan(new TextEncoder().encode('....ftypM4A not an MP3 at all'), 1200))).toMatchObject({ reason: 'no-audio' })
    expect(refusal(() => decodePlan(new Bytes().text('FORM').int(4, 4).text('AIFF').bytes, 1200))).toMatchObject({ reason: 'unsupported' })
  })

  it('counts an Opus stream\'s packets by their table of contents, from the pages whose CRC matches', () => {
    // 20 ms CELT frames: one frame (code 0), two (code 1), and three by count (code 3).
    const one = [(31 << 3) | 0, 0]
    const two = [(31 << 3) | 1, 0, 0]
    const three = [(31 << 3) | 3, 3, 0]
    const audio = oggPage({ serial: 7, sequence: 2, packets: [one, two, three, one] })
    const damaged = oggPage({ serial: 7, sequence: 3, packets: [three, three] })
    // A byte of its packets changed, so its CRC no longer matches.
    damaged[30] = (damaged[30] ?? 0) ^ 0xff
    const otherStream = oggPage({ serial: 9, sequence: 0, packets: [three, three] })
    const file = join(
      oggPage({ serial: 7, sequence: 0, packets: [OPUS_HEAD], begins: true }),
      oggPage({ serial: 7, sequence: 1, packets: [OPUS_TAGS] }),
      audio, otherStream, damaged,
    )
    const plan = decodePlan(file, 1200)
    expect(plan).toMatchObject({ sampleRate: 48_000, channels: 2, exact: true, cut: false })
    expect(plan.seconds).toBeCloseTo(0.02 * 7, 9)
    // The decoder receives the stream's intact pages alone.
    expect(plan.data.byteLength).toBe(file.byteLength - otherStream.byteLength - damaged.byteLength)
  })

  it('follows Ogg packets across pages, and counts a continuation after a missing page as a packet of its own', () => {
    const long = [(31 << 3) | 0, ...new Array<number>(400).fill(0)]
    const head = [
      oggPage({ serial: 1, sequence: 0, packets: [OPUS_HEAD], begins: true }), oggPage({ serial: 1, sequence: 1, packets: [OPUS_TAGS] }),
    ]
    const start = oggPage({ serial: 1, sequence: 2, packets: [long.slice(0, 255)], open: true })
    // One packet of 401 bytes spans two pages: it counts once.
    const spanned = join(...head, start, oggPage({ serial: 1, sequence: 3, packets: [long.slice(255)], continued: true }))
    expect(decodePlan(spanned, 1200).seconds).toBeCloseTo(0.02, 9)
    // When the page before a continuation is missing, a decoder may start a packet there, which counts as one.
    const gap = join(...head, start, oggPage({ serial: 1, sequence: 5, packets: [long.slice(255)], continued: true }))
    expect(decodePlan(gap, 1200).seconds).toBeGreaterThan(0.02)
  })

  it('bounds a Vorbis stream by half a long block for each audio packet, and refuses an Ogg stream it cannot bound', () => {
    // A Vorbis identification header: 44.1 kHz stereo, blocks of 256 and 2048 samples.
    const identification = [...new Bytes().raw(1).text('vorbis').int(0, 4).raw(2).int(44_100, 4).int(0, 4).int(160_000, 4).int(0, 4).raw(0xb8, 1).bytes]
    const headers = [identification, [3, ...Array.from('vorbis', character => character.charCodeAt(0))], [5, ...Array.from('vorbis', character => character.charCodeAt(0))]]
    const file = join(
      oggPage({ serial: 2, sequence: 0, packets: [headers[0] ?? []], begins: true }),
      oggPage({ serial: 2, sequence: 1, packets: [headers[1] ?? [], headers[2] ?? []] }),
      oggPage({ serial: 2, sequence: 2, packets: Array.from({ length: 10 }, () => [0, 1, 2]) }),
    )
    expect(decodePlan(file, 1200)).toMatchObject({ seconds: (10 * 1024) / 44_100, sampleRate: 44_100, channels: 2, exact: false })
    const theora = join(oggPage({ serial: 4, sequence: 0, packets: [[0x80, ...Array.from('theora', character => character.charCodeAt(0))]], begins: true }))
    expect(refusal(() => decodePlan(theora, 1200))).toMatchObject({ reason: 'unsupported' })
  })

  it('costs a bounded scan for a file of false Ogg pages', () => {
    // Capture patterns every few bytes, each claiming a page of 255 segments of 255 bytes, none with a matching CRC.
    const page = new Bytes().text('OggS').raw(0, 2).int(0, 8).int(1, 4).int(0, 4).int(0, 4).raw(255, ...new Array<number>(255).fill(255)).bytes
    const file = new Uint8Array(4 * 1024 * 1024)
    for (let at = 0; at + page.length <= file.length; at += page.length) file.set(page, at)
    const started = performance.now()
    expect(refusal(() => decodePlan(file, 1200))).toBeInstanceOf(DecodePlanError)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
