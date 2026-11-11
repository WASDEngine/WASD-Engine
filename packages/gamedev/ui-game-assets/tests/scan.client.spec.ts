/** The project scan: which folders it enters, which files it lists, its order, its caps, and its failures. */
import type { WorkspaceDirectoryEntry, WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { extensionOf, formatOf } from '../src/client/formats.ts'
import { childPath, entersFolder, scanAssets, type ListFolder } from '../src/client/scan.ts'

const file = (name: string, size?: number): WorkspaceDirectoryEntry => ({ name, type: 'file', ...size === undefined ? {} : { size } })
const folder = (name: string): WorkspaceDirectoryEntry => ({ name, type: 'directory' })

/** A project as folders by workspace path; `.` lists the root, whose listing reports the empty path. */
function project(tree: Readonly<Record<string, readonly WorkspaceDirectoryEntry[]>>, aliases: Readonly<Record<string, string>> = {}) {
  const list = vi.fn<ListFolder>(async (path) => {
    const key = path === '.' ? '' : aliases[path] ?? path
    const entries = tree[key]
    if (entries === undefined) return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
    return { ok: true, value: { path: key, entries, truncated: false } }
  })
  return list
}

const LIMITS = { maxFolders: 100, maxAssets: 100 }

describe('formats', () => {
  it('reads lowercase extensions and lists only art formats', () => {
    expect(extensionOf('assets/Hero.PNG')).toBe('png')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('folder.v2/readme')).toBe('')
    expect(formatOf('a.glb')).toMatchObject({ kind: 'model', decoder: 'gltf', label: 'GLB' })
    expect(formatOf('a.jpeg')).toMatchObject({ kind: 'image', decoder: 'browser', mediaType: 'image/jpeg' })
    expect(formatOf('a.exr')).toMatchObject({ kind: 'image', decoder: 'exr' })
    expect(formatOf('a.blend')).toMatchObject({ kind: 'model', decoder: 'blend' })
    expect(formatOf('a.gd')).toBeUndefined()
    expect(formatOf('a.toString')).toBeUndefined()
  })
})

