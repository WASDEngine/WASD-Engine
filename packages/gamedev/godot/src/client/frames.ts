/**
 * Frame view of a running game: the record parser of the Host's
 * `api/godot.frames` response body, a reader that reconnects while its owner
 * keeps it open, and a latest-wins presenter that decodes PNG and JPEG records
 * and draws the newest one on the next repaint.
 */

/** Bytes of one record header: u32 LE image length, u16 LE width, u16 LE height, u32 LE sequence number. */
export const FRAME_HEADER_BYTES = 12

/** Largest image one record may announce; a larger length means the stream is corrupt. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** Delay before the first reconnect after a frame response fails or ends. */
export const RECONNECT_INITIAL_MS = 250

/** Ceiling of the reconnect delay, which doubles per consecutive attempt that delivered no record. */
export const RECONNECT_MAX_MS = 4000

/** One frame of the stream. */
export interface FrameRecord {
  /** Harness frame sequence number. */
  readonly seq: number
  /** Image width in pixels. */
  readonly width: number
  /** Image height in pixels. */
  readonly height: number
  /** Bytes of a PNG or JPEG file. */
  readonly image: Uint8Array<ArrayBuffer>
}

/** The frame response carried bytes that do not form a record, or the Host refused the request. */
export class FrameStreamError extends Error {
  override readonly name = 'FrameStreamError'
}

interface PendingHeader {
  readonly length: number
  readonly width: number
  readonly height: number
  readonly seq: number
}

/** Incremental record parser; chunk boundaries may fall anywhere, including inside a header. */
export class FrameRecordParser {
  private readonly chunks: Uint8Array<ArrayBuffer>[] = []
  /** Read position inside the first chunk. */
  private offset = 0
  /** Unread bytes across every chunk. */
  private buffered = 0
  private header: PendingHeader | undefined

  /**
   * Append one body chunk.
   * @param chunk - the next bytes of the response body.
   * @returns the records this chunk completed, in stream order.
   * @throws {FrameStreamError} when a header announces an empty or oversized image.
   */
  push(chunk: Uint8Array<ArrayBuffer>): FrameRecord[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.byteLength
    }
    const records: FrameRecord[] = []
    while (true) {
      if (this.header === undefined) {
        if (this.buffered < FRAME_HEADER_BYTES) return records
        this.header = parseHeader(this.take(FRAME_HEADER_BYTES))
      }
      const header = this.header
      if (this.buffered < header.length) return records
      records.push({ seq: header.seq, width: header.width, height: header.height, image: this.take(header.length) })
      this.header = undefined
    }
  }

  /** Remove the next `count` buffered bytes; callers guarantee that many are buffered. */
  private take(count: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(count)
    let filled = 0
    let consumed = 0
    for (const chunk of this.chunks) {
      const length = Math.min(chunk.byteLength - this.offset, count - filled)
      bytes.set(chunk.subarray(this.offset, this.offset + length), filled)
      filled += length
      if (this.offset + length < chunk.byteLength) {
        this.offset += length
        break
      }
      consumed += 1
      this.offset = 0
      if (filled === count) break
    }
    this.chunks.splice(0, consumed)
    this.buffered -= count
    return bytes
  }
}

function parseHeader(bytes: Uint8Array<ArrayBuffer>): PendingHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = {
    length: view.getUint32(0, true), width: view.getUint16(4, true), height: view.getUint16(6, true), seq: view.getUint32(8, true),
  }
  if (header.length === 0 || header.length > MAX_FRAME_BYTES || header.width === 0 || header.height === 0) {
    throw new FrameStreamError(`frame record announces ${String(header.length)} bytes at ${String(header.width)}x${String(header.height)}`)
  }
  return header
}

/** Options of {@link readFrames}. */
export interface FrameReaderOptions {
  /**
   * Request the run's frame response.
   * @param signal - aborts the request and its body.
   * @returns the response; a non-OK status counts as a failed attempt.
   */
  readonly open: (signal: AbortSignal) => Promise<Response>
  /**
   * Receive one complete record.
   * @param record - the record, in stream order.
   */
  readonly onRecord: (record: FrameRecord) => void
  /** Ends the reader; no reconnect follows an abort. */
  readonly signal: AbortSignal
}

/**
 * Read frame records until `signal` aborts. A response that fails, is refused,
 * carries a corrupt record, or ends is replaced after a delay that starts at
 * {@link RECONNECT_INITIAL_MS} and doubles up to {@link RECONNECT_MAX_MS}
 * while attempts deliver no record.
 * @param options - opener, record consumer, and lifetime.
 * @returns once `signal` aborts.
 */
