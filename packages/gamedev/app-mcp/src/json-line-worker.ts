/**
 * Client of one headless application worker that speaks the shared JSON-lines
 * protocol. Requests are JSON lines on the worker's stdin. Replies are JSON
 * lines on its fd 3: first a ready line, then one reply per request, in
 * request order. The worker's stdout and stderr are logs, of which a bounded
 * tail is kept for diagnostics. On POSIX the worker leads its own process
 * group, so stopping it also stops every process it started.
 *
 * @module
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import type { JsonObject, JsonValue } from './types.ts'

/** Protocol revision this client speaks; a worker must announce it in its ready line. */
const PROTOCOL = 1

/**
 * Longest reply line accepted, in bytes. A longer line is a protocol
 * violation: no tool result could carry it through a 10 MiB stdio MCP frame.
 */
export const MAX_REPLY_BYTES = 32 * 1024 * 1024

/** Bytes of a rejected line quoted in a diagnostic. */
const QUOTE_BYTES = 200

const ReadyLine = z.object({
  ready: z.literal(true),
  protocol: z.literal(PROTOCOL),
  app: z.string().min(1),
  version: z.string(),
  python: z.string().optional(),
})

const ReplyLine = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.json() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.object({ type: z.string(), message: z.string(), traceback: z.string().optional() }),
  }),
])

/** How to launch one worker process. */
export interface JsonLineWorkerSpec {
  /** Executable followed by its arguments; `argv[0]` is the absolute path of the executable. */
  readonly argv: readonly string[]
  /** Working directory of the worker. */
  readonly cwd: string
  /** Complete worker environment; a caller that wants the worker to inherit `process.env` merges it here. */
  readonly env: NodeJS.ProcessEnv
  /** Milliseconds the worker has to write its ready line after it is spawned. */
  readonly readyTimeoutMs: number
  /** Bytes of interleaved stdout and stderr kept for diagnostics. */
  readonly logTailBytes: number
}

/** Identity a worker announces in its ready line. */
export interface WorkerReady {
  /** Application name, such as `blender` or `gimp`. */
  readonly app: string
  /** Application version. */
  readonly version: string
  /** Version of the Python interpreter running the worker; absent for a worker that runs no Python. */
  readonly python?: string | undefined
}

/** How a worker process ended. */
export interface WorkerExit {
  /** Exit code, or `null` when a signal ended the process. */
  readonly code: number | null
  /** Signal that ended the process, or `null` after an ordinary exit. */
  readonly signal: NodeJS.Signals | null
}

/** Budget and cancellation of one worker request. */
export interface WorkerRequestOptions {
  /** Milliseconds the worker has to answer, counted from when the request is written to it. */
  readonly timeoutMs: number
  /** Cancels the request: before dispatch it only leaves the queue; after dispatch it stops the worker. */
  readonly signal?: AbortSignal | undefined
}

/** Failure classes of a {@link WorkerError}. */
export type WorkerErrorCode = 'WORKER_START_FAILED' | 'WORKER_EXITED' | 'WORKER_TIMEOUT' | 'WORKER_PROTOCOL' | 'WORKER_REMOTE' | 'WORKERS_BUSY'

/** Details a {@link WorkerError} carries besides its code and message. */
export interface WorkerErrorDetails {
  /** Exception class the worker reported. */
  readonly remoteType?: string | undefined
  /** Traceback the worker reported. */
  readonly traceback?: string | undefined
  /** Recent worker stdout and stderr. */
  readonly logTail?: string | undefined
  /** Underlying failure. */
  readonly cause?: unknown
}

/**
 * A worker failure. `WORKER_REMOTE` is an exception the worker caught while
 * handling a request; the worker keeps running and keeps its state. Every
 * other code means the worker is stopped or stopping and its state is lost.
 */
