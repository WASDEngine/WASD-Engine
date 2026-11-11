// @vitest-environment jsdom
/**
 * The browser plugin's registrations: the Settings tab first in Built-in plugins, the Plugins page tab and the overlay
 * entry of its notice toast once the plugin manager's Remote exists, labels in the active locale, no Remote call
 * before a tab renders, refreshes on Host changes, and every registration withdrawn with the plugin fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult, PluginEntryId, PluginInfo, PluginInventorySnapshot, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { GameToolsNoticeToast, type GameToolsNoticeToastInjected } from '../src/client/GameToolsNoticeToast.tsx'
import { apply, inject } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { PluginsGameToolsTab, type PluginsGameToolsTabInjected } from '../src/client/PluginsGameToolsTab.tsx'
import { SettingsGameToolsTab, type SettingsGameToolsTabInjected } from '../src/client/SettingsGameToolsTab.tsx'
import { apply as hostApply } from '../src/index.ts'
import { BLENDER, change, ELEVENLABS, failed, GIMP, GODOT, inventory, plugins, SUPERCOLLIDER } from './fixtures.client.ts'

usePinnedBrowserLanguages('en-US')

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const list = vi.fn<() => Promise<RemoteResult<PluginInventorySnapshot>>>(() => Promise.resolve(inventory()))
  const listPlugins = vi.fn<() => Promise<RemoteResult<PluginInfo[]>>>(() => Promise.resolve(plugins()))
  const setPluginEnabled = vi.fn<(id: PluginEntryId, enabled: boolean) => Promise<RemoteResult<ChangeResult>>>(
    () => Promise.resolve(change()),
  )
  const remote = new TestRemote(ctx, { pluginInventory: { list } })
  const provideManager = (): void => { remote.provideNamespaces({ pluginManager: { listPlugins, setPluginEnabled } }) }
  const declare = (): (() => void) => ctx.slots.register({
    name: 'root',
    children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'plugins.tab': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const settingsTab = () => ctx.slots.entries('settings.plugins.tab')
  const pluginsTab = () => ctx.slots.entries('plugins.tab')
  const overlay = () => ctx.slots.entries('shell.overlay')
  return { ctx, locale, remote, list, listPlugins, setPluginEnabled, provideManager, declare, settingsTab, pluginsTab, overlay }
}

/** A registration's inject factory, as the slot ledger stores it. */
type Registered = { readonly inject?: ((...args: never[]) => object) | undefined } | undefined

function settingsFace(entry: Registered): SettingsGameToolsTabInjected {
  const injected: object | undefined = entry?.inject?.()
  if (injected === undefined || !('read' in injected)) throw new Error('the Settings tab registered no read face')
  return injected as SettingsGameToolsTabInjected
}

function pluginsFace(entry: Registered): PluginsGameToolsTabInjected {
  const injected: object | undefined = entry?.inject?.()
  if (injected === undefined || !('load' in injected)) throw new Error('the Plugins page tab registered no face')
  return injected as PluginsGameToolsTabInjected
}

function noticeFace(entry: Registered): GameToolsNoticeToastInjected {
  const injected: object | undefined = entry?.inject?.()
  if (injected === undefined || !('dismissNotice' in injected)) throw new Error('the notice toast registered no face')
  return injected as GameToolsNoticeToastInjected
}

