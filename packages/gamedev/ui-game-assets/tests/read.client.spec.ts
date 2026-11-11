// @vitest-environment jsdom
/** Reading the viewed asset, completely or window by window, and naming the files a model refers to. */
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { readAsset, relatedUrl, resolveRelated, type ReadBytes } from '../src/client/read.ts'

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
  it('resolves names against the viewed file\'s folder, absolute names by their file name', () => {
    expect(resolveRelated('/p/models/hero.gltf', 'hero.bin')).toBe('/p/models/hero.bin')
    expect(resolveRelated('/p/models/hero.gltf', './tex/skin.png')).toBe('/p/models/tex/skin.png')
    expect(resolveRelated('/p/models/hero.obj', '../materials/hero.mtl')).toBe('/p/materials/hero.mtl')
    expect(resolveRelated('/p/a.obj', '../../../../x.png')).toBe('/x.png')
    expect(resolveRelated('/p/models/hero.fbx', 'C:\\Users\\artist\\textures\\skin.png')).toBe('/p/models/skin.png')
    expect(resolveRelated('C:\\game\\models\\hero.gltf', 'tex/skin.png')).toBe('C:\\game\\models\\tex\\skin.png')
    expect(resolveRelated('C:\\game\\hero.gltf', '..\\..\\skin.png')).toBe('C:\\skin.png')
    expect(resolveRelated('\\\\server\\share\\hero.gltf', 'skin.png')).toBe('\\\\server\\share\\skin.png')
  })

  it('serves related files from the authenticated file route and passes data and blob URLs through', () => {
    const base = 'dsh-app://app/'
    expect(relatedUrl(base, '/p/models/hero.gltf', 'my%20skin.png'))
      .toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/p/models/my skin.png')}`)
    expect(relatedUrl(base, '/p/models/hero.gltf', '100%.png')).toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/p/models/100%.png')}`)
    expect(relatedUrl(base, '/p/hero.gltf', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(relatedUrl(base, '/p/hero.gltf', 'blob:dsh-app://app/123')).toBe('blob:dsh-app://app/123')
    expect(relatedUrl('file:///index.html', '/p/hero.gltf', 'skin.png')).toBe('skin.png')
  })
})
