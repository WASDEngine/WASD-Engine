/** The follow stream folds into one Session's game state, runs only while something reads it, and reopens after it stops. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGameSource, FOLLOW_RETRY_INITIAL_MS, FOLLOW_RETRY_MAX_MS, foldFollow, LOG_RING_SIZE, type GameState } from '../src/client/source.ts'
import { entry, follow, READY, run, snapshot, type FedFollow } from './client-fixtures.client.ts'

function state(overrides: Partial<GameState> = {}): GameState {
  return { run: run('r1'), runtime: READY, logs: [entry(1), entry(2)], cursor: 2, ...overrides }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('foldFollow', () => {
  it('replaces the state with a snapshot and keeps its newest entries', () => {
    const logs = Array.from({ length: LOG_RING_SIZE + 3 }, (_, index) => entry(index + 1))
    const next = foldFollow(state(), snapshot(run('r2'), logs))
    expect(next?.run?.runId).toBe('r2')
    expect(next?.logs).toHaveLength(LOG_RING_SIZE)
    expect(next?.logs[0]?.seq).toBe(4)
    expect(next?.cursor).toBe(LOG_RING_SIZE + 3)
  })

  it('ignores items that arrive before the first snapshot', () => {
    expect(foldFollow(null, { type: 'run', run: run('r1') })).toBeNull()
    expect(foldFollow(null, { type: 'logs', entries: [entry(1)], cursor: 1 })).toBeNull()
    expect(foldFollow(null, { type: 'runtime', runtime: READY })).toBeNull()
  })

  it('keeps the entries of the same run and drops those of another when the run changes', () => {
    const before = state({ logs: [entry(1, 'r1'), entry(2, 'r2')] })
    const updated = foldFollow(before, { type: 'run', run: run('r1', { fps: 60 }) })
    expect(updated?.run?.fps).toBe(60)
    expect(updated?.logs).toBe(before.logs)
    expect(foldFollow(before, { type: 'run', run: run('r2') })?.logs).toEqual([entry(2, 'r2')])
    expect(foldFollow(before, { type: 'run', run: null })).toEqual({ ...before, run: null, logs: [] })
    const idle = state({ run: null, logs: [entry(1)] })
    expect(foldFollow(idle, { type: 'run', run: null })?.logs).toBe(idle.logs)
  })

  it('appends new entries once, in order, within the ring', () => {
    const appended = foldFollow(state(), { type: 'logs', entries: [entry(2), entry(3), entry(4)], cursor: 4 })
    expect(appended?.logs.map(item => item.seq)).toEqual([1, 2, 3, 4])
    expect(appended?.cursor).toBe(4)
    const empty = foldFollow(state({ logs: [] }), { type: 'logs', entries: [entry(1)], cursor: 1 })
    expect(empty?.logs).toEqual([entry(1)])
    const full = state({ logs: Array.from({ length: LOG_RING_SIZE }, (_, index) => entry(index + 1)) })
    const rolled = foldFollow(full, { type: 'logs', entries: [entry(LOG_RING_SIZE + 1)], cursor: LOG_RING_SIZE + 1 })
    expect(rolled?.logs).toHaveLength(LOG_RING_SIZE)
    expect(rolled?.logs[0]?.seq).toBe(2)
  })

  it('replaces the runtime view', () => {
    expect(foldFollow(state(), { type: 'runtime', runtime: { state: 'installing' } })?.runtime).toEqual({ state: 'installing' })
  })
})

/** A terminal failure of a follow stream, such as a Gateway refusal. */
const REFUSED = new Error('gateway/internal')

function source() {
  const streams: FedFollow[] = []
  const game = createGameSource({
    open: () => {
      const stream = follow()
      streams.push(stream)
      return stream
    },
  })
  return { game, streams }
}

