/**
 * The JSON-lines worker client against real fixture processes: readiness,
 * serialized requests, remote errors, timeouts, cancellation, exits,
 * protocol violations, the bounded log tail, and escalating shutdown.
 */
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  abortError, assertDelay, describeExit, JsonLineWorker, LineBuffer, MAX_REPLY_BYTES,
} from '../src/json-line-worker.ts'
import { isAlive, killQuietly, pidsIn, startWorker, temporaryDirectory, workerError, workerSpec } from './harness.ts'

const REQUEST = { timeoutMs: 15_000 }
/** Ready budget of a silent worker whose log line or pid a test reads: long enough for Node to start under load. */
const SILENT_STARTED = { readyTimeoutMs: 2_000 }

describe('starting a worker', () => {
  it('resolves after the ready line with the announced identity', async () => {
    const worker = await startWorker()
    expect(worker.ready).toEqual({ app: 'fake', version: '1.2.3', python: '3.13.1' })
  })

  it('accepts a ready line without python from a worker that runs no Python', async () => {
    const worker = await startWorker('no-python')
    expect(worker.ready).toEqual({ app: 'fake', version: '1.2.3', python: undefined })
  })

  it.each([
    ['writes something other than a ready line', 'garbage-ready', { }, /wrote "not a ready line" instead of a ready line/u],
    ['announces another protocol revision', 'wrong-protocol', {}, /instead of a ready line/u],
    ['stays silent past the ready budget', 'silent', { readyTimeoutMs: 300 }, /did not report ready within 300 ms/u],
    ['exits before it is ready', 'exit-before-ready', {}, /exited with code 4 before it reported ready/u],
    ['is killed before it is ready', 'killed-before-ready', {}, /exited on signal SIGKILL before it reported ready/u],
  ])('fails with WORKER_START_FAILED when the worker %s', async (_case, mode, overrides, message) => {
    const error = await workerError(JsonLineWorker.start(workerSpec(mode, overrides)))
    expect(error.code).toBe('WORKER_START_FAILED')
    expect(error.message).toMatch(message)
    expect(error.message).toMatch(/^worker node: /u)
  })

  it('keeps the log tail of a worker that failed to start', async () => {
    const silent = await workerError(JsonLineWorker.start(workerSpec('silent', SILENT_STARTED)))
    expect(silent.logTail).toBe('loading forever\n')
    const exited = await workerError(JsonLineWorker.start(workerSpec('exit-before-ready')))
    expect(exited.logTail).toBe('cannot import bpy\n')
  })

  it('kills the worker and waits for its exit before rejecting', async () => {
    const pids = join(await temporaryDirectory('dsh-app-mcp-pids-'), 'pids')
    const env = { ...process.env, FAKE_WORKER_PIDS: pids }
    await workerError(JsonLineWorker.start(workerSpec('silent', { ...SILENT_STARTED, env })))
    const [pid] = await pidsIn(pids)
    expect(pid).toBeDefined()
    expect(isAlive(pid!)).toBe(false)
  })

  it('fails a ready line longer than the reply bound', async () => {
    const spec = workerSpec('oversized-ready')
    const error = await workerError(JsonLineWorker.start({ ...spec, argv: [...spec.argv, String(MAX_REPLY_BYTES + 1)] }))
    expect(error.code).toBe('WORKER_START_FAILED')
    expect(error.message).toContain(`wrote a line longer than ${MAX_REPLY_BYTES} bytes before its ready line`)
  })

  it('fails with WORKER_START_FAILED when the executable cannot run', async () => {
    const missing = await workerError(JsonLineWorker.start(workerSpec('ready', { argv: ['/nonexistent/dsh-app-mcp-worker'] })))
    expect(missing.code).toBe('WORKER_START_FAILED')
    expect(missing.message).toBe('worker dsh-app-mcp-worker: could not be started: spawn /nonexistent/dsh-app-mcp-worker ENOENT')
    expect(missing.cause).toMatchObject({ code: 'ENOENT' })
    const invalid = await workerError(JsonLineWorker.start(workerSpec('ready', { argv: ['/bin/x\0y'] })))
    expect(invalid.message).toMatch(/could not be spawned/u)
    expect(invalid.cause).toBeInstanceOf(Error)
  })

  it.each([[[]], [['']]])('refuses the argv %j', async (argv) => {
    const error = await workerError(JsonLineWorker.start(workerSpec('ready', { argv })))
    expect(error.code).toBe('WORKER_START_FAILED')
    expect(error.message).toBe('the worker argv is empty; argv[0] must be the worker executable')
  })

  it.each([
    [{ readyTimeoutMs: 0 }, /readyTimeoutMs must be a positive number/u],
    [{ readyTimeoutMs: Number.NaN }, /readyTimeoutMs/u],
    [{ readyTimeoutMs: 2 ** 31 }, /no greater than 2147483647/u],
    [{ logTailBytes: -1 }, /logTailBytes must be a non-negative integer/u],
    [{ logTailBytes: 1.5 }, /logTailBytes/u],
  ])('rejects the out-of-range spec field %j', async (overrides, message) => {
    await expect(JsonLineWorker.start(workerSpec('ready', overrides))).rejects.toThrow(RangeError)
    await expect(JsonLineWorker.start(workerSpec('ready', overrides))).rejects.toThrow(message)
  })

  it('rejects with the abort reason when the start is cancelled, after the worker is gone', async () => {
    const pids = join(await temporaryDirectory('dsh-app-mcp-pids-'), 'pids')
    const controller = new AbortController()
    const starting = JsonLineWorker.start(workerSpec('silent', { env: { ...process.env, FAKE_WORKER_PIDS: pids } }), controller.signal)
    await vi.waitFor(async () => { expect(await pidsIn(pids)).toHaveLength(1) })
    const reason = new Error('the user cancelled')
    controller.abort(reason)
    await expect(starting).rejects.toBe(reason)
    expect(isAlive((await pidsIn(pids))[0]!)).toBe(false)
  })

  it('spawns nothing for an already cancelled start', async () => {
    const pids = join(await temporaryDirectory('dsh-app-mcp-pids-'), 'pids')
    await expect(JsonLineWorker.start(workerSpec('ready', { env: { ...process.env, FAKE_WORKER_PIDS: pids } }), AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(await pidsIn(pids)).toEqual([])
  })
})

describe('requests', () => {
  it('resolves each request with the worker result, one at a time in call order', async () => {
    const worker = await startWorker()
    const results = await Promise.all([
      worker.request('sleep', { ms: 50 }, REQUEST),
      worker.request('echo', { order: 2 }, REQUEST),
      worker.request('echo', { order: 3, nested: { list: [1, 'two', null, true] } }, REQUEST),
    ])
    expect(results).toEqual([{ slept: 50 }, { order: 2 }, { order: 3, nested: { list: [1, 'two', null, true] } }])
  })

  it('reassembles replies split across reads, including inside a multibyte character', async () => {
    const worker = await startWorker()
    expect(await worker.request('split', { value: 'whole' }, REQUEST)).toEqual({ value: 'whole' })
    expect(await worker.request('multibyte-split', {}, REQUEST)).toBe('€uro')
  })

  it('rejects a reported exception with WORKER_REMOTE and keeps the worker running', async () => {
    const worker = await startWorker()
    const error = await workerError(worker.request('fail', { message: 'no object named Cube' }, REQUEST))
    expect(error).toMatchObject({ code: 'WORKER_REMOTE', remoteType: 'ValueError', message: 'ValueError: no object named Cube' })
    expect(error.traceback).toContain('Traceback (most recent call last)')
    const bare = await workerError(worker.request('fail-without-traceback', {}, REQUEST))
    expect(bare).toMatchObject({ code: 'WORKER_REMOTE', remoteType: 'KeyError', traceback: undefined, logTail: undefined })
    expect(await worker.request('echo', { still: 'running' }, REQUEST)).toEqual({ still: 'running' })
  })

  it('stops the worker when a request times out and refuses later requests', async () => {
    const worker = await startWorker()
    const pending = workerError(worker.request('sleep', { ms: 60_000 }, { timeoutMs: 200 }))
    const queued = workerError(worker.request('echo', {}, REQUEST))
    const error = await pending
    expect(error.code).toBe('WORKER_TIMEOUT')
    expect(error.message).toBe('fake worker: did not answer "sleep" within 200 ms, so it was stopped')
    expect(await queued).toBe(error)
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await workerError(worker.request('echo', {}, REQUEST))).toBe(error)
  })

  it('takes a cancelled queued request out of the queue without touching the worker', async () => {
    const worker = await startWorker()
    const running = worker.request('sleep', { ms: 200 }, REQUEST)
    const controller = new AbortController()
    const queued = worker.request('echo', { never: 'sent' }, { ...REQUEST, signal: controller.signal })
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(await running).toEqual({ slept: 200 })
    expect(await worker.request('echo', { after: 'abort' }, REQUEST)).toEqual({ after: 'abort' })
  })

  it('stops the worker when a dispatched request is cancelled', async () => {
    const worker = await startWorker()
    const controller = new AbortController()
    const running = worker.request('sleep', { ms: 60_000 }, { ...REQUEST, signal: controller.signal })
    const reason = new Error('the user pressed stop')
    setTimeout(() => { controller.abort(reason) }, 50)
    await expect(running).rejects.toBe(reason)
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
    const refused = await workerError(worker.request('echo', {}, REQUEST))
    expect(refused).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: was stopped because request "sleep" was cancelled' })
  })

  it('rejects with an AbortError when the abort reason is not an Error', async () => {
    const worker = await startWorker()
    const controller = new AbortController()
    const running = worker.request('sleep', { ms: 60_000 }, { ...REQUEST, signal: controller.signal })
    setTimeout(() => { controller.abort('stop') }, 50)
    await expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted' })
  })

  it('rejects an already cancelled request without dispatching it', async () => {
    const worker = await startWorker()
    await expect(worker.request('crash', {}, { ...REQUEST, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await worker.request('echo', { alive: true }, REQUEST)).toEqual({ alive: true })
  })

  it('fails the request being handled and the queued ones when the worker exits', async () => {
    const worker = await startWorker()
    const crashing = workerError(worker.request('crash', { code: 3 }, REQUEST))
    const queued = workerError(worker.request('echo', {}, REQUEST))
    const error = await crashing
    expect(error.code).toBe('WORKER_EXITED')
    expect(error.message).toBe('fake worker: exited with code 3 while handling "crash"')
    expect(error.logTail).toBe('fatal: crashing on purpose\n')
    expect(await queued).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: exited with code 3' })
    expect(await worker.exited).toEqual({ code: 3, signal: null })
  })

  it('names the signal that ended the worker', async () => {
    const worker = await startWorker()
    const error = await workerError(worker.request('die', {}, REQUEST))
    expect(error.message).toBe('fake worker: exited on signal SIGKILL while handling "die"')
  })

  it('refuses requests once the worker exited while idle', async () => {
    const worker = await startWorker()
    await worker.request('exit-later', { code: 7 }, REQUEST)
    expect(await worker.exited).toEqual({ code: 7, signal: null })
    await vi.waitFor(async () => {
      expect(await workerError(worker.request('echo', {}, REQUEST))).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: exited with code 7' })
    })
  })

  it.each([
    ['writes a line that is not JSON', 'garbage', 'wrote "this is not json", which is not a protocol reply'],
    ['writes a line that is not UTF-8', 'invalid-utf8', 'which is not a protocol reply'],
    ['answers another request id', 'wrong-id', 'answered request 101 while request 1 was pending'],
  ])('stops the worker with WORKER_PROTOCOL when it %s', async (_case, method, message) => {
    const worker = await startWorker()
    const error = await workerError(worker.request(method, {}, REQUEST))
    expect(error.code).toBe('WORKER_PROTOCOL')
    expect(error.message).toContain(message)
    expect(error.message).toMatch(/, so it was stopped$/u)
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await workerError(worker.request('echo', {}, REQUEST))).toBe(error)
  })

  it('stops the worker when it answers a request twice', async () => {
    const worker = await startWorker()
    expect(await worker.request('twice', {}, REQUEST)).toBe(1)
    await worker.exited
    const error = await workerError(worker.request('echo', {}, REQUEST))
    expect(error).toMatchObject({ code: 'WORKER_PROTOCOL', message: 'fake worker: answered request 1 while no request was pending, so it was stopped' })
  })

  it('quotes only the start of a long rejected line', async () => {
    const worker = await startWorker()
    const error = await workerError(worker.request('garbage-long', {}, REQUEST))
    expect(error.message).toContain(`wrote "${'z'.repeat(200)}"…, which is not a protocol reply`)
  })

  it('keeps the first violation and ignores the lines after it', async () => {
    const worker = await startWorker()
    const error = await workerError(worker.request('garbage-twice', {}, REQUEST))
    expect(error.message).toContain('"first garbage"')
  })

  it('stops the worker when a reply line exceeds the reply bound', async () => {
    const worker = await startWorker()
    const error = await workerError(worker.request('oversized', { bytes: MAX_REPLY_BYTES }, REQUEST))
    expect(error).toMatchObject({ code: 'WORKER_PROTOCOL', message: `fake worker: wrote a line longer than ${MAX_REPLY_BYTES} bytes, so it was stopped` })
  })

  it('survives a worker that closed its stdin: the unread request times out', async () => {
    const worker = await startWorker('no-stdin')
    const error = await workerError(worker.request('echo', {}, { timeoutMs: 300 }))
    expect(error.code).toBe('WORKER_TIMEOUT')
  })

  it('rejects an out-of-range timeout', async () => {
    const worker = await startWorker()
    await expect(worker.request('echo', {}, { timeoutMs: 0 })).rejects.toThrow(RangeError)
    await expect(worker.request('echo', {}, { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow('timeoutMs must be a positive number')
  })

  it('reaps the processes a crashed worker left in its group', async () => {
    const worker = await startWorker()
    const { orphan } = await worker.request('orphan', {}, REQUEST) as { orphan: number }
    try {
      expect(await worker.exited).toEqual({ code: 5, signal: null })
      await vi.waitFor(() => { expect(isAlive(orphan)).toBe(false) })
      await vi.waitFor(async () => {
        expect(await workerError(worker.request('echo', {}, REQUEST))).toMatchObject({ code: 'WORKER_EXITED' })
      })
    } finally {
      killQuietly(orphan)
    }
  })
})

describe('the log tail', () => {
  it('keeps the newest output of stdout and stderr', async () => {
    const worker = await startWorker('ready', { logTailBytes: 64 })
    await worker.request('noisy', { stdout: 'from stdout\n' }, REQUEST)
    await vi.waitFor(() => { expect(worker.logTail()).toBe('from stdout\n') })
    await worker.request('noisy', { stderr: 'from stderr\n' }, REQUEST)
    await vi.waitFor(() => { expect(worker.logTail()).toBe('from stdout\nfrom stderr\n') })
  })

  it.each([
    ['an exact fit', 10, 'abcdefghij', 'abcdefghij'],
    ['one byte over', 10, 'abcdefghijk', 'bcdefghijk'],
    ['an oversized single write', 4, 'x'.repeat(100) + 'tail', 'tail'],
    ['a cut through a multibyte character', 4, '€€', '€'],
    ['a cut leaving only continuation bytes', 2, '€', ''],
    ['no tail at all', 0, 'anything', ''],
  ])('bounds the tail by bytes: %s', async (_case, logTailBytes, stderr, expected) => {
    const worker = await startWorker('ready', { logTailBytes })
    await worker.request('noisy', { stderr }, REQUEST)
    await worker.request('noisy', { stdout: '' }, REQUEST)
    await vi.waitFor(() => { expect(worker.logTail()).toBe(expected) })
  })
})

describe('closing', () => {
  it('shuts an idle worker down through the protocol and refuses later requests', async () => {
    const worker = await startWorker()
    await worker.close(5_000)
    expect(await worker.exited).toEqual({ code: 0, signal: null })
    expect(await workerError(worker.request('echo', {}, REQUEST))).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: was shut down' })
    await expect(worker.close(5_000)).resolves.toBeUndefined()
  })

  it('accepts a worker that acknowledges the shutdown request', async () => {
    const worker = await startWorker('ack-shutdown')
    await worker.close(5_000)
    expect(await worker.exited).toEqual({ code: 0, signal: null })
  })

  it('lets the request being handled finish and rejects the queued ones', async () => {
    const worker = await startWorker()
    const running = worker.request('sleep', { ms: 200 }, REQUEST)
    const queued = worker.request('echo', {}, REQUEST)
    const closing = worker.close(5_000)
    expect(await workerError(queued)).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: was shut down' })
    expect(await running).toEqual({ slept: 200 })
    await closing
    expect(await worker.exited).toEqual({ code: 0, signal: null })
  })

  it('fails the request being handled when the worker exits during shutdown', async () => {
    const worker = await startWorker('stubborn')
    const running = worker.request('sleep', { ms: 60_000 }, REQUEST)
    await worker.close(100)
    expect(await workerError(running)).toMatchObject({ code: 'WORKER_EXITED', message: 'fake worker: was shut down' })
  })

  it('escalates to SIGTERM when the worker ignores the shutdown request', async () => {
    const worker = await startWorker('stubborn')
    await worker.close(100)
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('escalates to SIGKILL when the worker also ignores SIGTERM', async () => {
    const worker = await startWorker('immortal')
    await worker.close(100)
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(worker.logTail()).toContain('ignoring SIGTERM')
  })

  it('stops a worker on a protocol violation during shutdown', async () => {
    const worker = await startWorker('stubborn')
    const running = worker.request('garbage', {}, REQUEST)
    const closing = worker.close(5_000)
    expect(await workerError(running)).toMatchObject({ code: 'WORKER_PROTOCOL' })
    await closing
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
  })

  it('closes a worker that is already stopped without sending it SIGTERM', async () => {
    const worker = await startWorker()
    // Each SIGKILL arrives 50 ms late, so close runs while the stopped worker is still alive.
    const kill = process.kill.bind(process)
    const signals: (string | number | undefined)[] = []
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signals.push(signal)
      const send = (): void => {
        try {
          kill(pid, signal)
        } catch {
          // ESRCH: the process group already exited.
        }
      }
      if (signal === 'SIGKILL') setTimeout(send, 50)
      else send()
      return true
    })
    onTestFinished(() => { spy.mockRestore() })
    await workerError(worker.request('sleep', { ms: 60_000 }, { timeoutMs: 100 }))
    await worker.close(0)
    expect(signals).not.toContain('SIGTERM')
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' })
  })

  it('rejects an out-of-range grace period', async () => {
    const worker = await startWorker()
    await expect(worker.close(-1)).rejects.toThrow('graceMs must be a non-negative number')
    expect(await worker.request('echo', { open: true }, REQUEST)).toEqual({ open: true })
  })
})

describe('LineBuffer', () => {
  function collect(limit: number, chunks: string[]): { lines: string[]; results: boolean[] } {
    const buffer = new LineBuffer(limit)
    const lines: string[] = []
    const results = chunks.map(chunk => buffer.push(Buffer.from(chunk), (line) => { lines.push(line.toString()) }))
    return { lines, results }
  }

  it('emits every line a chunk completes, in order', () => {
    expect(collect(10, ['one\ntwo\nth', 'ree\n'])).toEqual({ lines: ['one', 'two', 'three'], results: [true, true] })
  })

  it('accepts a line of exactly the limit and refuses one byte more', () => {
    expect(collect(4, ['abcd\n'])).toEqual({ lines: ['abcd'], results: [true] })
    expect(collect(4, ['abcde\n'])).toEqual({ lines: [], results: [false] })
  })

  it('counts an unterminated line across chunks and drops it on overflow', () => {
    expect(collect(4, ['ab', 'cd', 'e', 'f\n'])).toEqual({ lines: ['f'], results: [true, true, false, true] })
  })

  it('emits the lines before an overflowing one', () => {
    expect(collect(3, ['ok\ntoo long\n'])).toEqual({ lines: ['ok'], results: [false] })
  })
})

describe('helpers', () => {
  it('validates timer delays', () => {
    expect(() => { assertDelay('graceMs', 0, true) }).not.toThrow()
    expect(() => { assertDelay('timeoutMs', 0) }).toThrow('timeoutMs must be a positive number of milliseconds no greater than 2147483647; got 0')
  })

  it('turns abort reasons into errors', () => {
    const reason = new Error('mine')
    expect(abortError(AbortSignal.abort(reason))).toBe(reason)
    expect(abortError(AbortSignal.abort(42))).toMatchObject({ name: 'AbortError' })
  })

  it('describes exits', () => {
    expect(describeExit({ code: 2, signal: null })).toBe('with code 2')
    expect(describeExit({ code: null, signal: 'SIGTERM' })).toBe('on signal SIGTERM')
  })
})
