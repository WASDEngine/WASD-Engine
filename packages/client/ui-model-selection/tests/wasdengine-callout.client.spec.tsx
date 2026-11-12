// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the callouts beside the composer's model seat: the seat renders
 * `conversation.input.model.callout` after its trigger with the trigger's CSS anchor name, whether its menu is open,
 * and whether the composer is locked, and renders none while the Session cannot select a model or has none selected.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'
import type { ModelCalloutOwner } from '../src/client/wasdengine-callout.ts'

afterEach(cleanup)

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? (commonEn as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const state: ModelDirectoryState = {
  current: { provider: 'deepseek-account', model: 'flash', reasoningEffort: 'high' },
  routable: true,
  groups: [{
    id: 'deepseek-account',
    name: 'Provider',
    models: [{ id: 'flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' } }],
  }],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
}

function seat(options: { readonly available?: boolean; readonly locked?: boolean; readonly directory?: ModelDirectoryState } = {}) {
  const renderSlot = vi.fn((name: string, _owner: object, slotOptions?: { readonly fallback?: ReactNode }) =>
    name === 'conversation.input.model.callout' ? <span data-testid="callout" /> : slotOptions?.fallback ?? null)
  render(<ModelSelect renderSlot={renderSlot} locked={options.locked ?? false} available={options.available ?? true}
    directory={createSnapshotStore(options.directory ?? state)} load={vi.fn()} resolveText={text => typeof text === 'string' ? text : text.en}
    select={vi.fn()} t={t} />)
  return {
    callouts: (): ModelCalloutOwner[] => renderSlot.mock.calls
      .filter(call => call[0] === 'conversation.input.model.callout')
      .map(call => ({ ...(call[1] as OwnerOf<'conversation.input.model.callout'>) })),
  }
}

it('renders the callouts after the trigger with its anchor name and the menu and lock state', () => {
  const { callouts } = seat()
  const trigger = screen.getByRole('button', { name: 'Reasoning effort, current High' })
  const anchor = trigger.style.getPropertyValue('--dsh-model-anchor')
  expect(anchor).toMatch(/^--dsh-model-/u)
  expect(callouts().at(-1)).toEqual({ anchor, menuOpen: false, locked: false })
  expect(trigger.nextElementSibling).toBe(screen.getByTestId('callout'))
  fireEvent.click(trigger)
  expect(callouts().at(-1)).toEqual({ anchor, menuOpen: true, locked: false })
  cleanup()
  expect(seat({ locked: true }).callouts().at(-1)?.locked).toBe(true)
})

it('renders no callout while the Session cannot select a model or has none selected', () => {
  expect(seat({ available: false }).callouts()).toEqual([])
  expect(screen.queryByTestId('callout')).toBeNull()
  cleanup()
  expect(seat({ directory: { ...state, current: null, groups: [], status: 'loading' } }).callouts()).toEqual([])
  expect(screen.queryByTestId('callout')).toBeNull()
})
