// @vitest-environment jsdom
/**
 * Data of the first build tip: an empty game project folder holds only hidden entries and system files, the selected
 * model's effort facts, the folder watch that lists on readiness and changes and ends once the folder holds something,
 * and the dismissed project folders kept in localStorage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDirectoryEntry, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createDismissedProjects, DISMISSED_LIMIT, DISMISSED_STORAGE_KEY, dismissProject, firstBuildEffort, holdsNothing,
  watchHoldsNothing, type FolderWatchRemote, type FolderWatchStream,
} from '../src/client/first-build.ts'

const SESSION = brandString<SessionId>('session-1')

afterEach(() => {
  localStorage.clear()
})

function entries(...names: string[]): WorkspaceDirectoryEntry[] {
  return names.map((name): WorkspaceDirectoryEntry => ({ name, type: name.includes('.') && !name.startsWith('.') ? 'file' : 'directory' }))
}

describe('holdsNothing', () => {
  it('counts hidden entries and system files as nothing', () => {
    expect(holdsNothing({ entries: [], truncated: false })).toBe(true)
    expect(holdsNothing({ entries: entries('.git', '.DS_Store', '.agents', 'Thumbs.db', 'desktop.ini'), truncated: false })).toBe(true)
  })

  it('counts any other entry, and a cut listing, as something', () => {
    expect(holdsNothing({ entries: entries('.git', 'project.godot'), truncated: false })).toBe(false)
    expect(holdsNothing({ entries: entries('assets'), truncated: false })).toBe(false)
    expect(holdsNothing({ entries: entries('.git'), truncated: true })).toBe(false)
  })
})

describe('firstBuildEffort', () => {
  const reasoning = {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'high',
  }
  type Models = ModelDirectoryState['groups'][number]['models']
  function directory(current: ModelDirectoryState['current'], models: Models = [{ id: 'flash', name: 'Flash', reasoning }]): Pick<ModelDirectoryState, 'current' | 'groups'> {
    return { current, groups: [{ id: 'deepseek-account', name: 'WASD Engine', models }] }
  }

  it('reads whether the selected model offers Max and runs at it', () => {
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'flash' }))).toEqual({ offersMax: true, atMax: false })
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'flash', reasoningEffort: 'max' }))).toEqual({ offersMax: true, atMax: true })
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'flash' }, [{
      id: 'flash', name: 'Flash', reasoning: { ...reasoning, defaultEffort: 'max' },
    }]))).toEqual({ offersMax: true, atMax: true })
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'flash', reasoningEffort: 'low' }, [{
      id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
    }]))).toEqual({ offersMax: false, atMax: false })
  })

  it('has no facts without a selection, a loaded catalog entry, or efforts', () => {
    expect(firstBuildEffort(directory(null))).toBeUndefined()
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'pro' }))).toBeUndefined()
    expect(firstBuildEffort(directory({ provider: 'other', model: 'flash' }))).toBeUndefined()
    expect(firstBuildEffort(directory({ provider: 'deepseek-account', model: 'flash' }, [{ id: 'flash', name: 'Flash' }]))).toBeUndefined()
  })
})

/** A watch whose frames the test pushes, and listings it answers in order. */
function folderRemote(listings: readonly (readonly string[] | 'failed')[]) {
  const frames: WorkspaceFileWatchFrame[] = []
  let wake: (() => void) | undefined
  const accepted: string[] = []
  const disposed = vi.fn(() => Promise.resolve())
  let listed = 0
  const list = vi.fn<FolderWatchRemote['workspaceFiles']['list']>((_sessionId, path) => {
    const next = listings[Math.min(listed++, listings.length - 1)]
    return Promise.resolve(next === 'failed' || next === undefined
      ? { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
      : { ok: true, value: { path: '', entries: entries(...next), truncated: false } })
  })
  const changes = vi.fn<FolderWatchRemote['workspaceFiles']['changes']>()
  const remote: FolderWatchRemote = {
    $stream<Item>(options: { readonly open: (signal: AbortSignal) => AsyncIterable<Item> }): FolderWatchStream<Item> {
      const lifetime = new AbortController()
      const source = options.open(lifetime.signal)
      return {
        async* [Symbol.asyncIterator]() {
          for await (const value of source) yield { value, accept: () => { accepted.push('accept') } }
        },
        dispose: async () => {
          lifetime.abort()
          await disposed()
        },
      }
    },
    workspaceFiles: { list, changes },
  }
  changes.mockImplementation(async function* (_sessionId, _path, signal = new AbortController().signal) {
    while (!signal.aborted) {
      const frame = frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  })
  return {
    remote,
    list,
    changes,
    accepted,
    disposed,
    push(frame: WorkspaceFileWatchFrame) {
      frames.push(frame)
      wake?.()
    },
  }
}

async function take(iterator: AsyncIterator<boolean>, count: number): Promise<(boolean | 'done')[]> {
  const values: (boolean | 'done')[] = []
  for (let index = 0; index < count; index++) {
    const step = await iterator.next()
    values.push(step.done === true ? 'done' : step.value)
  }
  return values
}

describe('watchHoldsNothing', () => {
  it('lists the folder when its watch is ready and after each change, and ends once it holds something', async () => {
    const watch = folderRemote([['.git'], ['.git', '.DS_Store'], ['.git', 'project.godot']])
    const iterator = watchHoldsNothing(watch.remote, SESSION, '/games/neon', new AbortController().signal)[Symbol.asyncIterator]()
    watch.push({ kind: 'ready' })
    expect(await take(iterator, 1)).toEqual([true])
    expect(watch.accepted).toEqual(['accept'])
    expect(watch.changes).toHaveBeenCalledWith(SESSION, '/games/neon', expect.any(AbortSignal))
    watch.push({ kind: 'change', change: { absolutePath: '/games/neon/.DS_Store', version: '1' } })
    expect(await take(iterator, 1)).toEqual([true])
    watch.push({ kind: 'change', change: { absolutePath: '/games/neon/project.godot', version: '1' } })
    expect(await take(iterator, 2)).toEqual([false, 'done'])
    expect(watch.list).toHaveBeenCalledTimes(3)
    expect(watch.list).toHaveBeenLastCalledWith(SESSION, '/games/neon', expect.any(AbortSignal))
    expect(watch.disposed).toHaveBeenCalledTimes(1)
  })

  it('counts a failed listing as something', async () => {
    const watch = folderRemote(['failed'])
    const iterator = watchHoldsNothing(watch.remote, SESSION, '/games/neon', new AbortController().signal)[Symbol.asyncIterator]()
    watch.push({ kind: 'ready' })
    expect(await take(iterator, 2)).toEqual([false, 'done'])
    expect(watch.disposed).toHaveBeenCalledTimes(1)
  })

  it('ends and closes the stream when its signal aborts', async () => {
    const watch = folderRemote([['.git']])
    const lifetime = new AbortController()
    const iterator = watchHoldsNothing(watch.remote, SESSION, '/games/neon', lifetime.signal)[Symbol.asyncIterator]()
    watch.push({ kind: 'ready' })
    expect(await take(iterator, 1)).toEqual([true])
    const next = iterator.next()
    lifetime.abort()
    expect(await next).toEqual({ done: true, value: undefined })
    expect(watch.disposed).toHaveBeenCalled()
  })

  it('opens nothing for an aborted signal', async () => {
    const watch = folderRemote([['.git']])
    const lifetime = new AbortController()
    lifetime.abort()
    expect(await take(watchHoldsNothing(watch.remote, SESSION, '/games/neon', lifetime.signal)[Symbol.asyncIterator](), 1)).toEqual(['done'])
    expect(watch.changes).not.toHaveBeenCalled()
  })
})

describe('dismissed projects', () => {
  it('keeps each project once, most recent last, up to the limit, in localStorage', () => {
    const store = createDismissedProjects()
    dismissProject(store, '/games/a')
    dismissProject(store, '/games/b')
    dismissProject(store, '/games/a')
    expect(store.getSnapshot()).toEqual(['/games/b', '/games/a'])
    expect(JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? 'null')).toEqual(['/games/b', '/games/a'])
    expect(createDismissedProjects().getSnapshot()).toEqual(['/games/b', '/games/a'])
    for (let index = 0; index < DISMISSED_LIMIT + 5; index++) dismissProject(store, `/games/${index}`)
    expect(store.getSnapshot()).toHaveLength(DISMISSED_LIMIT)
    expect(store.getSnapshot().at(-1)).toBe(`/games/${DISMISSED_LIMIT + 4}`)
    expect(store.getSnapshot()[0]).toBe('/games/5')
  })

  it('starts over from a stored value that is not a list of paths', () => {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ '/games/a': true }))
    expect(createDismissedProjects().getSnapshot()).toEqual([])
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(['/games/a', 7]))
    expect(createDismissedProjects().getSnapshot()).toEqual([])
  })
})
