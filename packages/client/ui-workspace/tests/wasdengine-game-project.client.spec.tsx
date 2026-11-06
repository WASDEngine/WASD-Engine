// @vitest-environment jsdom
/**
 * WASDEngine fork spec for the Create game project dialog: it asks for the first game project
 * while the Host's first use waits for one, replaces Add workspace while the Host serves game
 * projects, creates, adopts, and opens a project, and offers worktrees while the forge bundle
 * is off.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createWorkspaceShortcutControls } from '../src/client/shortcuts.ts'
import {
  applyGameProjects, GameProjectDialog, WORKTREE_BUNDLE,
  type GameProjectDialogInjected, type GameProjectOutcome, type GameProjectState,
} from '../src/client/wasdengine/game-project.tsx'
import { en } from '../src/client/wasdengine/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en) as never
const DOCUMENTS = '/home/dev/Documents/WASD Engine'

const snapshot = (items: readonly WorkspaceView[], phase: WorkspaceSnapshot['phase'] = 'ready'): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase, error: null,
})
const project: WorkspaceView = {
  workspaceId: 'space-frogs' as WorkspaceId, path: `${DOCUMENTS}/Space Frogs`, title: 'Space Frogs', sessionIds: [],
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
}

function standard(workspaces: WorkspaceSnapshot, access = true): GlobalStandardProps {
  const store = createSnapshotStore(workspaces)
  return {
    useSessions: bindSnapshotSelector(createSnapshotStore({ ids: [], byId: {}, phase: 'ready' as const, projectionsBySession: {} })),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    useSessionRetainInfo: () => undefined,
    usePanelInfo: selector => selector({ activePanelId: null }),
    useContextMenu: contextMenuHook(),
    useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} }),
    useWorkspaces: bindSnapshotSelector(store),
    ...allowAllAccess,
    useRemoteAccess: () => access,
  }
}

interface DialogOptions {
  readonly state?: Partial<GameProjectState>
  readonly workspaces?: WorkspaceSnapshot
  readonly access?: boolean
  readonly flow?: boolean
  readonly outcome?: GameProjectOutcome
}

function dialog(options: DialogOptions = {}) {
  const state = createSnapshotStore<GameProjectState>({
    host: { status: 'on', directory: DOCUMENTS, required: true }, requested: false, worktrees: 'unavailable', ...options.state,
  })
  const shortcuts = createWorkspaceShortcutControls()
  const createGameProject = vi.fn<GameProjectDialogInjected['createGameProject']>(async () => options.outcome ?? { ok: true })
  const openExistingFolder = vi.fn()
  const settleGameProject = vi.fn(() => { state.set({ ...state.getSnapshot(), requested: false }) })
  render(
    <GameProjectDialog
      {...standard(options.workspaces ?? snapshot([]), options.access)}
      t={t}
      useGameProjects={bindSnapshotSelector(state)}
      useWorkspaceShortcuts={bindSnapshotSelector(shortcuts.state)}
      useDirectoryFlow={bindSnapshotSelector(createSnapshotStore(options.flow ?? true))}
      createGameProject={createGameProject}
      openExistingFolder={openExistingFolder}
      settleGameProject={settleGameProject}
    />,
  )
  return { state, shortcuts, createGameProject, openExistingFolder, settleGameProject }
}

const nameField = (): HTMLInputElement => screen.getByPlaceholderText<HTMLInputElement>('My game')
const createButton = (): HTMLElement => screen.getByRole('button', { name: 'Create game project' })
const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })

describe('Create game project dialog', () => {
  it('asks for the first game project without a way to dismiss it', () => {
    const { settleGameProject } = dialog()
    expect(screen.getByRole('dialog', { name: 'Create a game project to get started' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleGameProject).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('stays closed while the Host has not answered, does not serve game projects, or the Peer may not create one', () => {
    dialog({ state: { host: { status: 'pending' } } })
    dialog({ state: { host: { status: 'off' } } })
    dialog({ access: false })
    dialog({ state: { host: { status: 'on', directory: DOCUMENTS, required: false } } })
    dialog({ workspaces: snapshot([project]) })
    dialog({ workspaces: snapshot([], 'pending') })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides while the sidebar picks a folder and returns when the pick is cancelled', () => {
    const { shortcuts } = dialog()
    act(() => { shortcuts.directoryBusy(true) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { shortcuts.directoryBusy(false) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('creates the named project in the suggested location', async () => {
    const { createGameProject } = dialog()
    expect(screen.getByDisplayValue(DOCUMENTS)).toBeTruthy()
    expect(createButton().hasAttribute('disabled')).toBe(true)
    fireEvent.change(nameField(), { target: { value: '  Space Frogs ' } })
    fireEvent.click(createButton())
    expect(createGameProject).toHaveBeenCalledWith('Space Frogs', DOCUMENTS, false)
    expect(screen.getByRole('button', { name: 'Creating…' }).hasAttribute('disabled')).toBe(true)
    await settle()
  })

  it('asks for a location when the Host found no Documents folder', () => {
    const { createGameProject } = dialog({ state: { host: { status: 'on', directory: null, required: true } } })
    expect(screen.getByText('Enter the full path of the folder that will hold the project.')).toBeTruthy()
    fireEvent.change(nameField(), { target: { value: 'Space Frogs' } })
    expect(createButton().hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByDisplayValue(''), { target: { value: '/games' } })
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    expect(createGameProject).toHaveBeenCalledWith('Space Frogs', '/games', false)
  })

  it.each([
    ['gameProject/exists', 'A folder named “Space Frogs” is already there. Choose another name, or open the existing folder.'],
    ['gameProject/invalid-name', 'Use a name without / \\ : * ? " < > | that doesn’t end with a period.'],
    ['gameProject/invalid-directory', 'Enter the full path of a folder.'],
    ['gameProject/create-failed', 'Couldn’t create the game project: disk full'],
  ])('explains a %s refusal and keeps the draft', async (code, message) => {
    dialog({ outcome: { ok: false, code, message: 'disk full' } })
    fireEvent.change(nameField(), { target: { value: 'Space Frogs' } })
    fireEvent.click(createButton())
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(nameField().value).toBe('Space Frogs')
    expect(createButton().hasAttribute('disabled')).toBe(false)
  })

  it('offers worktrees while the forge bundle is off and passes the choice on', () => {
    const { createGameProject } = dialog({ state: { worktrees: 'offer' } })
    const option = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Keep parallel sessions apart with Git worktrees' })
    expect(option.checked).toBe(true)
    fireEvent.change(nameField(), { target: { value: 'Space Frogs' } })
    fireEvent.click(createButton())
    expect(createGameProject).toHaveBeenLastCalledWith('Space Frogs', DOCUMENTS, true)
    cleanup()

    const unchecked = dialog({ state: { worktrees: 'offer' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(nameField(), { target: { value: 'Space Frogs' } })
    fireEvent.click(createButton())
    expect(unchecked.createGameProject).toHaveBeenLastCalledWith('Space Frogs', DOCUMENTS, false)
  })

  it('opens an existing folder through the sidebar flow, offered only while a flow is composed', () => {
    const { openExistingFolder } = dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Open existing folder…' }))
    expect(openExistingFolder).toHaveBeenCalledTimes(1)
    cleanup()
    dialog({ flow: false })
    expect(screen.queryByRole('button', { name: 'Open existing folder…' })).toBeNull()
  })

  it('closes a requested dialog with Cancel, Close, or Escape', () => {
    const requested = { host: { status: 'on' as const, directory: DOCUMENTS, required: false }, requested: true }
    const { state, settleGameProject } = dialog({ state: requested, workspaces: snapshot([project]) })
    expect(screen.getByRole('dialog', { name: 'Create a game project' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { state.set({ ...state.getSnapshot(), requested: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    act(() => { state.set({ ...state.getSnapshot(), requested: true }) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleGameProject).toHaveBeenCalledTimes(3)
  })
})

describe('game project registration', () => {
  async function bench(options: { gameProject?: boolean; required?: boolean; bundle?: { enabled: boolean } | undefined } = {}) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const defaults = vi.fn(async () => ({ ok: true as const, value: { directory: DOCUMENTS, required: options.required ?? true } }))
    const create = vi.fn(async (request: { name: string; directory: string }) => ({
      ok: true as const, value: { workspace: { ...project, path: `${request.directory}/${request.name}` }, git: true },
    }))
    const bundles = options.bundle === undefined ? [] : [{ name: WORKTREE_BUNDLE, enabled: options.bundle.enabled }]
    const listBundles = vi.fn(async () => ({ ok: true as const, value: bundles }))
    const setBundleEnabled = vi.fn(async () => ({ ok: true as const, value: { application: 'applied' as const } }))
    new TestRemote(ctx, {
      ...options.gameProject === false ? {} : { gameProject: { defaults, create } },
      pluginManager: { listBundles, setBundleEnabled },
    })
    const adopt = vi.fn(async (input: { path: string }) => ({ ...project, path: input.path }))
    const startSession = vi.fn()
    const shortcuts = createWorkspaceShortcutControls()
    const add = vi.spyOn(shortcuts, 'add')
    const controls = applyGameProjects(ctx, {
      workspaces: { create: adopt },
      startSession,
      shortcuts: { state: shortcuts.state, add: shortcuts.add },
      directoryFlow: createSnapshotStore(true),
    })
    await settle()
    const face = (): GameProjectDialogInjected => {
      const registration = slots.entries('shell.overlay').find(candidate => candidate.options.id === 'workspace.game-project')
      if (registration?.inject === undefined) throw new Error('the dialog is not registered')
      const injected: object = registration.inject()
      return injected as GameProjectDialogInjected
    }
    return { ctx, slots, controls, defaults, create, listBundles, setBundleEnabled, adopt, startSession, add, face }
  }

  it('keeps Add workspace while the composition serves no game projects', async () => {
    const { controls, slots } = await bench({ gameProject: false })
    expect(controls.request()).toBe(false)
    expect(slots.entries('shell.overlay')).toEqual([])
  })

  it('opens on request once the Host serves game projects, and asks again after a reconnection', async () => {
    const { ctx, controls, defaults, listBundles, face } = await bench({ required: false, bundle: { enabled: false } })
    expect(face().hooks.gameProjects.getSnapshot()).toMatchObject({ host: { status: 'on', directory: DOCUMENTS, required: false }, requested: false })
    expect(listBundles).not.toHaveBeenCalled()
    expect(controls.request()).toBe(true)
    await settle()
    expect(face().hooks.gameProjects.getSnapshot()).toMatchObject({ requested: true, worktrees: 'offer' })
    ctx.emit('connection/reset')
    await settle()
    expect(defaults).toHaveBeenCalledTimes(2)
  })

  it('reads the worktree offer at startup when first use waits for a game project', async () => {
    const { face, listBundles } = await bench({ bundle: { enabled: true } })
    expect(listBundles).toHaveBeenCalledTimes(1)
    expect(face().hooks.gameProjects.getSnapshot().worktrees).toBe('on')
  })

  it('creates, adopts, and opens the project, then turns worktrees on when asked', async () => {
    const { controls, create, adopt, startSession, setBundleEnabled, face } = await bench({ bundle: { enabled: false } })
    controls.request()
    await expect(face().createGameProject('Space Frogs', DOCUMENTS, true)).resolves.toEqual({ ok: true })
    expect(create).toHaveBeenCalledWith({ name: 'Space Frogs', directory: DOCUMENTS })
    expect(adopt).toHaveBeenCalledWith({ path: `${DOCUMENTS}/Space Frogs` })
    expect(startSession).toHaveBeenCalledWith(project.workspaceId, { clearPreviousDraft: false })
    expect(setBundleEnabled).toHaveBeenCalledWith(WORKTREE_BUNDLE, true)
    await settle()
    expect(face().hooks.gameProjects.getSnapshot()).toMatchObject({ requested: false, worktrees: 'on' })
  })

  it('reports a Host refusal without adopting anything', async () => {
    const { create, adopt, startSession, face } = await bench()
    create.mockResolvedValueOnce({ ok: false, error: { code: 'gameProject/exists', message: 'taken', details: { path: '/x' } } } as never)
    await expect(face().createGameProject('Taken', DOCUMENTS, false)).resolves.toEqual({ ok: false, code: 'gameProject/exists', message: 'taken' })
    expect(adopt).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('hands Open existing folder to the sidebar flow', async () => {
    const { controls, add, face } = await bench()
    controls.request()
    face().openExistingFolder()
    expect(add).toHaveBeenCalledTimes(1)
    expect(face().hooks.gameProjects.getSnapshot().requested).toBe(false)
  })
})