/** Let the stream readers run every iteration that is ready. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Let the stream readers run under fake timers without moving the clock. */
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('createGameSource', () => {
  it('opens one stream for every subscriber, closes it with the last one, and keeps the state for the next', async () => {
    const { game, streams } = source()
    expect(game.observable.getSnapshot()).toEqual({ state: null, disconnected: false })
    const seen: unknown[] = []
    const first = game.observable.subscribe(() => { seen.push(game.observable.getSnapshot().state?.run?.runId) })
    const second = game.observable.subscribe(() => {})
    expect(streams).toHaveLength(1)
    streams[0]!.push({ type: 'run', run: run('early') })
    streams[0]!.push(snapshot(run('r1')))
    streams[0]!.push({ type: 'run', run: run('r2') })
    await vi.waitFor(() => { expect(seen).toEqual(['r1', 'r2']) })
    expect(streams[0]!.accepted).toEqual([snapshot(run('r1'))])
    first()
    expect(streams[0]!.disposed).not.toHaveBeenCalled()
    second()
    expect(streams[0]!.disposed).toHaveBeenCalledOnce()
    expect(game.observable.getSnapshot().state?.run?.runId).toBe('r2')
    const again = game.observable.subscribe(() => {})
    expect(streams).toHaveLength(2)
    again()
  })

  it('accepts the opening snapshot of every generation and keeps the state between generations', async () => {
    const { game, streams } = source()
    const unsubscribe = game.observable.subscribe(() => {})
    streams[0]!.push(snapshot(run('r1'), [entry(1)]))
    streams[0]!.push(snapshot(run('r1'), [entry(1), entry(2)]))
    await vi.waitFor(() => { expect(game.observable.getSnapshot().state?.logs).toHaveLength(2) })
    expect(streams[0]!.accepted).toHaveLength(2)
    expect(game.observable.getSnapshot().disconnected).toBe(false)
    unsubscribe()
  })

  it('ignores items from a stream it closed', async () => {
    const { game, streams } = source()
    const unsubscribe = game.observable.subscribe(() => {})
    unsubscribe()
    streams[0]!.push(snapshot(run('late')))
    await settle()
    expect(game.observable.getSnapshot()).toEqual({ state: null, disconnected: false })
  })

  it('reopens a stream that ends or fails after its snapshot at once and keeps the last state meanwhile', async () => {
    const { game, streams } = source()
    const listener = vi.fn()
    const unsubscribe = game.observable.subscribe(listener)
    streams[0]!.push(snapshot(run('r1')))
    await vi.waitFor(() => { expect(game.observable.getSnapshot().state?.run?.runId).toBe('r1') })
    streams[0]!.end()
    await vi.waitFor(() => { expect(streams).toHaveLength(2) })
    expect(game.observable.getSnapshot()).toMatchObject({ disconnected: false, state: { run: { runId: 'r1' } } })
    streams[1]!.push(snapshot(run('r1')))
    await vi.waitFor(() => { expect(streams[1]!.accepted).toHaveLength(1) })
    streams[1]!.fail(REFUSED)
    await vi.waitFor(() => { expect(streams).toHaveLength(3) })
    expect(game.observable.getSnapshot().disconnected).toBe(false)
    unsubscribe()
  })

  it('reports a stream that stops before its snapshot and keeps the last state', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const unsubscribe = game.observable.subscribe(() => {})
    streams[0]!.push(snapshot(run('r1')))
    streams[0]!.end()
    await drain()
    expect(streams).toHaveLength(2)
    streams[1]!.push({ type: 'run', run: run('r2') })
    streams[1]!.end()
    await drain()
    expect(game.observable.getSnapshot()).toMatchObject({ state: { run: run('r1') }, disconnected: true })
    unsubscribe()
  })

  it('reopens after a delay that doubles per attempt without a snapshot, up to its ceiling, and reports the disconnection once', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const listener = vi.fn()
    const unsubscribe = game.observable.subscribe(listener)
    const delays: number[] = []
    let elapsed = 0
    for (let attempt = 0; attempt < 7; attempt++) {
      streams.at(-1)!.fail(REFUSED)
      await drain()
      expect(game.observable.getSnapshot()).toEqual({ state: null, disconnected: true })
      const opened = streams.length
      const started = elapsed
      while (streams.length === opened) {
        await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS / 4)
        elapsed += FOLLOW_RETRY_INITIAL_MS / 4
      }
      delays.push(elapsed - started)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_MAX_MS])
    // One report for the stop; reopening keeps it until a snapshot arrives.
    expect(listener).toHaveBeenCalledOnce()
    streams.at(-1)!.push(snapshot(run('r1')))
    await drain()
    expect(game.observable.getSnapshot()).toMatchObject({ disconnected: false, state: { run: { runId: 'r1' } } })
    streams.at(-1)!.end()
    await drain()
    streams.at(-1)!.end()
    await drain()
    expect(game.observable.getSnapshot().disconnected).toBe(true)
    const opened = streams.length
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS - 1)
    expect(streams).toHaveLength(opened)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(opened + 1)
    unsubscribe()
  })

  it('reopens at once on reconnect, clears the disconnection, and restarts the delay', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const listener = vi.fn()
    const unsubscribe = game.observable.subscribe(listener)
    game.reconnect()
    expect(streams).toHaveLength(1)
    for (const _ of [1, 2]) {
      streams.at(-1)!.fail(REFUSED)
      await drain()
      await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS * 2)
    }
    streams.at(-1)!.fail(REFUSED)
    await drain()
    expect(game.observable.getSnapshot()).toEqual({ state: null, disconnected: true })
    game.reconnect()
    expect(streams).toHaveLength(4)
    expect(game.observable.getSnapshot()).toEqual({ state: null, disconnected: false })
    streams[3]!.fail(REFUSED)
    await drain()
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS)
    expect(streams).toHaveLength(5)
    unsubscribe()
    game.reconnect()
    expect(streams).toHaveLength(5)
  })

  it('clears an old disconnection and restarts the delay when a later subscriber opens a stream', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const unsubscribe = game.observable.subscribe(() => {})
    for (let attempt = 0; attempt < 3; attempt++) {
      streams.at(-1)!.end()
      await drain()
      await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS * 4)
    }
    expect(streams).toHaveLength(4)
    expect(game.observable.getSnapshot().disconnected).toBe(true)
    unsubscribe()
    expect(game.observable.getSnapshot().disconnected).toBe(true)
    const again = game.observable.subscribe(() => {})
    expect(streams).toHaveLength(5)
    expect(game.observable.getSnapshot().disconnected).toBe(false)
    streams[4]!.end()
    await drain()
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS)
    expect(streams).toHaveLength(6)
    again()
  })

  it('stops reopening once the last subscriber leaves', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const unsubscribe = game.observable.subscribe(() => {})
    streams[0]!.fail(REFUSED)
    await drain()
    unsubscribe()
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_MAX_MS)
    expect(streams).toHaveLength(1)
  })

  it('drops every subscriber, its reopening, and the stream on close', async () => {
    vi.useFakeTimers()
    const { game, streams } = source()
    const listener = vi.fn()
    game.observable.subscribe(listener)
    streams[0]!.fail(REFUSED)
    await drain()
    game.close()
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_MAX_MS)
    expect(streams).toHaveLength(1)
    game.observable.subscribe(listener)
    expect(streams).toHaveLength(2)
    game.close()
    expect(streams[1]!.disposed).toHaveBeenCalledOnce()
    streams[1]!.push(snapshot(run('r1')))
    await drain()
    expect(listener).toHaveBeenCalledTimes(2)
    game.close()
    expect(streams[1]!.disposed).toHaveBeenCalledOnce()
  })

  it('keeps notifying the other subscribers when one throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { game, streams } = source()
    const healthy = vi.fn()
    game.observable.subscribe(() => { throw new Error('broken subscriber') })
    game.observable.subscribe(healthy)
    streams[0]!.push(snapshot(run('r1')))
    await vi.waitFor(() => { expect(healthy).toHaveBeenCalledOnce() })
    expect(error).toHaveBeenCalledWith('[godot] game source subscriber failed:', expect.any(Error))
    game.close()
  })
})
