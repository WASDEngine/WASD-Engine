/** A project's state: files replaced whole, and one operation of a project at a time, by the folder's real path. */
import type { PathLike } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectQueue, STATE_DIR, STATE_GITIGNORE, writeWhole } from '../src/state.ts'

/** A wait that the next lookup of a real path takes before it answers, such as a slow disk's. */
const lookups = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (path: PathLike): Promise<string> => {
      const hold = lookups.hold
      lookups.hold = undefined
      if (hold !== undefined) await hold
      return await actual.realpath(path)
    },
  }
})

const folders: string[] = []
afterEach(async () => {
  lookups.hold = undefined
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-state-'))
  folders.push(dir)
  return dir
}

const signal = new AbortController().signal

describe('ProjectQueue', () => {
  it('runs one project\'s operations one at a time in the order they asked, also through a symbolic link, and other projects\' at once', async () => {
    const root = await scratch()
    await mkdir(join(root, 'game'))
    await mkdir(join(root, 'other'))
    await symlink(join(root, 'game'), join(root, 'game link'))
    const queue = new ProjectQueue()
    const events: string[] = []
    const started = Promise.withResolvers<undefined>()
    const first = Promise.withResolvers<undefined>()
    const running = queue.run(join(root, 'game'), signal, async () => {
      events.push('first starts')
      started.resolve(undefined)
      await first.promise
      events.push('first ends')
    })
    await started.promise
    const second = queue.run(join(root, 'game link'), signal, async () => { events.push('second runs') })
    await queue.run(join(root, 'other'), signal, async () => { events.push('other runs') })
    expect(events).toEqual(['first starts', 'other runs'])
    first.resolve(undefined)
    await Promise.all([running, second])
    expect(events).toEqual(['first starts', 'other runs', 'first ends', 'second runs'])
  })

  it('ends a wait that its signal cancels without running it, and keeps later operations behind the earlier ones', async () => {
    const root = await scratch()
    const queue = new ProjectQueue()
    const events: string[] = []
    const first = Promise.withResolvers<undefined>()
    const running = queue.run(root, signal, async () => {
      await first.promise
      events.push('first ends')
    })
    const cancel = new AbortController()
    const cancelled = queue.run(root, cancel.signal, async () => { events.push('cancelled runs') })
    const third = queue.run(root, signal, async () => { events.push('third runs') })
    cancel.abort(new Error('The call was cancelled.'))
    await expect(cancelled).rejects.toThrow('The call was cancelled.')
    expect(events).toEqual([])
    first.resolve(undefined)
    await Promise.all([running, third])
    expect(events).toEqual(['first ends', 'third runs'])
  })

  it('queues operations in the order they were asked for, also when a later one finds its folder first', async () => {
    const root = await scratch()
    const queue = new ProjectQueue()
    const events: string[] = []
    const first = Promise.withResolvers<undefined>()
    const found = Promise.withResolvers<undefined>()
    lookups.hold = found.promise
    const running = queue.run(root, signal, async () => {
      events.push('first starts')
      await first.promise
      events.push('first ends')
    })
    const second = queue.run(root, signal, async () => { events.push('second runs') })
    // The second call's folder would resolve now, while the first call's waits.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(events).toEqual([])
    found.resolve(undefined)
    await vi.waitFor(() => { expect(events).toEqual(['first starts']) })
    first.resolve(undefined)
    await Promise.all([running, second])
    expect(events).toEqual(['first starts', 'first ends', 'second runs'])
  })

  it('runs the next operation after one that failed', async () => {
    const root = await scratch()
    const queue = new ProjectQueue()
    await expect(queue.run(root, signal, () => Promise.reject(new Error('The export failed.')))).rejects.toThrow('The export failed.')
    expect(await queue.run(root, signal, () => Promise.resolve('released'))).toBe('released')
  })
})

describe('writeWhole', () => {
  it('replaces a file, and leaves no temporary file when the write fails', async () => {
    const root = await scratch()
    await writeWhole(join(root, 'game.json'), '{"format":1}\n')
    await writeWhole(join(root, 'game.json'), '{"format":1,"games":{}}\n')
    expect(await readFile(join(root, 'game.json'), 'utf8')).toBe('{"format":1,"games":{}}\n')
    await expect(writeWhole(join(root, 'missing', 'game.json'), '{}')).rejects.toThrow(/ENOENT/u)
    expect(await readdir(root)).toEqual(['game.json'])
  })
})

describe('the state folder\'s .gitignore', () => {
  it('keeps the builds out of git once an operation leaves the state folder, and keeps a .gitignore the user wrote', async () => {
    const root = await scratch()
    const project = join(root, 'game')
    await mkdir(project)
    const queue = new ProjectQueue()
    // An operation that makes no state folder leaves none.
    await queue.run(project, signal, async () => {})
    expect(await readdir(project)).toEqual([])
    await queue.run(project, signal, async () => { await mkdir(join(project, STATE_DIR, 'web'), { recursive: true }) })
    expect(await readFile(join(project, STATE_DIR, '.gitignore'), 'utf8')).toBe(STATE_GITIGNORE)
    expect(STATE_GITIGNORE.split('\n')).toEqual(expect.arrayContaining(['/web/', '/desktop/', '/server/', '/mobile/', '/web-zip/', '/preview/']))
    await writeWhole(join(project, STATE_DIR, '.gitignore'), 'mine\n')
    await queue.run(project, signal, async () => {})
    expect(await readFile(join(project, STATE_DIR, '.gitignore'), 'utf8')).toBe('mine\n')
  })
})