describe('ui-game-tools browser plugin', () => {
  it('keeps the Host Loader entry inert and declares the services of the Settings tab', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory'])
  })

  it('registers the Settings tab first, and the Plugins page tab and its toast only once the plugin manager Remote exists', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const [settings] = b.settingsTab()
    expect(settings?.component).toBe(SettingsGameToolsTab)
    expect(settings?.options).toMatchObject({ id: 'game-tools', order: 5 })
    expect(settings?.locale).toBe(NS)
    expect(b.pluginsTab()).toEqual([])
    expect(b.overlay()).toEqual([])
    b.provideManager()
    await vi.waitFor(() => { expect(b.pluginsTab()).toHaveLength(1) })
    const [tab] = b.pluginsTab()
    expect(tab?.component).toBe(PluginsGameToolsTab)
    expect(tab?.options).toMatchObject({ id: 'game-tools', order: -10 })
    expect(tab?.locale).toBe(NS)
    const [toast] = b.overlay()
    expect(toast?.component).toBe(GameToolsNoticeToast)
    expect(toast?.options).toMatchObject({ id: 'game-tools.toast' })
    expect(toast?.locale).toBe(NS)
    // The toast reads the notices of the tab's own writes.
    expect(noticeFace(toast).hooks.gameTools).toBe(pluginsFace(tab).hooks.gameTools)
    expect(noticeFace(toast).resolveText('Godot')).toBe('Godot')
  })

  it('labels both tabs in the active locale', async () => {
    const b = await bench()
    b.provideManager()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.pluginsTab()).toHaveLength(1) })
    const labels = () => [resolveSlotLabel(b.settingsTab()[0]?.options.label), resolveSlotLabel(b.pluginsTab()[0]?.options.label)]
    expect(labels()).toEqual(['Game tools', 'Game tools'])
    b.locale.setLocale('zh')
    expect(labels()).toEqual(['游戏工具', '游戏工具'])
    b.locale.setLocale('en')
    expect(labels()).toEqual(['Game tools', 'Game tools'])
  })

  it('calls no Remote before a tab renders, Host changes and reconnections included', async () => {
    const b = await bench()
    b.provideManager()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.pluginsTab()).toHaveLength(1) })
    b.remote.emit('plugin-manager/changed', [{ reason: 'plugin' }])
    b.ctx.emit('connection/reset')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.list).not.toHaveBeenCalled()
    expect(b.listPlugins).not.toHaveBeenCalled()
    expect(b.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('reads the Settings tools from the inventory, in order, or says why it could not', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = settingsFace(b.settingsTab()[0])
    expect(await face.read()).toEqual({
      ok: true,
      tools: [
        { moduleName: BLENDER.moduleName, entry: BLENDER },
        { moduleName: ELEVENLABS.moduleName, entry: ELEVENLABS },
        { moduleName: GIMP.moduleName, entry: GIMP },
        { moduleName: GODOT.moduleName, entry: GODOT },
        { moduleName: SUPERCOLLIDER.moduleName, entry: SUPERCOLLIDER },
      ],
    })
    b.list.mockResolvedValueOnce(failed(true))
    expect(await face.read()).toEqual({ ok: false, failure: 'denied' })
    b.list.mockResolvedValueOnce(failed())
    expect(await face.read()).toEqual({ ok: false, failure: 'failed' })
    expect(face.resolveText({ en: 'English', zh: '中文' })).toBe('English')
    b.locale.setLocale('zh')
    expect(face.resolveText({ en: 'English', zh: '中文' })).toBe('中文')
  })

  it('reads the Plugins page tools again on a Host change or a reconnection once the tab rendered', async () => {
    const b = await bench()
    b.provideManager()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.pluginsTab()).toHaveLength(1) })
    const face = pluginsFace(b.pluginsTab()[0])
    face.load()
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledOnce() })
    b.remote.emit('plugin-manager/changed', [{ reason: 'plugin' }])
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledTimes(2) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledTimes(3) })
    expect(face.resolveText('Godot')).toBe('Godot')
  })

  it('follows a late declaration and withdraws both tabs, the toast, and the Host listeners with its fiber', async () => {
    const b = await bench()
    b.provideManager()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.settingsTab()).toEqual([])
    expect(b.pluginsTab()).toEqual([])
    const undeclare = b.declare()
    await vi.waitFor(() => {
      expect(b.settingsTab()).toHaveLength(1)
      expect(b.pluginsTab()).toHaveLength(1)
      expect(b.overlay()).toHaveLength(1)
    })
    const face = pluginsFace(b.pluginsTab()[0])
    face.load()
    await vi.waitFor(() => { expect(b.listPlugins).toHaveBeenCalledOnce() })
    undeclare()
    expect(b.settingsTab()).toEqual([])
    expect(b.pluginsTab()).toEqual([])
    expect(b.overlay()).toEqual([])
    b.declare()
    await vi.waitFor(() => {
      expect(b.pluginsTab()).toHaveLength(1)
      expect(b.overlay()).toHaveLength(1)
    })
    await fiber.dispose()
    expect(b.settingsTab()).toEqual([])
    expect(b.pluginsTab()).toEqual([])
    expect(b.overlay()).toEqual([])
    b.remote.emit('plugin-manager/changed', [{ reason: 'plugin' }])
    b.ctx.emit('connection/reset')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.listPlugins).toHaveBeenCalledOnce()
    expect(() => b.locale.register(NS, 'en', {})).not.toThrow()
  })
})
