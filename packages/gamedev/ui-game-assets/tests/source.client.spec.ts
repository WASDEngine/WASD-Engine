/** One Session's Assets tab state: scans, kept results, dropped duplicate scans, freshness, choices, and closing. */
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ListFolder } from '../src/client/scan.ts'
import { AssetsSource, FRESH_SCAN_MS } from '../src/client/source.ts'

type Listing = RemoteResult<WorkspaceDirectoryListing>

/** A listing the test settles by hand. */
function controlled() {
  const pending: { readonly path: string; readonly signal: AbortSignal; readonly settle: (result: Listing) => void }[] = []
  const list = vi.fn<ListFolder>((path, signal) => new Promise<Listing>((resolve) => { pending.push({ path, signal, settle: resolve }) }))
  return { list, pending }
}

const listing = (...names: string[]): Listing => ({
  ok: true,
  value: { path: '', entries: names.map(name => ({ name, type: 'file' as const })), truncated: false },
})

const settled = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }

describe('AssetsSource', () => {
  it('scans, keeps the result while the next scan runs and after it fails, and drops a request while one runs', async () => {
    let now = 1000
    const { list, pending } = controlled()
    const source = new AssetsSource(list, { maxFolders: 10, maxAssets: 10 }, () => now, vi.fn())
    expect(source.scanState.getSnapshot()).toEqual({ status: 'idle' })
    source.rescan()
    source.rescan()
    expect(list).toHaveBeenCalledOnce()
    expect(source.scanState.getSnapshot().status).toBe('scanning')
    pending[0]?.settle(listing('a.png', 'b.txt'))
    await settled()
    expect(source.scanState.getSnapshot()).toMatchObject({ status: 'ready', settledAt: 1000, scan: { assets: [{ path: 'a.png' }] } })
    now = 5000
    source.rescan()
    expect(source.scanState.getSnapshot()).toMatchObject({ status: 'scanning', scan: { assets: [{ path: 'a.png' }] } })
    const failure = new RemoteError('workspace-file/outside-workspace', 'outside', { path: '.' })
    pending[1]?.settle({ ok: false, error: failure })
    await settled()
    expect(source.scanState.getSnapshot()).toMatchObject({ status: 'failed', scan: { assets: [{ path: 'a.png' }] }, settledAt: 5000 })
    expect(source.scanState.getSnapshot().failure).toBe(failure)
    source.rescan()
    pending[2]?.settle(listing('c.glb'))
    await settled()
    expect(source.scanState.getSnapshot()).toMatchObject({ status: 'ready', scan: { assets: [{ path: 'c.glb' }] } })
    expect(source.scanState.getSnapshot().failure).toBeUndefined()
  })

  it('refreshes only a scan older than the freshness window', async () => {
    let now = 0
    const { list, pending } = controlled()
    const source = new AssetsSource(list, { maxFolders: 10, maxAssets: 10 }, () => now, vi.fn())
    source.refresh()
    pending[0]?.settle(listing())
    await settled()
    now = FRESH_SCAN_MS - 1
    source.refresh()
    expect(list).toHaveBeenCalledOnce()
    now = FRESH_SCAN_MS
    source.refresh()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('offers its latest scan only while it is fresh', async () => {
    let now = 0
    const { list, pending } = controlled()
    const source = new AssetsSource(list, { maxFolders: 10, maxAssets: 10 }, () => now, vi.fn())
    expect(source.freshScan()).toBeUndefined()
    source.rescan()
    pending[0]?.settle(listing('a.png'))
    await settled()
    expect(source.freshScan()?.assets.map(asset => asset.path)).toEqual(['a.png'])
    now = FRESH_SCAN_MS
    expect(source.freshScan()).toBeUndefined()
    expect(source.scanState.getSnapshot().scan?.assets.map(asset => asset.path)).toEqual(['a.png'])
  })

  it('keeps a slow scan fresh for ten times its duration', async () => {
    let now = 0
    const { list, pending } = controlled()
    const source = new AssetsSource(list, { maxFolders: 10, maxAssets: 10 }, () => now, vi.fn())
    source.rescan()
    now = 1000
    pending[0]?.settle(listing())
    await settled()
    now = 1000 + 9999
    source.refresh()
    expect(list).toHaveBeenCalledOnce()
    now = 1000 + 10_000
    source.refresh()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reports a scan that throws and shows it as failed', async () => {
    const report = vi.fn()
    const error = new Error('assembly fault')
    const source = new AssetsSource(vi.fn<ListFolder>(async () => { throw error }), { maxFolders: 10, maxAssets: 10 }, () => 7, report)
    source.rescan()
    await settled()
    expect(report).toHaveBeenCalledWith(error)
    expect(source.scanState.getSnapshot()).toEqual({ status: 'failed', settledAt: 7 })
  })

  it('records the selection, the open folders, and the filter', () => {
    const source = new AssetsSource(vi.fn<ListFolder>(), { maxFolders: 10, maxAssets: 10 }, () => 0, vi.fn())
    expect(source.view.getSnapshot()).toEqual({ selected: undefined, open: undefined, filter: 'all' })
    source.select('a.png')
    source.setOpen(['assets'])
    source.setFilter('model')
    expect(source.view.getSnapshot()).toEqual({ selected: 'a.png', open: ['assets'], filter: 'model' })
    source.select(undefined)
    expect(source.view.getSnapshot().selected).toBeUndefined()
  })

  it('stops the running scan on close, keeps its state, and scans no more', async () => {
    const { list, pending } = controlled()
    const source = new AssetsSource(list, { maxFolders: 10, maxAssets: 10 }, () => 0, vi.fn())
    source.rescan()
    source.close()
    expect(pending[0]?.signal.aborted).toBe(true)
    pending[0]?.settle(listing('a.png'))
    await settled()
    expect(source.scanState.getSnapshot().status).toBe('scanning')
    source.rescan()
    expect(list).toHaveBeenCalledOnce()
  })
})
