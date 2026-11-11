/**
 * Waiting on an operation that outlives its caller, or until one settles.
 * @module @deepseek-ai/dsh-godot/src/abort
 */

/**
 * Wait for an operation the caller does not own; aborting stops only this wait.
 * @param operation - shared operation.
 * @param signal - the caller's cancellation.
 * @returns the operation's value; rejects with the signal's reason once it aborts.
 */
export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Wait until an operation settles or the signal aborts, whichever comes first.
 * @param operation - the operation; its value or failure is not passed on.
 * @param signal - ends the wait.
 * @returns once either happened; it never rejects.
 */
export function untilSettledOrAborted(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    operation.then(done, done)
  })
}
