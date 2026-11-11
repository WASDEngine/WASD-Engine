/**
 * A fixed number of slots for Godot processes that run without a game: script checks and Web exports. A task holds a
 * slot while it runs; tasks that find every slot taken wait in arrival order.
 * @module @deepseek-ai/dsh-godot/src/slots
 */

/** A task waiting for a slot. */
interface Waiter {
  /** Hand the waiter a slot. */
  readonly grant: () => void
  /** Refuse the waiter with an error. */
  readonly refuse: (error: Error) => void
}

/** Runs tasks with at most `limit` of them at once. */
export class ProcessSlots {
  private held = 0
  private readonly waiting: Waiter[] = []
  private closed: Error | undefined

  /**
   * @param limit - most tasks that run at once, at least 1.
   * @throws RangeError when `limit` is not a whole number of at least 1.
   */
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a whole number of at least 1, got ${String(limit)}`)
  }

  /**
   * Run a task once a slot is free.
   * @param signal - cancels the wait for a slot; the task itself receives no signal from here.
   * @param task - runs while it holds the slot.
   * @returns the task's result.
   * @throws the abort reason when `signal` aborts before a slot is free; the error passed to {@link ProcessSlots.close}
   *   after the slots closed; the task's error.
   */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  /**
   * Refuse the waiting tasks and every later one; running tasks keep their slots until they end.
   * @param error - the refusal.
   */
  close(error: Error): void {
    this.closed ??= error
    for (const waiter of this.waiting.splice(0)) waiter.refuse(error)
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    signal.throwIfAborted()
    if (this.held < this.limit) {
      this.held += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
        reject(signal.reason)
      }
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        refuse: (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    // The slot passes straight to the next waiter, so `held` stays.
    if (next === undefined) this.held -= 1
    else next.grant()
  }
}
