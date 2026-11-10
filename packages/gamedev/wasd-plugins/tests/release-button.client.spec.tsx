// @vitest-environment jsdom
/**
 * The Session header's Release button: shown for a game project's Session the Peer may prompt, it opens a dialog with
 * the last release, takes notes, and asks the Session's agent to release.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReleaseButton, type ReleaseButtonInjected, type ReleaseButtonProps } from '../src/client/ReleaseButton.tsx'
import { en } from '../src/client/locales.ts'
import type { WasdProjectView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')

function button(options: {
  readonly path?: string
  readonly mayPrompt?: boolean
  readonly view?: WasdProjectView
  readonly startRelease?: ReleaseButtonInjected['startRelease']
} = {}) {
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
    t,
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
    expect(startRelease).toHaveBeenCalledWith(SESSION, 'New boss')
    expect(screen.queryByRole('dialog')).toBeNull()
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
