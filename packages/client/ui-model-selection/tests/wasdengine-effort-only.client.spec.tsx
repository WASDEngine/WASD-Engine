// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the composer's model seat: while WASD Engine's own model, served by the account provider,
 * is selected, the trigger shows the reasoning effort alone and the menu offers the effort and the session options,
 * such as agent teamwork, without the Model row; another provider's model keeps upstream's seat.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'
import { WASDENGINE_MODEL_PROVIDER, wasdengineEffortOnly } from '../src/client/wasdengine-effort-only.ts'

afterEach(cleanup)

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? (commonEn as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const resolveText: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.en

const reasoning = { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }

function state(provider: string): ModelDirectoryState {
  return {
    current: { provider, model: 'flash', reasoningEffort: 'high' },
    routable: true,
    groups: [{ id: provider, name: 'Provider', models: [{ id: 'flash', name: 'DeepSeek-V4.1-Flash', reasoning }] }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
  }
}

/** Stands in for the session options occupant, such as the agent teamwork switch, and draws each model label's fallback. */
const renderSlot: ComponentProps<typeof ModelSelect>['renderSlot'] = (name, _owner, options) =>
  name === 'conversation.input.model.options' ? <button type="button" role="menuitem">Enable agent teamwork</button> : options?.fallback ?? null

function seat(provider: string): void {
  render(<ModelSelect renderSlot={renderSlot} locked={false} available directory={createSnapshotStore(state(provider))} load={vi.fn()}
    resolveText={resolveText} select={vi.fn()} t={t} />)
}

it('names the account provider as WASD Engine\'s own model', () => {
  expect(WASDENGINE_MODEL_PROVIDER).toBe('deepseek-account')
  expect(wasdengineEffortOnly('deepseek-account')).toBe(true)
  expect(wasdengineEffortOnly('openrouter')).toBe(false)
  expect(wasdengineEffortOnly(undefined)).toBe(false)
})

it('shows only the effort and the session options for WASD Engine\'s own model', () => {
  seat('deepseek-account')
  const trigger = screen.getByRole('button', { name: 'Reasoning effort, current High' })
  expect(trigger.textContent).toBe('High')
  expect(trigger.title).toBe('High')
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['EffortHigh', 'Enable agent teamwork'])
  expect(screen.queryByText('Model')).toBeNull()
  // Leaving the effort list returns focus to the Effort row, now the first row.
  fireEvent.click(screen.getAllByRole('menuitem')[0]!)
  act(() => { fireEvent.keyDown(document.activeElement ?? trigger, { key: 'Escape' }) })
  expect(document.activeElement?.textContent).toBe('EffortHigh')
})

it('keeps the model name and the Model row for another provider', () => {
  seat('openrouter')
  const trigger = screen.getByRole('button', { name: 'Select model, current DeepSeek-V4.1-Flash, reasoning effort High' })
  expect(trigger.textContent).toBe('DeepSeek-V4.1-FlashHigh')
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['ModelDeepSeek-V4.1-Flash', 'EffortHigh', 'Enable agent teamwork'])
})
