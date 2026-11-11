/**
 * WASD Engine's auto recharge switch on the account Remote (fork-owned drift spec; `wasdengine/FORK.md` lists the
 * fork changes): `setAutoRecharge` passes the call to the account provider and returns its outcome and failure
 * unchanged.
 */
import { Context } from '@deepseek-ai/cordis'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountAutoRechargeChange, AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { afterEach, expect, it, vi } from 'vitest'
import AccountController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const client: AccountClientMetadata = { version: '0.0.0-test', locale: 'en-US', timezoneOffsetSeconds: 0 }

it('delegates the auto recharge switch without altering its outcome or failure', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const change: AccountAutoRechargeChange = { enabled: false, cardUrl: 'https://platform.example/billing/checkout?session_id=cs_1' }
  const provider = { setAutoRecharge: vi.fn<DeepSeekAccount['setAutoRecharge']>().mockResolvedValue(change) }
  ctx.provide('deepseekAccount', provider as never)
  const controller = new AccountController(ctx)
  expect(await controller.setAutoRecharge(true, client)).toBe(change)
  expect(provider.setAutoRecharge).toHaveBeenCalledExactlyOnceWith(true, client)
  const failure = new Error('unavailable')
  provider.setAutoRecharge.mockRejectedValueOnce(failure)
  await expect(controller.setAutoRecharge(false, client)).rejects.toBe(failure)
})
