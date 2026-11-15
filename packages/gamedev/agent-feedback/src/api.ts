/**
 * The WASD Engine site's routes for agents' reports: `POST /api/v1/feedback` takes one feedback and
 * `POST /api/v1/tool-usage` the tool calls counted since the last report, each for the account WASD Engine is signed
 * in to, with its token in `x-dsh-auth-token`. Requests never follow redirects.
 * @module @deepseek-ai/dsh-agent-feedback/src/api
 */
import { createHash } from 'node:crypto'
import type { FeedbackReport, SentFeedback, ToolUsageCount } from './types.ts'

/** The site the app is signed in to, and the account token it issued. */
export interface SiteAccess {
  /** Origin of the WASD Engine site, such as `https://app.wasdengine.com`. */
  readonly origin: string
  readonly token: string
}

/**
 * A fingerprint of one sign-in: the same for every request of that sign-in, and another for another account or a later
 * sign-in of the same account. It names no account and is never sent.
 * @param access - the sign-in's site and token.
 * @returns the fingerprint.
 */
export function signInOf(access: SiteAccess): string {
  return createHash('sha256').update(`${access.origin}\n${access.token}`).digest('hex').slice(0, 32)
}

/** What the client needs from its plugin. */
export interface ReportsApiOptions {
  /** @returns the signed-in site and token, or undefined while WASD Engine is signed out. */
  access(): Promise<SiteAccess | undefined>
  /** The fetch implementation; tests pass one that reaches a fake site. */
  fetch(input: string, init: RequestInit): Promise<Response>
  /** Time limit of one request in milliseconds. */
  readonly timeoutMs: number
  /** The app's version, which feedback names; empty names none. */
  readonly appVersion: string
  /** The computer's operating system as Node names it, such as `darwin`. */
  readonly platform: string
}

/** Feedback the site did not take, with a message that tells the agent what to do. */
export class FeedbackNotSent extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FeedbackNotSent'
  }
}

/**
 * What became of a usage report: `sent`; `kept`, to send again with the next report, for a failure that may pass, such
 * as a sign-out, a busy site, or no network; or `dropped`, for a report the site refused as it is or one whose sign-in
 * the app is no longer signed in to.
 */
export type UsageOutcome = 'sent' | 'kept' | 'dropped'

/** Longest error message read from the site. */
const MAX_ERROR_CHARS = 500

/** The error message of a site's JSON error body, `{ error: { message } }`, if it has one. */
async function siteMessage(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    const message = body.error?.message
    return typeof message === 'string' && message.trim() !== '' ? message.trim().slice(0, MAX_ERROR_CHARS) : undefined
  } catch {
    // A body that is not JSON carries no message the agent can use.
    return undefined
  }
}

/** The client of the site's report routes. */
export class ReportsApi {
  constructor(private readonly options: ReportsApiOptions) {}

  /**
   * The sign-in the app is signed in to now.
   * @returns its {@link signInOf} fingerprint, or undefined while WASD Engine is signed out.
   */
  async signIn(): Promise<string | undefined> {
    const access = await this.options.access()
    return access === undefined ? undefined : signInOf(access)
  }

  /**
   * Send one feedback.
   * @param feedback - the feedback.
   * @param signal - cancellation.
   * @returns every field the site received, as it received them.
   * @throws FeedbackNotSent when WASD Engine is signed out or the site does not take the feedback, with what to do.
   */
  async sendFeedback(feedback: FeedbackReport, signal: AbortSignal): Promise<SentFeedback> {
    const access = await this.options.access()
    if (access === undefined) {
      throw new FeedbackNotSent('WASD Engine is signed out, so the feedback was not sent. Ask the user to sign in to WASD Engine, then send it again.')
    }
    const sent: SentFeedback = {
      kind: feedback.kind,
      message: feedback.message,
      about: feedback.about,
      connected: feedback.agent.connected,
      agent: feedback.agent.id,
      agent_title: feedback.agent.title,
      model: feedback.model,
      app_version: this.options.appVersion,
      platform: this.options.platform,
    }
    let response: Response
    try {
      response = await this.post(access, '/api/v1/feedback', sent, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new FeedbackNotSent('The feedback could not be sent: the WASD Engine site did not answer. Try again later.', { cause: error })
    }
    if (response.ok) {
      await response.body?.cancel()
      return sent
    }
    const message = await siteMessage(response)
    switch (response.status) {
      case 401:
        throw new FeedbackNotSent('WASD Engine\'s sign-in is no longer valid, so the feedback was not sent. Ask the user to sign in to WASD Engine again.')
      case 400:
      case 403:
      case 413:
      case 429:
        throw new FeedbackNotSent(`The WASD Engine site did not take the feedback: ${message ?? `HTTP ${response.status}`}`)
      default:
        throw new FeedbackNotSent(`The feedback could not be sent: the WASD Engine site answered HTTP ${response.status}. Try again later.`)
    }
  }

  /**
   * Send the tool calls counted since the last report, for the sign-in they were counted under.
   * @param signIn - the {@link signInOf} fingerprint of that sign-in.
   * @param counts - one count per key, at most as many as the site takes in one report.
   * @param signal - cancellation.
   * @returns what became of the report: `dropped`, without a request, when the app is signed in to another sign-in
   *   now; it never throws for the site's answer or a network failure.
   */
  async sendUsage(signIn: string, counts: readonly ToolUsageCount[], signal: AbortSignal): Promise<UsageOutcome> {
    const access = await this.options.access()
    if (access === undefined) return 'kept'
    if (signInOf(access) !== signIn) return 'dropped'
    let response: Response
    try {
      response = await this.post(access, '/api/v1/tool-usage', {
        calls: counts.map(({ key, calls, errors }) => ({
          connected: key.agent.connected,
          agent: key.agent.id,
          agent_title: key.agent.title,
          custom: key.custom,
          server: key.server,
          server_title: key.serverTitle,
          tool: key.tool,
          calls,
          errors,
        })),
      }, signal)
    } catch {
      // No network or no answer in time: the counts wait for the next report.
      return 'kept'
    }
    await response.body?.cancel()
    if (response.ok) return 'sent'
    // A sign-in the site no longer takes may be renewed, and a busy or failing site may recover; the site refuses any
    // other report, such as one from an account that may not use WASD Engine, as it is.
    return response.status === 401 || response.status === 429 || response.status >= 500 ? 'kept' : 'dropped'
  }

  private post(access: SiteAccess, path: string, body: object, signal: AbortSignal): Promise<Response> {
    return this.options.fetch(new URL(path, access.origin).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-token': access.token },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
    })
  }
}
