/**
 * The project walks that the pictures drawn for one Session share. A caller takes a ticket when its request arrives
 * and uses only a walk that started after it, so a scene or resource an agent wrote just before its call is in the
 * walk. A caller that finds a walk running that started before its ticket waits for the next walk, which starts when
 * the running one ends and serves every caller that waited for it; callers whose tickets come before a walk started
 * share it while it runs and after it ends, until it is no longer fresh.
 */
import { freshScanMs } from './project-tab.ts'

/** One walk of a Session's project. */
interface Walk<T> {
  /** The ticket the walk took when it started; it serves the callers whose tickets are smaller. */
  readonly ticket: number
  /** The walk's result; undefined when it failed or was stopped. */
  readonly result: Promise<T | undefined>
  /** When it settled, in milliseconds of the clock, and so when it stops being fresh. */
  expiresAt?: number
}

/** The walks of one Session: the latest that started, and the one that waits for it to end. */
interface SessionWalks<T> {
  latest?: Walk<T>
  next?: Promise<T | undefined> | undefined
}

/** The project walks of every Session drawn for, shared by the pictures drawn together. */
export class ProjectWalks<T> {
  private readonly sessions = new Map<string, SessionWalks<T>>()
  private tickets = 0

  /**
   * @param walk - walks one Session's project; it settles with undefined, and does not reject, when the walk fails.
   * @param now - the clock, in milliseconds.
   * @param signal - ends every walk, as when the plugin unloads.
   */
  constructor(
    private readonly walk: (sessionId: string, signal: AbortSignal) => Promise<T | undefined>,
    private readonly now: () => number,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * Take the ticket of a request that arrives now.
   * @returns a number larger than the ticket of every walk started so far.
   */
  ticket(): number {
    this.tickets += 1
    return this.tickets
  }

  /**
   * The result of a walk of a Session's project that started after a ticket was taken.
   * @param sessionId - the Session.
   * @param ticket - the caller's ticket, from {@link ticket}.
   * @param signal - the caller's cancellation; the caller stops waiting, and the walk goes on for the others.
   * @returns the walk's result, or undefined when it failed.
   * @throws the caller's abort reason when the caller stops waiting.
   */
  async get(sessionId: string, ticket: number, signal: AbortSignal): Promise<T | undefined> {
    signal.throwIfAborted()
    const now = this.now()
    for (const [id, walks] of this.sessions) {
      if (walks.next === undefined && walks.latest?.expiresAt !== undefined && now >= walks.latest.expiresAt) this.sessions.delete(id)
    }
    let walks = this.sessions.get(sessionId)
    if (walks === undefined) {
      walks = {}
      this.sessions.set(sessionId, walks)
    }
    let result: Promise<T | undefined>
    if (walks.latest !== undefined && walks.latest.ticket > ticket) result = walks.latest.result
    else if (walks.next !== undefined) result = walks.next
    else if (walks.latest !== undefined && walks.latest.expiresAt === undefined) result = this.after(sessionId, walks, walks.latest)
    else result = this.start(sessionId, walks).result
    const waiting = Promise.withResolvers<T | undefined>()
    const stop = (): void => { waiting.reject(signal.reason) }
    signal.addEventListener('abort', stop, { once: true })
    void result.then(waiting.resolve).finally(() => { signal.removeEventListener('abort', stop) })
    return await waiting.promise
  }

  /** Start a walk now, as the Session's latest. */
  private start(sessionId: string, walks: SessionWalks<T>): Walk<T> {
    const startedAt = this.now()
    const walk: Walk<T> = {
      ticket: this.ticket(),
      result: this.walk(sessionId, this.signal).finally(() => {
        walk.expiresAt = this.now() + freshScanMs(this.now() - startedAt)
      }),
    }
    walks.latest = walk
    return walk
  }

  /** The walk that starts when the running one ends, shared by every caller that waits for it. */
  private after(sessionId: string, walks: SessionWalks<T>, running: Walk<T>): Promise<T | undefined> {
    const next = running.result.then(() => {
      walks.next = undefined
      return this.signal.aborted ? undefined : this.start(sessionId, walks).result
    })
    walks.next = next
    return next
  }
}
