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

/** Ordered account stream item; every item carries the latest safe state. */
export interface AccountUpdate {
  /** Initial state and progress use snapshot; credential writes and removal use credentials-changed. */
  readonly type: 'snapshot' | 'credentials-changed'
  readonly state: AccountView
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
   * Credits left, from referrals and auto recharge, which the account spends once the allowance is used up, as the
   * whole percent of the plan's monthly allowance, rounded down: 0 while they come to less than 1% of it, above 100
   * while they come to more than a month's allowance. Absent while none are left.
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
 * WASD Engine: auto recharge, which charges the account's saved card for more credits each time its AI usage and
 * credits run out. The service reports no amount: the page that saves the card states it.
 */
export interface AccountAutoRecharge {
  /** Whether auto recharge is on. */
  readonly enabled: boolean
  /** Why the last recharge failed, which turned auto recharge off; absent otherwise. */
  readonly failure?: string
}
/**
 * WASD Engine: the account's referral link, which earns the account free credits when people create accounts through
 * it; the service reports no amount.
 */
export interface AccountReferral {
  /** The link to share: the account service's front page with the account's referral code. */
  readonly url: string
  /** How many accounts that signed up through the link were let in. */
  readonly joined: number
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
  readonly balance: { readonly status: 'ready'; readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[]; readonly allowance?: AccountAllowance; readonly referral?: AccountReferral } | { readonly status: 'failed' }
}

/** Opaque string notification identity; stable across devices, sign-ins, and languages. */
export type AccountNotificationId = Branded<'AccountNotificationId'>
/** Presentation, any non-dismiss action click, or explicit dismissal; independent of backend consumption. */
export type AccountNotificationEvent = 'displayed' | 'cta_clicked' | 'dismissed'
/** Client action supported by the account notification presentation. */
export interface AccountNotificationAction {
  readonly label: string
  readonly style: 'primary' | 'secondary'
  readonly target: { readonly type: 'app_route'; readonly name: 'account' } | { readonly type: 'dismiss' }
}
/** One account notification with server-localized plain text and actions. */
export interface AccountNotification {
  readonly id: AccountNotificationId
  readonly createdAt: string
  /** Display deadline; null means the notification never expires. */
  readonly displayUntil: string | null
  readonly title: string
  readonly body: string
  readonly actions: readonly AccountNotificationAction[]
  /** Optional business data, retained independently of the localized copy. */
  readonly data?: JsonValue
}
/** Unconsumed notifications in server order, without account-profile data. */
export interface AccountNotificationBatch {
  /** Positive delay in seconds before querying again, within the browser timer range. */
  readonly nextPollAfterSeconds: number
  readonly notifications: readonly AccountNotification[]
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

/** Host-only credentials for an embedded Platform document; never expose through account RPC. */
export interface PlatformSession {
  readonly origin: string
  readonly token: string
  /** Stable issuer account ID from the last successful profile read; null requires disposable browser storage. */
  readonly userId: AccountUserId | null
  /** Optional dist query value selecting the embedded frontend deployment. */
  readonly embeddedPageDist?: string
  /** Host-only deployment request headers; the consuming client adds its own dynamic identity, and neither reaches renderer bootstrap. */
  readonly requestHeaders?: Readonly<Record<string, string>>
}
