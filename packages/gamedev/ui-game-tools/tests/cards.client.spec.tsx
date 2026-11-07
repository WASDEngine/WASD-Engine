// @vitest-environment jsdom
/**
 * One game tool card in every state it can show: the package logo with its default-artwork fallback, the package text
 * and its fallback, the Off, Failed, and Not in this profile tags, the phase dot, the diagnostics, and the end control.
 */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameToolCard, ReadFailureNotice } from '../src/client/GameToolCard.tsx'
import { en } from '../src/client/locales.ts'
import type { GameToolEntry, GameToolSlot } from '../src/client/tools.ts'
import { BLENDER, BLENDER_ICON, entryId, GIMP, GODOT } from './fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const resolveText = (text: string | { readonly en: string }): string => typeof text === 'string' ? text : text.en

function slot(entry: GameToolEntry | undefined, moduleName = entry?.moduleName ?? '@deepseek-ai/dsh-godot'): GameToolSlot {
  return { moduleName, entry }
}

function card(tool: GameToolSlot, control?: ReactNode): HTMLElement {
  render(<ul><GameToolCard tool={tool} t={t} resolveText={resolveText} control={control} /></ul>)
  return screen.getByRole('listitem')
}

describe('GameToolCard', () => {
  it('shows a running tool with its package logo, title, and description and no tag', () => {
    const item = card(slot(BLENDER))
    const logo = item.querySelector('img')
    expect(logo?.getAttribute('src')).toBe(BLENDER_ICON)
    expect(logo?.getAttribute('alt')).toBe('')
    expect(logo?.getAttribute('width')).toBe('36')
    expect(logo?.getAttribute('height')).toBe('36')
    expect(logo?.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(item.getAttribute('data-game-tool')).toBe('@deepseek-ai/dsh-blender')
    expect(item.getAttribute('data-state')).toBe('on')
    expect(within(item).getByText('Blender').getAttribute('title')).toBe('@deepseek-ai/dsh-blender')
    expect(within(item).getByText('Build 3D models.')).toBeTruthy()
    for (const label of [en.offTag, en.failedTag, en.absentTag]) expect(within(item).queryByText(label)).toBeNull()
    expect(within(item).queryByRole('img')).toBeNull()
  })

  it('falls back to the default plugin artwork without an icon and after a failed decode', () => {
    const plain = card(slot(GODOT))
    expect(plain.querySelector('img')).toBeNull()
    expect(plain.querySelector('svg')).not.toBeNull()
    cleanup()
    const broken = card(slot(BLENDER))
    fireEvent.error(broken.querySelector('img')!)
    expect(broken.querySelector('img')).toBeNull()
    expect(broken.querySelector('svg')).not.toBeNull()
  })

  it('tags a tool the profile switched off', () => {
    const item = card(slot(GIMP))
    expect(item.getAttribute('data-state')).toBe('off')
    expect(within(item).getByText(en.offTag)).toBeTruthy()
  })

  it('tags a failed start and shows its diagnostic', () => {
    const item = card(slot({ ...GODOT, fiberPhase: 'failed', diagnostic: 'LibGodot is missing' }))
    expect(item.getAttribute('data-state')).toBe('failed')
    expect(within(item).getByText(en.failedTag)).toBeTruthy()
    expect(within(item).getByRole('status').textContent).toBe('Reason: LibGodot is missing')
  })

  it.each([
    ['pending', en.phasePending],
    ['loading', en.phaseLoading],
    ['unloading', en.phaseUnloading],
  ] as const)('marks the %s phase with a named dot', (fiberPhase, label) => {
    const item = card(slot({ ...BLENDER, fiberPhase }))
    const dot = within(item).getByRole('img', { name: label })
    expect(dot.getAttribute('title')).toBe(label)
  })

  it('keeps the dot of a tool that unloads after being switched off', () => {
    const item = card(slot({ ...GIMP, fiberPhase: 'unloading' }))
    expect(within(item).getByRole('img', { name: en.phaseUnloading })).toBeTruthy()
    expect(within(item).getByText(en.offTag)).toBeTruthy()
  })

  it('names a tool the profile does not mount by its package', () => {
    const item = card(slot(undefined, '@deepseek-ai/dsh-gimp'))
    expect(item.getAttribute('data-state')).toBe('absent')
    expect(within(item).getByText('@deepseek-ai/dsh-gimp')).toBeTruthy()
    expect(within(item).getByText(en.absentTag)).toBeTruthy()
    expect(item.querySelector('p')).toBeNull()
  })

  it('falls back to the package name without package text and drops an empty description', () => {
    const item = card(slot({
      entryId: entryId('bare'), moduleName: '@deepseek-ai/dsh-blender', enabled: true, fiberPhase: 'active', meta: { description: '' },
    }))
    expect(within(item).getByText('@deepseek-ai/dsh-blender')).toBeTruthy()
    expect(item.querySelector('p')).toBeNull()
  })

  it('shows a package metadata diagnostic', () => {
    const item = card(slot({ ...GODOT, meta: { title: 'Godot', error: 'icon exceeds 256 KiB' } }))
    expect(item.querySelector('[data-package-meta-error]')?.textContent).toBe('Package metadata error: icon exceeds 256 KiB')
  })

  it('ends with the control it is given', () => {
    const item = card(slot(BLENDER), <button type="button">switch</button>)
    expect(within(item).getByRole('button', { name: 'switch' })).toBeTruthy()
  })
})

describe('ReadFailureNotice', () => {
  it.each([
    ['failed', false, en.error],
    ['failed', true, en.refreshError],
    ['denied', false, en.denied],
    ['denied', true, en.denied],
  ] as const)('says a %s read (refresh: %s) failed and retries', (failure, refresh, text) => {
    const onRetry = vi.fn()
    render(<ReadFailureNotice failure={failure} refresh={refresh} t={t} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
