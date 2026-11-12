// @vitest-environment jsdom
/**
 * Reading the viewed asset, completely or window by window, and naming the files a model refers to: inside the project
 * folder only, never from the web.
 */
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { projectRootOf, readAsset, relatedUrl, resolveRelated, type ReadBytes } from '../src/client/read.ts'

type Bytes = RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>

const COMPLETE_CAP = 8
const WINDOW = 4

/** A file served like the Host: complete reads up to a cap, windows of a fixed size, a version per content. */
function host(
  content: () => Uint8Array<ArrayBuffer>,
  version: () => string,
  size: (data: Uint8Array) => number | undefined = data => data.length,
) {
  return vi.fn<ReadBytes>(async (path: string, options: WorkspaceByteReadOptions): Promise<Bytes> => {
    const data = content()
    const meta = { absolutePath: `/project/${path}`, version: version(), ...size(data) === undefined ? {} : { bytes: data.length } }
    if (options.range === undefined) {
      if (data.length > COMPLETE_CAP) return { ok: false, error: new RemoteError('workspace-file/too-large', 'cap', { path, limit: COMPLETE_CAP }) }
      return { ok: true, value: { ...meta, offset: 0, data, eof: true } }
    }
    const offset = options.range.offset ?? 0
    const window = data.slice(offset, offset + WINDOW)
    return { ok: true, value: { ...meta, offset, data: window, eof: offset + WINDOW >= data.length } }
  })
}

const bytes = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, index) => index)

describe('readAsset', () => {
  it('reads a file under the complete-file cap at once', async () => {
    const read = host(() => bytes(5), () => 'v1')
    const result = await readAsset(read, 'a.png', 100, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: { data: bytes(5), absolutePath: '/project/a.png', version: 'v1' } })
    expect(read).toHaveBeenCalledOnce()
  })

  it('reads a larger file window by window, with or without a reported size', async () => {
    for (const size of [(data: Uint8Array) => data.length, () => undefined]) {
      const read = host(() => bytes(10), () => 'v1', size)
      const result = await readAsset(read, 'big.glb', 100, new AbortController().signal)
      expect(result.ok && [...result.value.data]).toEqual([...bytes(10)])
      expect(read.mock.calls.map(call => call[1])).toEqual([{}, { range: {} }, { range: { offset: 4 } }, { range: { offset: 8 } }])
    }
  })

  it('refuses a file above the preview cap, before or while reading its windows', async () => {
    const small = await readAsset(host(() => bytes(5), () => 'v1'), 'a.png', 4, new AbortController().signal)
    expect(!small.ok && small.error.code === 'workspace-file/too-large' && small.error.details.limit).toBe(4)
    const sized = await readAsset(host(() => bytes(10), () => 'v1'), 'a.png', 9, new AbortController().signal)
    expect(!sized.ok && sized.error.code).toBe('workspace-file/too-large')
    const unsized = host(() => bytes(10), () => 'v1', () => undefined)
    const streamed = await readAsset(unsized, 'a.png', 6, new AbortController().signal)
    expect(!streamed.ok && streamed.error.code).toBe('workspace-file/too-large')
  })

  it('starts over once when the file changes between windows, and gives up when it keeps changing', async () => {
    let calls = 0
    const settles = host(() => bytes(10), () => (calls++ < 2 ? 'v1' : 'v2'))
    const settled = await readAsset(settles, 'a.glb', 100, new AbortController().signal)
    expect(settled.ok && settled.value.version).toBe('v2')
    let tick = 0
    const restless = host(() => bytes(10), () => `v${String(tick++)}`)
    const failed = await readAsset(restless, 'a.glb', 100, new AbortController().signal)
    expect(!failed.ok && failed.error.code).toBe('game-assets/changed')
  })

  it('returns other failures as they are', async () => {
    const error = new RemoteError('workspace-file/not-found', 'gone', { path: 'a.png' })
    const read = vi.fn<ReadBytes>(async () => ({ ok: false, error }))
    expect(await readAsset(read, 'a.png', 100, new AbortController().signal)).toEqual({ ok: false, error })
    const windows = vi.fn<ReadBytes>(async (_path, options) => options.range === undefined
      ? { ok: false, error: new RemoteError('workspace-file/too-large', 'cap', { path: 'a', limit: 1 }) }
      : { ok: false, error })
    expect(await readAsset(windows, 'a.png', 100, new AbortController().signal)).toEqual({ ok: false, error })
  })
})

