/**
 * The worker pool against real fixture workers: one worker per scope, parallel
 * scopes and ordered calls within one, one start at a time with each scope's own
 * setup notes, a folder per worker in the folder of its process, the idle stop and the lost-state notice,
 * making room, the busy refusal, close, and the cleanup of folders that exited processes left behind.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { JsonLineWorker } from '../src/json-line-worker.ts'
import { SHARED_SCOPE, WorkerPool, type AppWorkerScope, type WorkerPoolOptions } from '../src/pool.ts'
import { isAlive, temporaryDirectory, workerError, workerSpec } from './harness.ts'

const STATE_LOST = 'its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker'

interface Pooled {
  readonly pool: WorkerPool
  readonly root: string
  /** Each start's scope, in start order. */
  readonly starts: AppWorkerScope[]
  /** Start and finish of each start, in order: `+key` and `-key`. */
  readonly events: string[]
}

/** A pool over fake workers whose starts record their scopes and leave one setup note each; teardown closes it. */
async function pooled(overrides: Partial<WorkerPoolOptions> = {}): Promise<Pooled> {
  const root = join(await temporaryDirectory('dsh-app-mcp-pool-'), 'workers')
  const starts: AppWorkerScope[] = []
  const events: string[] = []
  let notes: string[] = []
  const pool = new WorkerPool({
    app: 'Fake',
    root,
    start: async (signal, scope) => {
      starts.push(scope)
      events.push(`+${scope.key}`)
      // Starts overlap only if the pool fails to serialize them; the pause would show it.
      await new Promise(resolve => setTimeout(resolve, 30))
      const worker = await JsonLineWorker.start(workerSpec('ready', { cwd: scope.directory }), signal)
      notes.push(`started for ${scope.key}`)
      events.push(`-${scope.key}`)
      return worker
    },
    takeNotes: () => {
      const taken = notes
      notes = []
      return taken
    },
    maxWorkers: 4,
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 15_000,
    closeGraceMs: 2_000,
    ...overrides,
  })
  onTestFinished(() => pool.close())
  return { pool, root, starts, events }
}

async function pidOf(pool: WorkerPool, scope: string): Promise<number> {
  return Number(await pool.call(scope, 'pid', {}))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // access() rejects for a missing path, which is the answer here.
    return false
  }
}

