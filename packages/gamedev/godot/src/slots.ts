/**
 * A fixed number of slots for Godot processes that run without a game, such as script checks, exports, and script
 * runs. A task holds one slot, or every slot to run alone, while it runs; tasks that find too few slots free wait in
 * arrival order, so a task that waits for every slot keeps later tasks from starting before it.
 * @module @deepseek-ai/dsh-godot/src/slots
 */

/** A task waiting for slots. */
interface Waiter {
  /** Slots the task needs. */
  readonly count: number
  /** Hand the waiter its slots. */
  readonly grant: () => void
  /** Refuse the waiter with an error. */
  readonly refuse: (error: Error) => void
}

/** Runs tasks with at most `limit` slots held at once. */
export class ProcessSlots {
  private held = 0
  private readonly waiting: Waiter[] = []
  private closed: Error | undefined

  /**
   * @param limit - slots, at least 1.
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
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    return this.hold(1, signal, task)
  }

  /**
   * Run a task alone: once every slot is free, holding them all, so no other task of these slots runs meanwhile.
   * @param signal - cancels the wait for the slots; the task itself receives no signal from here.
   * @param task - runs while it holds every slot.
   * @returns the task's result.
   * @throws the errors of {@link ProcessSlots.run}.
   */
  runAlone<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    return this.hold(this.limit, signal, task)
  }

  /**
   * Refuse the waiting tasks and every later one; running tasks keep their slots until they end.
   * @param error - the refusal.
   */
  close(error: Error): void {
    this.closed ??= error
    for (const waiter of this.waiting.splice(0)) waiter.refuse(error)
  }

  private async hold<T>(count: number, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(count, signal)
    try {
      return await task()
    } finally {
      this.release(count)
    }
  }

  private acquire(count: number, signal: AbortSignal): Promise<void> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    signal.throwIfAborted()
    if (this.waiting.length === 0 && this.held + count <= this.limit) {
      this.held += count
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        // A task that waited for every slot may have held back smaller ones behind it.
        this.grantWaiting()
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
        reject(signal.reason)
      }
      const waiter: Waiter = {
        count,
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

  private release(count: number): void {
    this.held -= count
    this.grantWaiting()
  }

  /** Hand slots to the waiters in arrival order while the first one's slots are free. */
  private grantWaiting(): void {
    for (let next = this.waiting[0]; next !== undefined && this.held + next.count <= this.limit; next = this.waiting[0]) {
      this.waiting.shift()
      this.held += next.count
      next.grant()
    }
  }
}
