// @vitest-environment jsdom
/**
 * WASD Engine's last step of the Desktop introduction (fork-owned drift spec; `wasdengine/FORK.md` lists the fork
 * changes): while another plugin occupies `settings.account.onboarding.agents`, the detail level, or the purpose that
 * skips it, leads to the step instead of finishing; the step gets the introduction's heading, classes, and a finish
 * action, Back returns to the choice before it, and it offers no Skip. Without an occupant the introduction finishes
 * as upstream's does, and a saved step whose occupant is gone finishes it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopOnboarding } from '../src/client/DesktopOnboarding.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from '../src/client/onboarding-contract.ts'
import type { OnboardingAgentsOwner } from '../src/client/wasdengine-onboarding-agents.tsx'
import { en } from '../src/client/locales.ts'
import fork from '../src/client/wasdengine-onboarding.module.css'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(step: DesktopOnboardingState['progress']['step'], withAgents: boolean,
  purpose: DesktopOnboardingState['progress']['purpose'] = null) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const complete = vi.fn(async (_reason: 'completed' | 'skipped') => true)
  const update = vi.fn(async (_change: Parameters<DesktopOnboardingProps['update']>[0]) => true)
  const owners: OnboardingAgentsOwner[] = []
  const renderAgents = (owner: OnboardingAgentsOwner) => {
    owners.push(owner)
    return <div className={owner.classNames.content} data-agents-step>
      <div className={owner.classNames.copy}><h1 id={owner.headingId} ref={owner.heading} tabIndex={-1}>Set up with another agent</h1></div>
      <div className={owner.classNames.primaryAction}>
        <button type="button" className={owner.classNames.action} onClick={owner.next}>Continue</button>
      </div>
    </div>
  }
  function App() {
    const [state, setState] = useState<DesktopOnboardingState>({
      status: 'ready', visible: true, error: null, creditFunded: false,
      progress: { version: 1, step, purpose, process: null, completion: null, usage: 'compact', developerTools: false },
    })
    return <DesktopOnboarding locale="en" state={state} t={key => en[key]} complete={complete} retry={async () => true}
      renderAgents={withAgents ? renderAgents : undefined}
      update={async (change) => {
        const saved = await update(change)
        setState(current => ({ ...current, progress: saved ? { ...current.progress, ...change } : current.progress }))
        return saved
      }}
      account={{ view: { status: 'credential-stored', attempt: null, links: { usageUrl: '', topUpUrl: '' } }, avatar: undefined, failed: false, details: {} }} />
  }
  render(<App />)
  return { complete, update, owners }
}

it('goes from the detail level to the last step, which finishes the introduction', async () => {
  const operations = mount('process', true)
  await act(async () => { fireEvent.click(screen.getAllByRole('radio')[0]!) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.onboardingEnter })) })
  expect(operations.update).toHaveBeenLastCalledWith({ step: 'agents' })
  expect(operations.complete).not.toHaveBeenCalled()
  expect(document.querySelector('[data-desktop-onboarding="agents"] [data-agents-step]')).not.toBeNull()
  const heading = screen.getByRole('heading', { level: 1 })
  expect(document.activeElement).toBe(heading)
  expect(document.querySelector('[data-desktop-onboarding="agents"]')?.getAttribute('aria-labelledby')).toBe(heading.id)
  const owner = operations.owners.at(-1)!
  expect(owner.busy).toBe(false)
  expect(owner.classNames.content.split(' ')).toContain(fork.agents)
  expect(screen.queryByRole('button', { name: en.onboardingSkip })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })) })
  expect(operations.complete).toHaveBeenCalledExactlyOnceWith('completed')
})

it('reaches the last step from the purpose that skips the detail level, and Back returns to that purpose', async () => {
  const operations = mount('purpose', true)
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: en.onboardingOffice })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.onboardingContinue })) })
  expect(operations.update).toHaveBeenLastCalledWith({ step: 'agents' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.onboardingBack })) })
  expect(operations.update).toHaveBeenLastCalledWith({ step: 'purpose' })
  expect(operations.complete).not.toHaveBeenCalled()
})

it('returns from the last step to the detail level', async () => {
  const operations = mount('agents', true, 'development')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.onboardingBack })) })
  expect(operations.update).toHaveBeenLastCalledWith({ step: 'process' })
})

it('finishes after the detail level, as upstream does, without an occupant', async () => {
  const operations = mount('process', false)
  await act(async () => { fireEvent.click(screen.getAllByRole('radio')[0]!) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.onboardingEnter })) })
  expect(operations.complete).toHaveBeenCalledExactlyOnceWith('completed')
  expect(operations.update).not.toHaveBeenCalledWith({ step: 'agents' })
})

it('finishes a saved last step whose occupant is gone', () => {
  const operations = mount('agents', false, 'development')
  expect(operations.complete).toHaveBeenCalledExactlyOnceWith('completed')
})