export async function readFrames(options: FrameReaderOptions): Promise<void> {
  // A call, unlike a property read, is re-evaluated after each await.
  const stopped = (): boolean => options.signal.aborted
  let failures = 0
  while (!stopped()) {
    const progress = { delivered: false }
    try {
      await readResponse(options, progress)
    } catch (lost) {
      void lost // A refused request, a lost connection, or a corrupt record ends this attempt; the loop reconnects.
    }
    if (stopped()) return
    failures = progress.delivered ? 1 : failures + 1
    await delay(Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** (failures - 1)), options.signal)
  }
}

async function readResponse(options: FrameReaderOptions, progress: { delivered: boolean }): Promise<void> {
  const attempt = new AbortController()
  try {
    const response = await options.open(AbortSignal.any([options.signal, attempt.signal]))
    if (!response.ok || response.body === null) throw new FrameStreamError(`frame stream answered HTTP ${String(response.status)}`)
    const parser = new FrameRecordParser()
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      for (const record of parser.push(value)) {
        progress.delivered = true
        options.onRecord(record)
      }
    }
  } finally {
    // Aborting the attempt closes a body that a corrupt record or a consumer failure left open.
    attempt.abort()
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Options of {@link FramePresenter}. */
export interface FramePresenterOptions {
  /**
   * Decode one record.
   * @param record - the record to decode.
   * @returns a bitmap the presenter owns and closes.
   */
  readonly decode: (record: FrameRecord) => Promise<ImageBitmap>
  /**
   * Draw the newest decoded frame; the presenter closes the bitmap afterwards.
   * @param bitmap - the decoded frame.
   * @param record - the record it came from.
   */
  readonly draw: (bitmap: ImageBitmap, record: FrameRecord) => void
  /**
   * Run a callback before the next repaint.
   * @param callback - the paint callback.
   * @returns a function that cancels the callback.
   */
  readonly schedule: (callback: () => void) => () => void
}

/**
 * Latest-wins presentation: at most one decode runs at a time, a record that
 * arrives meanwhile replaces the waiting one, and only the newest decoded
 * bitmap is drawn per repaint. A record that does not decode is skipped.
 */
export class FramePresenter {
  private waiting: FrameRecord | undefined
  private decoding = false
  private ready: { readonly bitmap: ImageBitmap; readonly record: FrameRecord } | undefined
  private cancelPaint: (() => void) | undefined
  private disposed = false

  /** @param options - decoder, drawing callback, and repaint scheduler. */
  constructor(private readonly options: FramePresenterOptions) {}

  /**
   * Offer a record; it replaces any record still waiting for the decoder.
   * @param record - the newest record of the stream.
   */
  push(record: FrameRecord): void {
    if (this.disposed) return
    this.waiting = record
    this.pump()
  }

  /** Drop waiting work, cancel the pending paint, and close the undrawn bitmap; later decodes are closed unread. */
  dispose(): void {
    this.disposed = true
    this.waiting = undefined
    this.cancelPaint?.()
    this.cancelPaint = undefined
    this.ready?.bitmap.close()
    this.ready = undefined
  }

  private pump(): void {
    const record = this.waiting
    if (this.decoding || record === undefined) return
    this.waiting = undefined
    this.decoding = true
    void this.options.decode(record).then((bitmap) => {
      this.decoding = false
      if (this.disposed) {
        bitmap.close()
        return
      }
      this.ready?.bitmap.close()
      this.ready = { bitmap, record }
      this.cancelPaint ??= this.options.schedule(() => { this.paint() })
      this.pump()
    }, (undecodable: unknown) => {
      void undecodable // A corrupt image is skipped; the next record replaces it.
      this.decoding = false
      this.pump()
    })
  }

  private paint(): void {
    this.cancelPaint = undefined
    const frame = this.ready
    this.ready = undefined
    if (frame === undefined) return
    this.options.draw(frame.bitmap, frame.record)
    frame.bitmap.close()
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Decode a record's PNG or JPEG image; the PNG file signature selects `image/png`, and anything else is read as `image/jpeg`.
 * @param record - the record to decode.
 * @returns the decoded bitmap.
 */
export function decodeFrame(record: FrameRecord): Promise<ImageBitmap> {
  const png = PNG_SIGNATURE.every((byte, index) => record.image[index] === byte)
  return createImageBitmap(new Blob([record.image], { type: png ? 'image/png' : 'image/jpeg' }))
}

/**
 * Draw a bitmap at its own size, resizing the canvas when the frame size changed.
 * @param canvas - the canvas whose CSS fits the drawing into its box.
 * @param bitmap - the frame to draw.
 */
export function drawFrame(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
}

/**
 * Run a callback before the next repaint.
 * @param callback - the callback.
 * @returns a function that cancels it.
 */
export function nextFrame(callback: () => void): () => void {
  const handle = requestAnimationFrame(() => { callback() })
  return () => { cancelAnimationFrame(handle) }
}
