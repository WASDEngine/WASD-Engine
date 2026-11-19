/**
 * The usage reports switch of Agent feedback (`@deepseek-ai/dsh-agent-feedback`): its accepted Host value comes from
 * the `agent-feedback` entry's configuration form, and each change is one ordered write of its `usageReports` field,
 * whose notice outlives Settings.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Profile entry id of Agent feedback, whose configuration the switch edits. */
export const AGENT_FEEDBACK_ENTRY = 'agent-feedback'

/** The Agent feedback field the switch edits. */
export interface UsageReportsSettings {
  usageReports: boolean
}

/** A write's state, shared by the switch and its notice. */
export interface UsageReportsMutation {
  busy: boolean
  notice: 'saved' | 'failed' | null
  sequence: number
}

/* jscpd:ignore-start -- the write and notice follow UploadPreference of @deepseek-ai/dsh-client-ui-settings-session-log for
   another plugin's field; a client plugin imports no other plugin's values, and sharing the class would change that
   upstream package. */
/** Writes the switch without showing a value the Host has not accepted. */
export class UsageReportsPreference {
  /** Observable state of the latest write. */
  readonly state = createSnapshotStore<UsageReportsMutation>({ busy: false, notice: null, sequence: 0 })

  /** @param form - Agent feedback's configuration form. */
  constructor(private readonly form: ConfigForm<UsageReportsSettings>) {}

  /**
   * Turn usage reports on or off; a refused or failed write leaves the accepted value shown and says so.
   * @param enabled - whether reports are sent.
   * @returns once the write settles; a write while another is in flight does nothing.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.notice = null })
    let accepted = false
    try {
      accepted = await this.form.set('usageReports', enabled)
    } catch (_error) {
      // The notice reports the failed write; the form keeps the accepted value.
    }
    this.state.update((state) => {
      state.busy = false
      state.notice = accepted ? 'saved' : 'failed'
      state.sequence++
    })
  }

  /** Clear the notice. */
  dismiss(): void {
    this.state.update((state) => { state.notice = null })
  }
}
/* jscpd:ignore-end */
