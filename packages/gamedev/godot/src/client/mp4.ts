/**
 * An MP4 file (ISO base media file format) of one video track, written whole once every sample is known: `ftyp`, then
 * `moov` before `mdat`, so players start before the whole file arrived. The samples sit in one chunk in decode order;
 * `stts` holds their decode durations and `stss` the key frames. When the encoder reordered frames, `ctts` holds their
 * composition offsets and an edit list starts the presentation at the first frame. H.264 samples carry the encoder's
 * `avcC` record, VP9 samples a `vpcC` record of 8-bit 4:2:0 video.
 */

/** One encoded frame, in decode order. */
export interface Mp4Sample {
  /** The frame's bytes: length-prefixed NAL units for H.264, a frame for VP9. */
  readonly data: Uint8Array
  /** Presentation time in `timescale` units, from 0. */
  readonly time: number
  /** Whether the frame decodes alone. */
  readonly key: boolean
}

/** The track a file holds. */
export interface Mp4Track {
  /** `avc` for H.264, `vp9` for VP9. */
  readonly codec: 'avc' | 'vp9'
  /** Frame size in pixels. */
  readonly width: number
  readonly height: number
  /** Time units per second of the sample times. */
  readonly timescale: number
  /** The `avcC` record of an H.264 track. */
  readonly description?: Uint8Array
  /** VP9 profile and level, from the codec string. */
  readonly vp9?: { readonly profile: number; readonly level: number }
  /** Presentation time units that the last frame shows. */
  readonly lastDuration: number
}

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

/** Largest offset a 32-bit `stco` entry holds; larger files take `co64`. */
const MAX_UINT32 = 0xffff_ffff

class Writer {
  private readonly parts: Uint8Array[] = []
  size = 0

  bytes(data: Uint8Array): this {
    this.parts.push(data)
    this.size += data.byteLength
    return this
  }

  u8(value: number): this {
    return this.bytes(Uint8Array.of(value & 0xff))
  }

  u16(value: number): this {
    const data = new Uint8Array(2)
    new DataView(data.buffer).setUint16(0, value)
    return this.bytes(data)
  }

  u32(value: number): this {
    const data = new Uint8Array(4)
    new DataView(data.buffer).setUint32(0, value >>> 0)
    return this.bytes(data)
  }

  u64(value: number): this {
    const data = new Uint8Array(8)
    new DataView(data.buffer).setBigUint64(0, BigInt(value))
    return this.bytes(data)
  }

  text(value: string): this {
    return this.bytes(new TextEncoder().encode(value))
  }

  zeros(count: number): this {
    return this.bytes(new Uint8Array(count))
  }

  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    return out
  }
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const writer = new Writer()
  const size = 8 + children.reduce((total, child) => total + child.byteLength, 0)
  writer.u32(size).text(type)
  for (const child of children) writer.bytes(child)
  return writer.finish()
}

function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  const head = new Writer().u8(version).u8(flags >> 16).u8(flags >> 8).u8(flags).finish()
  return box(type, head, body)
}

function matrix(writer: Writer): Writer {
  for (const value of UNITY_MATRIX) writer.u32(value)
  return writer
}

/** Run-length pairs of equal consecutive values: [count, value]. */
function runs(values: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const value of values) {
    const last = out.at(-1)
    if (last !== undefined && last[1] === value) last[0] += 1
    else out.push([1, value])
  }
  return out
}

function sampleEntry(track: Mp4Track): Uint8Array {
  const visual = new Writer()
    .zeros(6).u16(1) // reserved, data_reference_index
    .u16(0).u16(0).zeros(12) // pre_defined, reserved, pre_defined
    .u16(track.width).u16(track.height)
    .u32(0x00480000).u32(0x00480000) // 72 dpi
    .u32(0).u16(1) // reserved, frame_count
    .zeros(32) // compressorname
    .u16(0x0018).u16(0xffff) // depth, pre_defined
    .finish()
  if (track.codec === 'avc') {
    if (track.description === undefined) throw new Error('An H.264 track needs its avcC record.')
    return box('avc1', visual, box('avcC', track.description))
  }
  const vp9 = track.vp9 ?? { profile: 0, level: 51 }
  const config = new Writer()
    .u8(vp9.profile).u8(vp9.level)
    .u8((8 << 4) | (1 << 1) | 0) // bit depth 8, 4:2:0 colocated with luma, limited range
    .u8(1).u8(1).u8(1) // BT.709 primaries, transfer, and matrix
    .u16(0) // no codec initialization data
    .finish()
  return box('vp09', visual, fullBox('vpcC', 1, 0, config))
}

/**
 * Write an MP4 file of one video track.
 * @param track - codec, size, timescale, and codec record.
 * @param samples - encoded frames in decode order, the first at presentation time 0.
 * @returns the file's bytes.
 * @throws {Error} without samples, or an H.264 track without its `avcC` record.
 */
