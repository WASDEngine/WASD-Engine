/**
 * WASD Engine's allowance and referral link (fork-owned drift spec; `wasdengine/FORK.md` lists the fork changes): the
 * balance read projects the `allowance` that the WASD Engine account service reports beside the wallets, with the
 * credits and the auto recharge switch, and the `referral` link, and drops a malformed one, or a malformed member,
 * without failing the wallet read. Neither carries a dollar amount. The referral link and the auto recharge switch's
 * reply may name only the service's own pages.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { readAccountDetail } from '../src/details.ts'
import { PlatformAuthError, requestAccount } from '../src/protocol.ts'
import { autoRechargeChange } from '../src/wasdengine-allowance.ts'

vi.mock('../src/protocol.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/protocol.ts')>(),
  requestAccount: vi.fn(),
}))

afterEach(() => { vi.mocked(requestAccount).mockReset() })

const readBalance = (summary: object) => {
  vi.mocked(requestAccount).mockResolvedValue(summary)
  return readAccountDetail('balance', 'https://platform.example', 'token', new AbortController().signal, {})
}

it('projects the allowance beside the wallets', async () => {
  const allowance = { remaining_percent: 38, remaining_share: 0.383, refreshes_at: '2026-12-01T00:00:00+00:00' }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance })).resolves.toEqual({
    status: 'ready', value: [], bonusWallets: [],
    allowance: { remainingPercent: 38, remainingShare: 0.383, refreshesAt: '2026-12-01T00:00:00+00:00' },
  })
  expect(requestAccount).toHaveBeenCalledWith('https://platform.example', '/api/v0/users/get_user_summary', 'token', expect.any(AbortSignal), {})
})

it.each([
  { remaining_percent: 38.5, remaining_share: 0.385, refreshes_at: '2026-12-01T00:00:00Z' },
  { remaining_percent: 38, remaining_share: 1.5, refreshes_at: '2026-12-01T00:00:00Z' },
  { remaining_percent: 38, remaining_share: 0.383, refreshes_at: 'December 1' },
  'all of it',
])('drops a malformed allowance and keeps the wallets: %j', async (allowance) => {
  const wallets = [{ currency: 'USD', balance: '2.00' }]
  await expect(readBalance({ normal_wallets: wallets, bonus_wallets: [], allowance }))
    .resolves.toEqual({ status: 'ready', value: wallets, bonusWallets: [] })
})

it('reports no allowance for a service that sends none', async () => {
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [] }))
    .resolves.toEqual({ status: 'ready', value: [], bonusWallets: [] })
})

it('projects the credits and the auto recharge switch with the allowance', async () => {
  const allowance = {
    remaining_percent: 0, remaining_share: 0, refreshes_at: '2026-12-01T00:00:00Z', credits_allowance_percent: 250,
    auto_recharge: { enabled: true, failure: null },
  }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance })).resolves.toEqual({
    status: 'ready', value: [], bonusWallets: [],
    allowance: {
      remainingPercent: 0, remainingShare: 0, refreshesAt: '2026-12-01T00:00:00Z', creditsPercent: 250,
      autoRecharge: { enabled: true },
    },
  })
  const failed = { ...allowance, auto_recharge: { enabled: false, failure: 'Your card was declined.' } }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance: failed })).resolves.toMatchObject({
    allowance: { autoRecharge: { enabled: false, failure: 'Your card was declined.' } },
  })
})

it('ignores the dollar fields that services before the referral link sent', async () => {
  // Earlier services sent credits as a share of one recharge and the recharge's price; the app shows neither.
  const allowance = {
    remaining_percent: 38, remaining_share: 0.383, refreshes_at: '2026-12-01T00:00:00Z', credits_percent: 85,
    auto_recharge: { enabled: true, charge_usd: 10, failure: null },
  }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance })).resolves.toEqual({
    status: 'ready', value: [], bonusWallets: [],
    allowance: { remainingPercent: 38, remainingShare: 0.383, refreshesAt: '2026-12-01T00:00:00Z', autoRecharge: { enabled: true } },
  })
})

it('projects the Unlimited tier, and drops a malformed flag', async () => {
  const allowance = { remaining_percent: 100, remaining_share: 1, refreshes_at: '2026-12-01T00:00:00Z', unlimited: true }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance })).resolves.toMatchObject({
    allowance: { remainingPercent: 100, remainingShare: 1, unlimited: true },
  })
  for (const unlimited of [false, 'yes']) {
    const balance = await readBalance({ normal_wallets: [], bonus_wallets: [], allowance: { ...allowance, unlimited } })
    expect(balance.status === 'ready' && balance.allowance?.unlimited, String(unlimited)).toBeUndefined()
  }
})

it.each([
  { credits_allowance_percent: -1, auto_recharge: { enabled: 'yes', failure: null } },
  { credits_allowance_percent: 8.5, auto_recharge: { enabled: true, failure: 7 } },
  { credits_allowance_percent: '85%', auto_recharge: { enabled: true } },
])('drops a malformed credits or switch report and keeps the allowance: %j', async (members) => {
  const allowance = { remaining_percent: 38, remaining_share: 0.383, refreshes_at: '2026-12-01T00:00:00Z', ...members }
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], allowance })).resolves.toEqual({
    status: 'ready', value: [], bonusWallets: [],
    allowance: { remainingPercent: 38, remainingShare: 0.383, refreshesAt: '2026-12-01T00:00:00Z' },
  })
})

it('accepts a switch reply whose card page is the service\'s own, and refuses any other', () => {
  const origin = 'https://platform.example'
  const card = `${origin}/billing/checkout?session_id=cs_test_1`
  expect(autoRechargeChange({ enabled: true, card_url: null }, origin, false)).toEqual({ enabled: true })
  expect(autoRechargeChange({ enabled: false, card_url: card }, origin, false)).toEqual({ enabled: false, cardUrl: card })
  // A development proxy maps the page to the configured origin, as it maps the sign-in pages.
  expect(autoRechargeChange({ enabled: false, card_url: 'https://proxy.example/billing/checkout?session_id=cs_1' }, origin, true))
    .toEqual({ enabled: false, cardUrl: `${origin}/billing/checkout?session_id=cs_1` })
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  for (const reply of [
    { enabled: false, card_url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
    { enabled: false, card_url: `${origin}/upgrade` },
    { enabled: false, card_url: 'not a url' },
    { enabled: 'no', card_url: null },
    null,
  ]) {
    expect(() => autoRechargeChange(reply, origin, false), JSON.stringify(reply)).toThrow(PlatformAuthError)
  }
  error.mockRestore()
})

it('projects the referral link on the service\'s own front page, and drops any other', async () => {
  const link = 'https://platform.example/?ref=k3x9q2mw'
  await expect(readBalance({ normal_wallets: [], bonus_wallets: [], referral: { url: link, joined: 2 } })).resolves.toEqual({
    status: 'ready', value: [], bonusWallets: [], referral: { url: link, joined: 2 },
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  for (const referral of [
    { url: 'https://elsewhere.example/?ref=k3x9q2mw', joined: 0 },
    { url: 'https://platform.example/signup?ref=k3x9q2mw', joined: 0 },
    { url: 'https://platform.example/?ref=k3x9q2mw&next=/upgrade', joined: 0 },
    { url: 'https://platform.example/?ref=<script>', joined: 0 },
    { url: 'https://platform.example/', joined: 0 },
    { url: 'javascript:alert(1)', joined: 0 },
    { url: link, joined: -1 },
    { url: link },
    'k3x9q2mw',
  ]) {
    await expect(readBalance({ normal_wallets: [], bonus_wallets: [], referral }), JSON.stringify(referral))
      .resolves.toEqual({ status: 'ready', value: [], bonusWallets: [] })
  }
  error.mockRestore()
})
