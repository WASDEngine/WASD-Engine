/**
 * The tool usage report: how often agents call each MCP tool, counted between two reports to the WASD Engine site. A
 * Session's own calls count when WASD Engine's MCP server offers the tool, under the plugin connected agents know it
 * by; calls of the tools of every MCP server the user added count together under {@link ADDED_SERVERS}, so a report
 * never names such a server or its tools; every other harness tool, such as reading a file, is no MCP tool and counts
 * nothing. Connected agents' calls count under the plugin that offers them. Counts belong to the sign-in they were
 * gathered under and go to the site only for that sign-in: when the app is signed in to another one by the time of a
 * report, they are dropped. A report holds names and counts only, never arguments or results.
 * @module @deepseek-ai/dsh-agent-feedback/src/usage
 */
import type { GameMcpToolOwner } from '@deepseek-ai/dsh-game-mcp'
import type { UsageOutcome } from './api.ts'
import type { ToolUsageCount, ToolUsageKey } from './types.ts'

/** Most counts one report holds: the most entries the site takes in one report. */
export const MAX_REPORT_ENTRIES = 500

/** The most calls one count holds: the most the site takes for one entry. */
export const MAX_COUNT = 1_000_000

/** The server and tool of a call, without its agent. */
export type ToolCallee = Omit<ToolUsageKey, 'agent'>

/** Public tool names the MCP client gives a server's tools: `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+$/u

/** The one key under which the calls of every MCP server the user added count, without its name or its tools' names. */
export const ADDED_SERVERS: ToolCallee = { custom: true, server: 'added-mcp-servers', serverTitle: 'MCP servers the user added', tool: 'all-tools' }

/**
 * What a Session's tool call is a call of.
 * @param name - the harness tool name the Session called.
 * @param owner - finds the provider of WASD Engine's MCP server that offers a tool, when that server runs.
 * @returns the plugin and tool for a tool WASD Engine's MCP server offers, {@link ADDED_SERVERS} for a tool of an MCP
 * server the user added, else undefined.
 */
export function sessionCallee(name: string, owner: ((name: string) => GameMcpToolOwner | undefined) | undefined): ToolCallee | undefined {
  const owned = owner?.(name)
  if (owned !== undefined) return { custom: false, server: owned.provider, serverTitle: owned.title, tool: owned.tool }
  return MCP_TOOL_NAME.test(name) ? ADDED_SERVERS : undefined
}

function keyOf(key: ToolUsageKey): string {
  return JSON.stringify([key.agent.connected, key.agent.id, key.custom, key.server, key.tool])
}

/** Callbacks of the report. */
export interface ToolUsageReportOptions {
  /**
   * The sign-in the app is signed in to now.
   * @returns a fingerprint of its account token, or undefined while signed out or when the sign-in cannot be read.
   */
  signIn(): Promise<string | undefined>
  /**
   * Send counts to the site for one sign-in.
   * @param signIn - the sign-in the counts were gathered under.
   * @param counts - at most {@link MAX_REPORT_ENTRIES} counts.
   * @param signal - cancellation.
   * @returns what became of them; `dropped` when the app is signed in to another sign-in by then.
   */
  send(signIn: string, counts: readonly ToolUsageCount[], signal: AbortSignal): Promise<UsageOutcome>
  /** Called once each time calls of a new tool are left uncounted because the report already holds its most counts. */
  overflow(): void
}

/** The sign-in of counts gathered before the report first read one. */
const UNREAD = Symbol('unread sign-in')

/** The counts since the last report that the site took, the sign-in they belong to, and the sending of the next one. */
export class ToolUsageReport {
  private counts = new Map<string, { key: ToolUsageKey; calls: number; errors: number }>()
  /** The last report asked for; each waits for the one before it. */
  private queue: Promise<void> = Promise.resolve()
  private full = false
  /**
   * The sign-in the counts were gathered under: {@link UNREAD} until {@link ToolUsageReport.begin} first reads it, then
   * its fingerprint, or undefined for counts gathered while signed out.
   */
  private signedIn: string | undefined | typeof UNREAD = UNREAD

