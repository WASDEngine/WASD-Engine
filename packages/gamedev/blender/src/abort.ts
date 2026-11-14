/** Cancellation of the Blender server's waits. */

/**
 * The error that a cancelled wait rejects with.
 * @param signal - the aborted signal.
 * @returns its reason when that is an Error, otherwise an `AbortError`.
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Wait for an earlier operation, or reject as soon as `signal` aborts.
 * @param turn - settles when the earlier operation settled; it never rejects.
 * @param signal - cancels the wait.
 * @returns once the earlier operation settled.
 */
export function untilSettled(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { reject(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void turn.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}
