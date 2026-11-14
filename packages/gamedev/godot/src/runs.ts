/**
 * Per-Session Godot state: at most one run per live Agent, the Session's log and error-digest cursors, and the
 * coordinate frame of its latest screenshot; and the watchers of the follow streams of each Session id, which need
 * no live Agent. Starts and stops of one Session are serialized, and the admission of starts across Sessions too; a
 * start that finds every run slot taken first stops the game that an agent started and that has gone unused longest,
 * when it has gone unused long enough. Disposal of the Agent or of the registry stops the Session's run.
 * @module @deepseek-ai/dsh-godot/src/runs
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lowMemoryMessage, type MemoryShortage } from '@deepseek-ai/dsh-app-mcp'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GodotRun } from './run.ts'

/** What a follow stream is woken for. */
export type SessionChange = 'run' | 'logs' | 'end'

/** Receives change notifications of one Session id. */
export interface SessionWatcher {
  /**
   * Record a change.
   * @param change - `run` for a new run, a changed view, or the end of the Session's Agent, after which the Session
   * has no run; `logs` for new entries of the current run; `end` once the registry was disposed.
   */
  notify(change: SessionChange): void
}

/** The screenshot frame that input coordinates in screenshot pixels refer to. */
export interface ScreenshotFrame {
  /** Run the screenshot belongs to. */
  readonly runId: string
  /** Image width as the model sees it. */
  readonly width: number
  /** Image height as the model sees it. */
  readonly height: number
  /** Game window width when the screenshot was taken. */
  readonly windowWidth: number
  /** Game window height when the screenshot was taken. */
  readonly windowHeight: number
  /** Window pixels from the window's left edge to the part of the window the image shows; 0 when absent. */
  readonly x?: number
  /** Window pixels from the window's top edge to the part of the window the image shows; 0 when absent. */
  readonly y?: number
  /** Width in window pixels of the part of the window the image shows; the window width when absent. */
  readonly regionWidth?: number
  /** Height in window pixels of the part of the window the image shows; the window height when absent. */
  readonly regionHeight?: number
}

/** The live Agent is not an active Session owner. */
export class GodotSessionError extends Error {
  override name = 'GodotSessionError'
}

/** Starting a run would exceed the number of games that may run at once. */
export class TooManyRunsError extends Error {
  override name = 'TooManyRunsError'

  /**
   * @param limit - most games that run at once on this computer.
   * @param idleStopMs - how long a game that an agent started must go unused before a start stops it; 0 when starts
   *   stop none.
   */
  constructor(readonly limit: number, idleStopMs = 0) {
    super(`${limit} Godot ${limit === 1 ? 'game already runs' : 'games already run'}, as many as this computer runs at once; `
      + `stop one before starting another.${idleStopMs > 0 ? ` A game that an agent started makes room once it has gone unused for ${describeMinutes(idleStopMs)}.` : ''}`)
  }
}

