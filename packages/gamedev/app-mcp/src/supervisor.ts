/**
 * Owns the application worker of one MCP server process: it starts the worker
 * on the first call, runs calls one at a time, starts a fresh worker after the
 * previous one stopped, and makes sure a caller learns when a stop lost the
 * worker's state.
 *
 * @module
 */

import { abortError, assertDelay, describeExit, WorkerError, type JsonLineWorker } from './json-line-worker.ts'
import type { JsonObject, JsonValue } from './types.ts'

/** What a caller is told when a worker stopped: the state it held is gone. */
const STATE_LOST = 'its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker'

/** Budgets of a {@link WorkerSupervisor}. */
export interface WorkerSupervisorOptions {
  /** Milliseconds a call may run when it names no budget of its own. */
  readonly requestTimeoutMs: number
  /** Milliseconds each step of a worker shutdown waits before escalating. */
  readonly closeGraceMs: number
}

/** Budget and cancellation of one supervised call. */
export interface WorkerCallOptions {
  /**
   * Milliseconds the call may take, counted from the call like the MCP client's own tool-call budget, so time spent
   * waiting for earlier calls is spent; defaults to the supervisor's `requestTimeoutMs`.
   */
  readonly timeoutMs?: number | undefined
  /** Cancels the call; once the worker runs it, cancelling stops the worker. */
  readonly signal?: AbortSignal | undefined
}

/** Wait for `turn`, or reject as soon as `signal` aborts. */
function untilTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
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

/**
 * Starts and restarts one worker and serializes calls to it. A call that
 * fails because the worker stopped (timeout, protocol violation, exit) says
 * the worker's state was lost. When the worker stops while idle, or because a
 * caller cancelled a running call, the next call fails with `WORKER_EXITED`
 * saying so without running; the call after it starts a fresh worker.
 */
export class WorkerSupervisor {
  private readonly startWorker: (signal: AbortSignal) => Promise<JsonLineWorker>
  private readonly requestTimeoutMs: number
  private readonly closeGraceMs: number
  /** Aborted by {@link WorkerSupervisor.close}: cancels the running call and refuses later ones. */
  private readonly lifetime = new AbortController()
  private worker: JsonLineWorker | undefined
  /** Whether a call is waiting on the current worker; that call reports a stop itself. */
  private calling = false
  /** A stop no caller has been told about yet; the next call fails with it. */
  private notice: WorkerError | undefined
  /** Settles when every call issued so far has settled; it never rejects. */
  private tail: Promise<void> = Promise.resolve()
  /** Calls issued and not yet settled; a call that finds one waits for its turn. */
  private unsettled = 0
  private closing: Promise<void> | undefined

  /**
   * @param start - starts a worker; the signal aborts when the starting call
   *   is cancelled or the supervisor closes.
   * @param options - default call budget and shutdown grace.
   * @throws RangeError when a budget is out of range.
   */
  constructor(start: (signal: AbortSignal) => Promise<JsonLineWorker>, options: WorkerSupervisorOptions) {
    assertDelay('requestTimeoutMs', options.requestTimeoutMs)
    assertDelay('closeGraceMs', options.closeGraceMs, true)
    this.startWorker = start
    this.requestTimeoutMs = options.requestTimeoutMs
    this.closeGraceMs = options.closeGraceMs
  }

  /** Whether a started worker is running. */
  get running(): boolean {
    return this.worker !== undefined
  }

  /**
   * Run one worker method, starting the worker first when none is running.
   * Calls run one at a time in call order.
   * @param method - worker method name.
   * @param params - method parameters.
   * @param options - answer budget and cancellation.
   * @returns the worker's result.
   * @throws WorkerError `WORKER_REMOTE` for an exception the worker reported;
   *   `WORKER_START_FAILED` when the worker could not start; `WORKER_TIMEOUT`,
   *   `WORKER_PROTOCOL`, or `WORKER_EXITED` when the worker stopped, with a
   *   message saying its state was lost; `WORKER_TIMEOUT` without running, the
   *   worker untouched, when waiting for earlier calls spent the whole budget;
   *   `WORKER_EXITED` after {@link WorkerSupervisor.close}. A cancellation
   *   rejects with the abort reason.
   * @throws RangeError when `timeoutMs` is out of range.
   */
  async call(method: string, params: JsonObject, options: WorkerCallOptions = {}): Promise<JsonValue> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    assertDelay('timeoutMs', timeoutMs)
    const called = performance.now()
    const queued = this.unsettled > 0
    this.unsettled++
    const signal = options.signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, options.signal])
    const previous = this.tail
    const turn = Promise.withResolvers<void>()
    this.tail = previous.then(() => turn.promise)
    try {
      await untilTurn(previous, signal)
      const waited = queued ? Math.round(performance.now() - called) : 0
      if (waited >= timeoutMs) {
        throw new WorkerError('WORKER_TIMEOUT', `call "${method}" waited ${waited} ms for earlier calls to finish, which spent `
          + `its ${timeoutMs} ms budget; it did not run, and the worker kept its state`)
      }
      return await this.run(method, params, timeoutMs - waited, signal)
    } finally {
      this.unsettled--
      turn.resolve()
    }
  }

  /**
   * Refuse further calls, cancel the running one, and shut the worker down.
   * Later calls join the first close.
   * @returns once every call settled and the worker process exited.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort(new WorkerError('WORKER_EXITED', 'the worker supervisor is closed, so no further calls run'))
    await this.tail
    const worker = this.worker
    this.worker = undefined
    await worker?.close(this.closeGraceMs)
  }

  private async run(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal): Promise<JsonValue> {
    const notice = this.notice
    this.notice = undefined
    if (notice !== undefined) throw notice
    const worker = this.worker ?? await this.launch(signal)
    // An abort before dispatch leaves the worker untouched; only a dispatched request stops it.
    if (signal.aborted) throw abortError(signal)
    this.calling = true
    try {
      return await worker.request(method, params, { timeoutMs, signal })
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'WORKER_REMOTE') throw error
      // Every other failure stopped the worker; wait until its process is gone.
      this.worker = undefined
      await worker.close(this.closeGraceMs)
      throw this.lost(worker, method, error)
    } finally {
      this.calling = false
    }
  }

  private async launch(signal: AbortSignal): Promise<JsonLineWorker> {
    const worker = await this.startWorker(signal)
    if (this.lifetime.signal.aborted) {
      // The start finished after close() began: nobody owns this worker anymore.
      await worker.close(this.closeGraceMs)
      throw abortError(this.lifetime.signal)
    }
    this.worker = worker
    void worker.exited.then((exit) => {
      // The supervisor retired this worker itself, or a waiting call reports the exit.
      if (this.worker !== worker || this.calling) return
      this.worker = undefined
      this.notice = new WorkerError('WORKER_EXITED',
        `${worker.ready.app} worker: exited ${describeExit(exit)} after the previous call; ${STATE_LOST}`,
        { logTail: worker.logTail() })
    })
    return worker
  }

  /**
   * The error for a call whose worker stopped. A cancelled call rejects with
   * its abort reason and leaves a notice for the next call; after close()
   * began, the failure passes through unchanged.
   */
  private lost(worker: JsonLineWorker, method: string, error: unknown): unknown {
    if (this.lifetime.signal.aborted) return error
    if (error instanceof WorkerError) {
      return new WorkerError(error.code, `${error.message}; ${STATE_LOST}`, { logTail: error.logTail, cause: error })
    }
    this.notice = new WorkerError('WORKER_EXITED',
      `${worker.ready.app} worker: was stopped when call "${method}" was cancelled; ${STATE_LOST}`)
    return error
  }
}
