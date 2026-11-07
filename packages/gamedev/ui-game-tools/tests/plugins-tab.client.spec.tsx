// @vitest-environment jsdom
/**
 * Plugins page → Game tools: the read it asks for on each mount, its loading, failed, and unmanaged states, a switch
 * per tool the Host can switch, locked and busy switches, focus returning to a switch after its write, and the
 * notice toast, which outlives the tab because the overlay entry draws it.
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult, PluginEntryId, PluginInfo, PluginInventorySnapshot, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { GameToolsController, type GameToolsSnapshot, type GameToolsState } from '../src/client/controller.ts'
import { GameToolsNoticeToast, type GameToolsNoticeToastProps } from '../src/client/GameToolsNoticeToast.tsx'
import { en } from '../src/client/locales.ts'
import {
  PluginsGameToolsTab, type PluginsGameToolsTabInjected, type PluginsGameToolsTabProps,
} from '../src/client/PluginsGameToolsTab.tsx'
import { BLENDER, change, entryId, GIMP, GODOT, inventory, plugins } from './fixtures.client.ts'

afterEach(cleanup)

const LOCKED: PluginInfo = {
  entryId: entryId('godot'), moduleName: GODOT.moduleName, enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable',
  meta: { title: 'Godot' },
}

const MANAGED: GameToolsSnapshot = {
  managed: true,
  tools: [
    { moduleName: BLENDER.moduleName, entry: BLENDER, control: { kind: 'switch' } },
    { moduleName: GIMP.moduleName, entry: GIMP, control: { kind: 'switch' } },
    { moduleName: GODOT.moduleName, entry: LOCKED, control: { kind: 'locked', reason: 'unaddressable' } },
  ],
}

const resolveText: PluginsGameToolsTabInjected['resolveText'] = text => typeof text === 'string' ? text : text.en

function tab(initial: Partial<GameToolsState> = {}) {
  const store = createSnapshotStore<GameToolsState>({ snapshot: null, failure: null, busy: [], notice: null, ...initial })
  const actions = { load: vi.fn(), setEnabled: vi.fn() }
  const props = { t: makeTranslate(en), useGameTools: bindSnapshotSelector(store), resolveText, ...actions } as PluginsGameToolsTabProps
  const view = render(<PluginsGameToolsTab {...props} />)
  return { store, view, props, ...actions }
}

describe('PluginsGameToolsTab states', () => {
  it('asks for a read on each mount and holds placeholder cards until the first answers', () => {
    const t = tab()
    expect(t.load).toHaveBeenCalledOnce()
    expect(screen.getByText(en.pluginsIntro)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(t.view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    t.view.unmount()
    render(<PluginsGameToolsTab {...t.props} />)
    expect(t.load).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['failed', en.error],
    ['denied', en.denied],
  ] as const)('offers a retry in place of the cards after a %s first read', (failure, text) => {
    const t = tab({ failure })
    expect(screen.getByRole('alert').textContent).toBe(text)
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(t.load).toHaveBeenCalledTimes(2)
  })

  it('keeps the cards under a failed refresh and offers a retry below them', () => {
    const t = tab({ snapshot: MANAGED, failure: 'failed' })
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('alert').textContent).toBe(en.refreshError)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(t.load).toHaveBeenCalledTimes(2)
  })

  it('lists the tools read-only, saying why, while the Host manages no profile', () => {
    tab({ snapshot: { managed: false, tools: MANAGED.tools.map(({ moduleName, entry }) => ({ moduleName, entry })) } })
    expect(screen.getByText(en.unmanaged)).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('draws no toast of its own for a notice', () => {
    tab({ snapshot: MANAGED, notice: { kind: 'overridden', tool: MANAGED.tools[1]!, enabled: true, seq: 1 } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('PluginsGameToolsTab switches', () => {
  it('switches each tool the Host can switch to the state it asks for', () => {
    const t = tab({ snapshot: MANAGED })
    const blender = screen.getByRole('switch', { name: 'Enable Blender' })
    const gimp = screen.getByRole('switch', { name: 'Enable GIMP' })
    expect(blender.getAttribute('aria-checked')).toBe('true')
    expect(gimp.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(blender)
    fireEvent.click(gimp)
    expect(t.setEnabled.mock.calls).toEqual([[BLENDER.entryId, false], [GIMP.entryId, true]])
  })

  it('locks a switch the Host refuses, with its reason as hover text', () => {
    tab({ snapshot: MANAGED })
    const godot = screen.getByRole('switch', { name: 'Enable Godot' })
    expect(godot.hasAttribute('disabled')).toBe(true)
    expect(godot.getAttribute('title')).toBe(en.lockedUnaddressable)
  })

  it('offers no switch for a tool the profile does not mount', () => {
    tab({ snapshot: { managed: true, tools: [MANAGED.tools[0]!, { moduleName: GIMP.moduleName, entry: undefined }] } })
    const absent = screen.getAllByRole('listitem')[1]!
    expect(within(absent).getByText(en.absentTag)).toBeTruthy()
    expect(within(absent).queryByRole('switch')).toBeNull()
  })

  it('holds a switch while its write runs and names the change in the live region', () => {
    const t = tab({ snapshot: MANAGED, busy: [BLENDER.entryId] })
    const blender = screen.getByRole('switch', { name: 'Enable Blender' })
    expect(blender.hasAttribute('disabled')).toBe(true)
    const card = screen.getAllByRole('listitem')[0]!
    expect(within(card).getByRole('status').textContent).toBe('Applying the change to Blender')
    expect(screen.getByRole('switch', { name: 'Enable GIMP' }).hasAttribute('disabled')).toBe(false)
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [] }) })
    expect(within(card).getByRole('status').textContent).toBe('')
  })

  it('gives the focus back to a switch flipped from the keyboard once its write ends', () => {
    const t = tab({ snapshot: MANAGED })
    const blender = screen.getByRole('switch', { name: 'Enable Blender' })
    blender.focus()
    fireEvent.click(blender)
    // A browser moves the focus of a control that becomes disabled to the page; jsdom keeps it, so the spec moves it.
    blender.blur()
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [BLENDER.entryId] }) })
    expect(document.activeElement).toBe(document.body)
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [] }) })
    expect(document.activeElement).toBe(blender)
  })

  it('leaves the focus where it moved during the write, and takes none for a switch flipped without it', () => {
    const t = tab({ snapshot: MANAGED })
    const blender = screen.getByRole('switch', { name: 'Enable Blender' })
    const gimp = screen.getByRole('switch', { name: 'Enable GIMP' })
    blender.focus()
    fireEvent.click(blender)
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [BLENDER.entryId] }) })
    gimp.focus()
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [] }) })
    expect(document.activeElement).toBe(gimp)
    gimp.blur()
    fireEvent.click(blender)
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [BLENDER.entryId] }) })
    act(() => { t.store.set({ ...t.store.getSnapshot(), busy: [] }) })
    expect(document.activeElement).toBe(document.body)
  })
})

describe('PluginsGameToolsTab over its controller', () => {
  it('reads on mount, writes the flipped switch, and keeps the toast of the answer after the tab closes', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const list = vi.fn<() => Promise<RemoteResult<PluginInventorySnapshot>>>(() => Promise.resolve(inventory()))
    const listPlugins = vi.fn<() => Promise<RemoteResult<PluginInfo[]>>>(() => Promise.resolve(plugins()))
    const setPluginEnabled = vi.fn<(id: PluginEntryId, enabled: boolean) => Promise<RemoteResult<ChangeResult>>>(
      () => Promise.resolve(change({ application: 'restart-required', restartReason: 'host-module' })),
    )
    new TestRemote(ctx, { pluginInventory: { list }, pluginManager: { listPlugins, setPluginEnabled } })
    const controller = new GameToolsController(ctx)
    const t = makeTranslate(en)
    const { hooks, ...actions } = controller.face(resolveText)
    const tabProps = { t, useGameTools: bindSnapshotSelector(hooks.gameTools), ...actions } as PluginsGameToolsTabProps
    const notices = controller.noticeFace(resolveText)
    const toastProps = {
      t, useGameTools: bindSnapshotSelector(notices.hooks.gameTools), resolveText, dismissNotice: notices.dismissNotice,
    } as GameToolsNoticeToastProps
    render(<GameToolsNoticeToast {...toastProps} />)
    const view = render(<PluginsGameToolsTab {...tabProps} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable GIMP' }))
    expect(setPluginEnabled).toHaveBeenCalledWith(GIMP.entryId, true)
    const text = 'Restart WASD Engine to apply the change to GIMP. The change reaches modules WASD Engine itself loaded.'
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    await vi.waitFor(() => { expect(listPlugins).toHaveBeenCalledTimes(2) })
    view.unmount()
    expect(screen.getByRole('alert').textContent).toBe(text)
  })
})