describe('scanAssets', () => {
  it('collects the art of every folder, skipping hidden folders and node_modules, ordered by folder and name', async () => {
    const list = project({
      '': [folder('assets'), folder('.godot'), folder('node_modules'), file('icon.svg', 120), file('main.gd'), file('project.godot')],
      assets: [folder('models'), folder('textures'), file('notes.txt')],
      'assets/models': [file('Tree 10.glb', 900), file('tree 2.glb', 800), folder('src')],
      'assets/models/src': [file('tree.blend')],
      'assets/textures': [file('grass.png'), file('dirt.PNG')],
    })
    const result = await scanAssets(list, LIMITS, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.assets.map(asset => asset.path)).toEqual([
      'icon.svg',
      'assets/models/tree 2.glb',
      'assets/models/Tree 10.glb',
      'assets/models/src/tree.blend',
      'assets/textures/dirt.PNG',
      'assets/textures/grass.png',
    ])
    expect(result.value.assets[0]).toMatchObject({ name: 'icon.svg', folder: '', bytes: 120, format: { kind: 'image' } })
    expect(result.value.assets[1]).toMatchObject({ folder: 'assets/models', bytes: 800 })
    expect(result.value).toMatchObject({ truncated: false, unreadable: 0 })
    expect(list.mock.calls.map(call => call[0]).sort()).toEqual(['.', 'assets', 'assets/models', 'assets/models/src', 'assets/textures'])
  })

  it('returns the project folder\'s own failure', async () => {
    const error = new RemoteError('workspace-file/outside-workspace', 'outside', { path: '.' })
    const list = vi.fn<ListFolder>(async () => ({ ok: false, error }))
    expect(await scanAssets(list, LIMITS, new AbortController().signal)).toEqual({ ok: false, error })
  })

  it('counts folders that fail to list, but not folders removed during the walk', async () => {
    const list = vi.fn<ListFolder>(async (path): Promise<RemoteResult<WorkspaceDirectoryListing>> => {
      if (path === '.') return { ok: true, value: { path: '', entries: [folder('locked'), folder('gone'), folder('art')], truncated: false } }
      if (path === 'locked') return { ok: false, error: new RemoteError('gateway/internal', 'denied', {}) }
      if (path === 'gone') return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
      return { ok: true, value: { path: 'art', entries: [file('a.png')], truncated: false } }
    })
    const result = await scanAssets(list, LIMITS, new AbortController().signal)
    expect(result.ok && result.value).toMatchObject({ unreadable: 1, truncated: false, assets: [{ path: 'art/a.png' }] })
  })

  it('lists a folder reached through a link once, under the path the Host resolves it to', async () => {
    const list = project({
      '': [folder('art'), folder('link'), folder('loop')],
      art: [file('a.png')],
    }, { link: 'art', loop: '' })
    const result = await scanAssets(list, LIMITS, new AbortController().signal)
    expect(result.ok && result.value.assets.map(asset => asset.path)).toEqual(['art/a.png'])
  })

  it('stops at the asset cap and at the folder cap, and says the list is incomplete', async () => {
    const tree = { '': [folder('a'), folder('b'), folder('c'), file('1.png'), file('2.png')], a: [file('3.png')], b: [file('4.png')], c: [file('5.png')] }
    const capped = await scanAssets(project(tree), { maxFolders: 100, maxAssets: 3 }, new AbortController().signal)
    expect(capped.ok && capped.value).toMatchObject({ truncated: true })
    expect(capped.ok && capped.value.assets).toHaveLength(3)
    const list = project(tree)
    const shallow = await scanAssets(list, { maxFolders: 2, maxAssets: 100 }, new AbortController().signal)
    expect(shallow.ok && shallow.value).toMatchObject({ truncated: true })
    expect(list).toHaveBeenCalledTimes(2)
    const cut = vi.fn<ListFolder>(async () => ({ ok: true, value: { path: '', entries: [file('a.png')], truncated: true } }))
    const partial = await scanAssets(cut, LIMITS, new AbortController().signal)
    expect(partial.ok && partial.value.truncated).toBe(true)
  })

  it('keeps at most six listings in flight', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `f${String(index)}`)
    let active = 0
    let peak = 0
    const list = vi.fn<ListFolder>(async (path) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      if (path === '.') return { ok: true, value: { path: '', entries: names.map(folder), truncated: false } }
      return { ok: true, value: { path, entries: [file('x.png')], truncated: false } }
    })
    const result = await scanAssets(list, LIMITS, new AbortController().signal)
    expect(result.ok && result.value.assets).toHaveLength(20)
    expect(peak).toBe(6)
  })

  it('rejects with the abort reason and lists nothing more', async () => {
    const controller = new AbortController()
    const list = vi.fn<ListFolder>(async (path) => {
      if (path !== '.') controller.abort(new Error('closed'))
      return { ok: true, value: { path: path === '.' ? '' : path, entries: path === '.' ? [folder('a'), folder('b')] : [folder('c')], truncated: false } }
    })
    await expect(scanAssets(list, LIMITS, controller.signal)).rejects.toThrow('closed')
    // The abort during the first folder's listing starts no other listing.
    expect(list.mock.calls.map(call => call[0])).toEqual(['.', 'a'])
    const aborted = new AbortController()
    aborted.abort(new Error('before'))
    await expect(scanAssets(list, LIMITS, aborted.signal)).rejects.toThrow('before')
  })

  it('rejects when a listing rejects', async () => {
    const list = vi.fn<ListFolder>(async (path) => {
      if (path === '.') return { ok: true, value: { path: '', entries: [folder('a')], truncated: false } }
      throw new Error('assembly fault')
    })
    await expect(scanAssets(list, LIMITS, new AbortController().signal)).rejects.toThrow('assembly fault')
  })

  it('joins paths and skips hidden folders', () => {
    expect(childPath('', 'a')).toBe('a')
    expect(childPath('a/b', 'c')).toBe('a/b/c')
    expect(entersFolder('.godot')).toBe(false)
    expect(entersFolder('node_modules')).toBe(false)
    expect(entersFolder('addons')).toBe(true)
  })
})
