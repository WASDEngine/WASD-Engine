/** The recording stream parser and the window's encoder check, without WebCodecs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canEncodeRecordings, encodeRecording, RECORD_HEADER_BYTES, RecordingParser, RecordingStreamError } from '../src/client/recorder.ts'

function record(index: number, timeMs: number, image: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(RECORD_HEADER_BYTES + image.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, image.length, true)
  view.setUint32(4, index, true)
  view.setUint32(8, timeMs, true)
  view.setUint16(12, 320, true)
  view.setUint16(14, 180, true)
  bytes.set(image, RECORD_HEADER_BYTES)
  return bytes
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RecordingParser', () => {
  it('reads records across any chunk boundaries, headers included', () => {
    const stream = new Uint8Array([...record(0, 0, [1, 2, 3]), ...record(1, 33, [4])])
    const parser = new RecordingParser()
    const frames = [...stream].flatMap(byte => parser.push(Uint8Array.of(byte)))
    const read = frames.map(frame => [frame.index, frame.timeMs, frame.width, frame.height, [...frame.image]])
    expect(read).toEqual([[0, 0, 320, 180, [1, 2, 3]], [1, 33, 320, 180, [4]]])
    expect(new RecordingParser().push(stream)).toHaveLength(2)
  })

  it('refuses a record that announces no bytes or more than 64 MiB', () => {
    expect(() => new RecordingParser().push(record(0, 0, []))).toThrow(new RecordingStreamError('A recording frame announced 0 bytes.'))
    const huge = record(0, 0, [1])
    new DataView(huge.buffer).setUint32(0, 64 * 1024 * 1024 + 1, true)
    expect(() => new RecordingParser().push(huge)).toThrow(RecordingStreamError)
  })
})

describe('encodeRecording', () => {
  it('needs WebCodecs and OffscreenCanvas', () => {
    expect(canEncodeRecordings()).toBe(false)
    vi.stubGlobal('VideoEncoder', vi.fn())
    vi.stubGlobal('VideoFrame', vi.fn())
    vi.stubGlobal('OffscreenCanvas', vi.fn())
    expect(canEncodeRecordings()).toBe(true)
  })

  it('fails when the Host refuses the frames, and when the stream ends without a frame', async () => {
    const request = { fps: 30, sheetFrames: 0, maxBytes: 1024 }
    const upload = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(encodeRecording(request, { open: async () => new Response('gone', { status: 404 }), upload }, new AbortController().signal))
      .rejects.toThrow('The Host refused the recording\'s frames (HTTP 404).')
    await expect(encodeRecording(request, { open: async () => new Response(new Uint8Array(0)), upload }, new AbortController().signal))
      .rejects.toThrow('The recording has no frames.')
    expect(upload).not.toHaveBeenCalled()
  })
})
