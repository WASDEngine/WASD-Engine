/**
 * Game tools, browser half: the Game tools tab of Settings → Built-in plugins and the Game tools tab of the Plugins
 * page. Both list ambientCG, Blender, ElevenLabs, GIMP, Godot, Nano Banana, Poly Haven, and SuperCollider with their package
 * logos and Loader state; the Plugins page tab also switches each tool in the profile patch through the `pluginManager`
 * Remote, and a `shell.overlay` entry shows what a switch write left to say. Neither tab reads the Host before it renders.
 * Settings → General also gets the usage reports switch of Agent feedback while the Host serves that entry.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge with its forwarded-event keys, and the plugin manager's event declarations `$on` reads.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
// Type-only: the `settings.plugins.tab`, `plugins.tab`, and `shell.overlay` SlotMap merges; their owners declare the
// slots at runtime.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { GameToolsController } from './controller.ts'
import { GameToolsNoticeToast, type GameToolsNoticeToastInjected } from './GameToolsNoticeToast.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { PluginsGameToolsTab, type PluginsGameToolsTabInjected } from './PluginsGameToolsTab.tsx'
import { SettingsGameToolsTab, type GameToolsRead, type SettingsGameToolsTabInjected } from './SettingsGameToolsTab.tsx'
import { gameToolSlots, readFailure } from './tools.ts'
import { AGENT_FEEDBACK_ENTRY, UsageReportsPreference, type UsageReportsSettings } from './usage-reports.ts'
import { UsageReportsRow, UsageReportsToast, type UsageReportsInjected } from './UsageReportsRow.tsx'

export type { GameToolNotice, GameToolOutcome, GameToolsSnapshot, GameToolsState, ManagedGameTool, ToolControl } from './controller.ts'
export type { GameToolsNoticeToastInjected, GameToolsNoticeToastProps } from './GameToolsNoticeToast.tsx'
export type { GameToolsLocaleKey } from './locales.ts'
export type { PluginsGameToolsTabInjected, PluginsGameToolsTabProps } from './PluginsGameToolsTab.tsx'
export type { GameToolsRead, SettingsGameToolsTabInjected, SettingsGameToolsTabProps } from './SettingsGameToolsTab.tsx'
export type { GameToolEntry, GameToolSlot, ReadFailure } from './tools.ts'
export type { UsageReportsMutation, UsageReportsSettings } from './usage-reports.ts'
export type { UsageReportsInjected, UsageReportsRowProps, UsageReportsToastProps } from './UsageReportsRow.tsx'

/** Registration id of both tabs. */
const TAB_ID = 'game-tools'

/** Registration id of the usage reports switch in Settings → General, after the Session log upload row. */
const USAGE_REPORTS_ID = 'agent-feedback.usage-reports'

/** Services the Settings tab reads; the Plugins page tab and its toast wait for `remote.pluginManager` on their own. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/**
 * Contribute the Game tools tabs. The Settings tab comes first, so it is the default view of Built-in plugins; the
 * Plugins page tab follows Installed. The Plugins page tab and the toast of its switch writes register in their own
 * scope once `remote.pluginManager` exists, so the Settings tab never waits for the plugin manager.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-tools: dictionaries')
  const t = ctx.locale.bind(NS)
  const resolveText = (text: LocalizedText): string => ctx.locale.resolveText(text)

  const settings: SettingsGameToolsTabInjected = {
    read: async (): Promise<GameToolsRead> => {
      const result = await ctx.remote.pluginInventory.list()
      return result.ok ? { ok: true, tools: gameToolSlots(result.value.entries) } : { ok: false, failure: readFailure(result.error) }
    },
    resolveText,
  }
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: TAB_ID,
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: () => settings,
  }, SettingsGameToolsTab))

  ctx.inject(['remote.pluginManager'], (scope) => {
    const controller = new GameToolsController(scope)
    scope.effect(() => () => { controller.dispose() }, 'ui-game-tools: controller')
    // A plugin manager operation from this tab, the Plugins page, or another client, or a reconnection, reads the tools again.
    scope.effect(() => {
      const disposers = [
        scope.remote.$on('plugin-manager/changed', () => { controller.changed() }),
        scope.on('connection/reset', () => { controller.changed() }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'ui-game-tools: Host changes')
    const face: PluginsGameToolsTabInjected = controller.face(resolveText)
    scope.slots.inject('plugins.tab', () => scope.slots.register({
      name: 'plugins.tab',
      id: TAB_ID,
      order: -10,
      label: () => t('tab'),
      locale: NS,
      inject: () => face,
    }, PluginsGameToolsTab))
    // The frame's overlay outlives the tab, so leaving the tab or the page cuts no toast short.
    const notices: GameToolsNoticeToastInjected = controller.noticeFace(resolveText)
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'game-tools.toast',
      locale: NS,
      inject: () => notices,
    }, GameToolsNoticeToast))
  })

  // Agent feedback's usage reports switch, in Settings → General while the Host serves the `agent-feedback` entry; its
  // notice outlives Settings.
  ctx.inject(['configForms'], (scope) => {
    const form = scope.configForms.get<UsageReportsSettings>(AGENT_FEEDBACK_ENTRY)
    const preference = new UsageReportsPreference(form)
    const face = (): UsageReportsInjected => ({
      hooks: { usageReports: form, mutation: preference.state },
      setEnabled: enabled => preference.setEnabled(enabled),
      dismiss: () => { preference.dismiss() },
    })
    scope.effect(() => scope.configForms.whileServed([AGENT_FEEDBACK_ENTRY], () => scope.slots.inject('settings.general.item', () =>
      scope.slots.register({ name: 'settings.general.item', id: USAGE_REPORTS_ID, order: 91, locale: NS, inject: face }, UsageReportsRow))),
    'ui-game-tools: usage reports switch')
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: `${USAGE_REPORTS_ID}.toast`, locale: NS, inject: face,
    }, UsageReportsToast))
  })
}
