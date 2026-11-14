// @vitest-environment jsdom
/**
 * The Multiplayer button of the Session header: shown for a game project's Session the Peer may prompt, its dialog
 * explains both ways before setup, shows a dedicated game's servers, and asks the Session's agent for the next step.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MultiplayerButton, type MultiplayerButtonInjected, type MultiplayerButtonProps } from '../src/client/MultiplayerButton.tsx'
import { en } from '../src/client/locales.ts'
import type { WasdMultiplayerView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')
const SERVERS = 'https://site.test/account/servers'

function button(options: {
  readonly path?: string
  readonly mayPrompt?: boolean
  readonly view?: WasdMultiplayerView | { readonly error: string }
  readonly ask?: MultiplayerButtonInjected['ask']
} = {}) {
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: options.path === undefined ? [] : [{
      workspaceId: brandString<WorkspaceId>('w1'), path: options.path, title: 'Game', sessionIds: [SESSION],
      createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z',
    }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const view = options.view ?? { godot: true, servers: [], serversUrl: SERVERS }
  const readMultiplayer = vi.fn<MultiplayerButtonInjected['readMultiplayer']>(() => Promise.resolve('godot' in view ? { view } : view))
  const ask = vi.fn<MultiplayerButtonInjected['ask']>(options.ask ?? (() => Promise.resolve(undefined)))
  const props: MultiplayerButtonProps = {
    ...({} as MultiplayerButtonProps),
    sessionId: SESSION,
    useWorkspaces: bindSnapshotSelector(workspaces),
    useAccess: () => options.mayPrompt ?? true,
    t,
    readMultiplayer,
    ask,
  }
  render(<MultiplayerButton {...props} />)
  return { readMultiplayer, ask }
}

async function open(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['multiplayer.button'] })) })
  return screen.getByRole('dialog', { name: en['multiplayer.title'] })
}

describe('MultiplayerButton', () => {
  it('shows only for a game project Session the Peer may prompt', () => {
    button({})
    expect(screen.queryByRole('button', { name: en['multiplayer.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', mayPrompt: false })
    expect(screen.queryByRole('button', { name: en['multiplayer.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon' })
    expect(screen.getByRole('button', { name: en['multiplayer.button'] }).title).toBe(en['multiplayer.tooltip'])
  })

  it('explains both ways before setup and asks the agent to set multiplayer up', async () => {
    const { readMultiplayer, ask } = button({ path: '/games/neon' })
    const dialog = await open()
    expect(readMultiplayer).toHaveBeenCalledWith('/games/neon')
    expect(within(dialog).getByText(en['multiplayer.hostedTitle'])).toBeTruthy()
    expect(within(dialog).getByText(en['multiplayer.dedicatedBody'])).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: en['multiplayer.test'] })).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['multiplayer.setup'] })) })
    expect(ask).toHaveBeenCalledWith(SESSION, 'setup')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists a dedicated game\'s servers with their state, players while running, and bandwidth, and offers a test and another server', async () => {
    const { ask } = button({
      path: '/games/neon',
      view: {
        godot: true, mode: 'dedicated', serversUrl: SERVERS,
        servers: [
          { id: 's1', name: 'West', size: 'Small', state: 'stopped_bandwidth', players: 0, bandwidthPercent: 100 },
          { id: 's2', name: 'East', size: 'Large', state: 'running', players: 12, bandwidthPercent: 42 },
          { id: 's3', name: 'North', size: 'xl', state: 'new_state', players: 0 },
        ],
      },
    })
    const dialog = await open()
    expect(within(dialog).getByText(en['multiplayer.dedicatedCurrent'])).toBeTruthy()
    expect(within(dialog).getByText('Small · stopped: bandwidth used up · 100% of this month\'s bandwidth')).toBeTruthy()
    expect(within(dialog).getByText('Large · running · 12 playing · 42% of this month\'s bandwidth')).toBeTruthy()
    expect(within(dialog).getByText('xl · new_state')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: en['multiplayer.manage'] }).getAttribute('href')).toBe(SERVERS)
    expect(within(dialog).queryByRole('button', { name: en['multiplayer.setup'] })).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['multiplayer.addServer'] })) })
    expect(ask).toHaveBeenCalledWith(SESSION, 'server')
  })

  it('keeps the dialog open with the reason when the prompt is refused, and explains what it could not read', async () => {
    button({ path: '/games/neon', view: { godot: true, mode: 'player_hosted', servers: [], serversUrl: SERVERS }, ask: () => Promise.resolve('The Session is not open.') })
    let dialog = await open()
    expect(within(dialog).getByText(en['multiplayer.hostedCurrent'])).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['multiplayer.test'] })) })
    expect(screen.getByRole('alert').textContent).toBe('Could not ask the agent. The Session is not open.')
    cleanup()
    button({ path: '/games/neon', view: { godot: true, mode: 'dedicated', servers: [], serversUrl: SERVERS, error: 'The WASD Engine sign-in has expired.' } })
    dialog = await open()
    expect(within(dialog).getByText('Could not read the servers. The WASD Engine sign-in has expired.')).toBeTruthy()
    expect(within(dialog).queryByText(en['multiplayer.noServers'])).toBeNull()
    cleanup()
    button({ path: '/games/empty', view: { godot: false, servers: [], serversUrl: SERVERS } })
    dialog = await open()
    expect(within(dialog).getByText(en['multiplayer.notGodot'])).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: en['multiplayer.setup'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', view: { error: 'projectDir must be an absolute path.' } })
    dialog = await open()
    expect(within(dialog).getByText('Could not read this project\'s multiplayer setup. projectDir must be an absolute path.')).toBeTruthy()
  })
})
