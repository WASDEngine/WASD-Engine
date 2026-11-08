/**
 * One application worker per Session scope. Each scope gets its own
 * `WorkerSupervisor`, so calls of one Session run one at a time while calls
 * of different Sessions run at the same time, and no Session sees another's
 * open files, scene, or variables. Workers start one at a time across
 * scopes, so first-use setup never runs twice at once. A worker that has had
 * no call for `idleTimeoutMs` stops, and when `maxWorkers` workers run, a new
 * scope stops the least recently used worker that has no call running, or
 * fails with `WORKERS_BUSY` when every worker has one. A scope whose worker
 * stopped that way learns on its next call that the state was lost. The
 * workers' folders sit in a folder named after the pool's process id, so two
 * server processes with one data directory, such as an old server that is
 * still shutting down and its replacement, never delete each other's folders.
 *
 * @module
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertDelay, WorkerError, type JsonLineWorker } from './json-line-worker.ts'
import { STATE_LOST, untilTurn, WorkerSupervisor, type WorkerCallOptions } from './supervisor.ts'
import type { JsonObject, JsonValue } from './types.ts'

/** Scope of the calls that name no Session; they share one worker. */
export const SHARED_SCOPE = 'shared'

/** Scopes whose lost-state notice waits for their next call; older ones are forgotten first. */
const MAX_NOTICES = 256

/** Name of a server process's folder in the pool root: a positive process id. */
const PROCESS_FOLDER = /^[1-9]\d{0,9}$/

/** Largest process id that a signal probe accepts. */
const MAX_PROCESS_ID = 0x7fffffff

/** The worker that a pool starts for one scope. */
export interface AppWorkerScope {
  /** `session:<id>` for a Session's calls, or {@link SHARED_SCOPE}. */
  readonly key: string
  /**
   * Absolute directory for this worker's own files, such as its working directory and application settings; it exists
   * before the start and is deleted after the worker stops.
   */
  readonly directory: string
}

/** File-system effects of a {@link WorkerPool}. */
export interface WorkerPoolFiles {
  /** Create a directory and its parents. */
  readonly makeDirectory: (path: string) => Promise<void>
  /** Delete a directory with its contents; a missing directory is not an error. */
  readonly removeDirectory: (path: string) => Promise<void>
  /** Names of a directory's entries; a missing directory has none. */
  readonly listDirectory: (path: string) => Promise<readonly string[]>
}

/** Node's file system for a {@link WorkerPool}. */
export const NODE_POOL_FILES: WorkerPoolFiles = {
  makeDirectory: async (path) => { await mkdir(path, { recursive: true }) },
  removeDirectory: async (path) => { await rm(path, { recursive: true, force: true }) },
  listDirectory: async (path) => {
    try {
      return await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  },
}

/** Whether a signal probe finds no process with this id; a process of another user counts as running. */
function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means that the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** What a {@link WorkerPool} needs. */
export interface WorkerPoolOptions {
  /** Application name in the pool's messages, such as `Blender`. */
  readonly app: string
  /**
   * Absolute directory that holds a folder for each server process, named by its process id, with a numbered
   * folder for each of its workers; the pool owns the folder of its own process and those of exited processes.
   */
  readonly root: string
  /** Start one worker for a scope; the signal aborts when the starting call is cancelled or the pool closes. */
  readonly start: (signal: AbortSignal, scope: AppWorkerScope) => Promise<JsonLineWorker>
  /** The application's setup notes since the previous read; the pool reads them right after each start. */
  readonly takeNotes: () => readonly string[]
  /** Most workers that run at once, at least 1. */
  readonly maxWorkers: number
  /** Milliseconds without a call after which a scope's worker stops. */
  readonly idleTimeoutMs: number
  /** Default budget of one worker request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Milliseconds each step of a worker shutdown waits before escalating. */
  readonly closeGraceMs: number
  /** File-system effects; omission uses Node's. */
  readonly files?: WorkerPoolFiles | undefined
  /** Milliseconds since an arbitrary origin; omission uses `performance.now`. */
  readonly now?: (() => number) | undefined
  /** Id of the process that runs the pool, which names its folder in `root`; omission uses `process.pid`. */
  readonly processId?: number | undefined
  /** Whether no process with this id runs; omission probes the process with signal 0. */
  readonly processExited?: ((pid: number) => boolean) | undefined
}

interface Entry {
  readonly scope: AppWorkerScope
  readonly supervisor: WorkerSupervisor
  /** Setup notes of this scope's worker starts that no tool result reported yet. */
  readonly notes: string[]
  /** Calls running or waiting on this scope's worker. */
  active: number
  lastUsed: number
  idle: ReturnType<typeof setTimeout> | undefined
  /** Whether a worker started for this scope, so that stopping it loses state. */
  started: boolean
}

/** A duration for a message, such as `10 minutes` or `45 seconds`. */
function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 1) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

