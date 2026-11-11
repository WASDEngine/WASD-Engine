/**
 * WASD Engine's AI usage row (fork-owned; `wasdengine/FORK.md` lists the fork changes). The WASD Engine account
 * service reports how much of the plan's monthly AI usage is left instead of a dollar balance, and Settings › Account
 * shows it the way the website's account page does: the balance row's amount is the whole percent left, and under the
 * row a bar shows the exact share left, with the day the usage refreshes and the auto recharge credits left. While the
 * account can use auto recharge, a row under the bar has the plans page's auto recharge switch. On the Unlimited tier
 * the amount reads Unlimited, with no bar, and the row says the account has no monthly limit. `AccountSection`
 * renders the parts.
 */
import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAllowance, AccountAutoRecharge, AccountAutoRechargeChange } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './wasdengine-allowance.module.css'

type Translate = PropsLocale<'settings.account'>['t']

/**
 * The language that formats the percent and the day: `<html lang>`, which the locale plugin keeps on the active
 * language; absent until it is set, which formats in the runtime's default.
 * @returns a BCP 47 language tag, or undefined.
 */
function pageLanguage(): string | undefined {
  return document.documentElement.lang || undefined
}

/** @returns the formatter of whole percents in the page language. */
function percentFormat(): Intl.NumberFormat {
  return new Intl.NumberFormat(pageLanguage(), { style: 'percent', maximumFractionDigits: 0 })
}

/**
 * The balance row's amount: the whole percent left, rounded down by the service, and "Less than 1%" while less than
 * 1% is left, so it reads 0% only once nothing is; Unlimited on the Unlimited tier.
 * @param allowance - what the account service reported.
 * @param t - the account copy.
 * @returns the formatted percent left, or Unlimited.
 */
export function allowancePercent(allowance: AccountAllowance, t: Translate): string {
  if (allowance.unlimited === true) return t('allowanceUnlimited')
  const percent = percentFormat()
  return allowance.remainingPercent === 0 && allowance.remainingShare > 0
    ? t('allowanceUnderOnePercent', { percent: percent.format(0.01) })
    : percent.format(allowance.remainingPercent / 100)
}

/**
 * The auto recharge credits left, as the share of what one recharge adds, worded as the website words it.
 * @param creditsPercent - the whole percent the service reports; 0 while less than 1% is left.
 * @param t - the account copy.
 * @returns the credits line.
 */
function creditsLabel(creditsPercent: number, t: Translate): string {
  const percent = percentFormat()
  return creditsPercent === 0
    ? t('allowanceCreditsUnderOnePercent', { percent: percent.format(0.01) })
    : t('allowanceCredits', { percent: percent.format(creditsPercent / 100) })
}

/**
 * The bar of the share left, amber once nothing is, the day the usage refreshes, in UTC as the service counts it, and
 * the auto recharge credits left, while any are; on the Unlimited tier, only that the account has no monthly limit.
 * @param props - what the account service reported, and the account copy.
 * @returns the part of the AI usage row under its amount.
 */
export function WasdengineAllowanceMeter({ allowance, t }: { allowance: AccountAllowance; t: Translate }) {
  if (allowance.unlimited === true) {
    return <div className={css.allowance}><div className={css.details}><span>{t('allowanceNoLimit')}</span></div></div>
  }
  const day = new Intl.DateTimeFormat(pageLanguage(), { month: 'long', day: 'numeric', timeZone: 'UTC' })
  return (
    <div className={css.allowance}>
      <div className={css.meter} data-empty={allowance.remainingShare === 0 ? '' : undefined} aria-hidden="true">
        <div className={css.fill} style={{ width: `${allowance.remainingShare * 100}%` }} />
      </div>
      <div className={css.details}>
        <span>{t('allowanceRefreshes', { date: day.format(new Date(allowance.refreshesAt)) })}</span>
        {allowance.creditsPercent !== undefined && <span>{creditsLabel(allowance.creditsPercent, t)}</span>}
      </div>
    </div>
  )
}

/** Props of {@link WasdengineAutoRecharge}. */
export interface WasdengineAutoRechargeProps {
  /** The account's auto recharge, as the last balance read reported it. */
  readonly recharge: AccountAutoRecharge
  /** The account copy. */
  readonly t: Translate
  /**
   * Turn auto recharge on or off, then re-read the balance.
   * @param enabled - whether auto recharge should be on.
   * @returns the outcome, or null when the account is absent or changed.
   */
  readonly setAutoRecharge: (enabled: boolean) => Promise<AccountAutoRechargeChange | null>
  /** Read the account again; the row calls it when the app regains focus while the card page is open. */
  readonly refreshAccount: () => Promise<void>
}

/**
 * The auto recharge switch, worded as the plans page words it, with the charge in US dollars. Turning it on without a
 * saved card opens the account service's card page in the browser and keeps a link to it, until a balance read
 * reports auto recharge on; returning to the app reads the balance again. A failed charge's reason, which turned auto
 * recharge off, shows under the switch.
 * @param props - the reported state, the account copy, and the account operations.
 * @returns the divider and the rows of the switch.
 */
export function WasdengineAutoRecharge({ recharge, t, setAutoRecharge, refreshAccount }: WasdengineAutoRechargeProps) {
  const [requested, setRequested] = useState<boolean | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [cardUrl, setCardUrl] = useState<string | undefined>(undefined)
  const amount = new Intl.NumberFormat(pageLanguage(), { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(recharge.chargeUsd)
  const label = t('autoRecharge', { amount })
  useEffect(() => { if (recharge.enabled) setCardUrl(undefined) }, [recharge.enabled])
  useEffect(() => {
    if (cardUrl === undefined) return undefined
    const read = (): void => { void refreshAccount() }
    window.addEventListener('focus', read)
    return () => { window.removeEventListener('focus', read) }
  }, [cardUrl, refreshAccount])
  const change = (next: boolean): void => {
    setFailed(false)
    setRequested(next)
    void setAutoRecharge(next).then((outcome) => {
      if (outcome === null) return
      setCardUrl(outcome.cardUrl)
      if (outcome.cardUrl !== undefined) window.open(outcome.cardUrl, '_blank', 'noopener,noreferrer')
    }).catch(() => { setFailed(true) }).finally(() => { setRequested(undefined) })
  }
  return <>
    <div className={css.divider} />
    <div className={css.recharge}>
      <span>{label}</span>
      <Switch checked={requested ?? recharge.enabled} disabled={requested !== undefined} label={label} onChange={change} />
    </div>
    {recharge.failure !== undefined && !recharge.enabled
      && <span className={css.warning} role="status">{t('autoRechargeFailed', { reason: recharge.failure })}</span>}
    {cardUrl !== undefined && <span className={css.note} role="status">
      {t('autoRechargeCard')} <a href={cardUrl} target="_blank" rel="noreferrer">{t('autoRechargeCardOpen')}</a>
    </span>}
    {failed && <span className={css.warning} role="alert">{t('autoRechargeError')}</span>}
  </>
}
