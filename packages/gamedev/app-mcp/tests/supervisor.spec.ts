/**
 * The worker supervisor against real fixture workers: lazy start, serialized
 * calls, restarts after a stop, the lost-state report for every way a worker
 * stops, cancellation, and close.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { JsonLineWorker, WorkerError } from '../src/json-line-worker.ts'
import { WorkerSupervisor, type WorkerSupervisorOptions } from '../src/supervisor.ts'
import { workerError, workerSpec } from './harness.ts'

const OPTIONS: WorkerSupervisorOptions = { requestTimeoutMs: 15_000, closeGraceMs: 2_000 }

const STATE_LOST = 'its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker'

/** A supervisor over fake workers that records every worker it started; teardown closes it. */
function supervise(mode = 'ready', options: WorkerSupervisorOptions = OPTIONS) {
  const workers: JsonLineWorker[] = []
  const supervisor = new WorkerSupervisor(async (signal) => {
    const worker = await JsonLineWorker.start(workerSpec(mode), signal)
    workers.push(worker)
    return worker
  }, options)
  onTestFinished(() => supervisor.close())
  return { supervisor, workers }
}

describe('WorkerSupervisor', () => {
  it('starts the worker on the first call and reuses it', async () => {
    const { supervisor, workers } = supervise()
    expect(supervisor.running).toBe(false)
    expect(workers).toHaveLength(0)
    expect(await supervisor.call('echo', { first: 1 })).toEqual({ first: 1 })
    expect(supervisor.running).toBe(true)
    expect(await supervisor.call('echo', { second: 2 })).toEqual({ second: 2 })
    expect(workers).toHaveLength(1)
  })

  it('runs calls one at a time in call order', async () => {
    const { supervisor } = supervise()
    const order: string[] = []
    await Promise.all([
      supervisor.call('sleep', { ms: 100 }).then(() => { order.push('sleep') }),
      supervisor.call('echo', {}).then(() => { order.push('echo') }),
    ])
    expect(order).toEqual(['sleep', 'echo'])
  })

  it('passes a remote error through and keeps the worker and its state', async () => {
    const { supervisor, workers } = supervise()
    expect(await workerError(supervisor.call('fail', {}))).toMatchObject({ code: 'WORKER_REMOTE', message: 'ValueError: boom' })
    expect(supervisor.running).toBe(true)
    expect(await supervisor.call('echo', { kept: true })).toEqual({ kept: true })
    expect(workers).toHaveLength(1)
  })

  it('reports a crash as lost state and starts a fresh worker on the next call', async () => {
    const { supervisor, workers } = supervise()
    const error = await workerError(supervisor.call('crash', { code: 3 }))
    expect(error.code).toBe('WORKER_EXITED')
    expect(error.message).toBe(`fake worker: exited with code 3 while handling "crash"; ${STATE_LOST}`)
    expect(error.logTail).toBe('fatal: crashing on purpose\n')
    expect(error.cause).toBeInstanceOf(WorkerError)
    expect(supervisor.running).toBe(false)
    expect(await supervisor.call('echo', { fresh: true })).toEqual({ fresh: true })
    expect(workers).toHaveLength(2)
  })

  it('reports a timeout as lost state and uses the per-call budget', async () => {
    const { supervisor, workers } = supervise()
    const error = await workerError(supervisor.call('sleep', { ms: 60_000 }, { timeoutMs: 200 }))
    expect(error.code).toBe('WORKER_TIMEOUT')
    expect(error.message).toBe(`fake worker: did not answer "sleep" within 200 ms, so it was stopped; ${STATE_LOST}`)
    expect(await workers[0]!.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await supervisor.call('echo', {})).toEqual({})
    expect(workers).toHaveLength(2)
  })

  it('applies the default budget to calls that name none', async () => {
    const { supervisor } = supervise('ready', { requestTimeoutMs: 200, closeGraceMs: 100 })
    expect(await workerError(supervisor.call('sleep', { ms: 60_000 }))).toMatchObject({ code: 'WORKER_TIMEOUT' })
  })

  it('reports a protocol violation as lost state', async () => {
    const { supervisor } = supervise()
    const error = await workerError(supervisor.call('garbage', {}))
    expect(error.code).toBe('WORKER_PROTOCOL')
    expect(error.message).toMatch(new RegExp(`, so it was stopped; ${STATE_LOST.replaceAll(/[()]/gu, '\\$&')}$`, 'u'))
  })

  it('tells the next caller about an exit between calls, without running that call', async () => {
    const { supervisor, workers } = supervise()
    await supervisor.call('exit-later', { code: 6 })
    await vi.waitFor(() => { expect(supervisor.running).toBe(false) })
    const notice = await workerError(supervisor.call('echo', { skipped: true }))
    expect(notice).toMatchObject({ code: 'WORKER_EXITED', message: `fake worker: exited with code 6 after the previous call; ${STATE_LOST}` })
    expect(workers).toHaveLength(1)
    expect(await supervisor.call('echo', { fresh: true })).toEqual({ fresh: true })
    expect(workers).toHaveLength(2)
  })

  it('stops the worker when its running call is cancelled and tells the next caller', async () => {
    const { supervisor, workers } = supervise()
    const controller = new AbortController()
    const running = supervisor.call('sleep', { ms: 60_000 }, { signal: controller.signal })
    await vi.waitFor(() => { expect(supervisor.running).toBe(true) })
    const reason = new Error('the user pressed stop')
    setTimeout(() => { controller.abort(reason) }, 50)
    await expect(running).rejects.toBe(reason)
    expect(await workers[0]!.exited).toEqual({ code: null, signal: 'SIGKILL' })
    const notice = await workerError(supervisor.call('echo', {}))
    expect(notice).toMatchObject({ code: 'WORKER_EXITED', message: `fake worker: was stopped when call "sleep" was cancelled; ${STATE_LOST}` })
    expect(await supervisor.call('echo', { fresh: true })).toEqual({ fresh: true })
    expect(workers).toHaveLength(2)
  })

  it('leaves the worker alone when a queued call is cancelled', async () => {
    const { supervisor, workers } = supervise()
    const running = supervisor.call('sleep', { ms: 200 })
    const controller = new AbortController()
    const queued = supervisor.call('echo', {}, { signal: controller.signal })
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(await running).toEqual({ slept: 200 })
    expect(await supervisor.call('echo', { same: 'worker' })).toEqual({ same: 'worker' })
    expect(workers).toHaveLength(1)
  })

  it('counts the wait for earlier calls against a queued call, which fails without running once its budget is spent', async () => {
    const { supervisor, workers } = supervise()
    const running = supervisor.call('sleep', { ms: 400 })
    const queued = workerError(supervisor.call('echo', {}, { timeoutMs: 200 }))
    expect(await running).toEqual({ slept: 400 })
    const error = await queued
    expect(error.code).toBe('WORKER_TIMEOUT')
    expect(error.message).toMatch(/^call "echo" waited \d+ ms for earlier calls to finish, which spent its 200 ms budget; /u)
    expect(error.message).toMatch(/; it did not run, and the worker kept its state$/u)
    expect(await supervisor.call('echo', { same: 'worker' })).toEqual({ same: 'worker' })
    expect(workers).toHaveLength(1)
  })

  it('gives a queued call what is left of its budget', async () => {
    const { supervisor } = supervise()
    const running = supervisor.call('sleep', { ms: 300 })
    const queued = workerError(supervisor.call('sleep', { ms: 60_000 }, { timeoutMs: 1_000 }))
    expect(await running).toEqual({ slept: 300 })
    const error = await queued
    expect(error.code).toBe('WORKER_TIMEOUT')
    const [, granted] = /within (\d+) ms/u.exec(error.message) ?? []
    expect(Number(granted)).toBeLessThanOrEqual(700)
  })

  it('rejects an already cancelled call without starting a worker', async () => {
    const { supervisor, workers } = supervise()
    await expect(supervisor.call('echo', {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers).toHaveLength(0)
  })

  it('keeps a worker whose start outran a cancellation', async () => {
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    let starts = 0
    const supervisor = new WorkerSupervisor(async (signal) => {
      starts++
      await release.promise
      return await JsonLineWorker.start(workerSpec(), signal.aborted ? undefined : signal)
    }, OPTIONS)
    onTestFinished(() => supervisor.close())
    // The start ignores the cancellation and finishes: the call is cancelled, the worker stays.
    const controller = new AbortController()
    const cancelled = supervisor.call('echo', {}, { signal: controller.signal })
    await vi.waitFor(() => { expect(starts).toBe(1) })
    controller.abort()
    release.resolve()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(supervisor.running).toBe(true)
    expect(await supervisor.call('echo', { reused: true })).toEqual({ reused: true })
    expect(starts).toBe(1)
  })

  it('starts again after a start that failed or was cancelled, with no lost-state notice', async () => {
    let mode = 'garbage-ready'
    const supervisor = new WorkerSupervisor(signal => JsonLineWorker.start(workerSpec(mode), signal), OPTIONS)
    onTestFinished(() => supervisor.close())
    expect(await workerError(supervisor.call('echo', {}))).toMatchObject({ code: 'WORKER_START_FAILED' })
    mode = 'silent'
    const controller = new AbortController()
    const starting = supervisor.call('echo', {}, { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 100)
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(supervisor.running).toBe(false)
    mode = 'ready'
    expect(await supervisor.call('echo', { started: true })).toEqual({ started: true })
  })

  it('cancels the running call on close, shuts the worker down, and refuses later calls', async () => {
    const { supervisor, workers } = supervise()
    const running = workerError(supervisor.call('sleep', { ms: 60_000 }))
    await vi.waitFor(() => { expect(supervisor.running).toBe(true) })
    const queued = workerError(supervisor.call('echo', {}))
    const closing = supervisor.close()
    expect(supervisor.close()).toBe(closing)
    const closed = 'the worker supervisor is closed, so no further calls run'
    expect(await running).toMatchObject({ code: 'WORKER_EXITED', message: closed })
    expect(await queued).toMatchObject({ code: 'WORKER_EXITED', message: closed })
    await closing
    expect(await workers[0]!.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(supervisor.running).toBe(false)
    expect(await workerError(supervisor.call('echo', {}))).toMatchObject({ code: 'WORKER_EXITED', message: closed })
  })

  it('shuts an idle worker down through the protocol on close', async () => {
    const { supervisor, workers } = supervise()
    await supervisor.call('echo', {})
    await supervisor.close()
    expect(await workers[0]!.exited).toEqual({ code: 0, signal: null })
  })

  it('closes without a worker', async () => {
    const { supervisor } = supervise()
    await expect(supervisor.close()).resolves.toBeUndefined()
  })

  it('shuts down a worker whose start finished after close began', async () => {
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    const workers: JsonLineWorker[] = []
    const supervisor = new WorkerSupervisor(async () => {
      entered.resolve()
      await release.promise
      const worker = await JsonLineWorker.start(workerSpec())
      workers.push(worker)
      return worker
    }, OPTIONS)
    const calling = supervisor.call('echo', {})
    await entered.promise
    const closing = supervisor.close()
    release.resolve()
    expect(await workerError(calling)).toMatchObject({ code: 'WORKER_EXITED' })
    await closing
    expect(await workers[0]!.exited).toEqual({ code: 0, signal: null })
  })

  it('rejects out-of-range budgets', () => {
    const start = (): Promise<JsonLineWorker> => Promise.reject(new Error('unused'))
    expect(() => new WorkerSupervisor(start, { requestTimeoutMs: 0, closeGraceMs: 0 })).toThrow('requestTimeoutMs must be a positive number')
    expect(() => new WorkerSupervisor(start, { requestTimeoutMs: 1, closeGraceMs: -1 })).toThrow('closeGraceMs must be a non-negative number')
  })

  it('rejects an out-of-range call budget', async () => {
    const { supervisor } = supervise()
    await expect(supervisor.call('echo', {}, { timeoutMs: -5 })).rejects.toThrow(RangeError)
  })
})
