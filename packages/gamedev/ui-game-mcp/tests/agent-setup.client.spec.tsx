// @vitest-environment jsdom
/**
 * The sign-in dialog's alternative: the offer's button, and the panel with the setup prompt, its copy button and
 * selection fallback, the server's state, Back while no agent connected, and Done once one did.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentSetup, type AgentSetupProps } from '../src/client/AgentSetup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSnapshot } from '../src/client/source.ts'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)

const CLASS_NAMES = {
  content: 'content', title: 'title', description: 'description', actions: 'actions', primaryButton: 'primary', secondaryButton: 'secondary',
}

function listening(overrides: Partial<GameMcpView> = {}): GameMcpView {
  return { state: 'listening', url: 'http://127.0.0.1:9273/mcp', prompt: 'Set up the WASD Engine MCP server…', clients: [], ...overrides }
}

function setup(view: AgentSetupProps['view'], snapshot: ServerSnapshot, copyText: AgentSetupProps['copyText'] = async () => true) {
  const store = createSnapshotStore<ServerSnapshot>(snapshot)
  const open = vi.fn<() => void>()
  const back = vi.fn<() => void>()
  const close = vi.fn<() => void>()
  const copy = vi.fn(copyText)
  const props: AgentSetupProps = {
    ...({} as GlobalStandardProps),
    view, open, back, close, classNames: CLASS_NAMES, useServer: bindSnapshotSelector(store), copyText: copy, t,
  }
  render(<AgentSetup {...props} />)
  return { store, open, back, close, copy }
}

describe('AgentSetup', () => {
  it('offers itself as one of the dialog\'s buttons', () => {
    const { open } = setup('offer', { view: null, disconnected: false })
    const offer = screen.getByRole('button', { name: en.offer })
    expect(offer.classList.contains('secondary')).toBe(true)
    fireEvent.click(offer)
    expect(open).toHaveBeenCalledOnce()
  })

  it('shows the prompt while the server starts, waits for an agent, and goes back to sign-in', () => {
    const { store, back } = setup('panel', { view: null, disconnected: false })
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en['status.starting'])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.copy }).disabled).toBe(true)
    act(() => { store.set({ view: listening(), disconnected: false }) })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['prompt.label'] }).value).toBe('Set up the WASD Engine MCP server…')
    expect(screen.getByRole('status').textContent).toBe(en['status.waiting'])
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('copies the prompt, and says so for a moment', async () => {
    vi.useFakeTimers()
    const { copy } = setup('panel', { view: listening(), disconnected: false })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copy })) })
    expect(copy).toHaveBeenCalledWith('Set up the WASD Engine MCP server…')
    expect(screen.getByRole('button', { name: en.copied })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('button', { name: en.copy })).toBeTruthy()
  })

  it('selects the prompt for the keyboard when the host refuses the clipboard', async () => {
    setup('panel', { view: listening(), disconnected: false }, async () => false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copy })) })
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['prompt.label'] })
    expect(screen.getByRole('button', { name: en.copyFailed })).toBeTruthy()
    expect(document.activeElement).toBe(area)
    expect(area.selectionEnd - area.selectionStart).toBe(area.value.length)
  })

  it('names the connected agent and closes with Done', () => {
    const { close } = setup('panel', { view: listening({ clients: [{ id: 'claude-code', title: 'Claude Code', lastSeen: 1 }] }), disconnected: false })
    expect(screen.getByRole('status').textContent).toBe('Claude Code is connected.')
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    expect(screen.getByRole('button', { name: en.copy }).classList.contains('secondary')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.done }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports a failed server and a lost connection to the Host', () => {
    const { store } = setup('panel', { view: { state: 'failed', message: 'Port 9273 is taken.', clients: [] }, disconnected: false })
    expect(screen.getByRole('status').textContent).toBe('The MCP server is not running. Port 9273 is taken.')
    act(() => { store.set({ view: listening(), disconnected: true }) })
    expect(screen.getByRole('status').textContent).toBe(en['status.disconnected'])
  })
})
