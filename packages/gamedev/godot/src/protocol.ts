/**
 * Framing and message validation for the loopback connection between the Host and `runtime/wasd_harness.gd`.
 *
 * Every message, in both directions, is a 4-byte little-endian length N followed by N bytes: a 1-byte kind and
 * its payload. Kind 1 is a UTF-8 JSON object. Kind 2 (harness to Host) is a streamed JPEG frame: u32 sequence,
 * u16 width, u16 height, JPEG bytes. Kind 3 (harness to Host) answers a screenshot request: u32 request id, then
 * the image bytes. The constants match the harness script; changing one requires changing both.
 * @module @deepseek-ai/dsh-godot/src/protocol
 */
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Harness protocol version carried by `hello`. */
export const HARNESS_PROTOCOL_VERSION = 1

/** Largest message body (kind byte plus payload) the harness sends or accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

const KIND_JSON = 1
const KIND_FRAME = 2
const KIND_IMAGE = 3
const FRAME_HEADER_BYTES = 8
const IMAGE_HEADER_BYTES = 4

/** A malformed message on the harness connection; the connection is no longer trustworthy. */
export class HarnessProtocolError extends Error {
  override name = 'HarnessProtocolError'
}

const LogLevel = z.enum(['stdout', 'stderr', 'warning', 'error', 'script_error', 'shader_error'])

const BacktraceFrame = z.object({ function: z.string(), file: z.string(), line: z.number().int() })

const HarnessLogEntry = z.object({
  level: LogLevel,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  function: z.string().optional(),
  code: z.string().optional(),
  backtrace: z.array(BacktraceFrame).optional(),
  time_ms: z.number().optional(),
})

const Hello = z.object({
  type: z.literal('hello'),
  protocol: z.number(),
  token: z.string(),
  pid: z.number().int(),
  godot: z.string(),
  project: z.string(),
  mainScene: z.string(),
  displayServer: z.string(),
  renderingDriver: z.string(),
  renderingMethod: z.string(),
  width: z.number().int(),
  height: z.number().int(),
})

const Status = z.object({
  type: z.literal('status'),
  frame: z.number().int(),
  fps: z.number(),
  paused: z.boolean(),
  scene: z.string(),
  mouseMode: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  droppedLogs: z.number().int(),
})

const Logs = z.object({ type: z.literal('logs'), entries: z.array(HarnessLogEntry) })

const Result = z.looseObject({
  type: z.literal('result'),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
})

const HarnessJson = z.discriminatedUnion('type', [Hello, Status, Logs, Result])

/** The harness's first message: identity, token, and the game's rendering facts. */
export type HarnessHello = z.infer<typeof Hello>

/** Periodic game state, sent on change and at least every second. */
export type HarnessStatus = z.infer<typeof Status>

/** One log entry as the harness logger records it. */
export type HarnessLogEntry = z.infer<typeof HarnessLogEntry>

/** A request answer; fields beyond `type`, `id`, `ok`, and `error` depend on the request type. */
export type HarnessResult = z.infer<typeof Result>

/** One validated JSON message from the harness. */
export type HarnessJsonMessage = z.infer<typeof HarnessJson>

/** One streamed frame. */
export interface HarnessFrame {
  /** Harness frame sequence number, increasing within one run. */
  readonly seq: number
  /** JPEG width in pixels. */
  readonly width: number
  /** JPEG height in pixels. */
  readonly height: number
  /** Encoded JPEG bytes. */
  readonly jpeg: Buffer
}

/** One decoded harness message. */
export type HarnessMessage =
  | { readonly kind: 'json'; readonly message: HarnessJsonMessage }
  | { readonly kind: 'frame'; readonly frame: HarnessFrame }
  | { readonly kind: 'image'; readonly id: number; readonly data: Buffer }

/**
 * Encode one JSON request for the harness.
 * @param message - JSON object; requests carry `type` and `id`.
 * @returns the length-prefixed kind-1 message.
 */
