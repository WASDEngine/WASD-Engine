/** Available onboarding credit includes both purchased and granted wallets. */
import { Big } from 'big.js'
import type { AccountSnapshot } from './AccountSection.tsx'

/**
 * Check purchased and granted credit without treating a pending query as zero.
 * A platform that reports no wallet at all does not bill by credit (WASDEngine fork).
 * @param balance - current account balance result.
 * @returns whether either wallet group has positive credit, or the platform reports no wallets.
 */
export function hasOnboardingCredit(balance: NonNullable<AccountSnapshot['details']>['balance']): boolean {
  if (balance?.status !== 'ready') return false
  const wallets = [...balance.value, ...balance.bonusWallets]
  return wallets.length === 0 || wallets.some(wallet => new Big(wallet.balance).gt(0))
}
