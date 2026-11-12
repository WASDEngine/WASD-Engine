// @vitest-environment jsdom
/**
 * The first build tip beside the composer's effort selector: it shows for an idle Session whose game project folder
 * holds nothing yet while Max effort or agent teamwork is off, turns on only the settings that are off, confirms, and
 * leaves; Not now and Escape hide it for the project.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamProjection } from '@deepseek-ai/dsh-agent-team/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { APPLIED_DISPLAY_MS, FirstBuildTip, type FirstBuildTipInjected, type FirstBuildTipProps } from '../src/client/FirstBuildTip.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')
const PROJECT = '/games/neon'
const ANCHOR = '--dsh-model-r1'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const reasoning = {
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
  defaultEffort: 'high',
}

function modelDirectory(effort: string | undefined, efforts = reasoning.efforts): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-account', model: 'flash', ...effort === undefined ? {} : { reasoningEffort: effort } },
    routable: true,
    groups: [{ id: 'deepseek-account', name: 'WASD Engine', models: [{ id: 'flash', name: 'Flash', reasoning: { ...reasoning, efforts } }] }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
  }
}

/** A folder watch the test answers: each `answer` reaches every open watch. */
function folderWatch(initial: boolean | undefined) {
  const answers: boolean[] = initial === undefined ? [] : [initial]
  const waiting = new Set<() => void>()
  const folders: string[] = []
  const watchFolder: FirstBuildTipInjected['watchFolder'] = async function* (folder, signal) {
    folders.push(folder)
    let index = 0
    while (!signal.aborted) {
      const answer = answers[index]
      if (answer !== undefined) {
        index++
        yield answer
        if (!answer) return
        continue
      }
      await new Promise<void>((resolve) => {
        waiting.add(resolve)
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
  return {
    watchFolder,
    folders,
    answer(empty: boolean) {
      answers.push(empty)
      for (const wake of waiting) wake()
      waiting.clear()
    },
  }
}

interface TipOptions {
  readonly project?: string | undefined
  readonly cwd?: string | undefined
  readonly origin?: 'subagent'
  readonly subagent?: boolean
  readonly running?: boolean
  readonly blank?: boolean
  readonly effort?: string | undefined
  readonly efforts?: typeof reasoning.efforts
  readonly team?: { readonly enabled: boolean } | undefined
  readonly mayChange?: boolean
  readonly dismissed?: readonly string[]
  readonly empty?: boolean | undefined
  readonly menuOpen?: boolean
  readonly locked?: boolean
  readonly selectMaxEffort?: FirstBuildTipInjected['selectMaxEffort']
  readonly enableTeamwork?: FirstBuildTipInjected['enableTeamwork']
}

function tip(options: TipOptions = {}) {
  const project = 'project' in options ? options.project : PROJECT
  const cwd = 'cwd' in options ? options.cwd : project
  const session = createSnapshotStore({
    ...sessionSnapshot(SESSION),
    running: options.running ?? false,
    blank: options.blank ?? true,
    ...options.subagent === true
      ? { subagent: { address: { parentSessionId: brandString<SessionId>('lead'), childSessionId: SESSION, mode: 'continuable' as const } } }
      : {},
  })
  const sessions = createSnapshotStore<SessionListState>({
    ids: [SESSION],
    byId: {
      [SESSION]: {
        id: SESSION, displayTitle: 'Neon', running: false, retainedBy: {}, blank: true, updatedAt: 0,
        ...cwd === undefined ? {} : { cwd }, ...options.origin === undefined ? {} : { origin: options.origin },
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: project === undefined ? [] : [{
      workspaceId: brandString<WorkspaceId>('w1'), path: project, title: 'Neon', sessionIds: [SESSION],
      createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
    }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const directory = createSnapshotStore(modelDirectory('effort' in options ? options.effort : 'high', options.efforts))
  const team = createSnapshotStore<TeamProjection | undefined>('team' in options
    ? options.team === undefined ? undefined : { ...options.team, tasks: [] }
    : { enabled: false, tasks: [] })
  const dismissedProjects = createSnapshotStore<readonly string[]>(options.dismissed ?? [])
  const watch = folderWatch('empty' in options ? options.empty : true)
  const selectMaxEffort = vi.fn<FirstBuildTipInjected['selectMaxEffort']>(options.selectMaxEffort ?? (() => {
    directory.set(modelDirectory('max'))
    return Promise.resolve(undefined)
  }))
  const enableTeamwork = vi.fn<FirstBuildTipInjected['enableTeamwork']>(options.enableTeamwork ?? (() => {
    team.set({ enabled: true, tasks: [] })
    return Promise.resolve(undefined)
  }))
  const dismiss = vi.fn<FirstBuildTipInjected['dismiss']>((path) => { dismissedProjects.set([...dismissedProjects.getSnapshot(), path]) })
  const useTeam = bindSnapshotSelector(team)
  const props = (overrides: Partial<Pick<FirstBuildTipProps, 'menuOpen' | 'locked'>> = {}): FirstBuildTipProps => ({
    ...({} as FirstBuildTipProps),
    sessionId: SESSION,
    anchor: ANCHOR,
    menuOpen: overrides.menuOpen ?? options.menuOpen ?? false,
    locked: overrides.locked ?? options.locked ?? false,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: (_key: 'agentTeam', selector?: (value: TeamProjection | undefined) => unknown) =>
      useTeam(value => selector === undefined ? value : selector(value)),
    useAccess: () => options.mayChange ?? true,
    useModelDirectory: bindSnapshotSelector(directory),
    useDismissedProjects: bindSnapshotSelector(dismissedProjects),
    watchFolder: watch.watchFolder,
    selectMaxEffort,
    enableTeamwork,
    dismiss,
    t,
  })
  const view = render(<FirstBuildTip {...props()} />)
  return {
    ...watch, session, directory, team, selectMaxEffort, enableTeamwork, dismiss,
    rerender: (overrides: Partial<Pick<FirstBuildTipProps, 'menuOpen' | 'locked'>>) => { view.rerender(<FirstBuildTip {...props(overrides)} />) },
  }
}

/** Let the folder watch's answers reach the component. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  })
}

function card(): HTMLElement | null {
  return screen.queryByRole('region', { name: en['firstBuild.title'] })
}

describe('FirstBuildTip', () => {
  it('points a card at the effort selector of an idle Session whose game project holds nothing yet', async () => {
    const { folders } = tip()
    await settle()
    const region = card()
    expect(region).not.toBeNull()
    expect(region?.parentElement).toBe(document.body)
    expect(region?.style.getPropertyValue('--wasd-first-build-anchor')).toBe(ANCHOR)
    expect(region?.getAttribute('data-side')).toBe('below')
    expect(region?.textContent).toContain(en['firstBuild.body'])
    expect(screen.getByRole('button', { name: en['firstBuild.apply'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['firstBuild.dismiss'] })).toBeTruthy()
    expect(folders).toEqual([PROJECT])
  })

  it('stays away from a folder that holds something, and leaves once files appear', async () => {
    tip({ empty: false })
    await settle()
    expect(card()).toBeNull()
    cleanup()
    const watch = tip()
    await settle()
    expect(card()).not.toBeNull()
    watch.answer(false)
    await settle()
    expect(card()).toBeNull()
  })

  it('waits for the folder answer and watches the Session\'s working directory', async () => {
    const watch = tip({ empty: undefined, cwd: `${PROJECT}/.agents/worktrees/dsh-1` })
    await settle()
    expect(card()).toBeNull()
    expect(watch.folders).toEqual([`${PROJECT}/.agents/worktrees/dsh-1`])
    watch.answer(true)
    await settle()
    expect(card()).not.toBeNull()
  })

  it('hides while a turn runs, the seat menu is open, or the composer is locked', async () => {
    const view = tip()
    await settle()
    expect(card()).not.toBeNull()
    act(() => { view.session.update((state) => { state.running = true }) })
    expect(card()).toBeNull()
    act(() => { view.session.update((state) => { state.running = false }) })
    expect(card()).not.toBeNull()
    view.rerender({ menuOpen: true })
    expect(card()).toBeNull()
    view.rerender({ locked: true })
    expect(card()).toBeNull()
    view.rerender({})
    expect(card()).not.toBeNull()
  })

  it.each<[string, TipOptions]>([
    ['Max effort and agent teamwork are on', { effort: 'max', team: { enabled: true } }],
    ['the model offers no Max effort', { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }],
    ['the composition has no Agent Teams', { team: undefined }],
    ['the Session belongs to no game project', { project: undefined, cwd: '/tmp/scratch' }],
    ['the Session has no working directory yet', { cwd: undefined }],
    ['the Session is a listed subagent', { origin: 'subagent' }],
    ['the Session is an addressed subagent', { subagent: true }],
    ['the Peer may not change the settings', { mayChange: false }],
    ['the user dismissed it in this project', { dismissed: [PROJECT] }],
  ])('stays hidden when %s', async (_case, options) => {
    tip(options)
    await settle()
    expect(card()).toBeNull()
  })

  it('does not watch a folder it has nothing to suggest for', async () => {
    const watch = tip({ effort: 'max', team: { enabled: true } })
    await settle()
    expect(watch.folders).toEqual([])
  })

  it('turns on Max effort and agent teamwork, confirms, and leaves', async () => {
    const view = tip()
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['firstBuild.apply'] })) })
    expect(view.selectMaxEffort).toHaveBeenCalledTimes(1)
    expect(view.enableTeamwork).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe(en['firstBuild.applied'])
    act(() => { vi.advanceTimersByTime(APPLIED_DISPLAY_MS) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.body.querySelector('section')).toBeNull()
  })

  it('turns on only the setting that is off', async () => {
    const atMax = tip({ effort: 'max' })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['firstBuild.apply'] })) })
    expect(atMax.selectMaxEffort).not.toHaveBeenCalled()
    expect(atMax.enableTeamwork).toHaveBeenCalledTimes(1)
    cleanup()
    const teamOn = tip({ team: { enabled: true } })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['firstBuild.apply'] })) })
    expect(teamOn.selectMaxEffort).toHaveBeenCalledTimes(1)
    expect(teamOn.enableTeamwork).not.toHaveBeenCalled()
  })

  it('keeps the card with the reason when a setting is refused', async () => {
    const view = tip({ selectMaxEffort: () => Promise.resolve('the Session is in use elsewhere') })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['firstBuild.apply'] })) })
    expect(view.enableTeamwork).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Could not change the settings. the Session is in use elsewhere')
    expect(card()).not.toBeNull()
  })

  it('hides for the project on Not now and on Escape', async () => {
    const view = tip()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['firstBuild.dismiss'] }))
    expect(view.dismiss).toHaveBeenCalledWith(PROJECT)
    expect(card()).toBeNull()
    cleanup()
    const escaped = tip()
    await settle()
    fireEvent.keyDown(screen.getByRole('button', { name: en['firstBuild.apply'] }), { key: 'Escape' })
    expect(escaped.dismiss).toHaveBeenCalledWith(PROJECT)
    expect(card()).toBeNull()
  })

  it('hides while its seat sits in an inert region, such as behind the open sidebar drawer', async () => {
    const view = tip()
    await settle()
    expect(card()).not.toBeNull()
    const marker = document.body.querySelector('[aria-hidden="true"]')
    expect(marker?.parentElement).not.toBe(document.body)
    await act(async () => {
      marker?.parentElement?.setAttribute('inert', '')
      await Promise.resolve()
    })
    expect(card()).toBeNull()
    await act(async () => {
      marker?.parentElement?.removeAttribute('inert')
      await Promise.resolve()
    })
    expect(card()).not.toBeNull()
    expect(view.dismiss).not.toHaveBeenCalled()
  })
})