  constructor(private readonly options: ToolUsageReportOptions) {}

  /**
   * Read the sign-in that the calls counted from now on belong to, such as when the account sign-in service starts.
   * The first read takes the calls counted before it; a later read that finds another sign-in drops the counts
   * gathered under the earlier one. Reports wait for the read.
   * @returns once it is read; it never rejects.
   */
  begin(): Promise<void> {
    const next = this.queue.then(async () => {
      const now = await this.readSignIn()
      if (this.signedIn === UNREAD) this.signedIn = now
      else if (now !== this.signedIn) this.forget(now)
    })
    this.queue = next
    return next
  }

  /**
   * Drop the counts, which belong to another sign-in than the one counted from now on.
   * @param signIn - the sign-in counted from now on.
   */
  private forget(signIn: string | undefined): void {
    this.counts = new Map()
    this.full = false
    this.signedIn = signIn
  }

  /** The sign-in now, or undefined when it cannot be read. */
  private async readSignIn(): Promise<string | undefined> {
    try {
      return await this.options.signIn()
    } catch {
      // A sign-in that cannot be read is treated as no sign-in: nothing is sent to it.
      return undefined
    }
  }

  /**
   * The number of keys, each an agent's calls of one tool, that the next report holds.
   * @returns how many tools the next report counts.
   */
  get size(): number {
    return this.counts.size
  }

  /**
   * Count one call.
   * @param key - who called which tool.
   * @param failed - whether the call failed.
   */
  count(key: ToolUsageKey, failed: boolean): void {
    this.add(key, 1, failed ? 1 : 0, true)
  }

  /**
   * Add calls to a key's count.
   * @param newer - whether the key's display names are newer than the count's, as a call's are and a kept report's
   * are not.
   */
  private add(key: ToolUsageKey, calls: number, errors: number, newer: boolean): void {
    const id = keyOf(key)
    const found = this.counts.get(id)
    if (found === undefined) {
      if (this.counts.size >= MAX_REPORT_ENTRIES) {
        if (!this.full) this.options.overflow()
        this.full = true
        return
      }
      this.counts.set(id, { key, calls: Math.min(MAX_COUNT, calls), errors: Math.min(MAX_COUNT, errors) })
      return
    }
    found.calls = Math.min(MAX_COUNT, found.calls + calls)
    found.errors = Math.min(found.calls, found.errors + errors)
    if (newer) found.key = key
  }

  /**
   * Drop the counts held, as when usage reports are turned off, once any report already on its way has ended.
   * @returns once they are dropped; it never rejects.
   */
  clear(): Promise<void> {
    const next = this.queue.then(() => {
      this.counts = new Map()
      this.full = false
    })
    this.queue = next
    return next
  }

  /**
   * Send the counts once any report already on its way has ended, so reports never overlap. Counts the site may take
   * later are kept for the next report, together with the calls counted meanwhile.
   * @param signal - cancellation of this report.
   * @returns once the report is sent, kept, or dropped; it never rejects.
   */
  flush(signal: AbortSignal): Promise<void> {
    const next = this.queue.then(() => this.send(signal))
    this.queue = next
    return next
  }

  private async send(signal: AbortSignal): Promise<void> {
    const now = await this.readSignIn()
    // Signed out, or a sign-in that cannot be read: the counts wait for the sign-in they were gathered under.
    if (now === undefined) return
    if (now !== this.signedIn) {
      // Another sign-in than the counts' own, or counts gathered while signed out: they never go to it.
      this.forget(now)
      return
    }
    if (this.counts.size === 0) return
    const taken = [...this.counts.values()]
    this.counts = new Map()
    this.full = false
    let outcome: UsageOutcome
    try {
      outcome = await this.options.send(now, taken.map(({ key, calls, errors }) => ({ key, calls, errors })), signal)
    } catch {
      // Cancellation, or a client that failed in a way it does not report: the next report sends these counts again.
      outcome = 'kept'
    }
    if (outcome !== 'kept') return
    for (const count of taken) this.add(count.key, count.calls, count.errors, false)
  }
}
