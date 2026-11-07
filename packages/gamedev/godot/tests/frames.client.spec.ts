// @vitest-environment jsdom
/** Frame records parse across any chunk split; the reader reconnects with backoff; the presenter draws the newest decoded frame. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeFrame, drawFrame, FRAME_HEADER_BYTES, FramePresenter, FrameRecordParser, FrameStreamError, MAX_FRAME_BYTES, nextFrame,
  readFrames, RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, type FrameRecord,
} from '../src/client/frames.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Encode one record the way the Host's frame route writes it. */
function encode(seq: number, width: number, height: number, image: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + image.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, image.length, true)
  view.setUint16(4, width, true)
  view.setUint16(6, height, true)
  view.setUint32(8, seq, true)
  bytes.set(image, FRAME_HEADER_BYTES)
  return bytes
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function plain(records: readonly FrameRecord[]) {
  return records.map(record => ({ seq: record.seq, width: record.width, height: record.height, image: [...record.image] }))
}

const EXPECTED = [
  { seq: 1, width: 640, height: 360, image: [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9] },
  { seq: 2, width: 1280, height: 720, image: [9] },
  { seq: 4_000_000_000, width: 65535, height: 1, image: Array.from({ length: 40 }, (_, index) => index) },
]
const STREAM = concat(...EXPECTED.map(entry => encode(entry.seq, entry.width, entry.height, entry.image)))

/** Deterministic pseudo-random split points. */
function* randomSplits(length: number, seed: number): Generator<number[]> {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state
  }
  for (let round = 0; round < 200; round++) {
    const cuts = new Set<number>()
    const count = next() % 12
    for (let index = 0; index < count; index++) cuts.add(next() % (length + 1))
    yield [...cuts].sort((left, right) => left - right)
  }
}

describe('FrameRecordParser', () => {
  it('parses the same records whatever single split the body takes', () => {
    for (let cut = 0; cut <= STREAM.byteLength; cut++) {
      const parser = new FrameRecordParser()
      const records = [...parser.push(STREAM.slice(0, cut)), ...parser.push(STREAM.slice(cut))]
      expect(plain(records)).toEqual(EXPECTED)
    }
  })

  it('parses byte by byte and across arbitrary chunk lists', () => {
    const bytewise = new FrameRecordParser()
    const records = [...STREAM].flatMap(byte => bytewise.push(new Uint8Array([byte])))
    expect(plain(records)).toEqual(EXPECTED)
    for (const cuts of randomSplits(STREAM.byteLength, 7)) {
      const parser = new FrameRecordParser()
      const bounds = [0, ...cuts, STREAM.byteLength]
      const parsed = bounds.slice(1).flatMap((end, index) => parser.push(STREAM.slice(bounds[index], end)))
      expect(plain(parsed)).toEqual(EXPECTED)
    }
  })

  it('returns completed records only and keeps a partial header or body for the next chunk', () => {
    const parser = new FrameRecordParser()
    const first = encode(5, 2, 2, [1, 2, 3])
    expect(parser.push(new Uint8Array(0))).toEqual([])
    expect(parser.push(first.slice(0, 5))).toEqual([])
    expect(parser.push(first.slice(5, FRAME_HEADER_BYTES + 1))).toEqual([])
    expect(plain(parser.push(concat(first.slice(FRAME_HEADER_BYTES + 1), encode(6, 1, 1, [7]).slice(0, 3))))).toEqual([
      { seq: 5, width: 2, height: 2, image: [1, 2, 3] },
    ])
  })

  it.each([
    ['an empty image', encode(1, 2, 2, []).slice(0, FRAME_HEADER_BYTES)],
    ['a zero width', encode(1, 0, 2, [1])],
    ['a zero height', encode(1, 2, 0, [1])],
  ])('rejects a header with %s', (_label, bytes) => {
    expect(() => new FrameRecordParser().push(bytes)).toThrow(FrameStreamError)
  })

  it('rejects an image longer than the record limit before buffering it', () => {
    const header = encode(1, 2, 2, []).slice(0, FRAME_HEADER_BYTES)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true)
    expect(() => new FrameRecordParser().push(header)).toThrow(FrameStreamError)
    expect(() => new FrameRecordParser().push(header)).toThrow(String(MAX_FRAME_BYTES + 1))
    expect(new FrameStreamError('corrupt').name).toBe('FrameStreamError')
    const atLimit = encode(1, 2, 2, []).slice(0, FRAME_HEADER_BYTES)
    new DataView(atLimit.buffer).setUint32(0, MAX_FRAME_BYTES, true)
    expect(new FrameRecordParser().push(atLimit)).toEqual([])
  })
})

