// @vitest-environment jsdom
/**
 * The notice toast of the Plugins page tab's switch writes: the sentence each outcome shows in English and in
 * Chinese, nothing while no notice waits, a hold that grows with the text, and the dismissal once the toast fades.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameToolNotice, GameToolOutcome, GameToolsState, ManagedGameTool } from '../src/client/controller.ts'
import { GameToolsNoticeToast, type GameToolsNoticeToastProps } from '../src/client/GameToolsNoticeToast.tsx'
import { en, zh } from '../src/client/locales.ts'
import { BLENDER, GIMP, GODOT } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TOOLS: readonly ManagedGameTool[] = [
  { moduleName: BLENDER.moduleName, entry: BLENDER, control: { kind: 'switch' } },
  { moduleName: GIMP.moduleName, entry: GIMP, control: { kind: 'switch' } },
  { moduleName: GODOT.moduleName, entry: GODOT, control: { kind: 'switch' } },
]

function notice(outcome: GameToolOutcome, tool = 0, enabled = true, seq = 1): GameToolNotice {
  return { ...outcome, tool: TOOLS[tool]!, enabled, seq }
}

function toast(shown: GameToolNotice | null, dictionary: Record<string, string> = en) {
  const store = createSnapshotStore<GameToolsState>({ snapshot: null, failure: null, busy: [], notice: shown })
  const dismissNotice = vi.fn(() => { store.set({ ...store.getSnapshot(), notice: null }) })
  const props = {
    t: makeTranslate(dictionary),
    useGameTools: bindSnapshotSelector(store),
    resolveText: (text: string | { readonly en: string }) => typeof text === 'string' ? text : text.en,
    dismissNotice,
  } as GameToolsNoticeToastProps
  render(<GameToolsNoticeToast {...props} />)
  return { store, dismissNotice }
}

describe('GameToolsNoticeToast', () => {
  it.each([
    ['a restart', notice({ kind: 'restart', reason: 'no-hmr' }),
      'Restart WASD Engine to apply the change to Blender. This profile applies changes only at startup.'],
    ['a restart without a reason', notice({ kind: 'restart', reason: undefined }), 'Restart WASD Engine to apply the change to Blender.'],
    ['a higher layer', notice({ kind: 'overridden' }, 1),
      'The change to GIMP was saved, but a higher-priority configuration overrides it, so it is not in effect.'],
    ['a refusal with a sentence', notice({ kind: 'failed', code: 'unknown-plugin', message: 'gone' }, 1),
      'Could not turn on GIMP. This profile no longer mounts it.'],
    ['a locked refusal', notice({ kind: 'failed', code: 'management-required', message: '' }, 0, false),
      'Could not turn off Blender. Plugin management needs this tool, so it cannot be switched off.'],
    ['a refusal with a diagnostic', notice({ kind: 'failed', code: 'operation-error', message: 'disk full' }, 2, false),
      'Could not turn off Godot. disk full'],
    ['a failure that says nothing more', notice({ kind: 'failed', code: undefined, message: '' }, 2),
      'Could not turn on Godot. Something went wrong.'],
  ] as const)('toasts %s', (_case, shown, text) => {
    toast(shown)
    expect(screen.getByRole('alert').textContent).toBe(text)
  })

  it.each([
    ['a restart', notice({ kind: 'restart', reason: 'no-hmr' }), '请重启 WASD Engine 使 Blender 的更改生效。这个 profile 只在启动时应用更改'],
    ['a restart without a reason', notice({ kind: 'restart', reason: undefined }), '请重启 WASD Engine 使 Blender 的更改生效'],
    ['a higher layer', notice({ kind: 'overridden' }, 1), 'GIMP 的更改已保存，但被更高优先级的配置覆盖，当前未生效'],
  ] as const)('toasts %s in Chinese without a closing full stop', (_case, shown, text) => {
    toast(shown, zh)
    expect(screen.getByRole('alert').textContent).toBe(text)
  })

  it('shows nothing while no notice waits', () => {
    toast(null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('holds a short notice 3 s and a long one up to 8 s, then drops the notice once the toast fades', () => {
    vi.useFakeTimers()
    // 'Could not turn on Godot. x' reads in the 3 s floor; the 1 s fade follows the hold.
    const short = toast(notice({ kind: 'failed', code: 'operation-error', message: 'x' }, 2))
    act(() => { vi.advanceTimersByTime(3_999) })
    expect(short.dismissNotice).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(short.dismissNotice).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()
    const long = toast(notice({ kind: 'failed', code: 'operation-error', message: 'x'.repeat(200) }, 2))
    act(() => { vi.advanceTimersByTime(8_999) })
    expect(long.dismissNotice).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(long.dismissNotice).toHaveBeenCalledOnce()
  })

  it('starts the hold again for the next notice', () => {
    vi.useFakeTimers()
    const failed: GameToolOutcome = { kind: 'failed', code: 'operation-error', message: 'x' }
    const t = toast(notice(failed, 1))
    act(() => { vi.advanceTimersByTime(3_000) })
    act(() => { t.store.set({ ...t.store.getSnapshot(), notice: notice(failed, 2, true, 2) }) })
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(t.dismissNotice).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Could not turn on Godot. x')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(t.dismissNotice).toHaveBeenCalledOnce()
  })
})
