/** The MP4 writer: one video track whose samples sit in one chunk after the movie box. */
import { describe, expect, it } from 'vitest'
import { writeMp4, type Mp4Sample, type Mp4Track } from '../src/client/mp4.ts'

interface Box {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly body: DataView
}

/** The boxes in `[start, end)` of a file, without descending. */
function boxes(file: Uint8Array, start = 0, end = file.byteLength): Box[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const found: Box[] = []
  for (let offset = start; offset < end;) {
    let size = view.getUint32(offset)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8))
      header = 16
    }
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8))
    const body = new DataView(file.buffer, file.byteOffset + offset + header, size - header)
    found.push({ type, start: offset, end: offset + size, body })
    offset += size
  }
  return found
}

/** The box at a path of types, such as moov/trak/mdia. */
function find(file: Uint8Array, path: readonly string[]): Box {
  let scope = boxes(file)
  let box: Box | undefined
  for (const [depth, type] of path.entries()) {
    box = scope.find(candidate => candidate.type === type)
    if (box === undefined) throw new Error(`no ${type} box`)
    if (depth + 1 < path.length) scope = boxes(file, box.body.byteOffset - file.byteOffset, box.end)
  }
  return box as Box
}

const STBL = ['moov', 'trak', 'mdia', 'minf', 'stbl']

function track(overrides: Partial<Mp4Track> = {}): Mp4Track {
  return { codec: 'avc', width: 640, height: 360, timescale: 90_000, description: Uint8Array.of(1, 100, 0, 31, 255), lastDuration: 3000, ...overrides }
}

function samples(times: readonly number[], keys: readonly number[] = [0]): Mp4Sample[] {
  return times.map((time, index) => ({ data: Uint8Array.of(index, index, index), time, key: keys.includes(index) }))
}

describe('writeMp4', () => {
  it('writes ftyp, then moov, then mdat with the samples in order, which the chunk offset points at', () => {
    const file = writeMp4(track(), samples([0, 3000, 6000, 9000], [0, 2]))
    expect(boxes(file).map(box => box.type)).toEqual(['ftyp', 'moov', 'mdat'])
    const mdat = boxes(file).find(box => box.type === 'mdat') as Box
    const stco = find(file, [...STBL, 'stco'])
    expect(stco.body.getUint32(4)).toBe(1)
    const offset = stco.body.getUint32(8)
    expect(offset).toBe(mdat.start + 8)
    expect([...file.subarray(offset, offset + 12)]).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
  })

  it('records the sample sizes, durations, key frames, size, and duration', () => {
    const file = writeMp4(track(), samples([0, 3000, 6000, 10_000], [0, 2]))
    const stsz = find(file, [...STBL, 'stsz'])
    expect([stsz.body.getUint32(4), stsz.body.getUint32(8), stsz.body.getUint32(12)]).toEqual([0, 4, 3])
    // Durations run-length encoded: two of 3000, one of 4000, then the last frame's 3000.
    const stts = find(file, [...STBL, 'stts'])
    expect(stts.body.getUint32(4)).toBe(3)
    expect([1, 2, 3, 4, 5, 6].map(index => stts.body.getUint32(4 + index * 4))).toEqual([2, 3000, 1, 4000, 1, 3000])
    const stss = find(file, [...STBL, 'stss'])
    expect([stss.body.getUint32(4), stss.body.getUint32(8), stss.body.getUint32(12)]).toEqual([2, 1, 3])
    const mdhd = find(file, ['moov', 'trak', 'mdia', 'mdhd'])
    expect([mdhd.body.getUint32(12), mdhd.body.getUint32(16)]).toEqual([90_000, 13_000])
    const tkhd = find(file, ['moov', 'trak', 'tkhd'])
    expect([tkhd.body.getUint32(76) / 0x10000, tkhd.body.getUint32(80) / 0x10000]).toEqual([640, 360])
    const avc1 = find(file, [...STBL, 'stsd'])
    expect(String.fromCharCode(...new Uint8Array(avc1.body.buffer, avc1.body.byteOffset + 12, 4))).toBe('avc1')
    expect(() => find(file, [...STBL, 'ctts'])).toThrow('no ctts box')
    expect(() => find(file, ['moov', 'trak', 'edts'])).toThrow('no edts box')
  })

  it('leaves out stss when every frame is a key frame, and writes vpcC for VP9', () => {
    const file = writeMp4(track({ codec: 'vp9', vp9: { profile: 0, level: 41 } }), samples([0, 3000], [0, 1]))
    expect(() => find(file, [...STBL, 'stss'])).toThrow('no stss box')
    const stsd = find(file, [...STBL, 'stsd'])
    const entry = new Uint8Array(stsd.body.buffer, stsd.body.byteOffset, stsd.body.byteLength)
    expect(String.fromCharCode(...entry.subarray(12, 16))).toBe('vp09')
    const vpcc = String.fromCharCode(...entry).indexOf('vpcC')
    expect([...entry.subarray(vpcc + 8, vpcc + 11)]).toEqual([0, 41, (8 << 4) | (1 << 1)])
  })

  it('writes composition offsets and an edit list for frames the encoder reordered', () => {
    // Decode order I0 P3 B1 B2: presentation times 0, 9000, 3000, 6000.
    const file = writeMp4(track(), samples([0, 9000, 3000, 6000]))
    const ctts = find(file, [...STBL, 'ctts'])
    const entries = ctts.body.getUint32(4)
    const pair = (index: number): readonly [number, number] => [ctts.body.getUint32(8 + index * 8), ctts.body.getUint32(12 + index * 8)]
    const pairs = Array.from({ length: entries }, (_unused, index) => pair(index))
    // Each frame shows no earlier than it decodes: composition = presentation + 3000, decode = 0, 3000, 6000, 9000.
    expect(pairs).toEqual([[1, 3000], [1, 9000], [2, 0]])
    const elst = find(file, ['moov', 'trak', 'edts', 'elst'])
    expect([elst.body.getUint32(4), elst.body.getUint32(12)]).toEqual([1, 3000])
  })

  it('refuses a video without frames, and an H.264 track without its avcC record', () => {
    expect(() => writeMp4(track(), [])).toThrow('A video needs at least one frame.')
    const { description: _description, ...bare } = track()
    expect(() => writeMp4(bare, samples([0]))).toThrow('An H.264 track needs its avcC record.')
  })
})
