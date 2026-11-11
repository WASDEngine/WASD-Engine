/** Client-supplied request identity and client-safe account state; credentials never cross this projection. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Identity of the requesting UI for one account operation; the Host derives Platform request headers from it. */
export interface AccountClientMetadata {
  readonly version: string
  /** Active UI language; only its primary subtag selects the Platform wire locale. */
  readonly locale: string
  /** Offset from UTC in seconds, positive east of Greenwich. */
  readonly timezoneOffsetSeconds: number
}

/** Identity of one local login attempt, unrelated to the platform request ID. */
export type SignInAttemptId = Branded<'SignInAttemptId'>
/**
 * Safe failure codes rendered through the caller's locale dictionary.
 * `no-response`: fetch returned no Response; `network`: HTTP or account-detail retrieval failure.
 * `protocol`: invalid response or authorization data; `expired`: authorization expired;
 * `storage`: local credential access or commit failed.
 */
export type SignInErrorCode = 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
/** Latest login attempt, including terminal outcomes until the next attempt. */
export interface SignInAttemptView {
  readonly id: SignInAttemptId
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: SignInErrorCode
}
/** Browser destinations derived from the Host's platform configuration; never carry tokens. */
export interface AccountLinks {
  readonly usageUrl: string
  readonly topUpUrl: string
}
/** Stored-account presence is not a claim that the server has validated its token. */
export interface AccountView {
  readonly status: 'signed-out' | 'credential-stored'
  readonly links: AccountLinks
  readonly attempt: SignInAttemptView | null
}

/** Platform account identifier supplied by the current-user endpoint. */
export type AccountUserId = Branded<'AccountUserId'>
/** Display identity; contacts retain Platform masking. */
export interface AccountProfile {
  readonly id: AccountUserId | null
  readonly name: string | null
  readonly contact: string | null
  /** Profile image URL supplied by Platform, absent when no picture is configured. */
  readonly avatarUrl?: string | null
}
/** Platform recharge or bonus wallet balance; decimal strings retain server precision. */
export interface AccountWallet {
  readonly currency: 'CNY' | 'USD'
  readonly balance: string
}
/**
 * WASD Engine: how much of the plan's monthly AI usage is left, which the WASD Engine account service reports with
 * the wallets in place of a dollar balance; other services report none.
 */
export interface AccountAllowance {
  /** Whole percent left, from 0 to 100, rounded down so it never shows more than is left. */
  readonly remainingPercent: number
  /** Exact share left, from 0 to 1; above 0 while anything is left, even when {@link remainingPercent} is 0. */
  readonly remainingShare: number
  /** When the allowance refreshes, as an ISO 8601 timestamp. */
  readonly refreshesAt: string
  /**
   * Auto recharge credits left, which the account spends once the allowance is used up, as the whole percent of what
   * one recharge adds, rounded down: 0 while less than 1% is left, above 100 while more than one recharge's credits
   * are. Absent while none are left.
   */
  readonly creditsPercent?: number
  /** The account's auto recharge; absent while the account cannot turn it on. */
  readonly autoRecharge?: AccountAutoRecharge
  /**
   * True while the account is on WASD Engine's Unlimited tier, which has no monthly limit: the percent and share then
   * report everything left, and the service reports no credits or auto recharge. Absent otherwise.
   */
  readonly unlimited?: true
}
/**
 * WASD Engine: auto recharge, which charges the account's saved card a fixed amount for more credits each time its AI
 * usage and credits run out.
 */
export interface AccountAutoRecharge {
  /** Whether auto recharge is on. */
  readonly enabled: boolean
  /** Whole US dollars each recharge charges. */
  readonly chargeUsd: number
  /** Why the last recharge failed, which turned auto recharge off; absent otherwise. */
  readonly failure?: string
}
/** WASD Engine: the outcome of switching auto recharge on or off. */
export interface AccountAutoRechargeChange {
  /** Whether auto recharge is on now. */
  readonly enabled: boolean
  /**
   * The account service's page that saves a card, to open in the browser; auto recharge turns on once the card is
   * saved. Absent when no card is needed.
   */
  readonly cardUrl?: string
}
/** Independent query outcomes allow profile and balance failures to render separately. */
export interface AccountDetails {
  readonly profile: { readonly status: 'ready'; readonly value: AccountProfile } | { readonly status: 'failed' }
  readonly balance: { readonly status: 'ready'; readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[]; readonly allowance?: AccountAllowance } | { readonly status: 'failed' }
}

/** Identity of one granted bonus order; stable across devices and sign-ins. */
export type AccountBonusOrderId = Branded<'AccountBonusOrderId'>
/** One granted bonus Platform has not yet recorded as displayed; copy is server-authored. */
export interface AccountBonusNotification {
  /** Server-localized plain-text title; absent responses use the localized bonus title. */
  readonly title?: string
  readonly orderId: AccountBonusOrderId
  /** Optional Platform metadata, forwarded without validation. */
  readonly campaign?: JsonValue
  readonly amount?: JsonValue
  readonly currency?: JsonValue
  readonly grantedAt?: JsonValue
  /** Platform expiry timestamp; an empty string means the notice never expires. */
  readonly expiresAt: string
  /** Server-localized plain text ready for display. */
  readonly message: string
}
/** Unnotified bonuses with the account they belong to, in Platform order. */
export interface AccountBonusBatch {
  readonly accountId: AccountUserId
  readonly bonuses: readonly AccountBonusNotification[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Server rejection removed the current account credential; this notification is not replayed.
     * @mode emit
     */
    'deepseek-account/session-expired'(): void
    /** An account model request requires the user to sign in.
     * @mode emit
     */
    'deepseek-account/model-sign-in-required'(): void
  }
}
