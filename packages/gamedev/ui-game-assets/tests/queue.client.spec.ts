/**
 * The window's queue of agent pictures: requests start in the order they came, several at a time within a total file
 * size, a larger file draws alone, and a cancelled request leaves the queue or gives up its place at once.
 */
import { describe, expect, it } from 'vitest'
import { DrawQueue } from '../src/client/queue.ts'

/** A drawing the spec finishes by hand. */
function held() {
  const done = Promise.withResolvers<string>()
  let started = false
  return {
    draw: () => {
      started = true
      return done.promise
    },
    get started() { return started },
    finish: (answer: string) => { done.resolve(answer) },
    fail: (error: Error) => { done.reject(error) },
  }
}

/** Let settled promises run their callbacks. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('DrawQueue', () => {
  it('draws up to its limit at once, in the order the requests came', async () => {
    const queue = new DrawQueue(2, 1000)
    const draws = [held(), held(), held(), held()]
    const answers = draws.map((draw, index) => queue.run(10, new AbortController().signal, draw.draw).then(answer => `${String(index)}:${answer}`))
    expect(draws.map(draw => draw.started)).toEqual([true, true, false, false])
    expect([queue.active, queue.queued]).toEqual([2, 2])
    draws[1]?.finish('b')
    await flush()
    expect(draws.map(draw => draw.started)).toEqual([true, true, true, false])
    draws[0]?.finish('a')
    draws[2]?.finish('c')
    await flush()
    expect(draws[3]?.started).toBe(true)
    draws[3]?.finish('d')
    expect(await Promise.all(answers)).toEqual(['0:a', '1:b', '2:c', '3:d'])
    await flush()
    expect([queue.active, queue.queued]).toEqual([0, 0])
  })

  it('keeps the files drawn at once within its size, and draws a larger file alone', async () => {
    const queue = new DrawQueue(3, 100)
    const small = held()
    const large = held()
    const after = held()
    void queue.run(60, new AbortController().signal, small.draw)
    void queue.run(500, new AbortController().signal, large.draw)
    void queue.run(10, new AbortController().signal, after.draw)
    // The large file waits for the small one, and the requests behind it wait their turn.
    expect([small.started, large.started, after.started]).toEqual([true, false, false])
    small.finish('small')
    await flush()
    expect([large.started, after.started]).toEqual([true, false])
    large.finish('large')
    await flush()
    expect(after.started).toBe(true)
    after.finish('after')
    await flush()
    // Two files whose sizes add up past the limit do not draw together.
    const first = held()
    const second = held()
    void queue.run(60, new AbortController().signal, first.draw)
    void queue.run(50, new AbortController().signal, second.draw)
    expect([first.started, second.started]).toEqual([true, false])
    first.finish('first')
    await flush()
    expect(second.started).toBe(true)
    second.finish('second')
  })

  it('takes a request cancelled while it waits out of the queue without drawing it', async () => {
    const queue = new DrawQueue(1, 1000)
    const running = held()
    const waiting = held()
    const next = held()
    void queue.run(1, new AbortController().signal, running.draw)
    const cancel = new AbortController()
    const cancelled = queue.run(1, cancel.signal, waiting.draw)
    const answer = queue.run(1, new AbortController().signal, next.draw)
    cancel.abort(new Error('the call ended'))
    await expect(cancelled).rejects.toThrow('the call ended')
    expect(queue.queued).toBe(1)
    running.finish('done')
    await flush()
    expect([waiting.started, next.started]).toEqual([false, true])
    next.finish('next')
    expect(await answer).toBe('next')
    // A request whose call has already ended never waits.
    await expect(queue.run(1, AbortSignal.abort(new Error('ended before')), held().draw)).rejects.toThrow('ended before')
  })

  it('starts the requests behind a cancelled file that was too large to draw beside the current ones', async () => {
    const queue = new DrawQueue(3, 100)
    const drawing = held()
    const large = held()
    const small = held()
    void queue.run(60, new AbortController().signal, drawing.draw)
    const cancel = new AbortController()
    const cancelled = queue.run(50, cancel.signal, large.draw)
    void queue.run(10, new AbortController().signal, small.draw)
    expect([drawing.started, large.started, small.started]).toEqual([true, false, false])
    cancel.abort(new Error('the call ended'))
    await expect(cancelled).rejects.toThrow('the call ended')
    expect([large.started, small.started]).toEqual([false, true])
    expect([queue.active, queue.queued]).toEqual([2, 0])
    drawing.finish('drawing')
    small.finish('small')
  })

  it('gives up the place of a request cancelled while it draws, so the next one starts at once', async () => {
    const queue = new DrawQueue(1, 1000)
    const stuck = held()
    const next = held()
    const cancel = new AbortController()
    const cancelled = queue.run(1, cancel.signal, stuck.draw)
    const answer = queue.run(1, new AbortController().signal, next.draw)
    expect(next.started).toBe(false)
    cancel.abort(new Error('the call timed out'))
    await expect(cancelled).rejects.toThrow('the call timed out')
    expect(next.started).toBe(true)
    // The cancelled drawing settling later changes nothing.
    stuck.finish('late')
    next.finish('next')
    expect(await answer).toBe('next')
    await flush()
    expect([queue.active, queue.queued]).toEqual([0, 0])
  })

  it('passes a failed drawing to its caller and goes on with the next request', async () => {
    const queue = new DrawQueue(1, 1000)
    const failing = held()
    const next = held()
    const failed = queue.run(1, new AbortController().signal, failing.draw)
    const answer = queue.run(1, new AbortController().signal, next.draw)
    failing.fail(new Error('the file could not be decoded'))
    await expect(failed).rejects.toThrow('the file could not be decoded')
    await flush()
    next.finish('next')
    expect(await answer).toBe('next')
    // A drawing that throws before it returns a promise fails its caller the same way.
    await expect(queue.run(1, new AbortController().signal, () => { throw new Error('thrown at once') })).rejects.toThrow('thrown at once')
    await flush()
    expect(queue.active).toBe(0)
  })
})
