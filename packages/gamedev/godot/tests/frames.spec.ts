/** The frames response streams the newest frame per read and ends with the run or the request. */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodeFrameRecord, FRAME_RECORD_HEADER_BYTES, frameStream, serveFrames, type FrameSource } from '../src/frames.ts'
import type { HarnessFrame } from '../src/protocol.ts'
import type { FrameSink } from '../src/run.ts'

class Source implements FrameSource {
  terminal = false
  readonly sinks = new Set<FrameSink>()

  subscribeFrames(sink: FrameSink): () => void {
    if (this.terminal) {
      sink.end()
      return () => {}
    }
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  emit(seq: number): void {
    for (const sink of this.sinks) sink.frame(frame(seq))
  }

  end(): void {
    this.terminal = true
    for (const sink of [...this.sinks]) sink.end()
  }
}

function frame(seq: number): HarnessFrame {
  return { seq, width: 64, height: 32, image: Buffer.from(`image-${seq}`) }
}

function decode(record: Uint8Array): { length: number; width: number; height: number; seq: number; image: string } {
  const bytes = Buffer.from(record)
  return {
    length: bytes.readUInt32LE(0), width: bytes.readUInt16LE(4), height: bytes.readUInt16LE(6), seq: bytes.readUInt32LE(8),
    image: bytes.subarray(FRAME_RECORD_HEADER_BYTES).toString('latin1'),
  }
}

describe('frame records', () => {
  it('encodes length, size, and sequence before the image', () => {
    expect(decode(encodeFrameRecord(frame(7)))).toEqual({ length: 7, width: 64, height: 32, seq: 7, image: 'image-7' })
  })
})

describe('frameStream', () => {
  it('delivers only the newest frame to a slow reader', async () => {
    const source = new Source()
    const reader = frameStream(source, new AbortController().signal).getReader()
    source.emit(1)
    source.emit(2)
    source.emit(3)
    expect(decode((await reader.read()).value as Uint8Array).seq).toBe(3)
    const pending = reader.read()
    await new Promise(resolve => setTimeout(resolve, 10))
    source.emit(4)
    expect(decode((await pending).value as Uint8Array).seq).toBe(4)
    source.end()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(source.sinks.size).toBe(0)
  })

  it('ends when the request aborts and unsubscribes', async () => {
    const source = new Source()
    const controller = new AbortController()
    const reader = frameStream(source, controller.signal).getReader()
    const pending = reader.read()
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(source.sinks.size).toBe(0)
  })

  it('ends at once for an aborted request or an ended run, and unsubscribes on cancel', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const first = new Source()
    expect(await frameStream(first, aborted.signal).getReader().read()).toMatchObject({ done: true })
    expect(first.sinks.size).toBe(0)
    const ended = new Source()
    ended.terminal = true
    expect(await frameStream(ended, new AbortController().signal).getReader().read()).toMatchObject({ done: true })
    const cancelled = new Source()
    const stream = frameStream(cancelled, new AbortController().signal)
    expect(cancelled.sinks.size).toBe(1)
    await stream.cancel()
    expect(cancelled.sinks.size).toBe(0)
  })
})

describe('serveFrames', () => {
  const url = (query: string) => `http://127.0.0.1/api/godot.frames${query}`

  it.each(['', '?session=s', '?run=r', '?session=&run=r', '?session=s&run='])('refuses missing parameters: %s', async (query) => {
    const response = serveFrames(new Request(url(query)), () => undefined)
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(await response.text()).toBe('session and run are required')
  })

  it('refuses unknown and ended runs', () => {
    expect(serveFrames(new Request(url('?session=s&run=r')), () => undefined).status).toBe(404)
    const ended = new Source()
    ended.terminal = true
    expect(serveFrames(new Request(url('?session=s&run=r')), () => ended).status).toBe(404)
  })

  it('streams records of the named run', async () => {
    const source = new Source()
    const seen: string[] = []
    const response = serveFrames(new Request(url('?session=s1&run=r1')), (session, run) => {
      seen.push(session, run)
      return source
    })
    expect(seen).toEqual(['s1', 'r1'])
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff',
    })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    source.emit(5)
    expect(decode((await reader.read()).value as Uint8Array).seq).toBe(5)
    await reader.cancel()
  })
})
