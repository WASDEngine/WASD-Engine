/**
 * The order of the pictures one window draws for agents. Requests start first come, first served, several at a time
 * within a total file size, so agents that look at different assets at once are answered together while one large
 * file draws alone. A request cancelled while it waits leaves the queue, and one cancelled while it draws gives up its
 * place at once.
 */

/** A request waiting for its turn. */
interface Waiting {
  readonly bytes: number
  readonly start: () => void
}

/** The agent pictures one window draws at once. */
export class DrawQueue {
  private readonly waiting: Waiting[] = []
  private drawing = 0
  private drawingBytes = 0

  /**
   * @param limit - most pictures drawn at once.
   * @param maxBytes - largest total size of the files drawn at once, in bytes; a larger file draws alone.
   */
  constructor(private readonly limit: number, private readonly maxBytes: number) {}

  /** Pictures being drawn now. */
  get active(): number {
    return this.drawing
  }

  /** Requests waiting for their turn. */
  get queued(): number {
    return this.waiting.length
  }

  /**
   * Draw one picture when its turn comes: the earliest waiting request starts as soon as fewer than `limit` pictures
   * are being drawn and its file fits within `maxBytes` beside theirs, or at once when nothing is being drawn.
   * Cancelling the request rejects at once, takes it out of the queue, and frees its place while the draw stops at
   * its next check of the signal.
   * @param bytes - size of the asset the draw reads, as its request counts it.
   * @param signal - the request's cancellation.
   * @param draw - the drawing.
   * @returns the drawing's answer.
   * @throws the signal's reason when the request is cancelled before the drawing settles, or the drawing's failure.
   */
  async run<T>(bytes: number, signal: AbortSignal, draw: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const answer = Promise.withResolvers<T>()
    let holding = false
    const release = (): void => {
      if (!holding) return
      holding = false
      this.drawing -= 1
      this.drawingBytes -= bytes
      this.pump()
    }
    const waiting: Waiting = {
      bytes,
      start: () => {
        holding = true
        this.drawing += 1
        this.drawingBytes += bytes
        void (async () => await draw())().then(answer.resolve, answer.reject).finally(() => {
          signal.removeEventListener('abort', cancel)
          release()
        })
      },
    }
    const cancel = (): void => {
      answer.reject(signal.reason)
      const index = this.waiting.indexOf(waiting)
      if (index < 0) {
        release()
        return
      }
      this.waiting.splice(index, 1)
      // The request that left may have been the earliest one, too large to draw beside the pictures being drawn.
      this.pump()
    }
    signal.addEventListener('abort', cancel, { once: true })
    this.waiting.push(waiting)
    this.pump()
    return await answer.promise
  }

  private pump(): void {
    for (let next = this.waiting[0]; next !== undefined; next = this.waiting[0]) {
      if (this.drawing >= this.limit) return
      if (this.drawing > 0 && this.drawingBytes + next.bytes > this.maxBytes) return
      this.waiting.shift()
      next.start()
    }
  }
}
