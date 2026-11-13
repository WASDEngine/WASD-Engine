// @vitest-environment jsdom
/**
 * The Export / Share button of the Session header and the New Session row: shown for a game project's Session the Peer
 * may prompt, in the New Session row only while the Session is blank, it opens a dialog with three choices. Sharing on
 * Explore or with a private link names the last release and whether the choice changes who can find the game, takes
 * notes and the desktop downloads to offer, offers a new game once the project has one, says when the folder is a copy,
 * and asks the agent to share; exporting takes the platforms and asks the agent to build them.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ExportShareButton, type ExportShareButtonProps, type ExportShareInjected, type ExportSharePlacement,
} from '../src/client/ExportShareButton.tsx'
import { en } from '../src/client/locales.ts'
import { exportArguments, shareArguments } from '../src/client/mount.ts'
import type { WasdProjectView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')
const PUBLIC_GAME: WasdProjectView = { godot: true, game: { title: 'Neon Drift', url: 'https://site.test/games/neon', version: 3, visibility: 'public' } }
const PRIVATE_GAME: WasdProjectView = { godot: true, game: { title: 'Neon Drift', url: 'https://site.test/games/neon-x7k2', version: 2, visibility: 'private' } }

function button(options: {
  readonly path?: string
  readonly mayPrompt?: boolean
  readonly placement?: ExportSharePlacement
  readonly blank?: boolean
  readonly view?: WasdProjectView
  readonly startShare?: ExportShareInjected['startShare']
  readonly startExport?: ExportShareInjected['startExport']
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
  const readProject = vi.fn<ExportShareInjected['readProject']>(() => Promise.resolve({ view: options.view ?? { godot: true } }))
  const startShare = vi.fn<ExportShareInjected['startShare']>(options.startShare ?? (() => Promise.resolve(undefined)))
  const startExport = vi.fn<ExportShareInjected['startExport']>(options.startExport ?? (() => Promise.resolve(undefined)))
  const props: ExportShareButtonProps = {
    ...({} as ExportShareButtonProps),
    sessionId: SESSION,
    useWorkspaces: bindSnapshotSelector(workspaces),
    useAccess: () => options.mayPrompt ?? true,
    useSession: bindSnapshotSelector(session),
    t,
    placement: options.placement ?? 'header',
    readProject,
    startShare,
    startExport,
  }
  render(<ExportShareButton {...props} />)
  return { readProject, startShare, startExport }
}

async function openDialog(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['share.button'] })) })
  return screen.getByRole('dialog', { name: en['share.title'] })
}

async function confirm(dialog: HTMLElement, label: string): Promise<void> {
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: label })) })
}

describe('ExportShareButton', () => {
  it('shows only for a game project Session the Peer may prompt', () => {
    button({})
    expect(screen.queryByRole('button', { name: en['share.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', mayPrompt: false })
    expect(screen.queryByRole('button', { name: en['share.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon' })
    expect(screen.getByRole('button', { name: en['share.button'] }).title).toBe(en['share.tooltip'])
  })

  it('shows in the New Session row only while the Session is blank, and in the header either way', () => {
    button({ path: '/games/neon', placement: 'newSession', blank: true })
    expect(screen.getByRole('button', { name: en['share.button'] }).getAttribute('data-placement')).toBe('newSession')
    cleanup()
    // A Session that is no longer blank shows its header, which has the button.
    button({ path: '/games/neon', placement: 'newSession', blank: false })
    expect(screen.queryByRole('button', { name: en['share.button'] })).toBeNull()
    cleanup()
    button({ path: '/games/neon', placement: 'header', blank: true })
    expect(screen.getByRole('button', { name: en['share.button'] }).getAttribute('data-placement')).toBe('header')
  })

  it('offers the three choices, starting on Explore, and asks the agent to share there with the notes and downloads', async () => {
    const { readProject, startShare } = button({ path: '/games/neon', view: PUBLIC_GAME })
    const dialog = await openDialog()
    expect(readProject).toHaveBeenCalledWith('/games/neon')
    const choices = within(dialog).getByRole('radiogroup', { name: en['share.choice'] })
    expect(within(choices).getAllByRole('radio').map(radio => radio.getAttribute('value'))).toEqual(['explore', 'private', 'export'])
    expect(within(choices).getByRole<HTMLInputElement>('radio', { name: new RegExp(en['share.explore'], 'u') }).checked).toBe(true)
    expect(within(dialog).getByText(/Latest release: version 3 · On Explore/u)).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: en['share.open'] }).getAttribute('href')).toBe('https://site.test/games/neon')
    const notes = within(dialog).getByRole('textbox', { name: en['share.notes'] })
    expect(notes.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.change(notes, { target: { value: '  New boss  ' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en['desktop.macos'] }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en['desktop.windows'] }))
    await confirm(dialog, en['share.confirmExplore'])
    expect(startShare).toHaveBeenCalledWith(SESSION, { visibility: 'public', notes: 'New boss', target: 'linked', desktop: ['windows', 'macos'] })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shares a private link, and says when the choice takes the game off Explore or puts it on', async () => {
    const shared = button({ path: '/games/neon', view: PUBLIC_GAME })
    let dialog = await openDialog()
    expect(within(dialog).queryByText(t('share.toPrivate', { title: 'Neon Drift' }))).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(en['share.private'], 'u') }))
    expect(within(dialog).getByText(t('share.toPrivate', { title: 'Neon Drift' }))).toBeTruthy()
    await confirm(dialog, en['share.confirmPrivate'])
    expect(shared.startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'private', notes: '', target: 'linked', desktop: [] })
    cleanup()

    // A private game's dialog starts on the private link, and Explore says the game joins it.
    const unlisted = button({ path: '/games/neon', view: PRIVATE_GAME })
    dialog = await openDialog()
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: new RegExp(en['share.private'], 'u') }).checked).toBe(true)
    expect(within(dialog).getByText(/Latest release: version 2 · Private link/u)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(en['share.explore'], 'u') }))
    expect(within(dialog).getByText(t('share.toPublic', { title: 'Neon Drift' }))).toBeTruthy()
    await confirm(dialog, en['share.confirmExplore'])
    expect(unlisted.startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'public', notes: '', target: 'linked', desktop: [] })
  })

  it('exports for the checked platforms, both at first, and needs at least one', async () => {
    const { startExport, startShare } = button({ path: '/games/neon' })
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(en['share.export'], 'u') }))
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(within(dialog).getByText(en['export.where'])).toBeTruthy()
    const windows = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: en['desktop.windows'] })
    const macos = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: en['desktop.macos'] })
    expect([windows.checked, macos.checked]).toEqual([true, true])
    fireEvent.click(windows)
    fireEvent.click(macos)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en['share.confirmExport'] }).disabled).toBe(true)
    fireEvent.click(macos)
    await confirm(dialog, en['share.confirmExport'])
    expect(startExport).toHaveBeenCalledWith(SESSION, ['macos'])
    expect(startShare).not.toHaveBeenCalled()
  })

  it('offers to release as a new game once the project has a game', async () => {
    const { startShare } = button({ path: '/games/neon' })
    let dialog = await openDialog()
    expect(within(dialog).queryByRole('checkbox', { name: en['share.newGame'] })).toBeNull()
    await confirm(dialog, en['share.confirmExplore'])
    expect(startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'public', notes: '', target: 'linked', desktop: [] })
    cleanup()

    const released = button({ path: '/games/neon', view: PUBLIC_GAME })
    dialog = await openDialog()
    const newGame = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: en['share.newGame'] })
    expect(newGame.checked).toBe(false)
    expect(within(dialog).getByText(t('share.newGameHint', { title: 'Neon Drift' }))).toBeTruthy()
    fireEvent.click(newGame)
    // A new game starts with the visibility chosen, so nothing changes for the existing game.
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(en['share.private'], 'u') }))
    expect(within(dialog).queryByText(t('share.toPrivate', { title: 'Neon Drift' }))).toBeNull()
    await confirm(dialog, en['share.confirmPrivate'])
    expect(released.startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'private', notes: '', target: 'new', desktop: [] })
    // The choices start over each time the dialog opens.
    dialog = await openDialog()
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: en['share.newGame'] }).checked).toBe(false)
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: new RegExp(en['share.explore'], 'u') }).checked).toBe(true)
  })

  it('says when the folder shares its game with another, and sends the choice of the same game unless a new game is checked', async () => {
    const view: WasdProjectView = { ...PUBLIC_GAME, sharedWith: '/games/neon' }
    const { startShare } = button({ path: '/games/neon copy', view })
    let dialog = await openDialog()
    expect(within(dialog).getByText(t('share.copy', { folder: '/games/neon' }))).toBeTruthy()
    await confirm(dialog, en['share.confirmExplore'])
    expect(startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'public', notes: '', target: 'same', desktop: [] })
    dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en['share.newGame'] }))
    await confirm(dialog, en['share.confirmExplore'])
    expect(startShare).toHaveBeenLastCalledWith(SESSION, { visibility: 'public', notes: '', target: 'new', desktop: [] })
  })

  it('keeps the dialog open with the reason when the prompt is refused, and refuses a project without project.godot', async () => {
    button({ path: '/games/neon', startShare: () => Promise.resolve('The Session is not open.'), startExport: () => Promise.resolve('Busy.') })
    let dialog = await openDialog()
    await confirm(dialog, en['share.confirmExplore'])
    expect(screen.getByRole('alert').textContent).toBe('Could not start sharing. The Session is not open.')
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(en['share.export'], 'u') }))
    await confirm(dialog, en['share.confirmExport'])
    expect(screen.getByRole('alert').textContent).toBe('Could not start the export. Busy.')
    cleanup()
    button({ path: '/games/empty', view: { godot: false } })
    dialog = await openDialog()
    expect(screen.getByText(en['share.notGodot'])).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en['share.confirmExplore'] }).disabled).toBe(true)
  })
})

describe('prompt arguments', () => {
  it('quote the visibility, the downloads when there are any, and the game choice of a project that has a game', () => {
    expect(shareArguments({ visibility: 'public', notes: '', target: 'linked', desktop: [] })).toBe('{"visibility":"public"}')
    expect(shareArguments({ visibility: 'private', notes: 'x', target: 'new', desktop: ['windows', 'macos'] }))
      .toBe('{"visibility":"private","desktop":["windows","macos"],"new_game":true}')
    expect(shareArguments({ visibility: 'public', notes: '', target: 'same', desktop: ['macos'] })).toBe('{"visibility":"public","desktop":["macos"],"new_game":false}')
    expect(exportArguments(['windows'])).toBe('{"platforms":["windows"]}')
  })
})
