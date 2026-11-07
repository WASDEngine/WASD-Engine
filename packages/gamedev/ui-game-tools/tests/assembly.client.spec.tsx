// @vitest-environment jsdom
/**
 * The Game tools tabs in the assembled Web client: the web profile's bundle roster, the fork's overlay row included,
 * boots without a new boot-time Remote call, Settings → Built-in plugins opens on Game tools with the tools' logos,
 * and a switch on the Plugins page writes through the plugin manager, with a toast that outlives the tab.
 */
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'
import { BLENDER, BLENDER_ICON, GIMP, GIMP_ICON, GODOT, OTHER, SUPERCOLLIDER } from './fixtures.client.ts'

usePinnedBrowserLanguages('en-US')

const PACKAGE = '@deepseek-ai/dsh-client-ui-game-tools'

const it = createClientTest({ roster: webApp.without(['@deepseek-ai/dsh-client-ui-settings-models']) }, { mount: true })

const SNAPSHOT: PluginInventorySnapshot = { managementAvailable: true, entries: [OTHER, BLENDER, GIMP, GODOT, SUPERCOLLIDER] }

it('opens Built-in plugins on the Game tools tab with each tool and its logo', async ({ mock, remote, start }) => {
  expect(webApp.rows.map(row => row.name)).toContain(PACKAGE)
  // jsdom omits the browser method used when the settings row receives focus.
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
  remote.pluginInventory.list.mockResolvedValue(ok(SNAPSHOT))
  const client = await start()
  expect(client.ctx.slots.entries('settings.plugins.tab').map(entry => entry.options.id)).toEqual(['game-tools', 'all'])
  await vi.waitFor(() => {
    expect(client.ctx.slots.entries('plugins.tab').map(entry => entry.options.id)).toContain('game-tools')
  })
  expect(mock.log.calls('pluginInventory/list')).toHaveLength(0)
  expect(mock.log.calls('pluginManager/listPlugins')).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Built-in plugins' }))
  const tabs = screen.getByRole('tablist')
  expect(within(tabs).getAllByRole('tab').map(tab => [tab.textContent, tab.getAttribute('aria-selected')]))
    .toEqual([['Game tools', 'true'], ['Plugin list', 'false']])
  const list = await screen.findByRole('list', { name: 'Game tools' })
  const cards = within(list).getAllByRole('listitem')
  expect(cards.map(card => card.getAttribute('data-game-tool'))).toEqual([BLENDER.moduleName, GIMP.moduleName, GODOT.moduleName, SUPERCOLLIDER.moduleName])
  expect(cards.map(card => card.querySelector('img')?.getAttribute('src'))).toEqual([BLENDER_ICON, GIMP_ICON, undefined, undefined])
  expect(within(cards[1]!).getByText('Off')).toBeTruthy()
  expect(within(list).queryByRole('switch')).toBeNull()
  expect(mock.log.calls('pluginInventory/list')).toHaveLength(1)
}, 60_000)

it('switches a tool from the Plugins page Game tools tab, and its toast stays when the tab closes', async ({ mock, remote, start }) => {
  remote.pluginInventory.list.mockResolvedValue(ok(SNAPSHOT))
  remote.pluginManager.listBundles.mockResolvedValue(ok([]))
  remote.pluginManager.listPlugins.mockResolvedValue(ok([OTHER, BLENDER, GIMP, GODOT, SUPERCOLLIDER]))
  remote.pluginManager.setPluginEnabled.mockResolvedValue(ok({
    changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'enable', target: GIMP.entryId, enabled: true,
  }))
  await start()
  fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'Game tools' }))
  const gimp = await screen.findByRole('switch', { name: 'Enable GIMP' })
  expect(gimp.getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('switch', { name: 'Enable Blender' }).getAttribute('aria-checked')).toBe('true')
  const before = mock.log.calls('pluginManager/listPlugins').length
  fireEvent.click(gimp)
  await vi.waitFor(() => { expect(remote.pluginManager.setPluginEnabled).toHaveBeenCalledWith(GIMP.entryId, true) })
  await vi.waitFor(() => { expect(mock.log.calls('pluginManager/listPlugins').length).toBeGreaterThan(before) })
  const restart = 'Restart WASD Engine to apply the change to GIMP. This profile applies changes only at startup.'
  expect(await screen.findByText(restart)).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Installed' }))
  expect(screen.queryByRole('switch', { name: 'Enable GIMP' })).toBeNull()
  expect(screen.getByText(restart)).toBeTruthy()
}, 60_000)