export class WorkerError extends Error {
  override name = 'WorkerError'
  /** Failure class, for handling; never parse the message. */
  readonly code: WorkerErrorCode
  /** Exception class the worker reported, for `WORKER_REMOTE`. */
  readonly remoteType: string | undefined
  /** Traceback the worker reported, for `WORKER_REMOTE`. */
  readonly traceback: string | undefined
  /** Recent worker stdout and stderr, when the failure concerns the process. */
  readonly logTail: string | undefined

  constructor(code: WorkerErrorCode, message: string, details: WorkerErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.code = code
    this.remoteType = details.remoteType
    this.traceback = details.traceback
    this.logTail = details.logTail
  }
}

/**
 * Reject a delay Node timers cannot honor; a larger delay would fire after one millisecond.
 * @param name - option name quoted in the error.
 * @param value - delay in milliseconds.
 * @param allowZero - whether zero is a valid delay.
 * @throws RangeError when the delay is not finite, exceeds the timer range, or is zero where zero is not allowed.
 */
export function assertDelay(name: string, value: number, allowZero = false): void {
  if (Number.isFinite(value) && value <= MAX_TIMER_DELAY_MS && (allowZero ? value >= 0 : value > 0)) return
  throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}; got ${value}`)
}

/**
 * Turn an abort into an Error: the signal's reason when it is one, otherwise an `AbortError`.
 * @param signal - an aborted signal.
 * @returns the error a cancelled operation rejects with.
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Describe how a process ended, as in "exited with code 3".
 * @param exit - the process exit.
 * @returns the exit code or the signal, as a phrase.
 */
export function describeExit(exit: WorkerExit): string {
  return exit.signal === null ? `with code ${String(exit.code)}` : `on signal ${exit.signal}`
}

/** The newest bytes appended, read back from the first complete UTF-8 character. */
class ByteTail {
  private bytes = Buffer.alloc(0)
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  append(chunk: Buffer): void {
    const joined = Buffer.concat([this.bytes, chunk])
    this.bytes = joined.subarray(Math.max(0, joined.length - this.limit))
  }

  text(): string {
    let start = 0
    // Skip the UTF-8 continuation bytes (10xxxxxx) of a character the bound cut.
    while (((this.bytes[start] ?? 0) & 0xc0) === 0x80) start++
    return this.bytes.toString('utf8', start)
  }
}

/** Splits a byte stream into newline-terminated lines and refuses any line longer than its limit. */
export class LineBuffer {
  private parts: Buffer[] = []
  private size = 0
  private readonly limit: number

  /** @param limit - longest accepted line in bytes, excluding its newline. */
  constructor(limit: number) {
    this.limit = limit
  }

  /**
   * Emit, in order, each line the chunk completes.
   * @param chunk - the next bytes of the stream.
   * @param line - receives each complete line without its newline.
   * @returns false when a line exceeds the limit; the buffered bytes are then dropped.
   */
  push(chunk: Buffer, line: (bytes: Buffer) => void): boolean {
    let start = 0
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      if (this.size + end - start > this.limit) return this.overflow()
      line(Buffer.concat([...this.parts, chunk.subarray(start, end)]))
      this.parts = []
      this.size = 0
      start = end + 1
    }
    if (this.size + chunk.length - start > this.limit) return this.overflow()
    this.parts.push(chunk.subarray(start))
    this.size += chunk.length - start
    return true
  }

  private overflow(): false {
    this.parts = []
    this.size = 0
    return false
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode one protocol line and validate it.
 * @returns the validated value, or `undefined` when the line is not UTF-8 JSON matching the schema.
 */
function parseLine<T>(bytes: Buffer, schema: z.ZodType<T>): T | undefined {
  let value: unknown
  try {
    value = JSON.parse(utf8.decode(bytes))
  } catch {
    // TypeError (not UTF-8) or SyntaxError (not JSON): the line is not a protocol line.
    return undefined
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Quote the start of a rejected line for a diagnostic. */
function quote(bytes: Buffer): string {
  const shown = JSON.stringify(bytes.toString('utf8', 0, QUOTE_BYTES))
  return bytes.length > QUOTE_BYTES ? `${shown}…` : shown
}

/** The four pipes `spawn` creates for the worker's `'pipe'` stdio entries. */
interface WorkerPipes {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly replies: Readable
}

function pipesOf(child: ChildProcess): WorkerPipes {
  const [stdin, stdout, stderr, replies] = child.stdio
  /* v8 ignore next -- spawn creates every 'pipe' entry, even when the executable is missing */
  if (stdin === null || stdout === null || stderr === null || !(replies instanceof Readable)) throw new Error('worker pipes were not created')
  return { stdin, stdout, stderr, replies }
}

/** Pipe errors (EPIPE once the worker stopped reading, ECONNRESET) only end the pipe; the process exit reports the failure. */
function ignorePipeError(): void {}

/** Resolve whether the process exits within `ms`; the timer never outlives the wait. */
function exitsWithin(exited: Promise<WorkerExit>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false) }, ms)
    void exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** A request waiting for its turn. */
interface QueuedRequest {
  readonly method: string
  readonly params: JsonObject
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly result: PromiseWithResolvers<JsonValue>
  /** Removes the listener that takes the request out of the queue on abort. */
  detach: () => void
}

/** The request the worker is handling. */
interface ActiveRequest {
  readonly id: number
  readonly request: QueuedRequest
  /** Clears the timeout and removes the abort listener. */
  readonly release: () => void
}

/**
 * Lifecycle phase: `starting` until the ready line, `running` while requests
 * are accepted, `closing` after {@link JsonLineWorker.close}, and `stopped`
 * once the worker was killed, failed to start, or exited.
 */
type Phase = 'starting' | 'running' | 'closing' | 'stopped'

/**
 * One worker process and its request queue. Requests run one at a time in
 * call order. Any request failure other than `WORKER_REMOTE` leaves the worker
 * stopped: a timeout, a cancelled dispatched request, or a protocol violation
 * kills it, since its state is unknown, and an exit fails the request it was
 * handling and every queued one. A stopped worker refuses further requests;
 * its owner starts a new one.
 */
export class JsonLineWorker {
  /**
   * Settles when the worker process has exited; it never rejects. By then
   * every process left in the worker's group was sent SIGKILL.
   */
  readonly exited: Promise<WorkerExit>

  private announced!: WorkerReady
  private label: string
  private readonly child: ChildProcess
  private readonly stdin: Writable
  private readonly tail: ByteTail
  private readonly lines = new LineBuffer(MAX_REPLY_BYTES)
  private readonly queue: QueuedRequest[] = []
  private readonly startup = Promise.withResolvers<void>()
  /** Settles once the process exited and every pipe closed: no reply or log can follow. */
  private readonly drained: Promise<WorkerExit>
  /** Clears the ready timeout and removes the start's abort listener. */
  private readonly disarmStart: () => void
  private active: ActiveRequest | undefined
  private phase: Phase = 'starting'
  /** Why the worker takes no more requests; the first reason wins. */
  private failure: WorkerError | undefined
  private exit: WorkerExit | undefined
  private closing: Promise<void> | undefined
  private nextId = 0
  private shutdownId = 0

  /**
   * Spawn a worker and resolve once it wrote a valid ready line. On any
   * failure the worker is killed and its output drained before the promise
   * rejects, so no process outlives a failed start.
   * @param spec - executable, environment, ready budget, and log tail size.
   * @param signal - cancels the start; the rejection is then the abort reason.
   * @returns the ready worker.
   * @throws WorkerError `WORKER_START_FAILED` when the worker cannot be spawned,
   *   exits, writes anything but a valid ready line, or stays silent past
   *   `readyTimeoutMs`; the error carries the log tail.
   * @throws RangeError when `readyTimeoutMs` or `logTailBytes` is out of range.
   */
  static async start(spec: JsonLineWorkerSpec, signal?: AbortSignal): Promise<JsonLineWorker> {
    if (signal?.aborted) throw abortError(signal)
    assertDelay('readyTimeoutMs', spec.readyTimeoutMs)
    if (!Number.isSafeInteger(spec.logTailBytes) || spec.logTailBytes < 0) {
      throw new RangeError(`logTailBytes must be a non-negative integer; got ${spec.logTailBytes}`)
    }
    const [command, ...args] = spec.argv
    if (command === undefined || command === '') {
      throw new WorkerError('WORKER_START_FAILED', 'the worker argv is empty; argv[0] must be the worker executable')
    }
    const worker = new JsonLineWorker(spec, command, args, signal)
    await worker.startup.promise
    return worker
  }

  private constructor(spec: JsonLineWorkerSpec, command: string, args: readonly string[], signal: AbortSignal | undefined) {
    this.label = `worker ${basename(command)}`
    this.tail = new ByteTail(spec.logTailBytes)
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      // spawn throws only Errors, for invalid arguments such as a NUL byte in argv.
      throw new WorkerError('WORKER_START_FAILED', `${this.label}: could not be spawned: ${(error as Error).message}`, { cause: error })
    }
    this.child = child
    const { stdin, stdout, stderr, replies } = pipesOf(child)
    this.stdin = stdin
    const exited = Promise.withResolvers<WorkerExit>()
    const drained = Promise.withResolvers<WorkerExit>()
    this.exited = exited.promise
    this.drained = drained.promise
    child.once('exit', (code, exitSignal) => {
      this.exit = { code, signal: exitSignal }
      exited.resolve(this.exit)
      // Group members the worker left behind are orphans holding its pipes open.
      /* v8 ignore else -- Windows has no process groups, and a Windows pid is reused too soon to signal it after exit */
      if (process.platform !== 'win32') this.signalGroup('SIGKILL')
    })
    // 'close' follows 'exit', or follows 'error' alone when the spawn failed.
    child.once('close', () => {
      const exit = this.exit ?? { code: null, signal: null }
      exited.resolve(exit)
      drained.resolve(exit)
      this.onDrained(exit)
    })
    child.on('error', (error) => {
      /* v8 ignore next -- after a successful spawn only child.kill() reports errors, and only the Windows path calls it */
      if (this.phase !== 'starting') return
      this.failStart(() => new WorkerError('WORKER_START_FAILED', `${this.label}: could not be started: ${error.message}`, {
        logTail: this.tail.text(), cause: error,
      }))
    })
    for (const pipe of [stdin, stdout, stderr, replies]) pipe.on('error', ignorePipeError)
    stdout.on('data', (chunk: Buffer) => { this.tail.append(chunk) })
    stderr.on('data', (chunk: Buffer) => { this.tail.append(chunk) })
    replies.on('data', (chunk: Buffer) => { this.onReplies(chunk) })

    const timer = setTimeout(() => {
      this.failStart(() => new WorkerError('WORKER_START_FAILED',
        `${this.label}: did not report ready within ${spec.readyTimeoutMs} ms`, { logTail: this.tail.text() }))
    }, spec.readyTimeoutMs)
    if (signal === undefined) {
      this.disarmStart = () => { clearTimeout(timer) }
    } else {
      const onAbort = (): void => { this.failStart(() => abortError(signal)) }
      signal.addEventListener('abort', onAbort, { once: true })
      this.disarmStart = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }
  }

  /** Identity the worker announced in its ready line. */
  get ready(): WorkerReady {
    return this.announced
  }

  /**
   * Send one request and resolve with the worker's result. Requests run one
   * at a time in call order; the timeout starts when the request is written.
   * @param method - worker method name.
   * @param params - method parameters.
   * @param options - answer budget and cancellation.
   * @returns the `result` of the worker's reply.
   * @throws WorkerError `WORKER_REMOTE` for an exception the worker reported (the
   *   worker keeps running); `WORKER_TIMEOUT` when no answer arrived in time and
   *   `WORKER_PROTOCOL` when the worker broke the protocol (both stop the worker);
   *   `WORKER_EXITED` when the worker exited, was shut down, or is stopped. A
   *   cancellation rejects with the abort reason and, once dispatched, stops the worker.
   * @throws RangeError when `timeoutMs` is out of range.
   */
  async request(method: string, params: JsonObject, options: WorkerRequestOptions): Promise<JsonValue> {
    assertDelay('timeoutMs', options.timeoutMs)
    const signal = options.signal
    if (signal?.aborted) throw abortError(signal)
    if (this.failure !== undefined) throw this.failure
    const queued: QueuedRequest = {
      method, params, timeoutMs: options.timeoutMs, signal, result: Promise.withResolvers(), detach: () => {},
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        // Leaving the queue removes this listener first, so the request is still queued here.
        this.queue.splice(this.queue.indexOf(queued), 1)
        queued.result.reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      queued.detach = () => { signal.removeEventListener('abort', onAbort) }
    }
    this.queue.push(queued)
    this.pump()
    return await queued.result.promise
  }

  /**
   * Recent stdout and stderr of the worker: at most `logTailBytes` bytes,
   * starting at a complete UTF-8 character.
   * @returns the log tail as text.
   */
  logTail(): string {
    return this.tail.text()
  }

  /**
   * Shut the worker down: send `shutdown` and close its stdin, then after
   * `graceMs` without an exit send SIGTERM to its process group, and SIGKILL
   * after another `graceMs`. Queued requests reject with `WORKER_EXITED`; the
   * request being handled may still complete. Later calls join the first
   * shutdown.
   * @param graceMs - milliseconds each step waits for the process to exit.
   * @returns once the worker process has exited.
   * @throws RangeError when `graceMs` is out of range.
   */
  async close(graceMs: number): Promise<void> {
    assertDelay('graceMs', graceMs, true)
    this.closing ??= this.shutdown(graceMs)
    await this.closing
  }

  private async shutdown(graceMs: number): Promise<void> {
    if (this.phase === 'running') {
      this.phase = 'closing'
      this.refuse(new WorkerError('WORKER_EXITED', `${this.label}: was shut down`))
      this.shutdownId = ++this.nextId
      this.write({ id: this.shutdownId, method: 'shutdown', params: {} })
      this.stdin.end()
    }
    if (await exitsWithin(this.exited, graceMs)) return
    this.signalGroup('SIGTERM')
    if (await exitsWithin(this.exited, graceMs)) return
    this.signalGroup('SIGKILL')
    await this.exited
  }

  private pump(): void {
    if (this.active !== undefined) return
    const request = this.queue.shift()
    if (request !== undefined) this.dispatch(request)
  }

  private dispatch(request: QueuedRequest): void {
    request.detach()
    const id = ++this.nextId
    const timer = setTimeout(() => {
      this.stop(new WorkerError('WORKER_TIMEOUT',
        `${this.label}: did not answer "${request.method}" within ${request.timeoutMs} ms, so it was stopped`,
        { logTail: this.tail.text() }))
    }, request.timeoutMs)
    let release = (): void => { clearTimeout(timer) }
    const signal = request.signal
    if (signal !== undefined) {
      const onAbort = (): void => {
        this.stop(new WorkerError('WORKER_EXITED', `${this.label}: was stopped because request "${request.method}" was cancelled`),
          abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      release = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }
    this.active = { id, request, release }
    this.write({ id, method: request.method, params: request.params })
  }

  private write(message: { readonly id: number; readonly method: string; readonly params: JsonObject }): void {
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onReplies(chunk: Buffer): void {
    if (!this.lines.push(chunk, (line) => { this.onLine(line) })) {
      this.violate(`wrote a line longer than ${MAX_REPLY_BYTES} bytes`)
    }
  }

  private onLine(line: Buffer): void {
    switch (this.phase) {
      case 'starting':
        this.onReadyLine(line)
        return
      case 'running':
      case 'closing':
        this.onReply(line)
        return
      case 'stopped':
        return
    }
  }

  private onReadyLine(line: Buffer): void {
    const ready = parseLine(line, ReadyLine)
    if (ready === undefined) {
      this.failStart(() => new WorkerError('WORKER_START_FAILED',
        `${this.label}: wrote ${quote(line)} instead of a ready line {"ready": true, "protocol": ${PROTOCOL}, "app", "version"}`,
        { logTail: this.tail.text() }))
      return
    }
    this.disarmStart()
    this.announced = { app: ready.app, version: ready.version, python: ready.python }
    this.label = `${ready.app} worker`
    this.phase = 'running'
    this.startup.resolve()
  }

  private onReply(line: Buffer): void {
    const reply = parseLine(line, ReplyLine)
    if (reply === undefined) {
      this.violate(`wrote ${quote(line)}, which is not a protocol reply`)
      return
    }
    const active = this.active
    if (active?.id !== reply.id) {
      // A worker may acknowledge the shutdown request before it exits.
      if (this.phase === 'closing' && reply.id === this.shutdownId) return
      this.violate(active === undefined
        ? `answered request ${reply.id} while no request was pending`
        : `answered request ${reply.id} while request ${active.id} was pending`)
      return
    }
    this.active = undefined
    active.release()
    if (reply.ok) {
      active.request.result.resolve(reply.result)
    } else {
      active.request.result.reject(new WorkerError('WORKER_REMOTE', `${reply.error.type}: ${reply.error.message}`, {
        remoteType: reply.error.type, traceback: reply.error.traceback,
      }))
    }
    this.pump()
  }

  /** A protocol violation: before the ready line it fails the start, afterwards it stops the worker. */
  private violate(reason: string): void {
    if (this.phase === 'starting') {
      this.failStart(() => new WorkerError('WORKER_START_FAILED', `${this.label}: ${reason} before its ready line`, { logTail: this.tail.text() }))
      return
    }
    this.stop(new WorkerError('WORKER_PROTOCOL', `${this.label}: ${reason}, so it was stopped`, { logTail: this.tail.text() }))
  }

  /** Fail the start: kill the worker, then reject with the error once its output is drained. Runs only while starting. */
  private failStart(error: () => Error): void {
    this.disarmStart()
    this.phase = 'stopped'
    this.signalGroup('SIGKILL')
    void this.drained.then(() => { this.startup.reject(error()) })
  }

  /**
   * Kill the worker; the request being handled rejects with `rejection`, the
   * queued ones with the first failure. Repeating it changes nothing.
   */
  private stop(failure: WorkerError, rejection: Error = failure): void {
    this.phase = 'stopped'
    const active = this.active
    this.active = undefined
    if (active !== undefined) {
      active.release()
      active.request.result.reject(rejection)
    }
    this.refuse(failure)
    this.signalGroup('SIGKILL')
  }

  /** Refuse new requests with the first failure and reject the queued ones with it. */
  private refuse(failure: WorkerError): void {
    this.failure ??= failure
    for (const queued of this.queue.splice(0)) {
      queued.detach()
      queued.result.reject(this.failure)
    }
  }

  private onDrained(exit: WorkerExit): void {
    if (this.phase === 'starting') {
      this.failStart(() => new WorkerError('WORKER_START_FAILED',
        `${this.label}: exited ${describeExit(exit)} before it reported ready`, { logTail: this.tail.text() }))
      return
    }
    const logTail = this.tail.text()
    const active = this.active
    this.active = undefined
    if (active !== undefined) {
      active.release()
      active.request.result.reject(this.failure ?? new WorkerError('WORKER_EXITED',
        `${this.label}: exited ${describeExit(exit)} while handling "${active.request.method}"`, { logTail }))
    }
    this.phase = 'stopped'
    this.refuse(new WorkerError('WORKER_EXITED', `${this.label}: exited ${describeExit(exit)}`, { logTail }))
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    /* v8 ignore start -- Windows has no process groups, and the coverage lanes run on POSIX */
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      this.child.kill(signal)
      return
    }
    /* v8 ignore stop */
    try {
      process.kill(-pid, signal)
    } catch {
      // ESRCH: no process of the group is left to signal.
    }
  }
}
