// @vitest-environment jsdom
/**
 * The Release button of the Session header and the New Session row: shown for a game project's Session the Peer may
 * prompt, in the New Session row only while the Session is blank, it opens a dialog with the last release, takes notes,
 * offers a new game once the project has one, says when the folder is a copy, and asks the Session's agent to release.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ReleaseButton, type ReleaseButtonInjected, type ReleaseButtonPlacement, type ReleaseButtonProps,
} from '../src/client/ReleaseButton.tsx'
import { en } from '../src/client/locales.ts'
import type { WasdProjectView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')

function button(options: {
  readonly path?: string
  readonly mayPrompt?: boolean
  readonly placement?: ReleaseButtonPlacement
  readonly blank?: boolean
  readonly view?: WasdProjectView
  readonly startRelease?: ReleaseButtonInjected['startRelease']
} = {}) {
  const session = createSnapshotStore({ ...sessionSnapshot(SESSION), blank: options.blank ?? false })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: options.path === undefined ? [] : [{
      workspaceId: brandString<WorkspaceId>('w1'), path: options.path, title: 'Game', sessionIds: [SESSION],
      createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
    }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const readProject = vi.fn<ReleaseButtonInjected['readProject']>(() => Promise.resolve({ view: options.view ?? { godot: true } }))
  const startRelease = vi.fn<ReleaseButtonInjected['startRelease']>(options.startRelease ?? (() => Promise.resolve(undefined)))
  const props: ReleaseButtonProps = {
    ...({} as ReleaseButtonProps),
    sessionId: SESSION,
    useWorkspaces: bindSnapshotSelector(workspaces),
    useAccess: () => options.mayPrompt ?? true,
    useSession: bindSnapshotSelector(session),
    t,
    placement: options.placement ?? 'header',
    readProject,
    startRelease,
  }
  render(<ReleaseButton {...props} />)
  return { readProject, startRelease }
}

describe('ReleaseButton', () => {
  it('shows only for a game project Session the Peer may prompt', () => {
    button({})
    expect(screen.queryByRole('button', { name: en['release.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', mayPrompt: false })
    expect(screen.queryByRole('button', { name: en['release.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon' })
    expect(screen.getByRole('button', { name: en['release.button'] }).title).toBe(en['release.tooltip'])
  })

  it('shows in the New Session row only while the Session is blank, and in the header either way', () => {
    button({ path: '/games/neon', placement: 'newSession', blank: true })
    expect(screen.getByRole('button', { name: en['release.button'] }).getAttribute('data-placement')).toBe('newSession')
    cleanup()
    // A Session that is no longer blank shows its header, which has the button.
    button({ path: '/games/neon', placement: 'newSession', blank: false })
    expect(screen.queryByRole('button', { name: en['release.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', placement: 'header', blank: true })
    expect(screen.getByRole('button', { name: en['release.button'] }).getAttribute('data-placement')).toBe('header')
  })

  it('names the last release and asks the agent to release with the notes', async () => {
    const view: WasdProjectView = { godot: true, game: { title: 'Neon Drift', url: 'https://site.test/games/neon', version: 3 } }
    const { readProject, startRelease } = button({ path: '/games/neon', view })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    expect(readProject).toHaveBeenCalledWith('/games/neon')
    const dialog = screen.getByRole('dialog', { name: en['release.title'] })
    expect(screen.getByText(/Latest release: version 3/u)).toBeTruthy()
    expect(screen.getByRole('link', { name: en['release.open'] }).getAttribute('href')).toBe('https://site.test/games/neon')
    const notes = within(dialog).getByRole('textbox', { name: en['release.notes'] })
    expect(notes.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.change(notes, { target: { value: '  New boss  ' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['release.confirm'] })) })
    expect(startRelease).toHaveBeenCalledWith(SESSION, 'New boss', 'linked')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers to release as a new game once the project has a game', async () => {
    const { startRelease } = button({ path: '/games/neon' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    expect(within(screen.getByRole('dialog')).queryByRole('checkbox')).toBeNull()
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['release.confirm'] })) })
    expect(startRelease).toHaveBeenLastCalledWith(SESSION, '', 'linked')
    cleanup()

    const view: WasdProjectView = { godot: true, game: { title: 'Neon Drift', url: 'https://site.test/games/neon', version: 3 } }
    const released = button({ path: '/games/neon', view })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    const dialog = screen.getByRole('dialog')
    const newGame = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: en['release.newGame'] })
    expect(newGame.checked).toBe(false)
    expect(within(dialog).getByText(t('release.newGameHint', { title: 'Neon Drift' }))).toBeTruthy()
    fireEvent.click(newGame)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['release.confirm'] })) })
    expect(released.startRelease).toHaveBeenLastCalledWith(SESSION, '', 'new')
    // The choice starts over each time the dialog opens.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    expect(within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('checkbox', { name: en['release.newGame'] }).checked).toBe(false)
  })

  it('says when the folder shares its game with another, and sends the choice of the same game unless a new game is checked', async () => {
    const view: WasdProjectView = { godot: true, game: { title: 'Neon Drift', url: 'https://site.test/games/neon', version: 3 }, sharedWith: '/games/neon' }
    const { startRelease } = button({ path: '/games/neon copy', view })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    expect(within(screen.getByRole('dialog')).getByText(t('release.copy', { folder: '/games/neon' }))).toBeTruthy()
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['release.confirm'] })) })
    expect(startRelease).toHaveBeenLastCalledWith(SESSION, '', 'same')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: en['release.newGame'] }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['release.confirm'] })) })
    expect(startRelease).toHaveBeenLastCalledWith(SESSION, '', 'new')
  })

  it('keeps the dialog open with the reason when the prompt is refused, and refuses a project without project.godot', async () => {
    button({ path: '/games/neon', startRelease: () => Promise.resolve('The Session is not open.') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['release.confirm'] })) })
    expect(screen.getByRole('alert').textContent).toBe('Could not start the release. The Session is not open.')
    cleanup()
    button({ path: '/games/empty', view: { godot: false } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['release.button'] })) })
    expect(screen.getByText(en['release.notGodot'])).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en['release.confirm'] }).disabled).toBe(true)
  })
})
