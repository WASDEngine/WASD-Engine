/** Release folders record which folders on this computer released each game, one file per game. */
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { folderOf, ReleaseFolders } from '../src/folders.ts'

const ORIGIN = 'https://site.test'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wasd-folders-'))
  roots.push(root)
  return root
}

describe('ReleaseFolders', () => {
  it('keeps one record per folder, the latest first, and follows a renamed folder by its file-system ID', async () => {
    const root = await scratch()
    const records = new ReleaseFolders(join(root, 'data'))
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    const a = await folderOf(join(root, 'a'))
    expect(a.path).toBe(await realpath(join(root, 'a')))
    expect(a.inode).toMatch(/^\d+$/u)
    expect(await records.list(ORIGIN, 'game-1')).toEqual([])
    await records.add(ORIGIN, 'game-1', a)
    await records.add(ORIGIN, 'game-1', await folderOf(join(root, 'b')))
    await records.add(ORIGIN, 'game-1', a)
    expect((await records.list(ORIGIN, 'game-1')).map(folder => folder.path)).toEqual([a.path, await realpath(join(root, 'b'))])
    await rename(join(root, 'a'), join(root, 'renamed'))
    const renamed = await folderOf(join(root, 'renamed'))
    expect(renamed.inode).toBe(a.inode)
    await records.add(ORIGIN, 'game-1', renamed)
    expect((await records.list(ORIGIN, 'game-1')).map(folder => folder.path)).toEqual([renamed.path, await realpath(join(root, 'b'))])
    expect(await records.list(ORIGIN, 'game-2')).toEqual([])
    expect(await records.list('https://other.test', 'game-1')).toEqual([])
    expect((await readdir(join(root, 'data'))).filter(name => !name.endsWith('.json'))).toEqual([])
  })

  it('names the folder that shares a game with a copy only while that folder exists and links to the game', async () => {
    const root = await scratch()
    const records = new ReleaseFolders(join(root, 'data'))
    await mkdir(join(root, 'original'))
    await mkdir(join(root, 'copy'))
    const original = await folderOf(join(root, 'original'))
    const copy = await folderOf(join(root, 'copy'))
    let links = true
    const linked = () => Promise.resolve(links)
    expect(await records.sharedWith(ORIGIN, 'game-1', copy, linked)).toBeUndefined()
    await records.add(ORIGIN, 'game-1', original)
    expect(await records.sharedWith(ORIGIN, 'game-1', copy, linked)).toBe(original.path)
    expect(await records.sharedWith(ORIGIN, 'game-1', original, linked)).toBeUndefined()
    links = false
    expect(await records.sharedWith(ORIGIN, 'game-1', copy, linked)).toBeUndefined()
    links = true
    await rm(join(root, 'original'), { recursive: true })
    expect(await records.sharedWith(ORIGIN, 'game-1', copy, linked)).toBeUndefined()
  })

  it('reads a damaged record as one that knows no folder', async () => {
    const root = await scratch()
    const records = new ReleaseFolders(join(root, 'data'))
    await mkdir(join(root, 'game'))
    const folder = await folderOf(join(root, 'game'))
    await records.add(ORIGIN, 'game-1', folder)
    const [file] = await readdir(join(root, 'data'))
    await writeFile(join(root, 'data', file!), 'not json')
    expect(await records.list(ORIGIN, 'game-1')).toEqual([])
    await writeFile(join(root, 'data', file!), '{"format": 2, "folders": []}')
    expect(await records.list(ORIGIN, 'game-1')).toEqual([])
    await records.add(ORIGIN, 'game-1', folder)
    expect(await records.list(ORIGIN, 'game-1')).toEqual([folder])
  })
})
