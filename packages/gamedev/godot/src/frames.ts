/**
 * The `GET /api/godot.frames?session=<SessionId>&run=<runId>` response: a sequence of frame records for as long
 * as the run lives. Each record is a u32 little-endian image length, u16 little-endian width, u16 little-endian
 * height, u32 little-endian frame sequence number, then the bytes of a PNG or JPEG file. Frames that arrive while
 * the consumer has not read the previous record replace one another, so a slow consumer always receives the
 * newest frame. The body ends when the run ends or the request is aborted.
 * @module @deepseek-ai/dsh-godot/src/frames
 */
import { Buffer } from 'node:buffer'
import type { HarnessFrame } from './protocol.ts'
import type { FrameSink } from './run.ts'

/** Bytes before the image in one record. */
export const FRAME_RECORD_HEADER_BYTES = 12

const COMMON_HEADERS = { 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' }

/** A run's frame subscription. */
export interface FrameSource {
  /** @returns whether the run ended. */
  readonly terminal: boolean
  /**
   * Receive frames until unsubscribed or the run ends.
   * @param sink - frame receiver.
   * @returns the unsubscriber, which must not throw: the stream calls it from the request's abort listener.
   */
  subscribeFrames(sink: FrameSink): () => void
}

/**
 * Encode one frame record.
 * @param frame - frame from the harness.
 * @returns the record bytes.
 */
export function encodeFrameRecord(frame: HarnessFrame): Uint8Array {
  const record = Buffer.allocUnsafe(FRAME_RECORD_HEADER_BYTES + frame.image.length)
  record.writeUInt32LE(frame.image.length, 0)
  record.writeUInt16LE(frame.width, 4)
  record.writeUInt16LE(frame.height, 6)
  record.writeUInt32LE(frame.seq, 8)
  frame.image.copy(record, FRAME_RECORD_HEADER_BYTES)
  return record
}

/**
 * Stream a run's frames, newest first when the consumer is behind.
 * @param source - run frame subscription.
 * @param signal - ends the stream when aborted.
 * @returns a pull-driven byte stream of frame records.
 */
export function frameStream(source: FrameSource, signal: AbortSignal): ReadableStream<Uint8Array> {
  let latest: HarnessFrame | undefined
  let ended = false
  let wake: (() => void) | undefined
  let unsubscribe: () => void = () => {}
  const notify = (): void => {
    wake?.()
    wake = undefined
  }
  const close = (): void => {
    ended = true
    unsubscribe()
    signal.removeEventListener('abort', close)
    notify()
  }
  return new ReadableStream<Uint8Array>({
    start() {
      unsubscribe = source.subscribeFrames({
        frame(frame) {
          latest = frame
          notify()
        },
        end: close,
      })
      if (signal.aborted) close()
      else signal.addEventListener('abort', close, { once: true })
    },
    async pull(controller) {
      while (latest === undefined && !ended) await new Promise<void>((resolve) => { wake = resolve })
      if (ended) {
        controller.close()
        return
      }
      controller.enqueue(encodeFrameRecord(latest as HarnessFrame))
      latest = undefined
    },
    cancel: close,
  }, { highWaterMark: 0 })
}

function refusal(status: 400 | 404, text: string): Response {
  return new Response(text, { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } })
}

/**
 * Answer one `GET` frames request.
 * @param request - authenticated owner request.
 * @param find - the live run a Session and run id name, if any.
 * @returns the frame stream, or 400 for missing parameters and 404 when no live run matches.
 */
export function serveFrames(request: Request, find: (sessionId: string, runId: string) => FrameSource | undefined): Response {
  const params = new URL(request.url).searchParams
  const sessionId = params.get('session')
  const runId = params.get('run')
  if (sessionId === null || sessionId === '' || runId === null || runId === '') return refusal(400, 'session and run are required')
  const run = find(sessionId, runId)
  if (run === undefined || run.terminal) return refusal(404, 'no running game')
  return new Response(frameStream(run, request.signal), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/octet-stream' } })
}
