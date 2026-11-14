/**
 * What agents tell the WASD Engine team. The `feedback_send` tool of every Session and of WASD Engine's MCP server
 * sends feedback about WASD Engine, such as a tool that failed or a capability that was missing, and the usage report
 * counts how often agents call each MCP tool: the game tools WASD Engine's MCP server offers, under the plugin
 * connected agents know them by, and the tools of the MCP servers the user added, by WASD Engine's own agent and by
 * each connected agent. Both go to the WASD Engine site the app is signed in to, for its account; nothing is sent
 * while signed out, and a report holds names and counts only.
 *
 * Function plugin: named exports `name`, `inject`, `Config`, and `apply`.
 * @module @deepseek-ai/dsh-agent-feedback
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ReportsApi, type ReportsApiOptions, type SiteAccess, type UsageOutcome } from './api.ts'
import { feedbackMcpProvider } from './mcp.ts'
import { feedbackToolDefinitions, WASD_ENGINE_AGENT, type FeedbackToolHost } from './tools.ts'
import { MAX_REPORT_ENTRIES, sessionCallee, ToolUsageReport } from './usage.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'agent-feedback'

/** Services the plugin needs. */
export const inject = ['tools']

/** Deployment configuration. */
export interface Config {
  /** Report how often agents call each MCP tool; false counts nothing and sends no reports. */
  usageReports: boolean
  /** Milliseconds between two usage reports; a report is sent only when calls were counted since the last one. */
  reportIntervalMs: number
  /** Time limit of one request to the WASD Engine site, in milliseconds. */
  requestTimeoutMs: number
  /** Time limit of the last usage report, which the plugin sends as it stops, such as when the app quits. */
  finalReportTimeoutMs: number
  /**
   * The app's version, which feedback names, such as `0.1.3`; empty names none, and so does a version the site would
   * refuse, which the plugin logs.
   */
  appVersion: string
}

/** Validates the configuration when the plugin loads. */
export const Config: z<Partial<Config>, Config> = z.object({
  usageReports: z.boolean().default(true),
  reportIntervalMs: z.natural().min(1000).max(MAX_TIMER_DELAY_MS).default(60_000),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  finalReportTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3000),
  appVersion: z.string().default(''),
})

/** Versions the site takes: a letter or digit, then at most 31 letters, digits, `.`, `+`, or `-`. */
const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/u

/**
 * Whether a finished call counts as failed: an error result, except a cancellation, which is the user's choice and no
 * failure of the tool.
 */
function failed(result: ToolExecutionResult): boolean {
  return result.isError && result.error.info?.code !== TOOL_ABORTED
}

/** The model a Session's agent runs on, by its display name when the model provider knows one. */
async function sessionModel(ctx: Context, exec: ToolRunContext): Promise<string | undefined> {
  const route = exec.agent?.model.current()
  if (route === undefined) return undefined
  try {
    return (await ctx.get('llm')?.resolveModelInfo(route.provider, route.model, exec.signal))?.name ?? route.model
  } catch {
    // A provider that cannot describe the model leaves its id as the name.
    return route.model
  }
}

/**
 * The account's site and token while signed in; a sign-in that cannot be read counts as signed out.
 * @param account - the account sign-in service, if one runs.
 * @param logger - where a sign-in that cannot be read is reported.
 */
async function siteAccess(account: Context['deepseekAccount'] | undefined, logger: Context['logger']): Promise<SiteAccess | undefined> {
  let session
  try {
    session = await account?.getPlatformSession()
  } catch (error) {
    logger.warn(`agent-feedback: the sign-in could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  return session == null ? undefined : { origin: new URL(session.origin).origin, token: session.token }
}

/** What the site clients share: the request time limit, the app version, and the operating system. */
type ApiSettings = Omit<ReportsApiOptions, 'access'>

/**
 * Count the MCP tool calls of Sessions' agents and of connected agents, and report them every `reportIntervalMs` and
 * once more as the plugin stops.
 */
function reportUsage(ctx: Context, settings: ApiSettings, config: Config): void {
  // The client of the reports' current account sign-in; none while no sign-in service runs.
  let api: ReportsApi | undefined
  const report = new ToolUsageReport({
    send: (counts, signal): Promise<UsageOutcome> => api === undefined ? Promise.resolve('kept') : api.sendUsage(counts, signal),
    overflow: () => { ctx.logger.warn(`agent-feedback: the usage report counts at most ${MAX_REPORT_ENTRIES} tools; calls of other tools wait for the next report`) },
  })
  ctx.on('tools/result', (exec, result) => {
    // A call cancelled before its tool ran used nothing.
    if (exec.agent === undefined || (result.isError && result.error.info?.code === TOOL_ABORTED_BEFORE_DISPATCH)) return
    const callee = sessionCallee(exec.name, name => ctx.get('gameMcp')?.toolOwner(name))
    if (callee !== undefined) report.count({ agent: WASD_ENGINE_AGENT, ...callee }, failed(result))
  })
  ctx.on('game-mcp/tool-result', (result) => {
    report.count({
      agent: { connected: true, id: result.client.id, title: result.client.title },
      custom: false,
      server: result.provider,
      serverTitle: ctx.get('gameMcp')?.toolOwner(result.tool)?.title ?? result.provider,
      tool: result.tool,
    }, result.isError)
  })
  // The reports run while the account sign-in does, and read it through this fiber's injected service: as a dependent
  // of the sign-in, the fiber stops before the sign-in does when the Host stops, and its injected service still answers
  // during that teardown, when `get()` no longer finds it, so the last report still finds the account's site and token.
  ctx.inject(['deepseekAccount'], (inner) => {
    inner.effect(() => {
      const account = inner.deepseekAccount
      api = new ReportsApi({ ...settings, access: () => siteAccess(account, ctx.logger) })
      const lifetime = new AbortController()
      const timer = setInterval(() => { void report.flush(lifetime.signal) }, config.reportIntervalMs)
      timer.unref()
      return async () => {
        clearInterval(timer)
        // A report on its way ends here and keeps its counts for the last report, which may take finalReportTimeoutMs.
        lifetime.abort()
        await report.flush(AbortSignal.timeout(config.finalReportTimeoutMs))
        api = undefined
      }
    }, 'agent-feedback: usage reports')
  })
}

/**
 * Register the feedback tool, offer it to WASD Engine's MCP server while that server runs, and, with `usageReports`,
 * count and report the agents' MCP tool calls.
 * @param ctx - plugin context with the tool registry.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let appVersion = config.appVersion
  if (appVersion !== '' && !APP_VERSION.test(appVersion)) {
    ctx.logger.warn(`agent-feedback: feedback names no app version, because the site would refuse ${JSON.stringify(appVersion)}`)
    appVersion = ''
  }
  const settings: ApiSettings = {
    fetch: (input, init) => fetch(input, init),
    timeoutMs: config.requestTimeoutMs,
    appVersion,
    platform: process.platform,
  }
  const api = new ReportsApi({ ...settings, access: () => siteAccess(ctx.get('deepseekAccount'), ctx.logger) })
  const host: FeedbackToolHost = {
    send: (feedback, signal) => api.sendFeedback(feedback, signal),
    sessionModel: exec => sessionModel(ctx, exec),
  }
  for (const definition of feedbackToolDefinitions(host, 'session')) ctx.tools.register(definition)
  // Agents connected through WASD Engine's MCP server get the same tool.
  ctx.inject(['gameMcp'], (inner) => {
    inner.effect(() => inner.gameMcp.provide(feedbackMcpProvider(host)), 'agent-feedback: game MCP tools')
  })
  if (config.usageReports) reportUsage(ctx, settings, config)
}
