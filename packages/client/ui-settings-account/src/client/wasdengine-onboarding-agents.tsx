/**
 * WASD Engine's extension point of the Desktop introduction (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): its last step, which another plugin contributes, such as setting WASD Engine up with another agent on
 * this computer. While the slot has an occupant, the introduction shows the step after the detail level, or after the
 * purpose when that choice skips the detail level; without one, the introduction ends there. The occupant draws the
 * whole page inside the introduction's page: its heading, which takes {@link OnboardingAgentsOwner.heading} so the
 * introduction can focus it, its content, and the action that calls {@link OnboardingAgentsOwner.next}. The
 * introduction keeps its Back button under the page. {@link WasdengineDesktopOnboardingEntry}, the `desktop-onboarding`
 * overlay entry that declares the slot, hands upstream's entry the `renderAgents` that draws the step.
 */
import type { RefObject } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { DesktopOnboardingEntry, type DesktopOnboardingInjected } from './DesktopOnboardingEntry.tsx'

/** Key of the introduction's last step. */
export const AGENTS_STEP_SLOT = 'settings.account.onboarding.agents'

/** Classes of the introduction's own elements, which the step uses to look like the other steps. */
export interface OnboardingAgentsClassNames {
  /** The step's centered column. */
  readonly content: string
  /** The heading block, which holds the `h1` heading and the paragraph under it. */
  readonly copy: string
  /** The paragraph under the heading. */
  readonly subtitle: string
  /** The row under the column that holds the step's action. */
  readonly primaryAction: string
  /** The step's action button. */
  readonly action: string
}

/** What the introduction passes to its last step. */
export interface OnboardingAgentsOwner {
  /** The heading's ref; the introduction focuses the heading when the step appears. */
  readonly heading: RefObject<HTMLHeadingElement>
  /** The heading's id, which names the introduction's page. */
  readonly headingId: string
  /** Whether the introduction is saving or changing steps; the step's action waits until it is not. */
  readonly busy: boolean
  /** Finish the introduction and reveal the app. */
  readonly next: () => void
  /** The introduction's classes. */
  readonly classNames: OnboardingAgentsClassNames
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The Desktop introduction's last step; without an occupant the introduction ends after the detail level. */
    'settings.account.onboarding.agents': { kind: 'single'; scope: 'root'; owner: OnboardingAgentsOwner }
  }
}

/** Registration-side dependencies of {@link WasdengineDesktopOnboardingEntry}: upstream's entry's, and the step's presence. */
export interface WasdengineDesktopOnboardingInjected extends DesktopOnboardingInjected {
  /** Whether a plugin occupies the introduction's last step, read at each render. */
  readonly agentsStep: () => boolean
}

/**
 * The `desktop-onboarding` overlay entry: upstream's {@link DesktopOnboardingEntry}, whose introduction ends with the
 * occupant of `settings.account.onboarding.agents` while a plugin occupies it.
 * @param props - upstream's entry's props, the step's presence, and the slot's renderer.
 * @returns upstream's entry.
 */
export function WasdengineDesktopOnboardingEntry({ agentsStep, renderSlot, ...props }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<WasdengineDesktopOnboardingInjected>
  & PropsRenderSlots<'settings.account.onboarding.agents'>) {
  const renderAgents = agentsStep() ? (owner: OnboardingAgentsOwner) => renderSlot(AGENTS_STEP_SLOT, owner) : undefined
  return <DesktopOnboardingEntry {...props} renderAgents={renderAgents} />
}
