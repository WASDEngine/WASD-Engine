/** What the header probe reads from WAV, AIFF, FLAC, MP3, and Ogg files, and how the AIFF decoder reads samples. */
import { describe, expect, it } from 'vitest'
import { AiffDecodeError, decodeAiff } from '../src/audio/aiff.ts'
import { probeAudio, readExtended } from '../src/audio/probe.ts'
import { aiff, Bytes, extended, memoryReader, pcmWav } from './signals.ts'

async function probe(bytes: Uint8Array): Promise<Awaited<ReturnType<typeof probeAudio>>> {
  return await probeAudio(memoryReader(bytes).read, bytes.length)
}

/** One MPEG-1 layer III frame at 128 kbps and 44.1 kHz: 417 bytes. */
function mp3Frame(options: { readonly mono?: boolean; readonly body?: (bytes: Bytes) => void } = {}): number[] {
  const frame = new Bytes().raw(0xff, 0xfb, 0x90, options.mono === true ? 0xc0 : 0x00)
  options.body?.(frame)
  const filled = frame.bytes.length
  return [...frame.zeros(417 - filled).bytes]
}

/** An Ogg page with one packet. */
function oggPage(options: {
  readonly type: number
  readonly granule: number
  readonly serial: number
  readonly packet: readonly number[]
}): number[] {
  return [...new Bytes().text('OggS').raw(0, options.type).int(options.granule, 8).int(options.serial, 4).int(0, 4).int(0, 4)
    .raw(1, options.packet.length).raw(...options.packet).bytes]
}

describe('probeAudio', () => {
  it('reads a WAV file\'s encoding, rate, channels, depth, and length, past chunks before its format', async () => {
    expect(await probe(pcmWav({ sampleRate: 48_000, channels: 1, bits: 16, frames: 24_000, before: [['LIST', 31], ['bext', 602]] }))).toEqual({
      format: 'WAV', encoding: '16-bit PCM', sampleRate: 48_000, channels: 1, bitDepth: 16, seconds: 0.5,
    })
    expect(await probe(pcmWav({ sampleRate: 44_100, channels: 2, bits: 32, code: 3, frames: 441, extensible: true }))).toMatchObject({
      encoding: '32-bit float', channels: 2, seconds: 0.01,
    })
  })

  it('reads a WAV sampler loop after the samples, a compressed encoding\'s bit rate, and a streamed length', async () => {
    expect((await probe(pcmWav({ frames: 4800, loop: [100, 4799] })))?.loop).toEqual({ start: 100, end: 4799 })
    const adpcm = await probe(pcmWav({ frames: 100, code: 0x11, bits: 4, channels: 2 }))
    expect(adpcm).toMatchObject({ encoding: 'IMA ADPCM', bitrate: 384_000 })
    expect(adpcm?.bitDepth).toBeUndefined()
    expect((await probe(pcmWav({ frames: 4800, dataLength: 0 })))?.seconds).toBe(0.1)
    expect((await probe(pcmWav({ frames: 4800, dataLength: 0xffff_ffff })))?.seconds).toBe(0.1)
  })

  it('reads an AIFF file\'s 80-bit sample rate and frame count', async () => {
    expect(readExtended(Uint8Array.from(extended(44_100)), 0)).toBe(44_100)
    expect(await probe(aiff({ sampleRate: 22_050, channels: 1, bits: 16, frames: 4, samples: [0, 0, 0, 0, 0, 0, 0, 0] }))).toEqual({
      format: 'AIFF', encoding: '16-bit PCM', sampleRate: 22_050, channels: 1, bitDepth: 16, seconds: 4 / 22_050,
    })
    expect((await probe(aiff({ sampleRate: 48_000, channels: 2, bits: 32, frames: 0, compression: 'fl32', samples: [] })))?.encoding).toBe('32-bit float')
  })

  it('reads FLAC STREAMINFO, also after an ID3 tag', async () => {
    const info = (44_100n << 44n) | (1n << 41n) | (15n << 36n) | 441_000n
    const packed: number[] = []
    for (let shift = 56n; shift >= 0n; shift -= 8n) packed.push(Number((info >> shift) & 0xffn))
    const flac = new Bytes().text('fLaC').raw(0x80, 0, 0, 34).int(4096, 2, true).int(4096, 2, true).zeros(6).raw(...packed).zeros(16).zeros(1000).bytes
    expect(await probe(flac)).toEqual({
      format: 'FLAC', encoding: '16-bit FLAC', sampleRate: 44_100, channels: 2, bitDepth: 16, seconds: 10, bitrate: Math.round(flac.length * 8 / 10),
    })
    const tagged = new Bytes().text('ID3').raw(3, 0, 0, 0, 0, 0, 20).zeros(20).raw(...flac).bytes
    expect((await probe(tagged))?.seconds).toBe(10)
  })

  it('reads an MP3 file\'s length from its Info frame less the LAME encoder delay and padding', async () => {
    const info = mp3Frame({
      body: frame => frame.zeros(32).text('Info').int(0x0f, 4, true).int(100, 4, true).int(41_700, 4, true).zeros(100).int(0, 4, true)
        .text('LAME3.100').zeros(12).raw(0x24, 0x03, 0xe8),
    })
    const file = Uint8Array.from([...info, ...mp3Frame(), ...mp3Frame()])
    expect(await probe(file)).toEqual({ format: 'MP3', sampleRate: 44_100, channels: 2, seconds: (100 * 1152 - 576 - 1000) / 44_100, bitrate: Math.round(41_700 * 8 / ((100 * 1152 - 1576) / 44_100)) })
  })

  it('reads a VBRI frame count, skips an ID3 tag, and estimates a length without a frame count from the bit rate', async () => {
    const vbri = mp3Frame({ body: frame => frame.zeros(32).text('VBRI').int(1, 2, true).int(0, 2, true).int(75, 2, true).int(20_000, 4, true).int(50, 4, true) })
    expect((await probe(Uint8Array.from([...vbri, ...mp3Frame()])))?.seconds).toBe(50 * 1152 / 44_100)
    const tag = new Bytes().text('ID3').raw(3, 0, 0, 0, 0, 2, 44).zeros(300).bytes
    const plain = Uint8Array.from([...tag, ...mp3Frame({ mono: true }), ...mp3Frame({ mono: true }), ...mp3Frame({ mono: true })])
    expect(await probe(plain)).toEqual({ format: 'MP3', sampleRate: 44_100, channels: 1, bitrate: 128_000, seconds: 3 * 417 * 8 / 128_000, estimated: true })
  })

  it('reads Ogg Vorbis and Ogg Opus lengths from the last page\'s granule position', async () => {
    const vorbisHead = [...new Bytes().raw(1).text('vorbis').int(0, 4).raw(2).int(44_100, 4).int(0, 4).int(160_000, 4).int(0, 4).raw(0xb8, 1).bytes]
    const vorbis = Uint8Array.from([
      ...oggPage({ type: 2, granule: 0, serial: 7, packet: vorbisHead }),
      ...new Array<number>(5000).fill(0),
      ...oggPage({ type: 0, granule: 220_500, serial: 7, packet: [1] }),
      ...oggPage({ type: 4, granule: 441_000, serial: 7, packet: [1] }),
      // A page of another stream at the end is not the Vorbis stream's last.
      ...oggPage({ type: 4, granule: 999_999, serial: 9, packet: [1] }),
    ])
    expect(await probe(vorbis)).toEqual({ format: 'Ogg Vorbis', sampleRate: 44_100, channels: 2, seconds: 10, bitrate: Math.round(vorbis.length * 8 / 10) })
    const opusHead = [...new Bytes().text('OpusHead').raw(1, 1).int(312, 2).int(16_000, 4).int(0, 2).raw(0).bytes]
    const opus = Uint8Array.from([
      ...oggPage({ type: 2, granule: 0, serial: 3, packet: opusHead }),
      ...oggPage({ type: 4, granule: 312 + 3 * 48_000, serial: 3, packet: [1] }),
      // A page without a finished packet carries the granule position -1.
      ...oggPage({ type: 0, granule: -1, serial: 3, packet: [1] }),
    ])
    expect(await probe(opus)).toMatchObject({ format: 'Ogg Opus', sampleRate: 48_000, channels: 1, seconds: 3 })
  })

  it('reads nothing from a file whose headers name no format it reads', async () => {
    expect(await probe(new TextEncoder().encode('not audio at all, just text'))).toBeUndefined()
    expect(await probe(Uint8Array.from([0x52, 0x49]))).toBeUndefined()
    // A frame sync whose next frame does not sync is junk, not MPEG audio.
    const junk = Uint8Array.from([...new Array<number>(20).fill(0), 0xff, 0xfb, 0x90, 0x00, ...new Array<number>(900).fill(0x11)])
    expect(await probe(junk)).toBeUndefined()
  })
})