describe('WorkerPool', () => {
  it('gives each scope its own worker and reuses it', async () => {
    const { pool, starts } = await pooled()
    const a = await pidOf(pool, 'session:a')
    const b = await pidOf(pool, 'session:b')
    const shared = await pidOf(pool, SHARED_SCOPE)
    expect(new Set([a, b, shared]).size).toBe(3)
    expect(await pidOf(pool, 'session:a')).toBe(a)
    expect(starts.map(scope => scope.key)).toEqual(['session:a', 'session:b', SHARED_SCOPE])
  })

  it('runs calls of different scopes at the same time and calls of one scope in order', async () => {
    const { pool } = await pooled()
    await pool.call('session:a', 'echo', {})
    await pool.call('session:b', 'echo', {})
    const order: string[] = []
    await Promise.all([
      pool.call('session:a', 'sleep', { ms: 400 }).then(() => { order.push('a sleep') }),
      pool.call('session:a', 'echo', {}).then(() => { order.push('a echo') }),
      pool.call('session:b', 'echo', {}).then(() => { order.push('b echo') }),
    ])
    expect(order).toEqual(['b echo', 'a sleep', 'a echo'])
  })

  it('starts one worker at a time and hands each scope the notes of its own start', async () => {
    const { pool, events } = await pooled()
    await Promise.all([pool.call('session:a', 'echo', {}), pool.call('session:b', 'echo', {})])
    expect(events).toEqual(['+session:a', '-session:a', '+session:b', '-session:b'])
    expect(pool.takeNotes('session:b')).toEqual(['started for session:b'])
    expect(pool.takeNotes('session:a')).toEqual(['started for session:a'])
    expect(pool.takeNotes('session:a')).toEqual([])
    expect(pool.takeNotes('session:unknown')).toEqual([])
  })

  it('gives each worker a fresh numbered folder in the folder of its process', async () => {
    const { pool, root, starts } = await pooled()
    await pool.call('session:a', 'echo', {})
    await pool.call('session:b', 'echo', {})
    const own = join(root, String(process.pid))
    expect(starts.map(scope => scope.directory)).toEqual([join(own, '1'), join(own, '2')])
    expect((await readdir(own)).sort()).toEqual(['1', '2'])
  })

  it('stops a worker after the idle timeout, deletes its folder, and says so on the scope\'s next call', async () => {
    const { pool, starts } = await pooled({ idleTimeoutMs: 300 })
    const first = await pidOf(pool, 'session:a')
    const folder = starts[0]!.directory
    await vi.waitFor(async () => {
      expect(isAlive(first)).toBe(false)
      expect(await exists(folder)).toBe(false)
    }, { timeout: 10_000 })
    const error = await workerError(pool.call('session:a', 'echo', {}))
    expect(error.code).toBe('WORKER_EXITED')
    expect(error.message).toBe(`The Fake worker of this conversation stopped after 1 second without calls; ${STATE_LOST}.`)
    const second = await pidOf(pool, 'session:a')
    expect(second).not.toBe(first)
  })

  it('keeps a worker while calls keep coming within the idle timeout', async () => {
    const { pool } = await pooled({ idleTimeoutMs: 400 })
    const pid = await pidOf(pool, 'session:a')
    for (let i = 0; i < 4; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(await pidOf(pool, 'session:a')).toBe(pid)
    }
  })

  it('makes room by stopping the least recently used worker that runs no call', async () => {
    const { pool } = await pooled({ maxWorkers: 2 })
    const a = await pidOf(pool, 'session:a')
    const b = await pidOf(pool, 'session:b')
    await pool.call('session:a', 'echo', {})
    await pidOf(pool, 'session:c')
    await vi.waitFor(() => { expect(isAlive(b)).toBe(false) }, { timeout: 10_000 })
    expect(await pidOf(pool, 'session:a')).toBe(a)
    const error = await workerError(pool.call('session:b', 'echo', {}))
    expect(error).toMatchObject({ code: 'WORKER_EXITED', message: `The Fake worker of this conversation was stopped to make room for another conversation; ${STATE_LOST}.` })
  })

  it('refuses a new scope with WORKERS_BUSY while every worker runs a call', async () => {
    const { pool } = await pooled({ maxWorkers: 1 })
    await pool.call('session:a', 'echo', {})
    const running = pool.call('session:a', 'sleep', { ms: 500 })
    const error = await workerError(pool.call('session:b', 'echo', {}))
    expect(error.code).toBe('WORKERS_BUSY')
    expect(error.message).toBe('All 1 Fake workers are running calls for other conversations. Call the tool again once one of them has finished.')
    await running
    expect(await pool.call('session:b', 'echo', { ok: true })).toEqual({ ok: true })
  })

  it('stops every worker on close, deletes the folder of its process, and refuses later calls', async () => {
    const { pool, root } = await pooled()
    const pids = [await pidOf(pool, 'session:a'), await pidOf(pool, SHARED_SCOPE)]
    await pool.close()
    for (const pid of pids) expect(isAlive(pid)).toBe(false)
    expect(await exists(join(root, String(process.pid)))).toBe(false)
    expect(await workerError(pool.call('session:a', 'echo', {}))).toMatchObject({ code: 'WORKER_EXITED', message: 'The Fake server is shutting down.' })
  })

  it('deletes the folders of exited server processes and of a former process with its id, and keeps the others', async () => {
    const { pool, root } = await pooled({ processId: 100, processExited: pid => pid !== 300 })
    for (const folder of ['100/1', '200/3/profile', '300/1', '0', '9999999999', 'notes']) {
      await mkdir(join(root, folder), { recursive: true })
    }
    await pool.prepare()
    expect((await readdir(root)).sort()).toEqual(['0', '300', '9999999999', 'notes'])
  })

  it('probes server processes with a signal unless told otherwise', async () => {
    const { pool, root } = await pooled()
    await pool.prepare()
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const exited = child.pid!
    await once(child, 'exit')
    for (const pid of [exited, process.ppid]) await mkdir(join(root, String(pid)), { recursive: true })
    await pool.prepare()
    expect(await readdir(root)).toEqual([String(process.ppid)])
  })

  it('refuses a maximum below one worker and out-of-range budgets', async () => {
    const options: WorkerPoolOptions = {
      app: 'Fake', root: '/tmp/none', start: () => Promise.reject(new Error('unused')), takeNotes: () => [],
      maxWorkers: 1, idleTimeoutMs: 1000, requestTimeoutMs: 1000, closeGraceMs: 0,
    }
    expect(() => new WorkerPool({ ...options, maxWorkers: 0 })).toThrow(RangeError)
    expect(() => new WorkerPool({ ...options, maxWorkers: 1.5 })).toThrow(RangeError)
    expect(() => new WorkerPool({ ...options, idleTimeoutMs: 0 })).toThrow(RangeError)
  })
})
