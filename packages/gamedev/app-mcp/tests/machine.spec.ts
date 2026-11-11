/** Sizing a kind of process against the computer, the memory check before a start, and its message. */
import { availableParallelism, totalmem } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { lowMemoryMessage, memoryShortage, nodeMachine, processLimit } from '../src/machine.ts'

const GIB = 1024 ** 3

describe('processLimit', () => {
  const sized = { max: 4, memoryBytes: 8 * GIB, cores: 4 }

  it.each([
    [1, '8 GiB with 8 processors', 8 * GIB, 8],
    [2, 'a 16 GB computer that reports 15.8 GiB, with 8 processors', 15.8 * GIB, 8],
    [2, '18 GiB with 12 processors', 18 * GIB, 12],
    [2, '24 GiB with 10 processors', 24 * GIB, 10],
    [3, '36 GiB with 14 processors', 36 * GIB, 14],
    [4, '64 GiB with 16 processors', 64 * GIB, 16],
    [4, '128 GiB with 32 processors', 128 * GIB, 32],
    [1, '4 GiB with 2 processors', 4 * GIB, 2],
  ])('allows %i at once on %s', (limit, _case, totalMemoryBytes, cores) => {
    expect(processLimit(sized, { totalMemoryBytes, cores })).toBe(limit)
  })

  it('leaves memory or processors out when their share is 0', () => {
    expect(processLimit({ max: 4, memoryBytes: 0, cores: 4 }, { totalMemoryBytes: GIB, cores: 12 })).toBe(3)
    expect(processLimit({ max: 4, memoryBytes: 2 * GIB, cores: 0 }, { totalMemoryBytes: 6 * GIB, cores: 1 })).toBe(3)
    expect(processLimit({ max: 3, memoryBytes: 0, cores: 0 }, { totalMemoryBytes: GIB, cores: 1 })).toBe(3)
  })
})

describe('memoryShortage', () => {
  it('reports the memory available and needed while less is available than needed', () => {
    expect(memoryShortage(GIB, () => GIB - 1)).toEqual({ availableBytes: GIB - 1, requiredBytes: GIB })
    expect(memoryShortage(GIB, () => GIB)).toBeUndefined()
  })

  it('reads nothing when a start needs no memory available', () => {
    const available = vi.fn(() => 0)
    expect(memoryShortage(0, available)).toBeUndefined()
    expect(available).not.toHaveBeenCalled()
  })
})

describe('lowMemoryMessage', () => {
  it('names what did not start, the memory available and needed, and what to do', () => {
    expect(lowMemoryMessage('the game', { availableBytes: 700 * 1024 ** 2, requiredBytes: 1.5 * GIB })).toBe(
      'The computer has 700.0 MiB of memory available, less than the 1.5 GiB that starting the game needs, so it did not start. '
      + 'Stop games you no longer need, wait for other work to finish, or ask the user to close programs they are not using, then try again.',
    )
  })
})

describe('nodeMachine', () => {
  it('reads this computer\'s memory and processors and the memory available now', () => {
    const machine = nodeMachine()
    expect(machine).toMatchObject({ totalMemoryBytes: totalmem(), cores: availableParallelism() })
    const available = machine.availableMemoryBytes()
    expect(available).toBeGreaterThan(0)
    expect(available).toBeLessThanOrEqual(totalmem())
  })
})
