// @vitest-environment jsdom
/**
 * WASD Engine's AI usage row (fork-owned drift spec; `wasdengine/FORK.md` lists the fork changes): when the account
 * service reports the allowance, Settings › Account shows the whole percent left in the balance row, a bar of the
 * exact share left, the day it refreshes, and the credits left as a share of a month's usage, and no dollar amount;
 * without it, the row keeps upstream's wallets. While the account can use auto recharge, a row has its switch, which
 * names no amount and opens the card page in the browser when a card is needed; while the account has a referral link,
 * a row shares it with a copy button. The registered dictionaries carry WASD Engine's own messages in every language.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AccountAllowance, AccountAutoRechargeChange, AccountDetails, AccountReferral } from '@deepseek-ai/dsh-deepseek-account/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountSection, type AccountSectionInjected, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { WASDENGINE_ACCOUNT_MESSAGES } from '../src/client/locales/wasdengine.ts'
import { brandAccountDictionaries, withWasdengineMessages } from '../src/client/wasdengine-copy.ts'
import css from '../src/client/wasdengine-allowance.module.css'

afterEach(() => { cleanup(); document.documentElement.lang = ''; vi.restoreAllMocks() })

const dictionaries = { en, zh, ja, es, fr, de, ru, pt }
const branded = brandAccountDictionaries(dictionaries)
const theme: ThemeSnapshot = {
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}
const refreshesAt = '2026-12-01T00:00:00+00:00'

function mount(balance: AccountDetails['balance'], language: keyof typeof branded = 'en', extra: Partial<AccountSectionInjected> = {}) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : language
  const snapshot: AccountSnapshot = {
    view: { status: 'credential-stored', attempt: null, links: { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' } },
    details: { balance }, avatar: undefined, failed: false,
  }
  const operations: AccountSectionInjected = {
    hooks: {
      account: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} },
    },
    hasRunningAccountTasks: vi.fn(async () => false),
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    refreshAccount: vi.fn(() => Promise.resolve()), avatarFailed: vi.fn(),
    start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()), signOut: vi.fn(() => Promise.resolve()),
    ...extra,
  }
  const globals = {} as GlobalStandardProps
  const view = render(<AccountSection {...globals} {...operations}
    useAccount={selector => selector(snapshot)} useTheme={selector => selector(theme)}
    close={() => {}} t={makeTranslate(branded[language])} />)
  return view.container
}

const allowance = (remainingPercent: number, remainingShare: number): AccountAllowance =>
  ({ remainingPercent, remainingShare, refreshesAt })
const ready = (left?: AccountAllowance): AccountDetails['balance'] =>
  ({ status: 'ready', value: [], bonusWallets: [], ...(left === undefined ? {} : { allowance: left }) })

describe('WASD Engine AI usage row', () => {
  it('shows the percent left, a bar of the share left, and the refresh day, without dollars', () => {
    const container = mount(ready(allowance(38, 0.383)))
    expect(screen.getByText(branded.en.balance).parentElement?.textContent).toBe(`${branded.en.balance}38%`)
    expect(screen.getByText('Refreshes December 1').textContent).toBeTruthy()
    const meter = container.querySelector(`.${css.meter}`)
    expect(meter?.getAttribute('aria-hidden')).toBe('true')
    expect(meter?.hasAttribute('data-empty')).toBe(false)
    expect(container.querySelector<HTMLElement>(`.${css.fill}`)?.style.width).toBe('38.3%')
    expect(container.textContent).not.toMatch(/[$¥]/u)
  })

  it('says less than 1% while anything is left, and 0% with an amber track once nothing is', () => {
    mount(ready(allowance(0, 0.005)))
    expect(screen.getByText('Less than 1%').textContent).toBeTruthy()
    cleanup()
    const container = mount(ready(allowance(0, 0)))
    expect(screen.getByText('0%').textContent).toBeTruthy()
    expect(container.querySelector(`.${css.meter}`)?.getAttribute('data-empty')).toBe('')
  })

  it('formats the percent and the day in the page language', () => {
    mount(ready(allowance(38, 0.383)), 'de')
    expect(screen.getByText(/^38\s%$/u).textContent).toBeTruthy()
    expect(screen.getByText('Wird am 1. Dezember erneuert').textContent).toBeTruthy()
    cleanup()
    mount(ready(allowance(0, 0.005)), 'zh')
    expect(screen.getByText('不到 1%').textContent).toBeTruthy()
    expect(screen.getByText('将于12月1日刷新').textContent).toBeTruthy()
  })

  it('shows the credits left under the refresh day, as a share of a month\'s usage', () => {
    const container = mount(ready({ ...allowance(0, 0), creditsPercent: 250 }))
    expect(screen.getByText('Credits: 250% of a month\'s AI usage').textContent).toBeTruthy()
    expect(container.textContent).not.toMatch(/[$¥]/u)
    cleanup()
    mount(ready({ ...allowance(0, 0), creditsPercent: 0 }))
    expect(screen.getByText('Credits: less than 1% of a month\'s AI usage').textContent).toBeTruthy()
    cleanup()
    mount(ready(allowance(38, 0.383)))
    expect(screen.queryByText(/^Credits/u)).toBeNull()
    cleanup()
    mount(ready({ ...allowance(0, 0), creditsPercent: 250 }), 'de')
    expect(screen.getByText(/^Guthaben: 250\s% der monatlichen KI-Nutzung$/u).textContent).toBeTruthy()
  })

  it('reads Unlimited with no bar on the Unlimited tier', () => {
    const container = mount(ready({ ...allowance(100, 1), unlimited: true }))
    expect(screen.getByText(branded.en.balance).parentElement?.textContent).toBe(`${branded.en.balance}Unlimited`)
    expect(screen.getByText('No monthly limit on AI usage').textContent).toBeTruthy()
    expect(container.querySelector(`.${css.meter}`)).toBeNull()
    expect(container.textContent).not.toContain('Refreshes')
    cleanup()
    mount(ready({ ...allowance(100, 1), unlimited: true }), 'ja')
    expect(screen.getByText('無制限').textContent).toBeTruthy()
  })

  it('keeps the wallets of a service that reports no allowance', () => {
    const container = mount({ status: 'ready', value: [{ currency: 'USD', balance: '2.00' }], bonusWallets: [] })
    expect(screen.getByText('$2.00').textContent).toBeTruthy()
    expect(container.querySelector(`.${css.meter}`)).toBeNull()
  })
})

describe('WASD Engine auto recharge switch', () => {
  const recharging = (enabled: boolean, failure?: string): AccountDetails['balance'] => ready({
    ...allowance(0, 0), autoRecharge: { enabled, ...(failure === undefined ? {} : { failure }) },
  })
  const label = 'Auto recharge credits when you run out.'

  it('shows the switch, worded as the plans page words it, only while the account can use it', () => {
    const setAutoRecharge = vi.fn<(enabled: boolean) => Promise<AccountAutoRechargeChange | null>>()
    mount(recharging(true), 'en', { setAutoRecharge })
    expect(screen.getByText(label).textContent).toBeTruthy()
    expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true')
    cleanup()
    mount(ready(allowance(38, 0.383)), 'en', { setAutoRecharge })
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    mount(recharging(false))
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('turns auto recharge off at once, and shows the requested state while the call runs', async () => {
    const call = Promise.withResolvers<AccountAutoRechargeChange | null>()
    const setAutoRecharge = vi.fn(() => call.promise)
    mount(recharging(true), 'en', { setAutoRecharge })
    const toggle = screen.getByRole('switch', { name: label })
    fireEvent.click(toggle)
    expect(setAutoRecharge).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(true)
    await act(async () => { call.resolve({ enabled: false }); await call.promise })
    expect(toggle.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/Save a card/u)).toBeNull()
  })

  it('opens the card page in the browser, links it, and reads the account again when the app regains focus', async () => {
    const card = 'https://wasdengine.example/billing/checkout?session_id=cs_test_1'
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const refreshAccount = vi.fn(() => Promise.resolve())
    const setAutoRecharge = vi.fn(() => Promise.resolve<AccountAutoRechargeChange | null>({ enabled: false, cardUrl: card }))
    mount(recharging(false), 'en', { setAutoRecharge, refreshAccount })
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: label })) })
    expect(open).toHaveBeenCalledExactlyOnceWith(card, '_blank', 'noopener,noreferrer')
    const note = screen.getByText(/^Save a card in your browser/u)
    expect([note.textContent, note.getAttribute('role')]).toEqual(['Save a card in your browser to turn on auto recharge. Open again', 'status'])
    expect(screen.getByRole('link', { name: 'Open again' }).getAttribute('href')).toBe(card)
    expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('false')
    window.dispatchEvent(new Event('focus'))
    expect(refreshAccount).toHaveBeenCalledOnce()
  })

  it('drops the card link once a read reports auto recharge on', async () => {
    const card = 'https://wasdengine.example/billing/checkout?session_id=cs_test_1'
    vi.spyOn(window, 'open').mockReturnValue(null)
    const refreshAccount = vi.fn(() => Promise.resolve())
    const setAutoRecharge = vi.fn(() => Promise.resolve<AccountAutoRechargeChange | null>({ enabled: false, cardUrl: card }))
    let balance = recharging(false)
    const snapshot = (): AccountSnapshot => ({
      view: { status: 'credential-stored', attempt: null, links: { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' } },
      details: { balance }, avatar: undefined, failed: false,
    })
    const props = {
      hooks: {
        account: { getSnapshot: snapshot, subscribe: () => () => {} },
        theme: { getSnapshot: () => theme, subscribe: () => () => {} },
      },
      hasRunningAccountTasks: vi.fn(async () => false), contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
      refreshAccount, avatarFailed: vi.fn(),
      start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()), signOut: vi.fn(() => Promise.resolve()),
      setAutoRecharge,
    } satisfies AccountSectionInjected
    const globals = {} as GlobalStandardProps
    const section = () => <AccountSection {...globals} {...props} useAccount={selector => selector(snapshot())}
      useTheme={selector => selector(theme)} close={() => {}} t={makeTranslate(branded.en)} />
    const view = render(section())
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: label })) })
    expect(screen.getByText(/^Save a card in your browser/u)).toBeTruthy()
    balance = recharging(true)
    view.rerender(section())
    expect(screen.queryByText(/Save a card/u)).toBeNull()
    expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true')
    window.dispatchEvent(new Event('focus'))
    expect(refreshAccount).not.toHaveBeenCalled()
  })

  it('says why a failed charge turned auto recharge off, and reports a switch that failed', async () => {
    const setAutoRecharge = vi.fn(() => Promise.reject(new Error('account auto recharge failed')))
    mount(recharging(false, 'Your card was declined.'), 'en', { setAutoRecharge })
    expect(screen.getByText(/^Auto recharge turned off/u).textContent).toBe(
      'Auto recharge turned off because its last charge failed: Your card was declined. Turn it on again to save another card.')
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: label })) })
    expect(screen.getByRole('alert').textContent).toBe('Auto recharge could not be changed. Try again.')
    expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('false')
  })

  it('names no amount in any language', () => {
    for (const language of Object.keys(dictionaries) as (keyof typeof branded)[]) {
      const container = mount(recharging(true), language, { setAutoRecharge: vi.fn() })
      const name = screen.getByRole('switch').getAttribute('aria-label')
      expect(name, language).toBe(branded[language].autoRecharge)
      expect(name, language).not.toMatch(/[$¥\d]/u)
      expect(container.textContent, language).not.toMatch(/[$¥]/u)
      cleanup()
    }
  })
})

describe('WASD Engine referral row', () => {
  const link = 'https://wasdengine.example/?ref=k3x9q2mw'
  const sharing = (joined: number, left?: AccountAllowance): AccountDetails['balance'] => {
    const referral: AccountReferral = { url: link, joined }
    return { ...ready(left), referral } as AccountDetails['balance']
  }

  it('shares the link with a copy button and says it earns free credits, with no amount', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const container = mount(sharing(0, allowance(38, 0.383)))
    expect(screen.getByText('Refer friends').textContent).toBeTruthy()
    expect(screen.getByText('Earn free credits when friends join WASD Engine with your link.').textContent).toBeTruthy()
    expect(screen.getByText(link).textContent).toBe(link)
    expect(screen.queryByText(/^Friends who joined/u)).toBeNull()
    expect(container.textContent).not.toMatch(/[$¥]/u)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(link)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('counts the friends who joined, in the page language', () => {
    mount(sharing(1200), 'de')
    expect(screen.getByText('Freunde einladen').textContent).toBeTruthy()
    expect(screen.getByText(/^Beigetretene Freunde: 1\.200$/u).textContent).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Link kopieren' })).toBeTruthy()
  })

  it('shows no row without a link', () => {
    mount(ready(allowance(38, 0.383)))
    expect(screen.queryByText('Refer friends')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })
})

describe('WASD Engine account messages', () => {
  it.each(Object.keys(dictionaries))('registers the AI usage row messages in %s', (id) => {
    const messages = branded[id as keyof typeof branded]
    expect(WASDENGINE_ACCOUNT_MESSAGES[id], id).toBeDefined()
    expect(messages.allowanceUnderOnePercent).toContain('{percent}')
    expect(messages.allowanceRefreshes).toContain('{date}')
    expect(messages.allowanceCredits).toContain('{percent}')
    expect(messages.allowanceCreditsUnderOnePercent).toContain('{percent}')
    expect(messages.referralJoined).toContain('{count}')
    for (const key of ['autoRecharge', 'referralTitle', 'referralDescription', 'referralCopy', 'referralCopied'] as const) {
      expect(messages[key], key).toBeTruthy()
    }
    // The copy names no amount, of usage, credits, or a charge.
    expect(Object.values(WASDENGINE_ACCOUNT_MESSAGES[id]!).filter(message => /[$¥]|\{amount\}/u.test(message))).toEqual([])
    expect(messages.allowanceUnlimited && messages.allowanceNoLimit).toBeTruthy()
    expect(messages.autoRechargeFailed).toContain('{reason}')
    for (const key of ['autoRechargeCard', 'autoRechargeCardOpen', 'autoRechargeError'] as const) expect(messages[key]).toBeTruthy()
  })

  it('adds the messages in English to a language without its own, and refuses a key a dictionary already has', () => {
    expect(withWasdengineMessages({ 'x-test': { balance: 'Balance' } })['x-test'])
      .toEqual({ balance: 'Balance', ...WASDENGINE_ACCOUNT_MESSAGES.en })
    expect(() => withWasdengineMessages({ en: { allowanceRefreshes: 'Renews {date}' } }))
      .toThrow('WASD Engine account messages: en already has a message allowanceRefreshes')
  })
})
