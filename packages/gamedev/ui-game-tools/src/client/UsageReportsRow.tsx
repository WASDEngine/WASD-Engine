/** The usage reports switch in Settings › General, and the notice of its last write. */
import { Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageReportsMutation, UsageReportsSettings } from './usage-reports.ts'
import css from './UsageReportsRow.module.css'

/** The accepted setting and the write callbacks the plugin supplies. */
export interface UsageReportsInjected {
  hooks: {
    usageReports: ObservableSnapshot<ConfigFormSnapshot<UsageReportsSettings>>
    mutation: ObservableSnapshot<UsageReportsMutation>
  }
  setEnabled(enabled: boolean): Promise<void>
  dismiss(): void
}

type Face = InjectFace<UsageReportsInjected> & PropsLocale<'gameTools'>

/** Props of {@link UsageReportsRow}. */
export type UsageReportsRowProps = PropsRuntime<'settings.general.item'> & Face

/** Props of {@link UsageReportsToast}. */
export type UsageReportsToastProps = PropsRuntime<'shell.overlay'> & Face

/**
 * Show whether WASD Engine sends tool usage reports, as the Host accepted it, with a switch that changes it.
 * @param props - the setting's hooks, its writer, and localized copy.
 * @returns the row.
 */
export function UsageReportsRow({ useUsageReports, useMutation, setEnabled, t }: UsageReportsRowProps) {
  const settings = useUsageReports(value => value)
  const busy = useMutation(value => value.busy)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('usageReportsTitle')}</div>
      <div className={css.description}>{t('usageReportsDescription')}</div>
    </div>
    <Switch checked={settings.value?.usageReports !== false} label={t('usageReportsTitle')}
      disabled={busy || settings.status !== 'ready' || !settings.writable}
      onChange={(enabled) => { void setEnabled(enabled) }} />
  </div>
}

/**
 * Keep the outcome of the last write visible after Settings closes.
 * @param props - the write's hook, its dismissal, and localized copy.
 * @returns the notice, or nothing.
 */
export function UsageReportsToast({ useMutation, dismiss, t }: UsageReportsToastProps) {
  const state = useMutation(value => value)
  if (state.notice === null) return null
  return <Toast key={state.sequence} text={t(state.notice === 'saved' ? 'usageReportsSaved' : 'usageReportsFailed')} onDone={dismiss}
    {...state.notice === 'saved' ? { tone: 'success' as const } : {}} />
}
