/**
 * The first build tip: a card beside the composer's effort selector that suggests Max effort with agent teamwork for
 * a game's first build. It shows while the Session's game project folder holds nothing but hidden entries, the Session
 * is idle, and either setting is off. Its button turns both on; Not now hides it for that project in this browser.
 * The card portals to the document body and anchors to the model seat's trigger, just below the composer card or, when
 * the viewport has no room below, just above it; a marker left in the seat hides it while the seat is not displayed or
 * sits in an inert region, such as behind the open sidebar drawer.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckCircleFillRegular, IconLoadingOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { firstBuildEffort } from './first-build.ts'
import type { NS } from './locales.ts'
import css from './FirstBuildTip.module.css'

/** How long the card confirms that both settings are on before it leaves, in milliseconds. */
export const APPLIED_DISPLAY_MS = 2600

/** Registration-side data and operations of one Session's tip. */
export interface FirstBuildTipInjected {
  readonly hooks: {
    /** The Session's model directory, which the composer's model seat also reads. */
    readonly modelDirectory: HostObservable<ModelDirectoryState>
    /** Project folders where the user dismissed the tip, most recent last. */
    readonly dismissedProjects: HostObservable<readonly string[]>
  }
  /**
   * Follow whether a folder of the Session holds nothing yet.
   * @param directory - absolute folder path inside the Session's workspace.
   * @param signal - ends the watch.
   * @returns true while the folder holds nothing; false, then the end, once it holds something.
   */
  readonly watchFolder: (directory: string, signal: AbortSignal) => AsyncIterable<boolean>
  /**
   * Select the Max effort for the Session's model.
   * @returns undefined once saved, else what went wrong.
   */
  readonly selectMaxEffort: () => Promise<string | undefined>
  /**
   * Turn on agent teamwork for the Session.
   * @returns undefined once saved, else what went wrong.
   */
  readonly enableTeamwork: () => Promise<string | undefined>
  /**
   * Hide the tip in a game project for this browser.
   * @param project - absolute path of the game project folder.
   */
  readonly dismiss: (project: string) => void
}

/** Props of {@link FirstBuildTip}. */
export type FirstBuildTipProps = PropsRuntime<'conversation.input.model.callout'> & PropsLocale<typeof NS>
  & InjectFace<FirstBuildTipInjected>

/**
 * Render the first build tip of one Session.
 * @param props - the model seat's anchor and state, Session props, and the registration's operations.
 * @returns the card portaled to the document body with its marker in the seat, or null while the tip does not apply.
 */
export function FirstBuildTip({
  sessionId, anchor, menuOpen, locked, useSession, useSessions, useWorkspaces, useProjection, useAccess,
  useModelDirectory, useDismissedProjects, watchFolder, selectMaxEffort, enableTeamwork, dismiss, t,
}: FirstBuildTipProps) {
  const running = useSession(state => state.running)
  const addressedChild = useSession(state => state.subagent !== null)
  const listedChild = useSessions(state => state.byId[sessionId]?.origin === 'subagent')
  const folder = useSessions(state => state.byId[sessionId]?.cwd)
  const project = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const team = useProjection('agentTeam')
  const offersMax = useModelDirectory(state => firstBuildEffort(state)?.offersMax === true)
  const atMax = useModelDirectory(state => firstBuildEffort(state)?.atMax === true)
  const dismissed = useDismissedProjects(projects => project !== undefined && projects.includes(project))
  const maySelectModel = useAccess('session/selectModel')
  const mayTeam = useAccess('agentTeams/setEnabled')
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [failure, setFailure] = useState<string>()

  const applies = project !== undefined && folder !== undefined && folder !== '' && !addressedChild && !listedChild
    && maySelectModel && mayTeam && !dismissed && team !== undefined && offersMax
  const needed = applies && (!atMax || !team.enabled)
  const empty = useHoldsNothing(watchFolder, folder, needed)

  useEffect(() => {
    if (!applied) return
    const timer = setTimeout(() => { setApplied(false) }, APPLIED_DISPLAY_MS)
    return () => { clearTimeout(timer) }
  }, [applied])

  if (!applies || menuOpen || locked) return null
  if (!applied && (!needed || empty !== true || running)) return null

  const apply = async (): Promise<void> => {
    setApplying(true)
    setFailure(undefined)
    const refused = (atMax ? undefined : await selectMaxEffort()) ?? (team.enabled ? undefined : await enableTeamwork())
    setApplying(false)
    if (refused !== undefined) {
      setFailure(t('firstBuild.failed', { message: refused }))
      return
    }
    setApplied(true)
  }

  return (
    <TipCard
      anchor={anchor}
      applied={applied}
      applying={applying}
      failure={failure}
      onApply={() => { void apply() }}
      onDismiss={() => { dismiss(project) }}
      t={t}
    />
  )
}