/** A response whose body yields the given chunks, then ends, fails, or stays open until `signal` aborts it as fetch does. */
function body(chunks: readonly Uint8Array<ArrayBuffer>[], end: 'close' | 'error' | AbortSignal = 'close'): Response {
  return new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (end === 'close') controller.close()
      else if (end === 'error') controller.error(new TypeError('network lost'))
      else end.addEventListener('abort', () => { controller.error(end.reason) })
    },
  }))
}

describe('readFrames', () => {
  it('delivers records in order and reopens after the body ends, resetting the backoff after delivery', async () => {
    vi.useFakeTimers()
    const lifetime = new AbortController()
    const records: number[] = []
    const signals: AbortSignal[] = []
    const open = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal)
      return open.mock.calls.length === 1 ? body([STREAM.slice(0, 20), STREAM.slice(20)]) : body([], signal)
    })
    const done = readFrames({ open, onRecord: (record) => { records.push(record.seq) }, signal: lifetime.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(records).toEqual([1, 2, 4_000_000_000])
    expect(signals[0]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_MS - 1)
    expect(open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledTimes(2)
    expect(signals[1]?.aborted).toBe(false)
    lifetime.abort()
    await done
    expect(signals[1]?.aborted).toBe(true)
  })

  it.each([
    ['refuses with an HTTP error', async () => new Response('stale run', { status: 409 })],
    ['answers without a body', async () => new Response(null, { status: 200 })],
    ['cannot connect', async (): Promise<Response> => { throw new TypeError('connection refused') }],
    ['loses the body', async () => body([STREAM.slice(0, 3)], 'error')],
    ['sends a corrupt record', async () => body([encode(1, 0, 0, [1])])],
  ])('doubles the delay up to the ceiling while the Host %s', async (_label, respond) => {
    vi.useFakeTimers()
    const lifetime = new AbortController()
    const open = vi.fn(respond)
    const onRecord = vi.fn()
    const done = readFrames({ open, onRecord, signal: lifetime.signal })
    await vi.advanceTimersByTimeAsync(0)
    const expected = [250, 500, 1000, 2000, 4000, 4000]
    expect(expected.at(-1)).toBe(RECONNECT_MAX_MS)
    for (const [index, wait] of expected.entries()) {
      expect(open).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(open).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(onRecord).not.toHaveBeenCalled()
    lifetime.abort()
    await done
  })

  it('returns at once when aborted while waiting to reconnect or while reading', async () => {
    const waiting = new AbortController()
    const refused = readFrames({ open: async () => new Response(null, { status: 503 }), onRecord: vi.fn(), signal: waiting.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    waiting.abort()
    await refused

    const reading = new AbortController()
    const opened = Promise.withResolvers<AbortSignal>()
    const held = readFrames({
      open: async (signal) => {
        opened.resolve(signal)
        return new Response(new ReadableStream({
          start(controller) { signal.addEventListener('abort', () => { controller.error(signal.reason) }) },
        }))
      },
      onRecord: vi.fn(),
      signal: reading.signal,
    })
    const signal = await opened.promise
    reading.abort()
    await held
    expect(signal.aborted).toBe(true)

    const never = vi.fn()
    const aborted = new AbortController()
    aborted.abort()
    await readFrames({ open: never, onRecord: vi.fn(), signal: aborted.signal })
    expect(never).not.toHaveBeenCalled()
  })
})

class FakeBitmap implements ImageBitmap {
  readonly close = vi.fn()
  constructor(readonly width: number, readonly height: number) {}
}

function record(seq: number): FrameRecord {
  return { seq, width: 4, height: 3, image: new Uint8Array([seq]) }
}

function presenter() {
  const decodes: { record: FrameRecord; resolve: (bitmap: ImageBitmap) => void; reject: (error: unknown) => void }[] = []
  const paints: (() => void)[] = []
  const cancels: ReturnType<typeof vi.fn>[] = []
  const draw = vi.fn<(bitmap: ImageBitmap, record: FrameRecord) => void>()
  const instance = new FramePresenter({
    decode: decoded => new Promise((resolve, reject) => { decodes.push({ record: decoded, resolve, reject }) }),
    draw,
    schedule: (callback) => {
      paints.push(callback)
      const cancel = vi.fn()
      cancels.push(cancel)
      return cancel
    },
  })
  return { instance, decodes, paints, cancels, draw }
}

describe('FramePresenter', () => {
  it('decodes one record at a time, keeps only the newest waiting record, and draws the newest bitmap once per repaint', async () => {
    const p = presenter()
    p.instance.push(record(1))
    p.instance.push(record(2))
    p.instance.push(record(3))
    expect(p.decodes.map(entry => entry.record.seq)).toEqual([1])
    const first = new FakeBitmap(4, 3)
    p.decodes[0]!.resolve(first)
    await vi.waitFor(() => { expect(p.decodes).toHaveLength(2) })
    expect(p.decodes[1]!.record.seq).toBe(3)
    expect(p.paints).toHaveLength(1)
    const third = new FakeBitmap(4, 3)
    p.decodes[1]!.resolve(third)
    await vi.waitFor(() => { expect(first.close).toHaveBeenCalledOnce() })
    expect(p.paints).toHaveLength(1)
    p.paints[0]!()
    expect(p.draw).toHaveBeenCalledExactlyOnceWith(third, p.decodes[1]!.record)
    expect(third.close).toHaveBeenCalledOnce()
    p.instance.push(record(4))
    p.decodes[2]!.resolve(new FakeBitmap(4, 3))
    await vi.waitFor(() => { expect(p.paints).toHaveLength(2) })
  })

  it('skips a record that does not decode and decodes the next one', async () => {
    const p = presenter()
    p.instance.push(record(1))
    p.instance.push(record(2))
    p.decodes[0]!.reject(new Error('corrupt image'))
    await vi.waitFor(() => { expect(p.decodes).toHaveLength(2) })
    p.decodes[1]!.resolve(new FakeBitmap(4, 3))
    await vi.waitFor(() => { expect(p.paints).toHaveLength(1) })
  })

  it('cancels the pending paint, closes undrawn and late bitmaps, and ignores records after disposal', async () => {
    const p = presenter()
    p.instance.push(record(1))
    const ready = new FakeBitmap(4, 3)
    p.decodes[0]!.resolve(ready)
    await vi.waitFor(() => { expect(p.paints).toHaveLength(1) })
    p.instance.push(record(2))
    p.instance.dispose()
    expect(p.cancels[0]).toHaveBeenCalledOnce()
    expect(ready.close).toHaveBeenCalledOnce()
    const late = new FakeBitmap(4, 3)
    p.decodes[1]!.resolve(late)
    await vi.waitFor(() => { expect(late.close).toHaveBeenCalledOnce() })
    p.paints[0]!()
    expect(p.draw).not.toHaveBeenCalled()
    p.instance.push(record(3))
    expect(p.decodes).toHaveLength(2)
    p.instance.dispose()
  })
})

describe('browser helpers', () => {
  it.each([
    ['a JPEG', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['a PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], 'image/png'],
    ['bytes that only begin like a PNG', [0x89, 0x50, 0x4e, 0x47], 'image/jpeg'],
  ])('decodes %s through createImageBitmap with its media type', async (_name, image, type) => {
    const bitmap = new FakeBitmap(4, 3)
    const create = vi.fn(async (_blob: Blob) => bitmap)
    vi.stubGlobal('createImageBitmap', create)
    await expect(decodeFrame({ seq: 9, width: 4, height: 3, image: new Uint8Array(image) })).resolves.toBe(bitmap)
    const blob = create.mock.calls[0]![0]
    expect(blob.type).toBe(type)
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(image)
  })

  it('resizes the canvas to the frame and draws it at the origin', () => {
    const drawImage = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const canvas = document.createElement('canvas')
    const bitmap = new FakeBitmap(640, 360)
    drawFrame(canvas, bitmap)
    expect([canvas.width, canvas.height]).toEqual([640, 360])
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    canvas.width = 640
    canvas.height = 200
    drawFrame(canvas, bitmap)
    expect(canvas.height).toBe(360)
    canvas.width = 100
    drawFrame(canvas, bitmap)
    expect(canvas.width).toBe(640)
    getContext.mockReturnValue(null)
    expect(() => { drawFrame(canvas, bitmap) }).not.toThrow()
  })

  it('schedules and cancels repaint callbacks', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const callback = vi.fn()
    const cancel = nextFrame(callback)
    frames[0]!(0)
    expect(callback).toHaveBeenCalledOnce()
    cancel()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })
})
