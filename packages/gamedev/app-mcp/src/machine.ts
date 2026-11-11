/**
 * How many game-tool processes a computer runs at once, and whether it has the memory to start one more. A kind of
 * process, such as Blender workers or Godot games, gets a limit from the computer's physical memory and logical
 * processors. Before a start, the memory that the operating system reports available decides whether the start
 * goes ahead; that figure covers the whole computer, so it counts every other program and every other game-tool
 * process, whichever plugin, Session, or connected agent started it.
 *
 * @module
 */

import { availableParallelism, totalmem } from 'node:os'
import { formatBytes } from './tools.ts'

/** The resources of the computer that runs the processes. */
export interface MachineResources {
  /** Bytes of physical memory. */
  readonly totalMemoryBytes: number
  /** Logical processors that this process may use. */
  readonly cores: number
  /**
   * Read the memory available now: free memory plus memory that the operating system can reclaim at once, such as
   * inactive and purgeable pages on macOS, `MemAvailable` (within a cgroup limit) on Linux, and available physical
   * memory on Windows.
   * @returns the bytes.
   */
  readonly availableMemoryBytes: () => number
}

/**
 * The resources of this computer.
 * @returns `os.totalmem()`, `os.availableParallelism()`, and `process.availableMemory()` as the reader.
 */
export function nodeMachine(): MachineResources {
  return { totalMemoryBytes: totalmem(), cores: availableParallelism(), availableMemoryBytes: () => process.availableMemory() }
}

/** How one kind of process is sized against the computer. */
export interface ProcessLimitOptions {
  /** Most processes of the kind on any computer, at least 1. */
  readonly max: number
  /** Bytes of the computer's physical memory for each process; 0 leaves memory out of the limit. */
  readonly memoryBytes: number
  /** Logical processors for each process; 0 leaves processors out of the limit. */
  readonly cores: number
}

/**
 * The most processes of one kind that run at once on a computer: the smallest of `max`, the computer's memory
 * divided by `memoryBytes` and rounded to the nearest whole number, and its logical processors divided by `cores`
 * and rounded down; at least 1. Rounding the memory quotient keeps a computer sold with 16 GB, whose operating
 * system reports a little less, at the limit of 16 GiB.
 * @param options - the most processes and the memory and processors for each.
 * @param machine - the computer's memory and processors.
 * @returns the limit.
 */
export function processLimit(options: ProcessLimitOptions, machine: Pick<MachineResources, 'totalMemoryBytes' | 'cores'>): number {
  const byMemory = options.memoryBytes === 0 ? Infinity : Math.round(machine.totalMemoryBytes / options.memoryBytes)
  const byCores = options.cores === 0 ? Infinity : Math.floor(machine.cores / options.cores)
  return Math.max(1, Math.min(options.max, byMemory, byCores))
}

/** The memory a start found short. */
export interface MemoryShortage {
  /** Bytes available when the start was refused. */
  readonly availableBytes: number
  /** Bytes that a start needs available. */
  readonly requiredBytes: number
}

/**
 * Compare the memory available with what a start needs.
 * @param requiredBytes - bytes that must be available; 0 needs none and reads nothing.
 * @param available - reads the bytes available now.
 * @returns the shortage, or undefined when at least `requiredBytes` are available.
 */
export function memoryShortage(requiredBytes: number, available: () => number): MemoryShortage | undefined {
  if (requiredBytes === 0) return undefined
  const availableBytes = available()
  return availableBytes >= requiredBytes ? undefined : { availableBytes, requiredBytes }
}

/**
 * Model-facing text for a start that too little available memory refused.
 * @param what - what did not start, such as `a Blender worker`.
 * @param shortage - the memory available and needed.
 * @returns the message.
 */
export function lowMemoryMessage(what: string, shortage: MemoryShortage): string {
  return `The computer has ${formatBytes(shortage.availableBytes)} of memory available, less than the ${formatBytes(shortage.requiredBytes)} `
    + `that starting ${what} needs, so it did not start. Stop games you no longer need, wait for other work to finish, `
    + 'or ask the user to close programs they are not using, then try again.'
}
