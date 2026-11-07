/**
 * The Plugins page tab's state owner: nothing is read before the tab renders, each mount reads again, reads join the
 * inventory with the plugin manager's switch targets, newer reads supersede older ones, and each switch write publishes
 * its busy state and the notice its answer leaves, without dropping another write's notice, before the tools are read
 * again.
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult, PluginEntryId, PluginInfo, PluginInventorySnapshot, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { GameToolsController, type GameToolsState } from '../src/client/controller.ts'
import { BLENDER, change, entryId, failed, GIMP, GODOT, inventory, OTHER, plugins } from './fixtures.client.ts'

function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const list = vi.fn<() => Promise<RemoteResult<PluginInventorySnapshot>>>(() => Promise.resolve(inventory()))
  const listPlugins = vi.fn<() => Promise<RemoteResult<PluginInfo[]>>>(() => Promise.resolve(plugins()))
  const setPluginEnabled = vi.fn<(id: PluginEntryId, enabled: boolean) => Promise<RemoteResult<ChangeResult>>>(
    () => Promise.resolve(change()),
  )
  new TestRemote(ctx, { pluginInventory: { list }, pluginManager: { listPlugins, setPluginEnabled } })
  const controller = new GameToolsController(ctx)
  const resolveText = (text: string | { readonly en: string }): string => typeof text === 'string' ? text : text.en
  const face = controller.face(resolveText)
  const notices = controller.noticeFace(resolveText)
  const state = (): GameToolsState => controller.store.getSnapshot()
  return { ctx, list, listPlugins, setPluginEnabled, controller, face, notices, state }
}

/** A promise with its resolver, for answers a spec releases by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('GameToolsController reads', () => {
  it('reads nothing until the tab first renders, then on each mount, and again on each Host change', async () => {
    const b = bench()
    b.controller.changed()
    expect(b.list).not.toHaveBeenCalled()
    expect(b.state()).toEqual({ snapshot: null, failure: null, busy: [], notice: null })
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    expect(b.list).toHaveBeenCalledOnce()
    expect(b.listPlugins).toHaveBeenCalledOnce()
    expect(b.state().snapshot).toEqual({
      managed: true,
      tools: [
        { moduleName: BLENDER.moduleName, entry: BLENDER, control: { kind: 'switch' } },
        { moduleName: GIMP.moduleName, entry: GIMP, control: { kind: 'switch' } },
        { moduleName: GODOT.moduleName, entry: GODOT, control: { kind: 'switch' } },
      ],
    })
    b.controller.changed()
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledTimes(2) })
    expect(b.face.resolveText({ en: 'English' })).toBe('English')
  })

  it('reads again when the tab mounts again, so a profile edit that announced nothing shows, keeping the last tools meanwhile', async () => {
    const b = bench()
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    const shown = b.state().snapshot
    // A hand edit of the profile patch applies through HMR without a plugin-manager/changed event.
    b.listPlugins.mockResolvedValue(plugins([BLENDER, GIMP, { ...GODOT, enabled: false }]))
    b.face.load()
    expect(b.state().snapshot).toBe(shown)
    await vi.waitFor(() => { expect(b.state().snapshot?.tools[2]?.entry?.enabled).toBe(false) })
    expect(b.list).toHaveBeenCalledTimes(2)
  })

  it('lists the inventory read-only while the Host manages no profile', async () => {
    const b = bench()
    b.list.mockResolvedValue(inventory([GODOT], false))
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    expect(b.listPlugins).not.toHaveBeenCalled()
    expect(b.state().snapshot).toEqual({
      managed: false,
      tools: [
        { moduleName: BLENDER.moduleName, entry: undefined },
        { moduleName: GIMP.moduleName, entry: undefined },
        { moduleName: GODOT.moduleName, entry: GODOT },
      ],
    })
  })

  it('locks a tool the Host cannot switch and leaves a tool the profile does not mount without a control', async () => {
    const b = bench()
    const locked: PluginInfo = {
      entryId: entryId('godot-copy'), moduleName: GODOT.moduleName, enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable',
    }
    b.listPlugins.mockResolvedValue(plugins([BLENDER, locked]))
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    expect(b.state().snapshot?.tools).toEqual([
      { moduleName: BLENDER.moduleName, entry: BLENDER, control: { kind: 'switch' } },
      { moduleName: GIMP.moduleName, entry: undefined },
      { moduleName: GODOT.moduleName, entry: locked, control: { kind: 'locked', reason: 'unaddressable' } },
    ])
  })

  it.each([
    ['the inventory fails', (b: ReturnType<typeof bench>) => { b.list.mockResolvedValue(failed()) }, 'failed'],
    ['the inventory refuses a Peer without access', (b: ReturnType<typeof bench>) => { b.list.mockResolvedValue(failed(true)) }, 'denied'],
    ['the plugin manager fails', (b: ReturnType<typeof bench>) => { b.listPlugins.mockResolvedValue(failed()) }, 'failed'],
    ['a Remote call rejects', (b: ReturnType<typeof bench>) => { b.list.mockRejectedValue(new Error('not mounted')) }, 'failed'],
  ] as const)('reports a failed read when %s, and a retry reads again', async (_case, arrange, failure) => {
    const b = bench()
    arrange(b)
    b.face.load()
    await vi.waitFor(() => { expect(b.state().failure).toBe(failure) })
    expect(b.state().snapshot).toBeNull()
    b.list.mockResolvedValue(inventory())
    b.listPlugins.mockResolvedValue(plugins())
    b.face.load()
    expect(b.state().failure).toBeNull()
    await vi.waitFor(() => { expect(b.state().snapshot?.managed).toBe(true) })
    expect(b.state().failure).toBeNull()
  })

  it('keeps the last tools when a refresh fails', async () => {
    const b = bench()
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    const snapshot = b.state().snapshot
    b.list.mockResolvedValueOnce(failed())
    b.controller.changed()
    await vi.waitFor(() => { expect(b.state().failure).toBe('failed') })
    expect(b.state().snapshot).toBe(snapshot)
  })

  it('drops the answer of a read that a newer read superseded', async () => {
    const b = bench()
    const slow = deferred<RemoteResult<PluginInventorySnapshot>>()
    b.list.mockReturnValueOnce(slow.promise)
    b.face.load()
    b.list.mockResolvedValueOnce(inventory([GODOT], false))
    b.controller.changed()
    await vi.waitFor(() => { expect(b.state().snapshot?.managed).toBe(false) })
    slow.resolve(inventory())
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledOnce() })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.state().snapshot?.managed).toBe(false)
  })

  it('publishes nothing after disposal', async () => {
    const b = bench()
    const slow = deferred<RemoteResult<PluginInventorySnapshot>>()
    b.list.mockReturnValueOnce(slow.promise)
    b.face.load()
    b.controller.dispose()
    slow.resolve(inventory())
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledOnce() })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.state().snapshot).toBeNull()
  })
})

describe('GameToolsController switch writes', () => {
  async function ready() {
    const b = bench()
    b.face.load()
    await vi.waitFor(() => { expect(b.state().snapshot).not.toBeNull() })
    return b
  }

  it('writes the entry, holds it busy until the answer, and reads again', async () => {
    const b = await ready()
    const answer = deferred<RemoteResult<ChangeResult>>()
    b.setPluginEnabled.mockReturnValueOnce(answer.promise)
    b.face.setEnabled(BLENDER.entryId, false)
    expect(b.setPluginEnabled).toHaveBeenCalledWith(BLENDER.entryId, false)
    expect(b.state().busy).toEqual([BLENDER.entryId])
    // A second flip of the same tool waits for the first write.
    b.face.setEnabled(BLENDER.entryId, true)
    expect(b.setPluginEnabled).toHaveBeenCalledOnce()
    answer.resolve(change())
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledTimes(2) })
    expect(b.state().busy).toEqual([])
    expect(b.state().notice).toBeNull()
  })

  it('ignores a write for an entry the last read did not list', async () => {
    const b = await ready()
    b.face.setEnabled(OTHER.entryId, false)
    expect(b.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('ignores a write before the first read answers', () => {
    const b = bench()
    b.face.setEnabled(BLENDER.entryId, false)
    expect(b.setPluginEnabled).not.toHaveBeenCalled()
  })

  it.each([
    ['an applied change', change(), null],
    ['a cancelled change', change({ application: 'cancelled' }), null],
    ['a restart', change({ application: 'restart-required', restartReason: 'no-hmr' }), { kind: 'restart', reason: 'no-hmr' }],
    ['a restart without a reason', change({ application: 'restart-required' }), { kind: 'restart', reason: undefined }],
    ['a higher layer', change({ application: 'overridden' }), { kind: 'overridden' }],
    ['a refusal', change({ application: 'failed', error: { code: 'unknown-plugin', diagnostic: 'gone' } }),
      { kind: 'failed', code: 'unknown-plugin', message: 'gone' }],
    ['a refusal without a diagnostic', change({ application: 'failed', error: { code: 'operation-error' } }),
      { kind: 'failed', code: 'operation-error', message: '' }],
    ['a failure without an error', change({ application: 'failed' }), { kind: 'failed', code: undefined, message: '' }],
    ['a failed Remote call', failed<ChangeResult>(), { kind: 'failed', code: undefined, message: 'the Host is gone' }],
  ] as const)('publishes what %s leaves to say', async (_case, answer, outcome) => {
    const b = await ready()
    b.setPluginEnabled.mockResolvedValueOnce(answer)
    b.face.setEnabled(GIMP.entryId, true)
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledTimes(2) })
    const notice = b.state().notice
    if (outcome === null) {
      expect(notice).toBeNull()
      return
    }
    expect(notice).toEqual({ ...outcome, tool: b.state().snapshot?.tools[1], enabled: true, seq: 1 })
    b.notices.dismissNotice()
    expect(b.state().notice).toBeNull()
  })

  it.each([
    ['an error', new Error('not mounted'), 'not mounted'],
    ['another value', 'the connection closed', 'the connection closed'],
  ])('reports a write whose Remote call rejects with %s as failed, with its message', async (_case, fault, message) => {
    const b = await ready()
    b.setPluginEnabled.mockRejectedValueOnce(fault)
    b.face.setEnabled(GODOT.entryId, false)
    await vi.waitFor(() => { expect(b.state().notice?.kind).toBe('failed') })
    expect(b.state().notice).toMatchObject({ code: undefined, message, enabled: false, seq: 1 })
    expect(b.state().busy).toEqual([])
  })

  it('keeps the notice of a failed write when another tool\'s write applies after it', async () => {
    const b = await ready()
    const gimp = deferred<RemoteResult<ChangeResult>>()
    const godot = deferred<RemoteResult<ChangeResult>>()
    b.setPluginEnabled.mockReturnValueOnce(gimp.promise).mockReturnValueOnce(godot.promise)
    b.face.setEnabled(GIMP.entryId, true)
    b.face.setEnabled(GODOT.entryId, false)
    expect(b.state().busy).toEqual([GIMP.entryId, GODOT.entryId])
    gimp.resolve(change({ application: 'failed', error: { code: 'operation-error', diagnostic: 'disk full' } }))
    await vi.waitFor(() => { expect(b.state().notice?.kind).toBe('failed') })
    godot.resolve(change())
    await vi.waitFor(() => { expect(b.state().busy).toEqual([]) })
    expect(b.state().notice).toMatchObject({
      kind: 'failed', message: 'disk full', enabled: true, tool: { moduleName: GIMP.moduleName }, seq: 1,
    })
  })

  it('numbers each notice and clears the last one when the next write starts', async () => {
    const b = await ready()
    b.setPluginEnabled.mockResolvedValue(change({ application: 'overridden' }))
    b.face.setEnabled(GIMP.entryId, true)
    await vi.waitFor(() => { expect(b.state().notice?.seq).toBe(1) })
    const second = deferred<RemoteResult<ChangeResult>>()
    b.setPluginEnabled.mockReturnValueOnce(second.promise)
    b.face.setEnabled(GIMP.entryId, true)
    expect(b.state().notice).toBeNull()
    second.resolve(change({ application: 'overridden' }))
    await vi.waitFor(() => { expect(b.state().notice?.seq).toBe(2) })
  })
})
