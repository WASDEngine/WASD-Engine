/** Presentation both Game tools tabs share: the tab frame, the tool cards, and the loading and failed-read states. */
import { useState, type ReactNode } from 'react'
import { Button, PluginArtworkDefault, StateDot, Tag, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { GameToolsLocaleKey } from './locales.ts'
import { GAME_TOOL_MODULES, toolText, type GameToolEntry, type GameToolSlot, type ReadFailure } from './tools.ts'
import css from './GameToolCard.module.css'

/** The translate seat of the `gameTools` namespace. */
export type Translate = PropsLocale<'gameTools'>['t']

/** Edge of the 36-unit package logo inside its 48 px frame. */
const LOGO_SIZE = 36

/** What a card says about its tool: not mounted by this profile, failed to start, switched off, or on. */
type CardState = 'absent' | 'failed' | 'off' | 'on'

/** The tag of each card state that departs from a plainly running tool. */
const STATE_TAGS = {
  absent: { tone: 'outline', key: 'absentTag' },
  failed: { tone: 'danger', key: 'failedTag' },
  off: { tone: 'neutral', key: 'offTag' },
} as const satisfies Record<Exclude<CardState, 'on'>, { readonly tone: TagTone; readonly key: GameToolsLocaleKey }>

/** The dot of each Loader phase still under way; a settled phase carries none. */
const PHASE_MARKS: Readonly<Record<
  NonNullable<GameToolEntry['fiberPhase']>,
  { readonly dot: StateDotState; readonly key: GameToolsLocaleKey } | null
>> = {
  pending: { dot: 'idle', key: 'phasePending' },
  loading: { dot: 'ongoing', key: 'phaseLoading' },
  unloading: { dot: 'ongoing', key: 'phaseUnloading' },
  active: null,
  failed: null,
}

/** A failed start outranks the switch state; an entry the profile switched off but still unloads stays `off`. */
function cardState(entry: GameToolEntry | undefined): CardState {
  if (entry === undefined) return 'absent'
  if (entry.fiberPhase === 'failed') return 'failed'
  return entry.enabled ? 'on' : 'off'
}

/** The package logo, or the default plugin artwork when the package declares none or its image fails to decode. */
function ToolLogo({ icon }: { readonly icon: string | undefined }): ReactNode {
  const [decoded, setDecoded] = useState(true)
  if (icon === undefined || !decoded) return <PluginArtworkDefault size={LOGO_SIZE} />
  return <img className={css.logo} src={icon} alt="" width={LOGO_SIZE} height={LOGO_SIZE} onError={() => { setDecoded(false) }} />
}

/** Props of one tool card. */
export interface GameToolCardProps {
  readonly tool: GameToolSlot
  readonly t: Translate
  /** Current-locale package text resolver. */
  readonly resolveText: (text: LocalizedText) => string
  /** What the card ends with, such as the tool's switch; absent on a read-only card. */
  readonly control?: ReactNode
}

/**
 * Render one game tool as a list item: its logo, its package title and description, a tag unless it runs, a dot while
 * its Loader phase is under way, and its startup and package metadata diagnostics.
 * @param props - the tool, the copy seat, the text resolver, and the optional end control.
 * @returns the card.
 */
export function GameToolCard({ tool, t, resolveText, control }: GameToolCardProps): ReactNode {
  const { entry } = tool
  const { title, description } = toolText(tool, resolveText)
  const state = cardState(entry)
  const mark = entry === undefined || entry.fiberPhase === null ? null : PHASE_MARKS[entry.fiberPhase]
  const icon = entry?.meta?.icon
  const metadataError = entry?.meta?.error
  return (
    <li className={css.card} data-game-tool={tool.moduleName} data-state={state}>
      <span className={css.logoFrame} aria-hidden="true"><ToolLogo key={icon} icon={icon} /></span>
      <div className={css.body}>
        <div className={css.heading}>
          <span className={css.title} title={tool.moduleName}>{title}</span>
          {mark === null ? null : (
            <span className={css.phase} role="img" aria-label={t(mark.key)} title={t(mark.key)}>
              <StateDot state={mark.dot} />
            </span>
          )}
          {state === 'on' ? null : <Tag tone={STATE_TAGS[state].tone}>{t(STATE_TAGS[state].key)}</Tag>}
        </div>
        {description === undefined ? null : <p className={css.description}>{description}</p>}
        {entry?.diagnostic === undefined ? null : (
          <p className={css.problem} role="status" data-plugin-runtime-error>{t('diagnostic', { diagnostic: entry.diagnostic })}</p>
        )}
        {metadataError === undefined ? null : (
          <p className={css.problem} role="status" data-package-meta-error>{t('metadataError', { error: metadataError })}</p>
        )}
      </div>
      {control === undefined ? null : <div className={css.control}>{control}</div>}
    </li>
  )
}

/**
 * Frame either tab: its introduction above the tab's state or cards.
 * @param props - the localized introduction, whether a first read runs, and the tab's content.
 * @returns the tab body.
 */
export function GameToolsFrame({ intro, busy, children }: {
  readonly intro: string
  readonly busy: boolean
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className={css.tab} aria-busy={busy}>
      <p className={css.intro}>{intro}</p>
      {children}
    </div>
  )
}

/**
 * List tool cards.
 * @param props - the list's accessible name and its cards.
 * @returns the list element.
 */
export function GameToolList({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return <ul className={css.cards} aria-label={label}>{children}</ul>
}

/**
 * Hold one placeholder card per tool until the first read answers.
 * @param props - the localized loading announcement.
 * @returns the loading state.
 */
export function GameToolsSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <div className={css.cards} role="status">
      <span className={css.visuallyHidden}>{label}</span>
      {GAME_TOOL_MODULES.map(moduleName => (
        <div key={moduleName} className={css.card} aria-hidden="true">
          <span className={`${css.logoFrame} ${css.placeholder}`} />
          <span className={css.body}>
            <span className={`${css.placeholder} ${css.placeholderTitle}`} />
            <span className={`${css.placeholder} ${css.placeholderLine}`} />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Say that a read failed and offer it again: the owner-only refusal a Peer without access receives, a failed first
 * read, or a failed refresh under cards that stay in place.
 * @param props - why the read failed, whether cards from an earlier read stay shown, the copy seat, and the retry.
 * @returns the notice.
 */
export function ReadFailureNotice({ failure, refresh, t, onRetry }: {
  readonly failure: ReadFailure
  readonly refresh: boolean
  readonly t: Translate
  readonly onRetry: () => void
}): ReactNode {
  return (
    <div className={css.failure}>
      <p className={css.failureText} role="alert">
        <StateDot state="error" />{t(failure === 'denied' ? 'denied' : refresh ? 'refreshError' : 'error')}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
    </div>
  )
}
