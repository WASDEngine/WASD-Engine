/**
 * The tool usage report: how often agents call each MCP tool, counted between two reports to the WASD Engine site. A
 * Session's own calls count when WASD Engine's MCP server offers the tool, under the plugin connected agents know it
 * by, or when the tool comes from an MCP server the user added; every other harness tool, such as reading a file, is
 * no MCP tool and counts nothing. Connected agents' calls count under the plugin that offers them. A report holds names
 * and counts only, never arguments or results.
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
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/u

/**
 * What a Session's tool call is a call of.
 * @param name - the harness tool name the Session called.
 * @param owner - finds the provider of WASD Engine's MCP server that offers a tool, when that server runs.
 * @returns the plugin and tool for a tool WASD Engine's MCP server offers, the server and tool for a tool of an MCP
 * server the user added, else undefined.
 */
export function sessionCallee(name: string, owner: ((name: string) => GameMcpToolOwner | undefined) | undefined): ToolCallee | undefined {
  const owned = owner?.(name)
  if (owned !== undefined) return { custom: false, server: owned.provider, serverTitle: owned.title, tool: owned.tool }
  const match = MCP_TOOL_NAME.exec(name)
  if (match === null) return undefined
  const [, server = '', tool = ''] = match
  return { custom: true, server, serverTitle: server, tool }
}

function keyOf(key: ToolUsageKey): string {
  return JSON.stringify([key.agent.connected, key.agent.id, key.custom, key.server, key.tool])
}

/** Callbacks of the report. */
export interface ToolUsageReportOptions {
  /**
   * Send counts to the site.
   * @param counts - at most {@link MAX_REPORT_ENTRIES} counts.
   * @param signal - cancellation.
   * @returns what became of them.
   */
  send(counts: readonly ToolUsageCount[], signal: AbortSignal): Promise<UsageOutcome>
  /** Called once each time calls of a new tool are left uncounted because the report already holds its most counts. */
  overflow(): void
}

/** The counts since the last report that the site took, and the sending of the next one. */
export class ToolUsageReport {
  private counts = new Map<string, { key: ToolUsageKey; calls: number; errors: number }>()
  /** The last report asked for; each waits for the one before it. */
  private queue: Promise<void> = Promise.resolve()
  private full = false

  constructor(private readonly options: ToolUsageReportOptions) {}

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
    if (this.counts.size === 0) return
    const taken = [...this.counts.values()]
    this.counts = new Map()
    this.full = false
    let outcome: UsageOutcome
    try {
      outcome = await this.options.send(taken.map(({ key, calls, errors }) => ({ key, calls, errors })), signal)
    } catch {
      // Cancellation, or a client that failed in a way it does not report: the next report sends these counts again.
      outcome = 'kept'
    }
    if (outcome !== 'kept') return
    for (const count of taken) this.add(count.key, count.calls, count.errors, false)
  }
}
