/** Settings → Built-in plugins → Game tools: the game tools as the Host's plugin inventory lists them, read-only. */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { GameToolCard, GameToolList, GameToolsFrame, GameToolsSkeleton, ReadFailureNotice } from './GameToolCard.tsx'
import type { GameToolSlot, ReadFailure } from './tools.ts'

/** One read of the plugin inventory: the game tools in display order, or why the read failed. */
export type GameToolsRead =
  | { readonly ok: true; readonly tools: readonly GameToolSlot[] }
  | { readonly ok: false; readonly failure: ReadFailure }

/** Registration-side face of the Settings tab. */
export interface SettingsGameToolsTabInjected {
  /** Read the game tools from the Host's plugin inventory. */
  readonly read: () => Promise<GameToolsRead>
  /** Resolve package text in the current Client locale at render time. */
  readonly resolveText: (text: LocalizedText) => string
}

/** Full component props assembled by the Settings slot renderer. */
export type SettingsGameToolsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'gameTools'>
  & InjectFace<SettingsGameToolsTabInjected>

type View =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly failure: ReadFailure }
  | { readonly status: 'ready'; readonly tools: readonly GameToolSlot[] }

/**
 * Read the game tools when the tab mounts and list them as cards; a failed read offers a retry. The cards carry no
 * switches: the Plugins page's Game tools tab switches the tools.
 * @param props - the copy seat, the inventory read, and the text resolver.
 * @returns the tab.
 */
export function SettingsGameToolsTab({ t, read, resolveText }: SettingsGameToolsTabProps): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState<View>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void read().then(
      (result) => { if (current) setView(result.ok ? { status: 'ready', tools: result.tools } : { status: 'failed', failure: result.failure }) },
      // A Remote read rejects only on an assembly fault, which the tab reports as a failed read.
      (_assemblyFault: unknown) => { if (current) setView({ status: 'failed', failure: 'failed' }) },
    )
    return () => { current = false }
  }, [read, attempt])

  const retry = (): void => {
    setView({ status: 'loading' })
    setAttempt(value => value + 1)
  }

  return (
    <GameToolsFrame intro={t('settingsIntro')} busy={view.status === 'loading'}>
      {view.status === 'loading' ? <GameToolsSkeleton label={t('loading')} /> : null}
      {view.status === 'failed' ? <ReadFailureNotice failure={view.failure} refresh={false} t={t} onRetry={retry} /> : null}
      {view.status === 'ready' ? (
        <GameToolList label={t('tab')}>
          {view.tools.map(tool => <GameToolCard key={tool.moduleName} tool={tool} t={t} resolveText={resolveText} />)}
        </GameToolList>
      ) : null}
    </GameToolsFrame>
  )
}