describe('decodeAiff', () => {
  it('reads big-endian, little-endian, unsigned, 24-bit, and float samples as values from -1 to 1', () => {
    const samples = [0x40, 0, 0xc0, 0, 0x7f, 0xff, 0x80, 0]
    const stereo = decodeAiff(aiff({ sampleRate: 8000, channels: 2, bits: 16, frames: 2, samples }))
    expect(Array.from(stereo.samples)).toEqual([0.5, -0.5, 32_767 / 32_768, -1])
    expect(stereo).toMatchObject({ sampleRate: 8000, channels: 2, frames: 2 })
    expect(Array.from(decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 16, frames: 1, compression: 'sowt', samples: [0, 0x40] })).samples)).toEqual([0.5])
    expect(Array.from(decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 8, frames: 1, compression: 'raw ', samples: [0xc0] })).samples)).toEqual([0.5])
    const deep = decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 24, frames: 1, samples: [0x40, 0, 0] }))
    expect(Array.from(deep.samples)).toEqual([0.5])
    const float = new DataView(new ArrayBuffer(4))
    float.setFloat32(0, -0.25, false)
    expect(Array.from(decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 32, frames: 1, compression: 'fl32', samples: [...new Uint8Array(float.buffer)] })).samples)).toEqual([-0.25])
  })

  it('stops at the end of a short sound chunk and names what it cannot read', () => {
    expect(decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 16, frames: 10, samples: [0x40, 0, 0x40] })).frames).toBe(1)
    expect(() => decodeAiff(new TextEncoder().encode('RIFF....WAVE'))).toThrow(AiffDecodeError)
    expect(() => decodeAiff(aiff({ sampleRate: 8000, channels: 1, bits: 8, frames: 1, compression: 'ulaw', samples: [0] }))).toThrow('"ulaw" samples')
    const soundless = new Bytes().text('FORM').int(30, 4, true).text('AIFF').text('COMM').int(18, 4, true)
      .int(1, 2, true).int(1, 4, true).int(16, 2, true).raw(...extended(8000)).bytes
    expect(() => decodeAiff(soundless)).toThrow('no sound chunk')
  })
})
