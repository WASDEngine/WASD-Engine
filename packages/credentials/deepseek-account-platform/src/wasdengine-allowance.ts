/**
 * WASD Engine's allowance and auto recharge (fork-owned; `wasdengine/FORK.md` lists the fork changes). The WASD Engine
 * account service reports beside the wallets how much of the plan's monthly AI usage is left, the auto recharge
 * credits left, the auto recharge switch, and whether the account is on the Unlimited tier, and switches auto recharge
 * at `set_auto_recharge`. A malformed report is dropped, so it never fails the wallet read.
 */
import { z } from 'zod'
import type { AccountAllowance, AccountAutoRechargeChange } from '@deepseek-ai/dsh-deepseek-account/types'
import { browserUrl, PlatformAuthError } from './protocol.ts'

/** Path of the account service's page that sends the browser on to the page that saves a card. */
export const CARD_PAGE_PATH = '/billing/checkout'

const autoRecharge = z.object({
  enabled: z.boolean(), charge_usd: z.number().int().positive(), failure: z.string().nullable(),
}).optional().catch(undefined)

/** The `allowance` of a user summary; a malformed one parses as absent, and so does a malformed optional member. */
export const allowance = z.object({
  remaining_percent: z.number().int().min(0).max(100),
  remaining_share: z.number().min(0).max(1),
  refreshes_at: z.iso.datetime({ offset: true }),
  credits_percent: z.number().int().min(0).optional().catch(undefined),
  auto_recharge: autoRecharge,
  unlimited: z.boolean().optional().catch(undefined),
}).optional().catch(undefined)

/**
 * Project a parsed `allowance` for account UI consumers.
 * @param left - the parsed allowance.
 * @returns the allowance with only the members the service sent.
 */
export function projectAllowance(left: Exclude<z.infer<typeof allowance>, undefined>): AccountAllowance {
  const recharge = left.auto_recharge
  return {
    remainingPercent: left.remaining_percent, remainingShare: left.remaining_share, refreshesAt: left.refreshes_at,
    ...(left.credits_percent === undefined ? {} : { creditsPercent: left.credits_percent }),
    ...(recharge === undefined ? {} : { autoRecharge: {
      enabled: recharge.enabled, chargeUsd: recharge.charge_usd,
      ...(recharge.failure === null ? {} : { failure: recharge.failure }),
    } }),
    ...(left.unlimited === true ? { unlimited: true as const } : {}),
  }
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
