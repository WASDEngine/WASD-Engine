/** Plugins page → Game tools: the game tools with a switch each, writing the profile the Host manages. */
import { useEffect, useRef, type ReactNode } from 'react'
import type { PluginEntryId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { GameToolsState, ManagedGameTool, ToolControl } from './controller.ts'
import { GameToolCard, GameToolList, GameToolsFrame, GameToolsSkeleton, ReadFailureNotice, type Translate } from './GameToolCard.tsx'
import { lockedText } from './presentation.ts'
import { toolText, type GameToolEntry } from './tools.ts'
import css from './GameToolCard.module.css'

/** Registration-side face of the Plugins page tab. */
export interface PluginsGameToolsTabInjected {
  readonly hooks: {
    /** The tab state, bound as `useGameTools`. */
    readonly gameTools: SnapshotStore<GameToolsState>
  }
  /** Resolve package text in the current Client locale at render time. */
  readonly resolveText: (text: LocalizedText) => string
  /** Read the tools, keeping the cards of an earlier read until the answer lands; the tab calls it on mount and on Retry. */
  readonly load: () => void
  /**
   * Switch one tool in the profile patch.
   * @param entryId - the tool's Loader entry.
   * @param enabled - whether the tool should run.
   */
  readonly setEnabled: (entryId: PluginEntryId, enabled: boolean) => void
}

/** Full component props assembled by the Plugins page's slot renderer. */
export type PluginsGameToolsTabProps =
  PropsRuntime<'plugins.tab'>
  & PropsLocale<'gameTools'>
  & InjectFace<PluginsGameToolsTabInjected>

/**
 * A tool's switch, locked with the Host's reason as its hover text; while its write runs, the switch waits beside an
 * ongoing dot and the live region names the change. Disabling the switch drops the focus of the person who flipped
 * it to the page, so the switch takes the focus back once the write ends, unless the focus has moved on.
 */
function ToolSwitch({ entry, control, title, busy, t, onChange }: {
  readonly entry: GameToolEntry
  readonly control: ToolControl
  readonly title: string
  readonly busy: boolean
  readonly t: Translate
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = control.kind === 'locked' ? lockedText(control.reason, t) : undefined
  const seat = useRef<HTMLSpanElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (busy || !refocus.current) return
    refocus.current = false
    if (document.activeElement === document.body) seat.current?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }, [busy])
  return (
    <span ref={seat} className={css.toggle}>
      <span className={css.progress} role="status">
        <span className={css.visuallyHidden}>{busy ? t('applying', { name: title }) : ''}</span>
        {busy ? <StateDot state="ongoing" /> : null}
      </span>
      <Switch
        checked={entry.enabled}
        label={t('toggle', { name: title })}
        disabled={busy || locked !== undefined}
        title={locked}
        onChange={(enabled) => {
          refocus.current = seat.current?.contains(document.activeElement) === true
          onChange(enabled)
        }}
      />
    </span>
  )
}

/**
 * Read the tools each time the tab mounts and list them, each with its switch while the Host manages the profile.
 * A failed first read offers a retry in place of the cards; a failed refresh keeps the cards and offers it under them.
 * The notice toast of a switch write is not the tab's: a `shell.overlay` entry shows it.
 * @param props - the copy seat, the state hook, and the tab's actions.
 * @returns the tab.
 */
export function PluginsGameToolsTab({ t, useGameTools, resolveText, load, setEnabled }: PluginsGameToolsTabProps): ReactNode {
  const { snapshot, failure, busy } = useGameTools(state => state)
  useEffect(() => { load() }, [load])
  const card = (tool: ManagedGameTool): ReactNode => {
    const { entry, control } = tool
    return (
      <GameToolCard
        key={tool.moduleName}
        tool={tool}
        t={t}
        resolveText={resolveText}
        control={entry === undefined || control === undefined ? undefined : (
          <ToolSwitch
            entry={entry}
            control={control}
            title={toolText(tool, resolveText).title}
            busy={busy.includes(entry.entryId)}
            t={t}
            onChange={(enabled) => { setEnabled(entry.entryId, enabled) }}
          />
        )}
      />
    )
  }
  return (
    <GameToolsFrame intro={t('pluginsIntro')} busy={snapshot === null && failure === null}>
      {snapshot === null && failure === null ? <GameToolsSkeleton label={t('loading')} /> : null}
      {snapshot === null && failure !== null ? <ReadFailureNotice failure={failure} refresh={false} t={t} onRetry={load} /> : null}
      {snapshot === null ? null : (
        <>
          {snapshot.managed ? null : <p className={css.status} role="status"><StateDot state="idle" />{t('unmanaged')}</p>}
          <GameToolList label={t('tab')}>{snapshot.tools.map(card)}</GameToolList>
          {failure === null ? null : <ReadFailureNotice failure={failure} refresh t={t} onRetry={load} />}
        </>
      )}
    </GameToolsFrame>
  )
}
