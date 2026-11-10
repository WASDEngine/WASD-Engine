// @vitest-environment jsdom
/**
 * The setup for another agent, after sign-in: the Desktop introduction's last step, with the introduction's heading,
 * classes, and Continue, and the Other agents section of Settings. Both show the agents' logos, the setup prompt with
 * its copy button and selection fallback, and the server's state.
 */
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AGENT_LOGOS, AgentSetupSection, AgentSetupStep, type AgentSetupInjected, type AgentSetupSectionProps, type AgentSetupStepProps,
} from '../src/client/AgentSetup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSnapshot } from '../src/client/source.ts'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)

const CLASS_NAMES = { content: 'content', copy: 'copy', subtitle: 'subtitle', primaryAction: 'primary-action', action: 'action' }

function listening(overrides: Partial<GameMcpView> = {}): GameMcpView {
  return { state: 'listening', url: 'http://127.0.0.1:9273/mcp', prompt: 'Set up the WASD Engine MCP server…', clients: [], ...overrides }
}

function section(snapshot: ServerSnapshot, copyText: AgentSetupInjected['copyText'] = async () => true) {
  const store = createSnapshotStore<ServerSnapshot>(snapshot)
  const copy = vi.fn(copyText)
  const props: AgentSetupSectionProps = {
    ...({} as GlobalStandardProps), close: () => {}, useServer: bindSnapshotSelector(store), copyText: copy, t,
  }
  render(<AgentSetupSection {...props} />)
  return { store, copy }
}

function step(busy = false) {
  const store = createSnapshotStore<ServerSnapshot>({ view: listening(), disconnected: false })
  const next = vi.fn<() => void>()
  const heading = createRef<HTMLHeadingElement>()
  const props: AgentSetupStepProps = {
    ...({} as GlobalStandardProps), heading, headingId: 'desktop-onboarding-title', busy, next, classNames: CLASS_NAMES,
    useServer: bindSnapshotSelector(store), copyText: async () => true, t,
  }
  const view = render(<AgentSetupStep {...props} />)
  return { next, heading, view }
}

describe('AgentSetupSection', () => {
  it('shows the agents that connect by their logos, as the website does', () => {
    section({ view: listening(), disconnected: false })
    const list = screen.getByRole('list', { name: en['logos.label'] })
    const logos = within(list).getAllByRole('img')
    expect(logos.map(logo => logo.getAttribute('alt'))).toEqual(['ChatGPT', 'Claude', 'Gemini', 'Grok', 'MiniMax', 'DeepSeek', 'Kimi', 'GLM'])
    expect(logos.map(logo => logo.getAttribute('src'))).toEqual(AGENT_LOGOS.map(([, , src]) => src))
    expect(within(list).getAllByRole('listitem').map(item => item.title)).toEqual(AGENT_LOGOS.map(([name]) => name))
  })

  it('titles itself and shows the prompt while the server starts and waits for an agent', () => {
    const { store } = section({ view: null, disconnected: false })
    expect(screen.getByRole('region', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.description)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en['status.starting'])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.copy }).disabled).toBe(true)
    act(() => { store.set({ view: listening(), disconnected: false }) })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['prompt.label'] }).value).toBe('Set up the WASD Engine MCP server…')
    expect(screen.getByRole('status').textContent).toBe(en['status.waiting'])
  })

  it('copies the prompt, and says so for a moment', async () => {
    vi.useFakeTimers()
    const { copy } = section({ view: listening(), disconnected: false })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copy })) })
    expect(copy).toHaveBeenCalledWith('Set up the WASD Engine MCP server…')
    expect(screen.getByRole('button', { name: en.copied })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('button', { name: en.copy })).toBeTruthy()
  })

  it('selects the prompt for the keyboard when the host refuses the clipboard', async () => {
    section({ view: listening(), disconnected: false }, async () => false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copy })) })
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['prompt.label'] })
    expect(screen.getByRole('button', { name: en.copyFailed })).toBeTruthy()
    expect(document.activeElement).toBe(area)
    expect(area.selectionEnd - area.selectionStart).toBe(area.value.length)
  })

  it('names the connected agent', () => {
    section({ view: listening({ clients: [{ id: 'claude-code', title: 'Claude Code', lastSeen: 1 }] }), disconnected: false })
    expect(screen.getByRole('status').textContent).toBe('Claude Code is connected.')
  })

  it('reports a failed server and a lost connection to the Host', () => {
    const { store } = section({ view: { state: 'failed', message: 'Port 9273 is taken.', clients: [] }, disconnected: false })
    expect(screen.getByRole('status').textContent).toBe('The MCP server is not running. Port 9273 is taken.')
    act(() => { store.set({ view: listening(), disconnected: true }) })
    expect(screen.getByRole('status').textContent).toBe(en['status.disconnected'])
  })
})

describe('AgentSetupStep', () => {
  it('draws the introduction\'s page with its classes, a heading the introduction can focus, and the logos', () => {
    const { heading, view } = step()
    const title = screen.getByRole('heading', { level: 1, name: en.title })
    expect(title.id).toBe('desktop-onboarding-title')
    expect(heading.current).toBe(title)
    expect(title.tabIndex).toBe(-1)
    expect(title.parentElement?.className).toBe('copy')
    expect(screen.getByText(en.description).className).toBe('subtitle')
    expect((view.container.firstElementChild as HTMLElement).className).toBe('content')
    expect(screen.getAllByRole('img')).toHaveLength(AGENT_LOGOS.length)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en['prompt.label'] }).value).toBe('Set up the WASD Engine MCP server…')
    const action = screen.getByRole('button', { name: en.continue })
    expect(action.classList.contains('action')).toBe(true)
    expect(action.parentElement?.className).toBe('primary-action')
  })

  it('finishes the introduction with Continue, whether or not an agent connected', () => {
    const { next } = step()
    fireEvent.click(screen.getByRole('button', { name: en.continue }))
    expect(next).toHaveBeenCalledOnce()
  })

  it('waits while the introduction is busy', () => {
    const { next } = step(true)
    const action = screen.getByRole('button', { name: en.continue })
    expect(action.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(action)
    expect(next).not.toHaveBeenCalled()
  })
})
