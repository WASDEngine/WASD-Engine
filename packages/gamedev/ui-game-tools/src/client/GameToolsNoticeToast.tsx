/**
 * The toast of the Plugins page tab's switch writes. A `shell.overlay` entry renders it, so a toast outlives the tab
 * and the Plugins page and reaches its fade wherever the person goes.
 */
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the `shell.overlay` SlotMap merge; ui-layout declares the slot at runtime.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { GameToolsState } from './controller.ts'
import { noticeText } from './presentation.ts'
import { toolText } from './tools.ts'

/** Registration-side face of the notice toast. */
export interface GameToolsNoticeToastInjected {
  readonly hooks: {
    /** The Plugins page tab's state, whose `notice` the toast shows; bound as `useGameTools`. */
    readonly gameTools: SnapshotStore<GameToolsState>
  }
  /** Resolve package text in the current Client locale at render time. */
  readonly resolveText: (text: LocalizedText) => string
  /** Drop the notice once its toast has faded. */
  readonly dismissNotice: () => void
}

/** Full component props assembled by the shell overlay's slot renderer. */
export type GameToolsNoticeToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'gameTools'>
  & InjectFace<GameToolsNoticeToastInjected>

/**
 * Show what the last switch write left to say as the app-wide toast, held long enough to read a failure that names
 * what broke, and drop the notice once the toast fades.
 * @param props - the state hook, the text resolver, the dismissal, and the copy seat.
 * @returns the toast, or null while no notice waits.
 */
export function GameToolsNoticeToast({ useGameTools, resolveText, dismissNotice, t }: GameToolsNoticeToastProps): ReactNode {
  const notice = useGameTools(state => state.notice)
  if (notice === null) return null
  const text = noticeText(notice, toolText(notice.tool, resolveText).title, t)
  const holdMs = Math.min(8_000, Math.max(3_000, text.length * 80))
  return <Toast key={notice.seq} text={text} icon={<IconWarningOutlineRegular />} holdMs={holdMs} onDone={dismissNotice} />
}
