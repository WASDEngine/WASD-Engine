// @vitest-environment jsdom
/**
 * WASDEngine fork spec for the worktree default: a new Session whose game project already has
 * another Session asks once for its own worktree, from the current branch, and never again after
 * the user unchecks New worktree.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelSnapshot } from '../src/client/source.ts'
import { sharesProject, WorktreeDefault } from '../src/client/wasdengine-worktree-default.tsx'
import type { ForgePanelState } from '../src/types.ts'
import { created, creation, ready, requested, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {}, cwd: '/games/frogs', ...overrides,
})
const sessionList = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(entry => entry.id), byId: Object.fromEntries(items.map(entry => [entry.id, entry])), phase: 'ready', projectionsBySession: {},
})
const projects = (members: readonly string[], archived: readonly string[] = []): WorkspaceSnapshot => ({
  items: [{
    workspaceId: 'frogs' as WorkspaceId, path: '/games/frogs', title: 'Frogs', sessionIds: members.map(sid),
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  }],
  archivedSessionIds: archived.map(sid), pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})

/** The new Session `new` and, in a shared project, the started Session `older`. */
const SHARED = { workspaces: projects(['new', 'older']), sessions: sessionList([summary('new', { blank: true }), summary('older')]) }
const ALONE = { workspaces: projects(['new']), sessions: sessionList([summary('new', { blank: true })]) }

/** Panel state of a new Session that can still start in a worktree. */
const fresh = (branch: string | null = 'main'): ForgePanelState => ready({ worktree: worktree({ editable: true }) }, { branch })

function occupant(state: ForgePanelState | null, lists: { workspaces: WorkspaceSnapshot; sessions: SessionListState } = SHARED) {
  const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
  const workspaces = createSnapshotStore(lists.workspaces)
  const sessions = createSnapshotStore(lists.sessions)
  const standard: GlobalStandardProps = {
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    useSessionRetainInfo: () => undefined,
    usePanelInfo: selector => selector({ activePanelId: null }),
    useContextMenu: contextMenuHook(),
    useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} }),
    useWorkspaces: bindSnapshotSelector(workspaces),
    ...allowAllAccess,
  }
  const claimed = new Set<string>()
  const claim = vi.fn(() => {
    if (claimed.has('new')) return false
    claimed.add('new')
    return true
  })
  const request = vi.fn(async (_from: string | null) => true)
  const view = render(
    <WorktreeDefault {...standard} usePanel={bindSnapshotSelector(panel)} sessionId={sid('new')} claim={claim} request={request} />,
  )
  const publish = (next: ForgePanelState | null): void => { act(() => { panel.set({ state: next, disconnected: false }) }) }
  return { view, claim, request, publish, workspaces, sessions }
}

describe('WorktreeDefault', () => {
  it('requests a worktree from the current branch when the project has another Session', () => {
    const { view, request } = occupant(fresh('feat/levels'))
    expect(request).toHaveBeenCalledWith('feat/levels')
    expect(view.container.textContent).toBe('')
  })

  it('requests one from HEAD on a detached checkout', () => {
    const { request } = occupant(fresh(null))
    expect(request).toHaveBeenCalledWith(null)
  })

  it('keeps the first Session of a project in the project folder', () => {
    const { request, claim } = occupant(fresh(), ALONE)
    expect(request).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('requests once the lists show another Session after the panel state arrived', () => {
    const { request, workspaces, sessions } = occupant(fresh(), ALONE)
    act(() => {
      sessions.set(SHARED.sessions)
      workspaces.set(SHARED.workspaces)
    })
    expect(request).toHaveBeenCalledWith('main')
  })

  it('waits for an inspection and does nothing outside a usable checkout', () => {
    const { request, publish } = occupant(null)
    publish(ready({ worktree: worktree({ editable: true, blocker: 'not-git' }) }))
    publish(ready({ worktree: worktree({ editable: true, blocker: 'read-only' }) }))
    publish({ ...fresh(), checkout: { state: 'pending' } })
    expect(request).not.toHaveBeenCalled()
    publish(fresh())
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks once, so unchecking New worktree keeps the Session in the project folder', () => {
    const { request, publish } = occupant(fresh())
    publish(requested('main'))
    publish(fresh())
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('leaves a Session alone once it has a request, a worktree, a running creation, or a started turn', () => {
    for (const state of [
      requested('release'),
      ready({ worktree: worktree({ editable: false, created: created() }) }),
      ready({ worktree: worktree({ editable: true, creation: creation() }) }),
      ready({ worktree: worktree({ editable: false }) }),
    ]) {
      const { request, claim, publish } = occupant(state)
      publish(fresh())
      expect(request).not.toHaveBeenCalled()
      expect(claim).toHaveBeenCalled()
      cleanup()
    }
  })
})

describe('sharesProject', () => {
  it('counts visible Sessions of the same project other than the new one', () => {
    expect(sharesProject(SHARED.workspaces, SHARED.sessions, sid('new'))).toBe(true)
    expect(sharesProject(ALONE.workspaces, ALONE.sessions, sid('new'))).toBe(false)
  })

  it('finds the project by the Session directory before its membership arrives', () => {
    expect(sharesProject(projects(['older']), SHARED.sessions, sid('new'))).toBe(true)
  })

  it('ignores blank, archived, and subagent Sessions', () => {
    const sessions = sessionList([
      summary('new', { blank: true }), summary('blank', { blank: true }), summary('archived'), summary('child', { origin: 'subagent' }),
    ])
    expect(sharesProject(projects(['new', 'blank', 'archived', 'child'], ['archived']), sessions, sid('new'))).toBe(false)
  })

  it('answers false while the Session belongs to no listed project', () => {
    expect(sharesProject(projects([]), sessionList([summary('new', { cwd: '/elsewhere' })]), sid('new'))).toBe(false)
  })
})