/** The card and the marker that tells whether the seat it points at is on screen. */
function TipCard({ anchor, applied, applying, failure, onApply, onDismiss, t }: {
  readonly anchor: string
  readonly applied: boolean
  readonly applying: boolean
  readonly failure: string | undefined
  readonly onApply: () => void
  readonly onDismiss: () => void
  readonly t: FirstBuildTipProps['t']
}) {
  const marker = useRef<HTMLSpanElement | null>(null)
  const card = useRef<HTMLElement | null>(null)
  const shown = useSeatShown(marker)
  const placement = useCardPlacement(card, marker, shown)
  const titleId = useId()
  const style: CSSProperties & Record<`--wasd-first-build-${'anchor' | 'drop' | 'lift'}`, string> = {
    '--wasd-first-build-anchor': anchor,
    '--wasd-first-build-drop': `${placement.drop}px`,
    '--wasd-first-build-lift': `${placement.lift}px`,
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || applied) return
    event.preventDefault()
    onDismiss()
  }
  return (
    <>
      <span ref={marker} className={css.marker} aria-hidden="true" />
      {shown && createPortal(
        <section
          ref={card}
          className={css.card}
          style={style}
          aria-labelledby={titleId}
          data-side={placement.side}
          data-applied={applied ? '' : undefined}
          onKeyDown={onKeyDown}
        >
          <span className={css.arrow} aria-hidden="true" />
          {applied
            ? (
              <p className={css.header} role="status">
                <IconCheckCircleFillRegular size={14} className={css.icon} aria-hidden="true" />
                <span id={titleId} className={css.title}>{t('firstBuild.applied')}</span>
              </p>
            )
            : (
              <>
                <p className={css.header}>
                  <IconSparkleRegular size={14} className={css.icon} aria-hidden="true" />
                  <span id={titleId} className={css.title}>{t('firstBuild.title')}</span>
                </p>
                <p className={css.body}>{t('firstBuild.body')}</p>
                {failure !== undefined && <p className={css.failure} role="alert">{failure}</p>}
                <div className={css.actions}>
                  <button type="button" className={css.dismiss} onClick={onDismiss} disabled={applying}>{t('firstBuild.dismiss')}</button>
                  <button type="button" className={css.apply} onClick={onApply} disabled={applying} aria-busy={applying}>
                    {applying && <IconLoadingOutlineRegular size={14} className={css.spinner} aria-hidden="true" />}
                    {t('firstBuild.apply')}
                  </button>
                </div>
              </>
            )}
        </section>,
        document.body,
      )}
    </>
  )
}

/**
 * Follow whether a folder holds nothing yet while `active`; the last answer for the same folder stays readable after
 * the watch stops.
 * @returns undefined until the first answer for `folder`.
 */
function useHoldsNothing(
  watchFolder: FirstBuildTipInjected['watchFolder'],
  folder: string | undefined,
  active: boolean,
): boolean | undefined {
  const [answer, setAnswer] = useState<{ readonly folder: string; readonly empty: boolean }>()
  useEffect(() => {
    if (!active || folder === undefined || folder === '') return
    const lifetime = new AbortController()
    void (async () => {
      try {
        for await (const empty of watchFolder(folder, lifetime.signal)) setAnswer({ folder, empty })
      } catch (_failure: unknown) {
        // A folder the Host cannot watch or list gets no tip.
        if (!lifetime.signal.aborted) setAnswer({ folder, empty: false })
      }
    })()
    return () => { lifetime.abort() }
  }, [watchFolder, folder, active])
  return answer !== undefined && answer.folder === folder ? answer.empty : undefined
}

