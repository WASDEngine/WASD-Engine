// @vitest-environment jsdom
/**
 * WASD Engine's auto recharge switch in the shipped client composition (fork-owned drift spec; `wasdengine/FORK.md`
 * lists the fork changes): the account operation calls the account Remote with the client identity, then reads the
 * balance again, so Settings › Account shows the new state; a refused call throws, and an absent account reads
 * nothing.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { AccountDetails, AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'

const it = createClientTest({ roster: webApp })
const stored: AccountView = {
  status: 'credential-stored', attempt: null,
  links: { usageUrl: 'https://wasdengine.example/usage', topUpUrl: 'https://wasdengine.example/top_up' },
}
/** @param enabled - whether auto recharge is on. @returns a ready balance whose allowance carries the switch. */
function balance(enabled: boolean): AccountDetails['balance'] {
  return {
    status: 'ready', value: [], bonusWallets: [],
    allowance: { remainingPercent: 0, remainingShare: 0, refreshesAt: '2026-12-01T00:00:00Z', autoRecharge: { enabled } },
  }
}
function operations(c: TestClient): AccountSectionInjected {
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  return injected as AccountSectionInjected
}
beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('switches auto recharge through the account Remote, then reads the balance again', async ({ start }) => {
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance(false)))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance(false)) })
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance(true)))
  c.mock.remote.account.setAutoRecharge.mockResolvedValueOnce(ok({ enabled: true }))
  await expect(actions.setAutoRecharge!(true)).resolves.toEqual({ enabled: true })
  expect(c.mock.remote.account.setAutoRecharge).toHaveBeenCalledExactlyOnceWith(true, expect.objectContaining({ version: '0.0.0-test' }))
  expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance(true))

  c.mock.remote.account.setAutoRecharge.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  await expect(actions.setAutoRecharge!(false)).rejects.toThrow('account auto recharge failed')
  c.mock.remote.account.getBalance.mockClear()
  c.mock.remote.account.setAutoRecharge.mockResolvedValueOnce(ok(null))
  await expect(actions.setAutoRecharge!(false)).resolves.toBeNull()
  expect(c.mock.remote.account.getBalance).not.toHaveBeenCalled()
}, 60_000)
