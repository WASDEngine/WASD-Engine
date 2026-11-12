/**
 * WASD Engine's allowance, auto recharge, and referral link (fork-owned; `wasdengine/FORK.md` lists the fork changes).
 * The WASD Engine account service reports beside the wallets how much of the plan's monthly AI usage is left, the
 * credits left as a share of that allowance, the auto recharge switch, whether the account is on the Unlimited tier,
 * and the account's referral link, never a dollar amount; and it switches auto recharge at `set_auto_recharge`. A
 * malformed report is dropped, so it never fails the wallet read.
 */
import { z } from 'zod'
import type { AccountAllowance, AccountAutoRechargeChange, AccountReferral } from './types.ts'
import { browserUrl, PlatformAuthError } from './protocol.ts'

/** Path of the account service's page that sends the browser on to the page that saves a card. */
export const CARD_PAGE_PATH = '/billing/checkout'
/** Path of a referral link: the account service's front page, which keeps the link's code for its sign-up form. */
export const REFERRAL_PAGE_PATH = '/'

const autoRecharge = z.object({ enabled: z.boolean(), failure: z.string().nullable() }).optional().catch(undefined)

/** The `allowance` of a user summary; a malformed one parses as absent, and so does a malformed optional member. */
export const allowance = z.object({
  remaining_percent: z.number().int().min(0).max(100),
  remaining_share: z.number().min(0).max(1),
  refreshes_at: z.iso.datetime({ offset: true }),
  credits_allowance_percent: z.number().int().min(0).optional().catch(undefined),
  auto_recharge: autoRecharge,
  unlimited: z.boolean().optional().catch(undefined),
}).optional().catch(undefined)

/** The `referral` of a user summary; a malformed one parses as absent. {@link projectReferral} checks its link. */
export const referral = z.object({ url: z.string(), joined: z.number().int().min(0) }).optional().catch(undefined)

/**
 * Project a parsed `allowance` for account UI consumers.
 * @param left - the parsed allowance.
 * @returns the allowance with only the members the service sent.
 */
export function projectAllowance(left: Exclude<z.infer<typeof allowance>, undefined>): AccountAllowance {
  const recharge = left.auto_recharge
  return {
    remainingPercent: left.remaining_percent, remainingShare: left.remaining_share, refreshesAt: left.refreshes_at,
    ...(left.credits_allowance_percent === undefined ? {} : { creditsPercent: left.credits_allowance_percent }),
    ...(recharge === undefined ? {} : { autoRecharge: {
      enabled: recharge.enabled, ...(recharge.failure === null ? {} : { failure: recharge.failure }),
    } }),
    ...(left.unlimited === true ? { unlimited: true as const } : {}),
  }
}

/**
 * Project a parsed `referral` for account UI consumers, keeping it only when its link is the account service's own
 * front page on `origin` with a `ref` code, so the shared link cannot point anywhere else.
 * @param shared - the parsed referral.
 * @param origin - configured account service origin.
 * @returns the referral, or undefined when its link is another page or another site's.
 */
export function projectReferral(shared: Exclude<z.infer<typeof referral>, undefined>, origin: string): AccountReferral | undefined {
  let url: string
  try { url = browserUrl(shared.url, origin, REFERRAL_PAGE_PATH) } catch { return undefined }
  const search = new URL(url).searchParams
  if ([...search.keys()].join() !== 'ref' || !/^[a-z0-9]{1,32}$/u.test(search.get('ref') ?? '')) return undefined
  return { url, joined: shared.joined }
}

const change = z.object({ enabled: z.boolean(), card_url: z.string().nullable() })

/**
 * Validate the reply of `set_auto_recharge`. The card page must be the account service's own {@link CARD_PAGE_PATH},
 * so the reply cannot send the browser anywhere else.
 * @param value - the reply's business payload.
 * @param origin - configured account service origin.
 * @param rewriteOrigin - map the card page to `origin`, as `rewriteBrowserOrigin` does for the sign-in pages.
 * @returns the outcome.
 * @throws PlatformAuthError with code `protocol` for a malformed reply or a card page elsewhere.
 */
export function autoRechargeChange(value: unknown, origin: string, rewriteOrigin: boolean): AccountAutoRechargeChange {
  const parsed = change.safeParse(value)
  if (!parsed.success) throw new PlatformAuthError('protocol')
  const { enabled, card_url: cardUrl } = parsed.data
  return cardUrl === null ? { enabled } : { enabled, cardUrl: browserUrl(cardUrl, origin, CARD_PAGE_PATH, rewriteOrigin) }
}