export function writeMp4(track: Mp4Track, samples: readonly Mp4Sample[]): Uint8Array<ArrayBuffer> {
  if (samples.length === 0) throw new Error('A video needs at least one frame.')
  // Decode times are the presentation times in order; composition times shift by the most that a frame decodes after
  // its presentation time would, so no frame shows before it decodes.
  const dts = samples.map(sample => sample.time).sort((left, right) => left - right)
  const shift = Math.max(0, ...samples.map((sample, index) => (dts[index] as number) - sample.time))
  const durations = dts.map((time, index) => index + 1 < dts.length ? (dts[index + 1] as number) - time : track.lastDuration)
  const offsets = samples.map((sample, index) => sample.time + shift - (dts[index] as number))
  const reordered = offsets.some(offset => offset !== 0)
  const duration = (dts.at(-1) as number) + track.lastDuration
  const dataBytes = samples.reduce((total, sample) => total + sample.data.byteLength, 0)

  const build = (chunkOffset: number, wide: boolean): Uint8Array => {
    const stts = new Writer()
    const timeRuns = runs(durations)
    stts.u32(timeRuns.length)
    for (const [count, delta] of timeRuns) stts.u32(count).u32(delta)
    const tables = [
      fullBox('stsd', 0, 0, new Writer().u32(1).bytes(sampleEntry(track)).finish()),
      fullBox('stts', 0, 0, stts.finish()),
    ]
    if (reordered) {
      const ctts = new Writer()
      const offsetRuns = runs(offsets)
      ctts.u32(offsetRuns.length)
      for (const [count, offset] of offsetRuns) ctts.u32(count).u32(offset)
      tables.push(fullBox('ctts', 0, 0, ctts.finish()))
    }
    const keys = samples.flatMap((sample, index) => sample.key ? [index + 1] : [])
    if (keys.length < samples.length) {
      const stss = new Writer().u32(keys.length)
      for (const key of keys) stss.u32(key)
      tables.push(fullBox('stss', 0, 0, stss.finish()))
    }
    tables.push(fullBox('stsc', 0, 0, new Writer().u32(1).u32(1).u32(samples.length).u32(1).finish()))
    const stsz = new Writer().u32(0).u32(samples.length)
    for (const sample of samples) stsz.u32(sample.data.byteLength)
    tables.push(fullBox('stsz', 0, 0, stsz.finish()))
    tables.push(wide
      ? fullBox('co64', 0, 0, new Writer().u32(1).u64(chunkOffset).finish())
      : fullBox('stco', 0, 0, new Writer().u32(1).u32(chunkOffset).finish()))
    const movieDuration = Math.round(duration * 1000 / track.timescale)
    const mvhd = fullBox('mvhd', 0, 0, matrix(new Writer()
      .u32(0).u32(0).u32(1000).u32(movieDuration) // creation, modification, timescale, duration
      .u32(0x00010000).u16(0x0100).zeros(10)) // rate, volume, reserved
      .zeros(24).u32(2).finish()) // pre_defined, next_track_ID
    const tkhd = fullBox('tkhd', 0, 3, matrix(new Writer()
      .u32(0).u32(0).u32(1).u32(0).u32(movieDuration) // creation, modification, track_ID, reserved, duration
      .zeros(8).u16(0).u16(0).u16(0).u16(0)) // reserved, layer, alternate_group, volume, reserved
      .u32(track.width * 0x10000).u32(track.height * 0x10000).finish())
    const mdhd = fullBox('mdhd', 0, 0, new Writer().u32(0).u32(0).u32(track.timescale).u32(duration).u16(0x55c4).u16(0).finish())
    const hdlr = fullBox('hdlr', 0, 0, new Writer().u32(0).text('vide').zeros(12).text('VideoHandler').u8(0).finish())
    const vmhd = fullBox('vmhd', 0, 1, new Writer().zeros(8).finish())
    const dinf = box('dinf', fullBox('dref', 0, 0, new Writer().u32(1).bytes(fullBox('url ', 0, 1, new Uint8Array(0))).finish()))
    const minf = box('minf', vmhd, dinf, box('stbl', ...tables))
    const mdia = box('mdia', mdhd, hdlr, minf)
    if (shift === 0) return box('moov', mvhd, box('trak', tkhd, mdia))
    const elst = fullBox('elst', 0, 0, new Writer().u32(1).u32(movieDuration).u32(shift).u16(1).u16(0).finish())
    return box('moov', mvhd, box('trak', tkhd, box('edts', elst), mdia))
  }

  const brands = track.codec === 'avc' ? ['isom', 'iso2', 'avc1', 'mp41'] : ['isom', 'iso2', 'vp09', 'mp41']
  const ftyp = box('ftyp', new Writer().text('isom').u32(0x200).text(brands.join('')).finish())
  const largeData = dataBytes + 8 > MAX_UINT32
  const mdatHeader = largeData ? 16 : 8
  // The movie box's size does not depend on the chunk offset's value, only on its width.
  let wide = false
  let moov = build(0, wide)
  if (ftyp.byteLength + moov.byteLength + mdatHeader > MAX_UINT32 - dataBytes) {
    wide = true
    moov = build(0, wide)
  }
  const chunkOffset = ftyp.byteLength + moov.byteLength + mdatHeader
  moov = build(chunkOffset, wide)
  const mdat = new Writer()
  if (largeData) mdat.u32(1).text('mdat').u64(dataBytes + 16)
  else mdat.u32(dataBytes + 8).text('mdat')
  for (const sample of samples) mdat.bytes(sample.data)
  const file = new Writer().bytes(ftyp).bytes(moov).bytes(mdat.finish())
  return file.finish()
}
