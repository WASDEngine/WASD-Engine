/** Pure view inputs for the desktop onboarding flow. */
import type { ReactNode } from 'react'
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import type { OnboardingProgress } from '../onboarding-settings.ts'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { PlatformPages } from './platform-pages.ts'
import type { AccountKey } from './locales.ts'
import type { OnboardingAgentsOwner } from './wasdengine-onboarding-agents.tsx'

/** Render state with pending choices previewed over durable Host progress. */
export interface DesktopOnboardingState {
  status: 'loading' | 'ready' | 'saving' | 'error'
  visible: boolean
  progress: OnboardingProgress
  /** Whether positive balance was already available at first credit-page entry; pending uses ordinary actions, never persisted. */
  creditFunded: boolean
  error: 'settings' | null
}

/** User-selected fields accepted before final preference application. */
export type OnboardingChange = Partial<Pick<OnboardingProgress, 'step' | 'purpose' | 'process'>>

/** Data and callbacks consumed by the presentational desktop flow. */
export interface DesktopOnboardingProps {
  /** Keep the saved final step visible while revealing the workspace. */
  exiting?: boolean
  /** Desktop collection callback; absent when analytics is disabled. */
  track?: TrackProductEvent
  state: DesktopOnboardingState
  account: AccountSnapshot
  /** Desktop-only: show the shared native recharge page; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']
  /** WASD Engine: render the last step, another plugin's; absent, the introduction ends after the detail level. */
  renderAgents?: ((owner: OnboardingAgentsOwner) => ReactNode) | undefined
  update(this: void, change: OnboardingChange): Promise<boolean>
  complete(this: void, reason: 'completed' | 'skipped'): Promise<boolean>
  retry(this: void): Promise<boolean>
  /** Active interface language selects the matching illustration artwork. */
  locale: string
  t: (key: AccountKey) => string
}
