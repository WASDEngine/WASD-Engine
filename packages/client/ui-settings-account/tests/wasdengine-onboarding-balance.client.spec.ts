/**
 * WASDEngine fork: the WASDEngine Platform reports no wallets because it does
 * not bill by credit, so Desktop onboarding must not ask for credits
 * (wasdengine/FORK.md). Platforms that report wallets keep the upstream rule.
 */

import { describe, expect, it } from 'vitest'
import { hasOnboardingCredit } from '../src/client/onboarding-balance.ts'

describe('onboarding credit on the WASDEngine fork', () => {
  it('treats a Platform that reports no wallets as funded', () => {
    expect(hasOnboardingCredit({ status: 'ready', value: [], bonusWallets: [] })).toBe(true)
  })

  it('requires positive credit when the Platform reports wallets', () => {
    expect(hasOnboardingCredit({ status: 'ready', value: [{ currency: 'USD', balance: '0' }], bonusWallets: [] })).toBe(false)
    expect(hasOnboardingCredit({ status: 'ready', value: [], bonusWallets: [{ currency: 'USD', balance: '0.01' }] })).toBe(true)
  })

  it('does not treat a pending or failed balance query as funded', () => {
    expect(hasOnboardingCredit(undefined)).toBe(false)
    expect(hasOnboardingCredit({ status: 'failed' })).toBe(false)
  })
})
