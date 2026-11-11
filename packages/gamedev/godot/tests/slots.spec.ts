/** Slots of the Godot processes that run without a game: a limit on running tasks, waiting in order, and cancellation. */
import { describe, expect, it } from 'vitest'
import { ProcessSlots } from '../src/slots.ts'

/** A task that runs until its `finish` is called. */
function held(log: string[], name: string): { readonly task: () => Promise<string>; readonly finish: () => void } {
  const done = Promise.withResolvers<undefined>()
  return {
    task: async () => {
      log.push(`+${name}`)
      await done.promise
      log.push(`-${name}`)
      return name
    },
    finish: () => { done.resolve(undefined) },
  }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('ProcessSlots', () => {
  it('runs at most limit tasks at once and starts waiting tasks in arrival order', async () => {
    const slots = new ProcessSlots(2)
    const log: string[] = []
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => held(log, name))
    const signal = new AbortController().signal
    const results = [a, b, c, d].map(task => slots.run(signal, task!.task))
    await tick()
    expect(log).toEqual(['+a', '+b'])
    b!.finish()
    await tick()
    expect(log).toEqual(['+a', '+b', '-b', '+c'])
    a!.finish()
    await tick()
    expect(log).toEqual(['+a', '+b', '-b', '+c', '-a', '+d'])
    c!.finish()
    d!.finish()
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('frees the slot of a task that failed', async () => {
    const slots = new ProcessSlots(1)
    const signal = new AbortController().signal
    await expect(slots.run(signal, () => Promise.reject(new Error('crashed')))).rejects.toThrow('crashed')
    await expect(slots.run(signal, () => Promise.resolve('next'))).resolves.toBe('next')
  })

  it('stops waiting when the signal aborts, and runs nothing for an aborted signal', async () => {
    const slots = new ProcessSlots(1)
    const log: string[] = []
    const first = held(log, 'first')
    const running = slots.run(new AbortController().signal, first.task)
    const cancel = new AbortController()
    const waiting = slots.run(cancel.signal, held(log, 'cancelled').task)
    cancel.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    await expect(slots.run(cancel.signal, held(log, 'late').task)).rejects.toThrow('cancelled')
    const next = held(log, 'next')
    const queued = slots.run(new AbortController().signal, next.task)
    first.finish()
    await running
    next.finish()
    await queued
    expect(log).toEqual(['+first', '-first', '+next', '-next'])
  })

  it('refuses waiting and later tasks once closed and lets running ones finish', async () => {
    const slots = new ProcessSlots(1)
    const log: string[] = []
    const signal = new AbortController().signal
    const first = held(log, 'first')
    const running = slots.run(signal, first.task)
    const waiting = slots.run(signal, held(log, 'waiting').task)
    slots.close(new Error('closed'))
    await expect(waiting).rejects.toThrow('closed')
    await expect(slots.run(signal, held(log, 'later').task)).rejects.toThrow('closed')
    first.finish()
    await expect(running).resolves.toBe('first')
    expect(log).toEqual(['+first', '-first'])
  })

  it('refuses a limit below one task', () => {
    expect(() => new ProcessSlots(0)).toThrow(RangeError)
    expect(() => new ProcessSlots(1.5)).toThrow(RangeError)
  })
})
