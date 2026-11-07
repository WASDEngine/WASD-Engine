/** The setup panel follows the server's view while it shows, reopening the stream when it stops. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerSource, FOLLOW_RETRY_INITIAL_MS, type ViewDelivery, type ViewStream } from '../src/client/source.ts'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'

afterEach(() => {
  vi.useRealTimers()
})

function view(overrides: Partial<GameMcpView> = {}): GameMcpView {
  return { state: 'listening', clients: [], ...overrides }
}

/** A stream the spec feeds by hand. */
function fed() {
  const pending: Array<PromiseWithResolvers<IteratorResult<ViewDelivery>>> = []
  const queued: Array<IteratorResult<ViewDelivery> | Error> = []
  let disposed = false
  const pull = (): Promise<IteratorResult<ViewDelivery>> => {
    const next = queued.shift()
    if (next instanceof Error) return Promise.reject(next)
    if (next !== undefined) return Promise.resolve(next)
    const waiting = Promise.withResolvers<IteratorResult<ViewDelivery>>()
    pending.push(waiting)
    return waiting.promise
  }
  const push = (item: IteratorResult<ViewDelivery> | Error): void => {
    const waiting = pending.shift()
    if (waiting === undefined) queued.push(item)
    else if (item instanceof Error) waiting.reject(item)
    else waiting.resolve(item)
  }
  const accept = vi.fn<() => void>()
  const stream: ViewStream = {
    [Symbol.asyncIterator]: () => ({ next: pull }),
    dispose: async () => {
      disposed = true
      push({ done: true, value: undefined })
    },
  }
  return {
    stream,
    accept,
    deliver(value: GameMcpView) { push({ done: false, value: { value, accept } }) },
    end() { push({ done: true, value: undefined }) },
    fail() { push(new Error('refused')) },
    get disposed() { return disposed },
  }
}

describe('createServerSource', () => {
  it('opens the stream for its first subscriber, publishes each view, and closes it after the last one leaves', async () => {
    const stream = fed()
    const open = vi.fn(() => stream.stream)
    const source = createServerSource(open)
    expect(open).not.toHaveBeenCalled()
    const listener = vi.fn<() => void>()
    const leave = source.observable.subscribe(listener)
    expect(open).toHaveBeenCalledOnce()
    expect(source.observable.getSnapshot()).toEqual({ view: null, disconnected: false })
    stream.deliver(view({ url: 'http://127.0.0.1:9273/mcp' }))
    await vi.waitFor(() => { expect(source.observable.getSnapshot().view?.url).toBe('http://127.0.0.1:9273/mcp') })
    expect(stream.accept).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalled()
    leave()
    expect(stream.disposed).toBe(true)
    expect(source.observable.getSnapshot().view?.url).toBe('http://127.0.0.1:9273/mcp')
  })

  it('reopens at once after a stream that delivered, and after a growing delay otherwise', async () => {
    vi.useFakeTimers()
    const streams = [fed(), fed(), fed(), fed()]
    let opened = 0
    const source = createServerSource(() => (streams[opened++] as ReturnType<typeof fed>).stream)
    source.observable.subscribe(() => {})
    streams[0]?.deliver(view())
    await vi.advanceTimersByTimeAsync(0)
    streams[0]?.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(opened).toBe(2)
    streams[1]?.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.observable.getSnapshot()).toMatchObject({ disconnected: true, view: { state: 'listening' } })
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS - 1)
    expect(opened).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened).toBe(3)
    streams[2]?.end()
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS * 2)
    expect(opened).toBe(4)
    streams[3]?.deliver(view())
    await vi.advanceTimersByTimeAsync(0)
    expect(source.observable.getSnapshot().disconnected).toBe(false)
    source.close()
    expect(streams[3]?.disposed).toBe(true)
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_INITIAL_MS * 4)
    expect(opened).toBe(4)
  })
})