/** Where the card sits relative to the model seat, in CSS pixels. */
interface CardPlacement {
  /** The side of the seat CSS anchor positioning chose; the arrow follows it. */
  readonly side: 'below' | 'above'
  /** Distance from the seat's bottom edge to the card below it: clear of the composer card's bottom edge. */
  readonly drop: number
  /** Distance from the seat's top edge to the card above it: clear of the composer card's top edge, so the card covers no draft. */
  readonly lift: number
}

/** Smallest distance between the seat and the card. */
const CARD_GAP = 10

/** Room the arrow takes between the composer card's edge and the card. */
const ARROW_CLEARANCE = 12

/**
 * Measure the card's placement against the model seat, which holds `marker`, and the composer card around it. CSS
 * anchor positioning moves the card above the seat when the viewport has no room below. Measured again whenever the
 * card, the composer card, or the window resizes.
 * @returns the placement; below the seat, {@link CARD_GAP} away, until measured.
 */
function useCardPlacement(
  card: { readonly current: HTMLElement | null },
  marker: { readonly current: HTMLElement | null },
  shown: boolean,
): CardPlacement {
  const [placement, setPlacement] = useState<CardPlacement>({ side: 'below', drop: CARD_GAP, lift: CARD_GAP })
  useLayoutEffect(() => {
    const element = card.current
    const spot = marker.current
    if (!shown || element === null || spot === null) return
    // The marker sits at the seat's top left corner, absolutely positioned in the seat's root, which holds the trigger.
    const seat = spot.offsetParent ?? spot.parentElement ?? spot
    const composer = spot.closest<HTMLElement>('[data-composer-card]')
    const measure = (): void => {
      const seatBox = seat.getBoundingClientRect()
      const composerBox = composer?.getBoundingClientRect()
      const next: CardPlacement = {
        side: element.getBoundingClientRect().top >= seatBox.top ? 'below' : 'above',
        drop: composerBox === undefined ? CARD_GAP : Math.max(CARD_GAP, Math.round(composerBox.bottom - seatBox.bottom + ARROW_CLEARANCE)),
        lift: composerBox === undefined ? CARD_GAP : Math.max(CARD_GAP, Math.round(seatBox.top - composerBox.top + ARROW_CLEARANCE)),
      }
      setPlacement(current => current.side === next.side && current.drop === next.drop && current.lift === next.lift ? current : next)
    }
    measure()
    window.addEventListener('resize', measure)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(element)
    if (composer !== null) resize?.observe(composer)
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', measure)
    }
    // A new drop or lift moves the card, which can move it to the other side; measuring again settles the side.
  }, [card, marker, shown, placement.drop, placement.lift])
  return placement
}

/**
 * Whether the model seat that holds `marker` is displayed in the viewport outside an inert region. Without
 * IntersectionObserver the seat counts as displayed.
 * @returns false until the marker has been observed.
 */
function useSeatShown(marker: { readonly current: HTMLElement | null }): boolean {
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined')
  const [inert, setInert] = useState(false)
  useEffect(() => {
    const element = marker.current
    if (element === null) return
    const readInert = (): void => { setInert(element.closest('[inert]') !== null) }
    readInert()
    const attributes = new MutationObserver(readInert)
    attributes.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true })
    if (typeof IntersectionObserver === 'undefined') return () => { attributes.disconnect() }
    const view = new IntersectionObserver((entries) => {
      const last = entries.at(-1)
      if (last !== undefined) setInView(last.isIntersecting)
    })
    view.observe(element)
    return () => {
      view.disconnect()
      attributes.disconnect()
    }
  }, [marker])
  return inView && !inert
}
