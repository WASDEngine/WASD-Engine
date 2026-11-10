// @vitest-environment jsdom
/**
 * WASDEngine fork spec: a click on a game project that shows no Session and no child game
 * project opens a Session in it, as its New session button does, instead of folding it. A
 * project made by an agent connected through game-mcp holds only that agent's blank Session,
 * which the sidebar hides, so the click opens that Session.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  allowAllAccess, contextMenuHook, makeTranslate, SlotTestRuntime, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ProjectRowItem } from '../src/client/rows/Rows.tsx'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import type { GroupNode } from '../src/client/tree.ts'
import { en } from '../src/client/locales.ts'
import { renderMenuButton } from './menu-button.tsx'
import { SECTION_HOOK_CONTEXT, SECTION_INJECT } from './section-scroller.client.ts'

usePinnedBrowserLanguages('en-US')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const FROGS = 'frogs' as WorkspaceId
const FROGS_PATH = '/games/Space Frogs'
/** The Session the Host creates when the project has no blank to reuse. */
const CREATED = 'created' as SessionId
/** The Session of another game project that the window shows before the click. */
const ELSEWHERE = 'elsewhere' as SessionId
const CREATED_AT = '2026-11-10T00:00:00.000Z'

describe('empty game project row', () => {
  const t = makeTranslate(en, commonEn) as never
  const group = (expanded: boolean): GroupNode => ({
    key: FROGS, workspaceId: FROGS, cwd: FROGS_PATH, createdAt: 0, label: 'Space Frogs',
    sessionCount: 0, expanded, containsCurrent: false, sessions: [],
  })

  function row(options: { readonly empty: boolean; readonly create?: boolean }) {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const props = {
      group: group(false), onToggle, onCreate, t,
      useRemoteAccess: allowAllAccess.useRemoteAccess,
      useWorkspaceAccess: (_id: WorkspaceId, action: string) => action !== 'session/create' || options.create !== false,
      renderFactorySlot: renderMenuButton,
      useContextMenuTarget: <S,>(select: (target: null) => S): S => select(null),
      useContextMenu: contextMenuHook(),
    }
    const view = render(<ProjectRowItem {...props} empty={options.empty} />)
    const rerender = (empty: boolean): void => { view.rerender(<ProjectRowItem {...props} group={group(true)} empty={empty} />) }
    return { onToggle, onCreate, rerender, element: () => screen.getByRole('treeitem') }
  }

  it('starts a Session instead of folding', () => {
    const { onToggle, onCreate, element } = row({ empty: true })
    fireEvent.click(element(), { detail: 1 })
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('leaves the project unfolded through the rest of that double-click, then folds on the next click', () => {
    const { onToggle, onCreate, rerender, element } = row({ empty: true })
    fireEvent.click(element(), { detail: 1 })
    // The new Session's row arrived between the two presses.
    rerender(false)
    fireEvent.click(element(), { detail: 2 })
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(element(), { detail: 1 })
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('keeps upstream folding for a project with rows and for a Peer that may not start a Session', () => {
    const shown = row({ empty: false })
    fireEvent.click(shown.element(), { detail: 1 })
    fireEvent.click(shown.element(), { detail: 2 })
    expect(shown.onToggle).toHaveBeenCalledTimes(2)
    expect(shown.onCreate).not.toHaveBeenCalled()
    cleanup()

    const refused = row({ empty: true, create: false })
    fireEvent.click(refused.element(), { detail: 1 })
    expect(refused.onToggle).toHaveBeenCalledOnce()
    expect(refused.onCreate).not.toHaveBeenCalled()
  })
})

describe('empty game project through the assembled sidebar', () => {
  /** Test-owned sidebar shell role: declares and renders the browsing region. */
  type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
  function SidebarFrame({ renderSlot }: FrameProps) {
    return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} }, { hookContext: SECTION_HOOK_CONTEXT })}</>
  }

  interface BenchOptions {
    /** Sessions of Space Frogs, in list order. */
    readonly sessions?: readonly { readonly id: string; readonly blank: boolean }[]
    /** A parent game project that holds Space Frogs, shown nested. */
    readonly parent?: boolean
  }

  /**
   * The real Workspace plugin in the sidebar over Space Frogs, with a Host that names a
   * reused blank or creates {@link CREATED} in the project. The window shows a Session of
   * another game project, which startup restores instead of opening a blank Session.
   * @param options - the project's Sessions and whether a parent project nests it.
   * @returns the runtime and the Host's create calls.
   */
  async function bench(options: BenchOptions = {}) {
    if (options.parent === true) createWorkspaceViewStore().create().actions.setGroupBy('workspace-tree')
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: ELSEWHERE }))
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
    runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
    runtime.releaseWorkspaceSource()
    runtime.remote.provideNamespaces({ directoryPicker: {} })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const sessions = options.sessions ?? []
    for (const session of sessions) {
      await runtime.sessions.add({ id: session.id, summary: { title: session.id, cwd: FROGS_PATH, blank: session.blank } })
    }
    // Created blank and outside the project until the Host adds it, so the sidebar hides it.
    await runtime.sessions.add({ id: CREATED, summary: { cwd: FROGS_PATH, blank: true } })
    await runtime.sessions.add({ id: ELSEWHERE, summary: { title: 'Boss fight', cwd: '/elsewhere/Other game' } })
    const frogs = {
      workspaceId: FROGS, title: 'Space Frogs', path: FROGS_PATH,
      sessionIds: sessions.map(session => session.id as SessionId), createdAt: CREATED_AT, updatedAt: CREATED_AT,
    }
    const other = { ...frogs, workspaceId: 'other' as WorkspaceId, title: 'Other game', path: '/elsewhere/Other game', sessionIds: [ELSEWHERE] }
    const parent = { ...frogs, workspaceId: 'games' as WorkspaceId, title: 'Games', path: '/games', sessionIds: [] }
    await runtime.workspaces.update((draft) => {
      draft.items = options.parent === true ? [other, parent, frogs] : [other, frogs]
    })
    const create = vi.fn(async (request: Parameters<ISessions['create']>[0]) => request?.sessionId ?? CREATED)
    runtime.sessions.stubCreate(create)
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root', inject: SECTION_INJECT } } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderRoot()
    await screen.findByText('Space Frogs')
    await waitFor(() => { expect(mainView(runtime, ELSEWHERE)).toBe(1) })
    return { runtime, create }
  }

  const header = (title: string): HTMLElement => {
    const element = screen.getByText(title).closest<HTMLElement>('[role="treeitem"]')
    if (element === null) throw new Error(`no row for ${title}`)
    return element
  }
  const mainView = (runtime: SlotTestRuntime, id: SessionId): number =>
    runtime.sessions.list.getSnapshot().byId[id]?.retainedBy.mainView ?? 0

  it('opens a new Session in a project without Sessions and unfolds it', async () => {
    const { runtime, create } = await bench()
    fireEvent.click(header('Space Frogs'))
    await waitFor(() => { expect(mainView(runtime, CREATED)).toBe(1) })
    expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: FROGS })
    expect(mainView(runtime, ELSEWHERE)).toBe(0)
    // The Host's Workspace stream lists the new Session in the project.
    await runtime.workspaces.update((draft) => {
      draft.items = draft.items.map(item => item.workspaceId === FROGS ? { ...item, sessionIds: [CREATED] } : item)
    })
    expect(header('Space Frogs').getAttribute('aria-expanded')).toBe('true')
    const rows = screen.getAllByRole('treeitem')
    const created = rows[rows.indexOf(header('Space Frogs')) + 1]
    expect(created?.textContent).toContain('New Session')
    expect(created?.getAttribute('aria-selected')).toBe('true')
  })

  it('opens the hidden blank Session of a connected agent instead of creating another', async () => {
    const { runtime, create } = await bench({ sessions: [{ id: 'agent', blank: true }] })
    fireEvent.click(header('Space Frogs'))
    await waitFor(() => { expect(mainView(runtime, 'agent' as SessionId)).toBe(1) })
    expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: FROGS, sessionId: 'agent' })
  })

  it('folds and unfolds a project that shows a Session', async () => {
    const { create } = await bench({ sessions: [{ id: 'Level one', blank: false }] })
    fireEvent.click(header('Space Frogs'))
    expect(header('Space Frogs').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Level one')).toBeTruthy()
    fireEvent.click(header('Space Frogs'))
    expect(header('Space Frogs').getAttribute('aria-expanded')).toBe('false')
    expect(create).not.toHaveBeenCalled()
  })

  it('folds a parent project that holds only another project', async () => {
    const { runtime, create } = await bench({ parent: true })
    expect(header('Games').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header('Games'))
    expect(header('Games').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header('Games'))
    fireEvent.click(header('Space Frogs'))
    await waitFor(() => { expect(mainView(runtime, CREATED)).toBe(1) })
    expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: FROGS })
  })

  it('folds while the Session list is loading', async () => {
    const { runtime, create } = await bench()
    act(() => { runtime.sessions.list.update((draft) => { draft.phase = 'pending' }) })
    fireEvent.click(header('Space Frogs'))
    expect(header('Space Frogs').getAttribute('aria-expanded')).toBe('true')
    expect(create).not.toHaveBeenCalled()
  })
})