/** Keeps one worker per Session scope; see the module documentation. */
export class WorkerPool {
  private readonly options: WorkerPoolOptions
  private readonly files: WorkerPoolFiles
  private readonly now: () => number
  private readonly processId: number
  private readonly processExited: (pid: number) => boolean
  /** This process's folder in `root`, which holds the folders of its workers. */
  private readonly folder: string
  private readonly entries = new Map<string, Entry>()
  /** Why a scope's worker stopped, told on the scope's next call. */
  private readonly notices = new Map<string, string>()
  /** Stops of released workers that have not finished yet. */
  private readonly stopping = new Set<Promise<void>>()
  /** Settles when the latest worker start has settled; it never rejects. */
  private starting: Promise<void> = Promise.resolve()
  private serial = 0
  private closed = false

  /**
   * @param options - application, worker folder root, worker start, limits, and budgets.
   * @throws RangeError when `maxWorkers` is not a whole number of at least 1 or a budget is out of range.
   */
  constructor(options: WorkerPoolOptions) {
    if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1) {
      throw new RangeError(`maxWorkers must be a whole number of at least 1, got ${String(options.maxWorkers)}`)
    }
    assertDelay('idleTimeoutMs', options.idleTimeoutMs)
    assertDelay('requestTimeoutMs', options.requestTimeoutMs)
    assertDelay('closeGraceMs', options.closeGraceMs, true)
    this.options = options
    this.files = options.files ?? NODE_POOL_FILES
    this.now = options.now ?? (() => performance.now())
    this.processId = options.processId ?? process.pid
    this.processExited = options.processExited ?? processExited
    this.folder = join(options.root, String(this.processId))
  }

  /**
   * Delete the folders in `root` of server processes that have exited, and a folder of this process's id, which a
   * former process with the same id left behind. Call it once, before the first call.
   */
  async prepare(): Promise<void> {
    const names = await this.files.listDirectory(this.options.root)
    await Promise.all(names.filter(name => this.leftBehind(name)).map(async (name) => {
      await this.files.removeDirectory(join(this.options.root, name))
    }))
  }

  /**
   * Run one worker method on a scope's worker, starting one when the scope has none.
   * @param scope - `session:<id>` or {@link SHARED_SCOPE}.
   * @param method - worker method name.
   * @param params - method parameters.
   * @param options - answer budget and cancellation.
   * @returns the worker's result.
   * @throws WorkerError `WORKER_EXITED` once after the scope's worker stopped without a running call;
   *   `WORKERS_BUSY` when `maxWorkers` workers each run a call; the errors of {@link WorkerSupervisor.call}.
   */
  async call(scope: string, method: string, params: JsonObject, options: WorkerCallOptions = {}): Promise<JsonValue> {
    if (this.closed) throw new WorkerError('WORKER_EXITED', `The ${this.options.app} server is shutting down.`)
    const notice = this.notices.get(scope)
    if (notice !== undefined) {
      this.notices.delete(scope)
      throw new WorkerError('WORKER_EXITED', notice)
    }
    const entry = this.entryFor(scope)
    entry.active += 1
    if (entry.idle !== undefined) {
      clearTimeout(entry.idle)
      entry.idle = undefined
    }
    try {
      return await entry.supervisor.call(method, params, options)
    } finally {
      entry.active -= 1
      entry.lastUsed = this.now()
      if (entry.active === 0 && this.entries.get(scope) === entry) this.armIdle(entry)
    }
  }

  /**
   * Hand over a scope's setup notes, such as the version of a worker that started.
   * @param scope - the scope.
   * @returns the notes not yet reported, oldest first; each note is handed over once.
   */
  takeNotes(scope: string): readonly string[] {
    const entry = this.entries.get(scope)
    return entry === undefined ? [] : entry.notes.splice(0)
  }

  /** Stop every worker, wait for them, and delete this process's folder. */
  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) if (entry.idle !== undefined) clearTimeout(entry.idle)
    await Promise.all([...entries.map(async (entry) => { await entry.supervisor.close() }), ...this.stopping])
    await this.files.removeDirectory(this.folder)
  }

  private leftBehind(name: string): boolean {
    if (!PROCESS_FOLDER.test(name)) return false
    const pid = Number(name)
    return pid === this.processId || (pid <= MAX_PROCESS_ID && this.processExited(pid))
  }

  private entryFor(key: string): Entry {
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    if (this.entries.size >= this.options.maxWorkers) {
      let oldest: Entry | undefined
      for (const entry of this.entries.values()) {
        if (entry.active === 0 && (oldest === undefined || entry.lastUsed < oldest.lastUsed)) oldest = entry
      }
      if (oldest === undefined) {
        throw new WorkerError('WORKERS_BUSY', `All ${String(this.options.maxWorkers)} ${this.options.app} workers are running calls `
          + 'for other conversations. Call the tool again once one of them has finished.')
      }
      this.release(oldest, `The ${this.options.app} worker of this conversation was stopped to make room for another conversation; ${STATE_LOST}.`)
    }
    this.serial += 1
    const scope: AppWorkerScope = { key, directory: join(this.folder, String(this.serial)) }
    const notes: string[] = []
    const entry: Entry = {
      scope,
      notes,
      supervisor: new WorkerSupervisor(async (signal) => {
        const worker = await this.startScoped(scope, notes, signal)
        entry.started = true
        return worker
      }, { requestTimeoutMs: this.options.requestTimeoutMs, closeGraceMs: this.options.closeGraceMs }),
      active: 0,
      lastUsed: this.now(),
      idle: undefined,
      started: false,
    }
    this.entries.set(key, entry)
    return entry
  }

  private async startScoped(scope: AppWorkerScope, notes: string[], signal: AbortSignal): Promise<JsonLineWorker> {
    const previous = this.starting
    let finished = (): void => {}
    this.starting = new Promise<void>((resolve) => { finished = resolve })
    try {
      await untilTurn(previous, signal)
      await this.files.makeDirectory(scope.directory)
      return await this.options.start(signal, scope)
    } finally {
      // Starts run one at a time, so the notes gathered now belong to this scope's start.
      notes.push(...this.options.takeNotes())
      finished()
    }
  }

  private armIdle(entry: Entry): void {
    entry.idle = setTimeout(() => {
      entry.idle = undefined
      if (entry.active === 0 && this.entries.get(entry.scope.key) === entry) {
        this.release(entry, `The ${this.options.app} worker of this conversation stopped after ${describeDuration(this.options.idleTimeoutMs)} `
          + `without calls; ${STATE_LOST}.`)
      }
    }, this.options.idleTimeoutMs)
    entry.idle.unref()
  }

  private release(entry: Entry, notice: string): void {
    this.entries.delete(entry.scope.key)
    if (entry.idle !== undefined) clearTimeout(entry.idle)
    if (entry.started) {
      this.notices.delete(entry.scope.key)
      this.notices.set(entry.scope.key, notice)
      while (this.notices.size > MAX_NOTICES) this.notices.delete(this.notices.keys().next().value as string)
    }
    const stop = (async () => {
      await entry.supervisor.close()
      await this.files.removeDirectory(entry.scope.directory)
    })().catch((error: unknown) => {
      // The worker has stopped; a folder that could not be deleted goes when the next server process prepares the pool.
      void error
    })
    this.stopping.add(stop)
    void stop.finally(() => { this.stopping.delete(stop) })
  }
}
