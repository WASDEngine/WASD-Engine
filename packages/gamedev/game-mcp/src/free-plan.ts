/**
 * Free accounts whose AI usage is used up, as agents connected through WASD Engine's MCP server meet them. A call of a
 * tool that spends the account's AI usage (`GameMcpProvider.spendsUsage`) that fails because the usage limit was
 * reached, while the account service reports a Free account whose usage is used up, becomes a choice for the user
 * ({@link FreePlan.offer}): upgrade to Pro on the account service's page that buys it, or stay on Free, where WASD Engine
 * keeps working but the quality of generated audio, video, 3D models, animations, and graphics decreases. A user who
 * stays on Free is offered none of those providers until the usage refreshes, or until the account service reports
 * usage left again, as after an upgrade; the agent is never told why they are gone. The choice is kept in a file of the
 * server's data folder, so it outlives a restart. MCP sends the server instructions once per connection, so an agent that
 * received them before such a change gets a note with its next tool result that names the providers turned off, or on
 * again ({@link ProviderNotes}).
 * @module @deepseek-ai/dsh-game-mcp/src/free-plan
 */
import { readFile, rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { z } from 'zod'

/** Name of the file in the server's data folder that keeps the choice to stay on Free. */
export const FREE_PLAN_FILE = 'free-plan.json'

/** Path of the account service's page that buys Pro as soon as it loads. */
export const UPGRADE_PATH = '/upgrade?plan=pro'

/** What the failure of a tool that spends the account's usage says when the account service refused it for that usage. */
const USED_UP = /usage limit reached/iu

/** How old the reading of the account may be before a request, while the user stays on Free, reads it again. */
const READ_EVERY_MS = 60_000

/** Longest wait for one reading of the account, so a slow account service holds no request up for long. */
const READ_TIMEOUT_MS = 5_000

/** How long a choice to stay on Free lasts when the account service names no time the usage refreshes. */
const CHOICE_FALLBACK_MS = 24 * 60 * 60 * 1000

/** The server's identity in its reads of the account service, which follow no window's language or time zone. */
const SERVER_CLIENT: AccountClientMetadata = { version: 'game-mcp', locale: 'en', timezoneOffsetSeconds: 0 }

/** The stored choice: the user stays on Free until `until`. */
const storedChoice = z.object({ version: z.literal(1), until: z.iso.datetime({ offset: true }) })

/** What the agent reads after the user opened the page that upgrades the account. */
export const UPGRADING = 'The user opened a page in their browser about this tool. Go on with other work, and call the tool again once they say '
  + 'they are done there.'

/** What the agent reads after the user chose to stay on Free: nothing about the plan, only that the tool is gone. */
export const STAYING = 'This tool is not available now. Go on with the work using WASD Engine\'s other game tools.'

/** What the agent reads after the user dismissed the question. */
export const DISMISSED = 'The tool did not run. Go on with the work without it for now.'

/** The choice put to the user in place of a failed call. */
export interface UsageOffer {
  /** The page that upgrades the account to Pro. */
  readonly url: string
  /** What the user reads beside the page, as their agent's client shows it: decline to stay on Free. */
  readonly message: string
  /** What the agent passes on to the user, with the page, when its client cannot show the page. */
  readonly passOn: string
}

/** One reading of the account. */
interface Reading {
  /** When it was taken, in milliseconds since the epoch. */
  readonly at: number
  /** Whether the account is on Free and its AI usage is used up. */
  readonly exhausted: boolean
  /** When the usage refreshes, in milliseconds since the epoch; absent when the account service named no time. */
  readonly refreshesAt?: number
}

/**
 * The day the usage refreshes, as the offer names it: `December 1`, in UTC, as the account service counts its months.
 * @param time - milliseconds since the epoch.
 * @returns the day.
 */
function dayOf(time: number): string {
  return new Date(time).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/**
 * The offer's texts.
 * @param url - the page that upgrades the account to Pro.
 * @param refreshesAt - when the usage refreshes, when known.
 * @returns the offer.
 */
export function usageOffer(url: string, refreshesAt: number | undefined): UsageOffer {
  const used = `Your WASD Engine Free plan has used up its AI usage for this month${refreshesAt === undefined ? '' : ` (it refreshes on ${dayOf(refreshesAt)})`}.`
  const free = 'On Free you can keep using WASD Engine, but the quality of generated audio, video, 3D models, animations, and graphics will decrease.'
  return {
    url,
    message: `${used} Open the page to upgrade to Pro, or decline to stay on Free. ${free}`,
    passOn: `Pass this on to the user, with its link, then go on with the work without this tool: ${used} To upgrade to Pro, open ${url}. Or stay `
      + `on Free: ${free}`,
  }
}

/** A provider as a note names it. */
export interface NamedProvider {
  readonly id: string
  readonly title: string
}

/** Agents whose last word on the providers that spend the account's usage the server remembers. */
const MAX_NOTED_AGENTS = 64

/**
 * The note that tells an agent which game tools WASD Engine turned off, or on again, since it received the server
 * instructions: MCP sends them once per connection, so an agent that connected before the change still reads of those
 * providers there. Neither note says why.
 * @param providers - the providers that spend the account's usage.
 * @param off - whether they are turned off now.
 * @returns the note.
 */
export function providersNote(providers: readonly NamedProvider[], off: boolean): string {
  const names = providers.map(provider => `${provider.title} (${provider.id}_*)`).join(', ')
  return off
    ? `Note: WASD Engine turned off these game tools for now: ${names}. Do not call them, even where the server instructions or a guide name `
      + 'them; use WASD Engine\'s other game tools instead.'
    : `Note: these WASD Engine game tools are available again: ${names}. If your tool list lacks them, find them with search_game_tools and `
      + 'call them through call_game_tool.'
}

/**
 * What each connected agent was last told of the providers that spend the account's usage: whether they were off when
 * it received the server instructions (`initialize` or `server/discover`) or a note. The first tool result an agent gets
 * after they turned off, or on again, carries the note once ({@link providersNote}). An agent the server has not seen
 * receive instructions, as after WASD Engine restarted, is taken to have received them with the providers on.
 */
export class ProviderNotes {
  private readonly told = new Map<string, boolean>()

  /**
   * Remember that an agent received the server instructions now.
   * @param agent - the agent's client id.
   * @param off - whether the providers are off in them.
   */
  instructed(agent: string, off: boolean): void {
    this.remember(agent, off)
  }

  /**
   * The note for an agent's tool result, once after each change.
   * @param agent - the agent's client id.
   * @param off - whether the providers are off now.
   * @param providers - the providers that spend the account's usage, read only when there is something to say.
   * @returns the note, or undefined when the agent knows already or no such provider is registered.
   */
  note(agent: string, off: boolean, providers: () => readonly NamedProvider[]): string | undefined {
    if ((this.told.get(agent) ?? false) === off) return undefined
    this.remember(agent, off)
    const named = providers()
    return named.length === 0 ? undefined : providersNote(named, off)
  }

  private remember(agent: string, off: boolean): void {
    this.told.delete(agent)
    this.told.set(agent, off)
    // The oldest agent is forgotten first; it is told again only when it differs from what it would be taken to know.
    if (this.told.size > MAX_NOTED_AGENTS) this.told.delete(this.told.keys().next().value as string)
  }
}

/**
 * Settle `work`, or fail once `ms` milliseconds passed.
 * @param work - the work.
 * @param ms - the time limit.
 * @returns what the work returned.
 * @throws Error when the time limit passed first, or what the work threw.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`no answer within ${String(ms)} ms`)) }, ms)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

/** The choice of a Free account whose AI usage is used up, for the server's connected agents. */
export class FreePlan {
  /** Until when the user stays on Free, in milliseconds since the epoch; undefined while no such choice holds. */
  private until: number | undefined
  private loading: Promise<void> | undefined
  private reading: Reading | undefined
  private reads: Promise<Reading | undefined> | undefined

  /**
   * @param ctx - context with the optional account service; without it, no call becomes the offer.
   * @param file - absolute path of the file that keeps the choice.
   * @param changed - called when the providers offered to connected agents may have changed.
   * @param now - the clock, in milliseconds since the epoch.
   */
  constructor(
    private readonly ctx: Context,
    private readonly file: string,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether connected agents are offered no provider that spends the account's usage now: the user chose to stay on
   * Free, the usage has not refreshed since, and the last reading of the account still shows a Free account whose usage
   * is used up. Before the first reading, the stored choice decides.
   * @returns true while those providers are left out.
   */
  hiding(): boolean {
    const until = this.until
    if (until === undefined || this.now() >= until) return false
    return this.reading?.exhausted ?? true
  }

  /**
   * Prepare for a request: load the stored choice once and, while it holds, read the account again when the last
   * reading is older than a minute, so an upgrade or new credits bring the providers back. It never fails: an account
   * service that does not answer leaves the last reading.
   * @returns once the choice is current.
   */
  async refresh(): Promise<void> {
    await this.load()
    const until = this.until
    if (until === undefined || this.now() >= until) return
    if (this.reading !== undefined && this.now() - this.reading.at < READ_EVERY_MS) return
    await this.read()
  }

  /**
   * The choice to put to the user in place of a failed call of a tool that spends the account's usage: only a failure
   * that says the usage limit was reached becomes it, and only while the account service reports a Free account whose
   * usage is used up, read anew for the call.
   * @param failure - the failed call's text.
   * @returns the offer, or undefined to keep the failure as it is.
   */
  async offer(failure: string): Promise<UsageOffer | undefined> {
    if (!USED_UP.test(failure)) return undefined
    const reading = await this.read()
    const account = this.ctx.get('deepseekAccount')
    if (reading?.exhausted !== true || account === undefined) return undefined
    let url: string
    try {
      url = new URL(UPGRADE_PATH, (await account.getState()).links.topUpUrl).href
    } catch (error) {
      this.ctx.logger.warn(`game-mcp: the page that upgrades the account could not be found: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    return usageOffer(url, reading.refreshesAt)
  }

  /**
   * Record that the user stays on Free until the usage refreshes, as the last reading says, or for a day without one;
   * from then on connected agents are offered no provider that spends the usage. It never fails: a file that cannot be
   * written keeps the choice for this run of WASD Engine.
   * @returns once the choice is recorded.
   */
  async stayOnFree(): Promise<void> {
    await this.load()
    const until = this.reading?.refreshesAt ?? this.now() + CHOICE_FALLBACK_MS
    this.until = until
    try {
      await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, until: new Date(until).toISOString() })}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      this.ctx.logger.warn(`game-mcp: the choice to stay on Free could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.changed()
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      let text: string
      try {
        text = await readFile(this.file, 'utf8')
      } catch (error) {
        // A missing file holds no choice; any other failure is reported, and no choice holds.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger.warn(`game-mcp: the choice to stay on Free could not be read: ${String(error)}`)
        return
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch (_malformed) {
        // A file that is not JSON holds no choice.
        return
      }
      const parsed = storedChoice.safeParse(json)
      if (parsed.success) this.until = Date.parse(parsed.data.until)
    })()
    return this.loading
  }

  /**
   * Read the account now, one reading at a time.
   * @returns the reading, the last one when the account service cannot answer, or undefined without either.
   */
  private read(): Promise<Reading | undefined> {
    this.reads ??= this.readAccount().finally(() => { this.reads = undefined })
    return this.reads
  }

  private async readAccount(): Promise<Reading | undefined> {
    const account = this.ctx.get('deepseekAccount')
    if (account === undefined) return undefined
    const before = this.hiding()
    try {
      const balance = await within(account.getBalance(SERVER_CLIENT), READ_TIMEOUT_MS)
      // Signed out, or a balance the service could not read: the last reading stands.
      if (balance === null || balance.status !== 'ready') return this.reading
      const allowance = balance.allowance
      const refreshesAt = allowance === undefined ? Number.NaN : Date.parse(allowance.refreshesAt)
      this.reading = {
        at: this.now(),
        exhausted: allowance?.plan === 'free' && allowance.usedUp === true,
        ...Number.isFinite(refreshesAt) ? { refreshesAt } : {},
      }
    } catch (error) {
      this.ctx.logger.warn(`game-mcp: the account's usage could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return this.reading
    }
    // An upgrade, new credits, or a new month ends the choice: once the usage is used up again, the user is asked again.
    if (this.until !== undefined && !this.reading.exhausted) await this.forget()
    if (this.hiding() !== before) this.changed()
    return this.reading
  }

  private async forget(): Promise<void> {
    this.until = undefined
    try {
      await rm(this.file, { force: true })
    } catch (error) {
      this.ctx.logger.warn(`game-mcp: the ended choice to stay on Free could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