describe('related files', () => {
  it('finds the project folder from a file\'s absolute path and its path in the project', () => {
    expect(projectRootOf('/Users/me/Knight/models/knight.gltf', 'models/knight.gltf')).toBe('/Users/me/Knight')
    expect(projectRootOf('C:\\Games\\Knight\\models\\knight.gltf', 'models/knight.gltf')).toBe('C:\\Games\\Knight')
    // A case-insensitive filesystem may report another case than the call named.
    expect(projectRootOf('/Users/me/Knight/models/knight.gltf', 'Models/Knight.gltf')).toBe('/Users/me/Knight')
    expect(projectRootOf('/knight.gltf', 'knight.gltf')).toBe('')
    // A file outside the project, or reached through a link that leads elsewhere, keeps to its own folder.
    expect(projectRootOf('/Users/me/Knight/models/knight.gltf', '/Users/me/Knight/models/knight.gltf')).toBe('/Users/me/Knight/models')
    expect(projectRootOf('/Volumes/shared/meshes/knight.gltf', 'models/knight.gltf')).toBe('/Volumes/shared/meshes')
    expect(projectRootOf('/Users/me/Knight/knight.gltf', '../Knight/knight.gltf')).toBe('/Users/me/Knight')
  })

  it('resolves names against the viewed file\'s folder inside the project, absolute names by their file name', () => {
    expect(resolveRelated('/p/models/hero.gltf', 'hero.bin', '/p')).toBe('/p/models/hero.bin')
    expect(resolveRelated('/p/models/hero.gltf', './tex/skin.png', '/p')).toBe('/p/models/tex/skin.png')
    expect(resolveRelated('/p/models/hero.obj', '../materials/hero.mtl', '/p')).toBe('/p/materials/hero.mtl')
    expect(resolveRelated('/p/models/hero.fbx', 'C:\\Users\\artist\\textures\\skin.png', '/p')).toBe('/p/models/skin.png')
    expect(resolveRelated('C:\\game\\models\\hero.gltf', 'tex/skin.png', 'C:\\game')).toBe('C:\\game\\models\\tex\\skin.png')
    expect(resolveRelated('C:\\game\\models\\hero.gltf', '..\\skin.png', 'C:\\game')).toBe('C:\\game\\skin.png')
    expect(resolveRelated('\\\\server\\share\\hero.gltf', 'skin.png', '\\\\server\\share')).toBe('\\\\server\\share\\skin.png')
    // `..` never leads out of the project folder.
    expect(resolveRelated('/p/a.obj', '../../../../x.png', '/p')).toBeUndefined()
    expect(resolveRelated('C:\\game\\hero.gltf', '..\\..\\skin.png', 'C:\\game')).toBeUndefined()
    expect(resolveRelated('/p/models/hero.gltf', '../../p/models/hero.bin', '/p')).toBeUndefined()
  })

  it('serves related files from the authenticated file route and passes data and blob URLs through', () => {
    const base = 'dsh-app://app/'
    expect(relatedUrl(base, '/p/models/hero.gltf', 'models/hero.gltf', 'my%20skin.png'))
      .toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/p/models/my skin.png')}`)
    expect(relatedUrl(base, '/p/models/hero.gltf', 'models/hero.gltf', '100%.png')).toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/p/models/100%.png')}`)
    expect(relatedUrl(base, '/p/models/hero.gltf', 'models/hero.gltf', '../textures/skin.png'))
      .toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/p/textures/skin.png')}`)
    expect(relatedUrl(base, '/p/hero.gltf', 'hero.gltf', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(relatedUrl(base, '/p/hero.gltf', 'hero.gltf', 'blob:dsh-app://app/123')).toBe('blob:dsh-app://app/123')
  })

  it('loads nothing from the web, from outside the project, or from a path the file route does not serve', () => {
    const base = 'dsh-app://app/'
    const model = '/Users/me/Games/Knight/models/knight.gltf'
    const refused = [
      'https://tracker.example/t.png',
      // A control character makes the file route refuse the path; the name is not fetched from the web instead.
      'https://tracker.example/t%0A.png',
      'https%3A%2F%2Ftracker.example%2Ft.png',
      'file:///Users/me/Pictures/private.png',
      '../../../../../Users/me/Pictures/private.png',
      'textures/body%0A.png',
    ]
    for (const reference of refused) expect(relatedUrl(base, model, 'models/knight.gltf', reference), reference).toBeUndefined()
    // An absolute name loads by its file name from the model's folder.
    expect(relatedUrl(base, model, 'models/knight.gltf', '/Users/me/Pictures/private.png'))
      .toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/Users/me/Games/Knight/models/private.png')}`)
    // A project on a UNC share, which the file route does not serve, loads none of its model's files.
    expect(relatedUrl(base, '\\\\nas\\share\\Knight\\knight.gltf', 'knight.gltf', 'textures/body.png')).toBeUndefined()
    expect(relatedUrl(base, '\\\\nas\\share\\Knight\\knight.gltf', 'knight.gltf', 'https://tracker.example/t.png')).toBeUndefined()
    // A page the file route does not serve, such as one opened from a file, loads none either.
    expect(relatedUrl('file:///index.html', '/p/hero.gltf', 'hero.gltf', 'skin.png')).toBeUndefined()
  })
})
