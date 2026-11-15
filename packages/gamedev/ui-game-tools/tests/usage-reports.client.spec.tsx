// @vitest-environment jsdom
/**
 * The usage reports switch of Agent feedback in Settings › General: it shows the setting the Host accepted, writes
 * `usageReports` of the `agent-feedback` entry, keeps the accepted value after a refused write, and exists only while
 * the Host serves that entry.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { UsageReportsPreference, type UsageReportsSettings } from '../src/client/usage-reports.ts'
import { UsageReportsRow, UsageReportsToast, type UsageReportsInjected } from '../src/client/UsageReportsRow.tsx'

afterEach(cleanup)

function fixture(writable = true) {
  const formState = createSnapshotStore<ConfigFormSnapshot<UsageReportsSettings>>({
    status: 'ready', value: { usageReports: true }, base: {}, user: {}, revision: 0, writable,
  })
  const set = vi.fn(async (_field: string, enabled: unknown) => {
    formState.update((state) => { state.value = { usageReports: enabled === true } })
    return true
  })
  const form: ConfigForm<UsageReportsSettings> = {
    getSnapshot: () => formState.getSnapshot(), subscribe: listener => formState.subscribe(listener),
    set, unset: vi.fn(), mutate: vi.fn(),
  }
  const preference = new UsageReportsPreference(form)
  const props = {
    useUsageReports: bindSnapshotSelector(formState), useMutation: bindSnapshotSelector(preference.state),
    setEnabled: (enabled: boolean) => preference.setEnabled(enabled), dismiss: () => { preference.dismiss() },
    t: (key: keyof typeof en) => en[key],
  } as ComponentProps<typeof UsageReportsRow>
  return { set, preference, props }
}

it('turns usage reports off through Agent feedback\'s setting and keeps its notice after the row unmounts', async () => {
  const { props, set } = fixture()
  const row = render(<UsageReportsRow {...props} />)
  render(<UsageReportsToast {...props} />)
  expect(screen.getByText(en.usageReportsDescription)).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: en.usageReportsTitle }))
  await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })
  expect(set).toHaveBeenCalledWith('usageReports', false)
  row.unmount()
  expect(screen.getByText(en.usageReportsSaved)).toBeTruthy()
})

it.each(['refused', 'rejected'] as const)('keeps the accepted setting after a %s write and says so', async (failure) => {
  const { props, set } = fixture()
  if (failure === 'refused') set.mockResolvedValue(false)
  else set.mockRejectedValue(new Error('Disconnected'))
  render(<><UsageReportsRow {...props} /><UsageReportsToast {...props} /></>)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText(en.usageReportsFailed)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it('shows the Chinese copy and cannot change a read-only setting', () => {
  const { props, set } = fixture(false)
  const translated: Record<string, string> = zh
  render(<UsageReportsRow {...props} t={key => translated[key] ?? key} />)
  expect(screen.getByRole('switch', { name: zh.usageReportsTitle }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('switch'))
  expect(set).not.toHaveBeenCalled()
})

it('adds the switch to Settings › General only while the Host serves Agent feedback, and removes it with the plugin', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const served = { writable: true, hasDocument: true, namespaces: [{
      ns: 'agent-feedback', schema: {}, value: { usageReports: true }, applies: 'live' as const, secrets: [] as never[], revision: 1,
    }] }
    const describe = vi.fn(async () => ({
      ok: true as const,
      value: { writable: true, hasDocument: true, namespaces: [] as typeof served.namespaces },
    }))
    const list = vi.fn(async () => ({ ok: true as const, value: { entries: [] } }))
    const remote = new TestRemote(ctx, { settings: { describe }, pluginInventory: { list } })
    await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    await ctx.configForms.describe().ensure()
    expect(slots.entries('settings.general.item')).toHaveLength(0)
    describe.mockResolvedValue({ ok: true, value: served })
    remote.emit('settings/document-updated', ['agent-feedback', 1])
    await vi.waitFor(() => { expect(slots.entries('settings.general.item')).toHaveLength(1) })
    expect(slots.entries('settings.general.item')[0]!.options).toMatchObject({ id: 'agent-feedback.usage-reports', order: 91 })
    const face = slots.entries('settings.general.item')[0]!.inject!() as UsageReportsInjected & Record<string, unknown>
    const set = vi.spyOn(ctx.configForms.get('agent-feedback'), 'set').mockResolvedValue(true)
    await face.setEnabled(false)
    expect(set).toHaveBeenCalledWith('usageReports', false)
    expect(face.hooks.mutation.getSnapshot().notice).toBe('saved')
    describe.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    remote.emit('settings/document-updated', ['agent-feedback', 2])
    await vi.waitFor(() => { expect(slots.entries('settings.general.item')).toHaveLength(0) })
    expect(slots.entries('shell.overlay').map(entry => entry.options.id)).toContain('agent-feedback.usage-reports.toast')
    await fiber.dispose()
    expect(slots.entries('shell.overlay').map(entry => entry.options.id)).not.toContain('agent-feedback.usage-reports.toast')
  } finally {
    await ctx.fiber.dispose()
  }
})
