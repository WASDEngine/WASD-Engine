/**
 * Waiting on an operation that outlives its caller.
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
