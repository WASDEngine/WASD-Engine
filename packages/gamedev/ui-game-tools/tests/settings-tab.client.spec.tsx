// @vitest-environment jsdom
/**
 * Settings → Built-in plugins → Game tools: a read on mount, placeholder cards until it answers, read-only cards in
 * the tools' order, and a failed read, the owner-only refusal included, with a retry.
 */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import {
  SettingsGameToolsTab, type GameToolsRead, type SettingsGameToolsTabProps,
} from '../src/client/SettingsGameToolsTab.tsx'
import { gameToolSlots } from '../src/client/tools.ts'
import { BLENDER, GIMP, GODOT } from './fixtures.client.ts'

afterEach(cleanup)

const READY: GameToolsRead = { ok: true, tools: gameToolSlots([GODOT, BLENDER, GIMP]) }

function tab(read: () => Promise<GameToolsRead>) {
  const props = {
    t: makeTranslate(en),
    read,
    resolveText: (text: string | { readonly en: string }) => typeof text === 'string' ? text : text.en,
  } as SettingsGameToolsTabProps
  return render(<SettingsGameToolsTab {...props} />)
}

describe('SettingsGameToolsTab', () => {
  it('holds placeholder cards until the read answers, then lists the tools in order without switches', async () => {
    let answer: (value: GameToolsRead) => void = () => {}
    const read = vi.fn(() => new Promise<GameToolsRead>((resolve) => { answer = resolve }))
    const view = tab(read)
    expect(screen.getByText(en.settingsIntro)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    answer(READY)
    const list = await screen.findByRole('list', { name: en.tab })
    expect([...list.querySelectorAll('li')].map(item => item.getAttribute('data-game-tool')))
      .toEqual(['@deepseek-ai/dsh-blender', '@deepseek-ai/dsh-gimp', '@deepseek-ai/dsh-godot'])
    expect(screen.queryByRole('switch')).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    expect(read).toHaveBeenCalledOnce()
  })

  it.each([
    ['failed', en.error],
    ['denied', en.denied],
  ] as const)('reports a %s read and reads again on retry', async (failure, text) => {
    const read = vi.fn<() => Promise<GameToolsRead>>()
      .mockResolvedValueOnce({ ok: false, failure })
      .mockResolvedValueOnce(READY)
    tab(read)
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    await screen.findByRole('list', { name: en.tab })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected read as failed', async () => {
    tab(() => Promise.reject(new Error('not mounted')))
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
  })

  it('drops an answer that arrives after the tab unmounted', async () => {
    let answer: (value: GameToolsRead) => void = () => {}
    let refuse: (error: Error) => void = () => {}
    const settled = tab(() => new Promise<GameToolsRead>((resolve) => { answer = resolve }))
    settled.unmount()
    answer(READY)
    const rejected = tab(() => new Promise<GameToolsRead>((_resolve, reject) => { refuse = reject }))
    rejected.unmount()
    refuse(new Error('late'))
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