/** A duration in whole minutes, or in seconds below a minute, as messages give it. */
function describeMinutes(ms: number): string {
  const [count, unit] = ms < 60_000 ? [Math.max(1, Math.round(ms / 1000)), 'second'] : [Math.round(ms / 60_000), 'minute']
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`
}

/** The computer has too little memory available to start a Godot process. */
export class LowMemoryError extends Error {
  override name = 'LowMemoryError'

  /**
   * @param what - what did not start, such as `the game`.
   * @param shortage - the memory available and needed.
   */
  constructor(what: string, readonly shortage: MemoryShortage) {
    super(lowMemoryMessage(what, shortage))
  }
}

/** Godot state of one live Agent. */
export class GodotSession {
  /** Current or most recent run. */
  run: GodotRun | undefined
  /** Cursor of the Session's last log read. */
  logCursor = 0
  /** Sequence number through which error-level entries were reported to the Session. */
  digestCursor = 0
  /** Frame of the latest screenshot, for input coordinates in screenshot pixels. */
  screenshot: ScreenshotFrame | undefined
  /** Whether the Session closed. */
  closed = false
  private unsubscribe: (() => void) | undefined
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param agent - live owner.
   * @param changed - receives the run and log changes of the current run.
   */
  constructor(readonly agent: Agent, private readonly changed: (change: 'run' | 'logs') => void) {}

  /**
   * Run an operation after earlier starts and stops of this Session settle.
   * @param operation - start or stop.
   * @returns the operation's result.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation)
    this.queue = task.catch(() => {
      // The caller receives the failure; the queue only orders operations.
    })
    return task
  }

  /**
   * Make a run the Session's current run.
   * @param run - new run.
   */
  attach(run: GodotRun): void {
    this.unsubscribe?.()
    this.run = run
    this.screenshot = undefined
    this.unsubscribe = run.subscribe((event) => { this.changed(event.type === 'logs' ? 'logs' : 'run') })
    this.changed('run')
  }

  /** Stop observing the run. */
  detach(): void {
    this.unsubscribe?.()
  }
}

/** Registry of the Godot state of every live Agent, and of the follow-stream watchers of every Session id. */
export class GodotSessions {
  private readonly byAgent = new Map<Agent, GodotSession>()
  private readonly releases = new Map<GodotSession, () => Promise<void>>()
  /** Runs whose process may still live, also those of Sessions that closed while their game stops. */
  private readonly live = new Set<GodotRun>()
  /** Watchers per Session id; a Session id keeps its watchers while its Agent comes and goes. */
  private readonly watchers = new Map<SessionId, Set<SessionWatcher>>()
  /** The admission of the latest start; starts across Sessions are admitted one at a time. */
  private admission: Promise<unknown> = Promise.resolve()
  private disposing: Promise<void> | undefined

  /**
   * @param ctx - context whose Agent registry decides liveness.
   * @param maxRuns - most runs whose game may live at once across Sessions; a run counts until it ended.
   * @param admit - called before each start that `maxRuns` allows, after the Session's previous run ended; it throws
   *   to refuse the start, such as with a {@link LowMemoryError}.
   * @param idleStopMs - how long a game that an agent started must have gone unused, shown in no view and serving no
   *   request, before a start that finds every run slot taken stops it; 0 makes such a start fail instead.
   */
  constructor(
    private readonly ctx: Context,
    private readonly maxRuns: number,
    private readonly admit: () => void,
    private readonly idleStopMs = 0,
  ) {}

  /**
   * The Godot state of a live Agent, created on first use.
   * @param agent - exact live Agent.
   * @returns the Session state.
   * @throws {GodotSessionError} when the Agent is not live or the registry is disposed.
   */
  session(agent: Agent): GodotSession {
    if (this.disposing !== undefined || this.ctx.agents.get(agent.id) !== agent) {
      throw new GodotSessionError('This Session is not active; reopen it and try again.')
    }
    const existing = this.byAgent.get(agent)
    if (existing !== undefined) return existing
    const session = new GodotSession(agent, (change) => {
      // A closed Session's run no longer describes the Session, whose watchers already learned that it has none.
      if (this.byAgent.get(agent) === session) this.notify(agent.id, change)
    })
    this.byAgent.set(agent, session)
    this.releases.set(session, agent.ctx.effect(() => () => this.close(session), 'godot.session'))
    return session
  }

  /**
   * The Godot state of a Session, without creating it or resuming the Session.
   * @param id - Session id.
   * @returns the state of its live Agent, or undefined while it has no live Agent or that Agent has none.
   */
  find(id: SessionId): GodotSession | undefined {
    const agent = this.ctx.agents.get(id)
    return agent === undefined ? undefined : this.byAgent.get(agent)
  }

  /**
   * Observe the run and log changes of a Session id, whether or not the Session has a live Agent.
   * @param id - Session id.
   * @param watcher - change receiver; once the registry is disposed, it receives `end`, at once when it comes later.
   * @returns the unsubscriber.
   */
  watch(id: SessionId, watcher: SessionWatcher): () => void {
    if (this.disposing !== undefined) {
      watcher.notify('end')
      return () => {}
    }
    let followers = this.watchers.get(id)
    if (followers === undefined) {
      followers = new Set()
      this.watchers.set(id, followers)
    }
    followers.add(watcher)
    return () => {
      // The last unsubscriber removes the id; a repeated call finds nothing to delete.
      if (!followers.delete(watcher) || followers.size > 0) return
      this.watchers.delete(id)
    }
  }

  /**
   * Replace the Session's run: stop the current one, then create the next. When the games of other Sessions use every
   * run slot, the start first stops the game that an agent started, that no view shows and no request uses, and that
   * has gone unused longest, once it has gone unused for `idleStopMs`; that game's view then says why it stopped.
   * @param session - Session state.
   * @param create - launches the new run; called only when the limit allows it.
   * @returns the new run, launched but not necessarily started.
   * @throws {TooManyRunsError} when the games of other Sessions, also of closed Sessions whose game still stops,
   * use every run slot and none of them may be stopped; the error of `admit`.
   */
  replace(session: GodotSession, create: () => GodotRun): Promise<GodotRun> {
    return session.serialize(async () => {
      await session.run?.stop()
      if (session.closed) throw new GodotSessionError('This Session closed; reopen it and try again.')
      return await this.admitted(async () => {
        if (this.live.size >= this.maxRuns) await this.makeRoom()
        this.admit()
        const run = create()
        this.live.add(run)
        void run.whenEnded().then(() => { this.live.delete(run) })
        session.attach(run)
        return run
      })
    })
  }

  /** Run a start's admission after the admissions of earlier starts settled, so two starts never take one free slot. */
  private admitted<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.admission.then(operation)
    this.admission = task.catch(() => {
      // The caller receives the failure; the chain only orders admissions.
    })
    return task
  }

  /**
   * Stop the game that an agent started and that has gone unused longest, when it has gone unused for `idleStopMs`.
   * @throws {TooManyRunsError} when no game may be stopped.
   */
  private async makeRoom(): Promise<void> {
    const now = Date.now()
    let idlest: GodotRun | undefined
    let since = Number.POSITIVE_INFINITY
    for (const run of this.live) {
      const idle = run.idleSince()
      if (idle === undefined || run.view().startedBy !== 'agent' || now - idle < this.idleStopMs || idle >= since) continue
      idlest = run
      since = idle
    }
    if (this.idleStopMs === 0 || idlest === undefined) throw new TooManyRunsError(this.maxRuns, this.idleStopMs)
    const games = this.maxRuns === 1 ? 'game' : 'games'
    await idlest.stopWith(`WASD Engine stopped this game to start another Session's game: this computer runs at most ${String(this.maxRuns)} ${games} `
      + `at once, and this one had gone unused for ${describeMinutes(now - since)}. Call godot_run to start it again.`)
    this.live.delete(idlest)
  }

  /**
   * Stop the Session's run.
   * @param session - Session state.
   * @returns after the run ended; a Session without a run resolves at once.
   */
  stop(session: GodotSession): Promise<void> {
    return session.serialize(async () => { await session.run?.stop() })
  }

  /**
   * Stop every run, release every Agent registration, then end every watcher.
   * @returns after all runs ended.
   */
  dispose(): Promise<void> {
    this.disposing ??= Promise.all([...this.releases.values()].map(release => release())).then(() => {
      for (const followers of [...this.watchers.values()]) for (const watcher of [...followers]) watcher.notify('end')
      this.watchers.clear()
    })
    return this.disposing
  }

  private notify(id: SessionId, change: SessionChange): void {
    for (const watcher of [...this.watchers.get(id) ?? []]) watcher.notify(change)
  }

  private async close(session: GodotSession): Promise<void> {
    session.closed = true
    this.byAgent.delete(session.agent)
    this.releases.delete(session)
    // From here on the Session has no run until a live Agent starts one.
    this.notify(session.agent.id, 'run')
    await session.serialize(async () => { await session.run?.stop() })
    session.detach()
  }
}