export function encodeJsonMessage(message: Readonly<Record<string, JsonValue>>): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt32LE(body.length + 1, 0)
  header[4] = KIND_JSON
  return Buffer.concat([header, body])
}

/**
 * Decode one complete message body (kind byte and payload).
 * @param body - message bytes after the length prefix.
 * @returns the validated message.
 * @throws {HarnessProtocolError} for an unknown kind, a short binary header, or invalid JSON.
 */
function decodeBody(body: Buffer): HarnessMessage {
  const kind = body[0]
  const payload = body.subarray(1)
  switch (kind) {
    case KIND_JSON: {
      let value: unknown
      try {
        value = JSON.parse(payload.toString('utf8'))
      } catch (error) {
        throw new HarnessProtocolError('Harness sent a JSON message that does not parse', { cause: error })
      }
      const parsed = HarnessJson.safeParse(value)
      if (!parsed.success) throw new HarnessProtocolError(`Harness sent an invalid message: ${parsed.error.message}`)
      return { kind: 'json', message: parsed.data }
    }
    case KIND_FRAME:
      if (payload.length < FRAME_HEADER_BYTES) throw new HarnessProtocolError('Harness sent a frame without its header')
      return {
        kind: 'frame',
        frame: {
          seq: payload.readUInt32LE(0),
          width: payload.readUInt16LE(4),
          height: payload.readUInt16LE(6),
          jpeg: payload.subarray(FRAME_HEADER_BYTES),
        },
      }
    case KIND_IMAGE:
      if (payload.length < IMAGE_HEADER_BYTES) throw new HarnessProtocolError('Harness sent an image without its request id')
      return { kind: 'image', id: payload.readUInt32LE(0), data: payload.subarray(IMAGE_HEADER_BYTES) }
    default:
      throw new HarnessProtocolError(`Harness sent unknown message kind ${String(kind)}`)
  }
}

/**
 * Incremental decoder for one connection. Partial messages wait without copying until complete; each complete
 * message is copied out of its chunks once. Messages decode one at a time, so a reader can change
 * {@link HarnessDecoder.maxMessageBytes} between two messages of one chunk.
 */
export class HarnessDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  private expected: number | undefined

  /**
   * @param maxMessageBytes - largest accepted message body; a larger length prefix fails the connection. The
   * limit applies to each length prefix when {@link HarnessDecoder.next} reads it.
   */
  constructor(public maxMessageBytes: number) {}

  /**
   * Append received bytes; {@link HarnessDecoder.next} decodes the messages they complete.
   * @param chunk - bytes in arrival order.
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.buffered += chunk.length
  }

  /**
   * Decode the oldest complete message.
   * @returns the message, or undefined until more bytes arrive.
   * @throws {HarnessProtocolError} for a length outside 1..maxMessageBytes or a malformed body.
   */
  next(): HarnessMessage | undefined {
    if (this.expected === undefined) {
      if (this.buffered < 4) return undefined
      const length = this.peekLength()
      if (length < 1 || length > this.maxMessageBytes) {
        throw new HarnessProtocolError(`Harness message length ${length} is outside 1..${this.maxMessageBytes}`)
      }
      this.expected = 4 + length
    }
    if (this.buffered < this.expected) return undefined
    const message = this.take(this.expected)
    this.expected = undefined
    return decodeBody(message.subarray(4))
  }

  private peekLength(): number {
    const first = this.chunks[0] as Buffer
    if (first.length >= 4) return first.readUInt32LE(0)
    return this.take(this.buffered, false).readUInt32LE(0)
  }

  private take(bytes: number, consume = true): Buffer {
    const whole = this.chunks.length === 1 ? this.chunks[0] as Buffer : Buffer.concat(this.chunks, this.buffered)
    if (!consume) {
      this.chunks = [whole]
      return whole
    }
    const rest = whole.subarray(bytes)
    this.chunks = rest.length > 0 ? [rest] : []
    this.buffered = rest.length
    return whole.subarray(0, bytes)
  }
}
