/** Body and chip title of the Game tab: the run toolbar, the game view that takes keyboard and mouse input, and the log drawer. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconChevronUpOutlineRegular, IconCloseCircleFillRegular,
  IconCloseOutlineRegular, IconDownloadOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular,
  IconStopFillRegular, IconWarningTriangleOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  GodotControlRequest, GodotInputEvent, GodotLogEntry, GodotRunPhase, GodotRunRequest, GodotRunView, GodotRuntimeView,
} from '../types.ts'
import type { GameFailure } from './actions.ts'
import { decodeFrame, drawFrame, FramePresenter, nextFrame, readFrames } from './frames.ts'
import { GameControllerIcon } from './icon.tsx'
import { bindGameInput, MOUSE_MODE_CAPTURED, type GameInputTarget, type PixelSize } from './input.ts'
import type { GodotUiKey, NS } from './locales.ts'
import { ACTIVE_PHASES, LIVE_PHASES, type GameSnapshot, type GameState } from './source.ts'
import css from './GameTab.module.css'

/** Business face of the Game tab body. */
export interface GameTabInjected {
  /** The Session's game state; the renderer binds it as `useGame`. */
  readonly hooks: { readonly game: HostObservable<GameSnapshot> }
  /** Open the follow stream at once after it stopped, instead of after its retry delay. */
  readonly reconnect: () => void
  /**
   * Start the Session's game, replacing a run in progress.
   * @param request - project and scene; empty runs the nearest project's main scene.
   * @returns the failure to show, or undefined once the Host accepted the run.
   */
  readonly play: (request: GodotRunRequest) => Promise<GameFailure | undefined>
  /**
   * Stop the Session's game.
   * @returns the failure to show, or undefined once stopped.
   */
  readonly stop: () => Promise<GameFailure | undefined>
  /**
   * Pause, resume, or step the running game.
   * @param request - the control action.
   * @returns the failure to show, or undefined once applied.
   */
  readonly control: (request: GodotControlRequest) => Promise<GameFailure | undefined>
  /**
   * Install the managed Godot runtime; progress arrives through `useGame`.
   * @returns the failure to show, or undefined once installed.
   */
  readonly install: () => Promise<GameFailure | undefined>
  /**
   * Deliver one ordered batch of input events to a run; a run that ended meanwhile drops it.
   * @param runId - the run the events belong to.
   * @param events - at most 256 events.
   * @returns once the Host accepted or dropped the batch; rejects with the failure when the game may not have received it.
   */
  readonly input: (runId: string, events: GodotInputEvent[]) => Promise<void>
  /**
   * Request a run's frame stream.
   * @param runId - the run to stream.
   * @param signal - closes the response.
   * @returns the streaming response.
   */
  readonly openFrames: (runId: string, signal: AbortSignal) => Promise<Response>
  /**
   * Keep application shortcuts from taking keys while the game view has focus.
   * @returns the release.
   */
  readonly captureKeyboard: () => () => void
}

/** Full props of the Game tab body. */
export type GameTabProps = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo'> & InjectFace<GameTabInjected> & PropsLocale<typeof NS>

type Translate = GameTabProps['t']

/** Toolbar operations that disable their own control while they run. */
type GameAction = 'play' | 'stop' | 'control' | 'install'

const NO_ACTIONS: ReadonlySet<GameAction> = new Set()

const PHASE_KEYS = {
  preparing: 'phase.preparing',
  importing: 'phase.importing',
  starting: 'phase.starting',
  running: 'phase.running',
  paused: 'phase.paused',
  exited: 'phase.exited',
  crashed: 'phase.crashed',
  failed: 'phase.failed',
} as const satisfies Record<GodotRunPhase, GodotUiKey>

const EMPTY_SIZE: PixelSize = { width: 0, height: 0 }

/**
 * Render the Game tab of one Session. The frame stream and input capture run
 * only while the follow stream delivers, the tab is visible, and the game is
 * running or paused; keys reach the game only while the game view has focus.
 * After the follow stream stops, the tab keeps the last state and offers Retry.
 * Restart starts the run's project with the scene and window size of its start
 * request; Play starts the main scene.
 * @param props - tab information, the game state hook, run actions, and copy.
 * @returns the tab body.
 */
export function GameTab({
  useTabInfo, useGame, reconnect, play, stop, control, install, input, openFrames, captureKeyboard, t,
}: GameTabProps): ReactNode {
  const { tab } = useTabInfo()
  const snapshot = useGame(value => value)
  const [failure, setFailure] = useState<GameFailure>()
  const [pending, setPending] = useState(NO_ACTIONS)
  const [logsOpen, setLogsOpen] = useState(false)
  const state = snapshot.state
  const reconnectNotice = snapshot.disconnected && (
    <div className={css.notice} role="status">
      <span className={css.noticeText}>{t('stream.failed')}</span>
      <Button size="sm" variant="outline" onClick={reconnect}>{t('action.retry')}</Button>
    </div>
  )
  if (state === null) return <div className={css.centered}>{reconnectNotice || <StateDot state="ongoing" />}</div>
  const perform = (action: GameAction, operation: () => Promise<GameFailure | undefined>): void => {
    setFailure(undefined)
    setPending(current => new Set([...current, action]))
    const settled = (): void => { setPending(current => new Set([...current].filter(entry => entry !== action))) }
    void operation().then((result) => {
      settled()
      if (result !== undefined) setFailure(result)
    }, (error: unknown) => {
      settled()
      setFailure({ issue: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }
  const { run, runtime } = state
  const active = run !== null && ACTIVE_PHASES.has(run.phase)
  const live = run !== null && LIVE_PHASES.has(run.phase)
  const paused = run?.phase === 'paused'
  const request: GodotRunRequest = run === null ? {} : active ? { project: run.projectDir, ...run.launch } : { project: run.projectDir }
  return (
    <div className={css.root} data-godot-game="">
      <div className={css.toolbar} role="toolbar" aria-label={t('toolbar.label')}>
        <ToolButton label={t(active ? 'action.restart' : 'action.play')} disabled={runtime.state !== 'ready' || pending.has('play')}
          onClick={() => { perform('play', () => play(request)) }}>
          {active ? <IconRefreshOutlineRegular /> : <IconPlayOutlineRegular />}
        </ToolButton>
        <ToolButton label={t('action.stop')} disabled={!active || pending.has('stop')} onClick={() => { perform('stop', stop) }}>
          <IconStopFillRegular />
        </ToolButton>
        <ToolButton label={t(paused ? 'action.resume' : 'action.pause')} disabled={!live || pending.has('control')}
          onClick={() => { perform('control', () => control({ action: paused ? 'resume' : 'pause' })) }}>
          {paused ? <IconPlayOutlineRegular /> : <IconPauseOutlineRegular />}
        </ToolButton>
        <ToolButton label={t('action.step')} disabled={!paused || pending.has('control')}
          onClick={() => { perform('control', () => control({ action: 'step', frames: 1 })) }}>
          <IconChevronRightOutlineRegular />
        </ToolButton>
        <Status run={run} runtime={runtime} t={t} />
        {(runtime.state === 'missing' || runtime.state === 'failed') && (
          <Button size="sm" variant="outline" icon={<IconDownloadOutlineRegular />} disabled={pending.has('install')}
            onClick={() => { perform('install', install) }}>
            {t('action.install')}
          </Button>
        )}
      </div>
      {reconnectNotice}
      {failure !== undefined && (
        <div className={css.notice} role="alert">
          <span className={css.noticeText}>{failureText(failure, t)}</span>
          <button type="button" className={css.tool} aria-label={t('action.dismiss')} onClick={() => { setFailure(undefined) }}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
      )}
      <div className={css.stage}>
        <Viewport run={run} visible={tab.visible} connected={!snapshot.disconnected} input={input} openFrames={openFrames}
          captureKeyboard={captureKeyboard} t={t} />
        <StageMessage state={state} t={t} />
      </div>
      <LogDrawer run={run} logs={state.logs} open={logsOpen} onToggle={() => { setLogsOpen(open => !open) }} t={t} />
    </div>
  )
}

/**
 * Render the tab chip title.
 * @param props - Game tab copy.
 * @returns the game controller glyph followed by the tab name.
 */
export function GameTabTitle({ t }: PropsLocale<typeof NS>): ReactNode {
  return (
    <>
      <GameControllerIcon />
      <span className={css.title}>{t('tab.title')}</span>
    </>
  )
}

function ToolButton({ label, disabled, onClick, children }: {
  readonly label: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button type="button" className={css.tool} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
    </Tooltip>
  )
}

function Status({ run, runtime, t }: {
  readonly run: GodotRunView | null
  readonly runtime: GodotRuntimeView
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.status}>
      {runtime.state === 'installing' && <span className={css.statusItem}>{installText(runtime, t)}</span>}
      {run !== null && <span className={css.statusItem} data-phase={run.phase}>{t(PHASE_KEYS[run.phase])}</span>}
      {run !== null && LIVE_PHASES.has(run.phase) && run.fps !== undefined && (
        <span className={css.statusItem}>{t('status.fps', { fps: Math.round(run.fps) })}</span>
      )}
      {run?.scene !== undefined && (
        <Tooltip label={run.scene} side="bottom" delayMs={500}>
          <span className={css.statusItem}>{run.scene.slice(run.scene.lastIndexOf('/') + 1)}</span>
        </Tooltip>
      )}
      {run?.renderer !== undefined && <span className={css.statusItem}>{run.renderer}</span>}
    </div>
  )
}

function installText(runtime: GodotRuntimeView, t: Translate): string {
  const progress = runtime.progress
  if (progress === undefined) return t('runtime.installing')
  switch (progress.phase) {
    case 'downloading': {
      const percent = progress.totalBytes > 0 ? Math.min(100, Math.floor(progress.completedBytes / progress.totalBytes * 100)) : 0
      return t('runtime.downloading', { percent })
    }
    case 'verifying': return t('runtime.verifying')
    case 'extracting': return t('runtime.extracting')
    /* v8 ignore next -- closed GodotRuntimeInstallProgress phase union exhaustiveness guard */
    default: return assertNever(progress.phase, 'GodotRuntimeInstallProgress.phase')
  }
}

function failureText(failure: GameFailure, t: Translate): string {
  switch (failure.issue) {
    case 'noProject': return t('issue.noProject')
    case 'runtimeUnavailable': return t('issue.runtimeUnavailable', { message: failure.message })
    case 'notRunning': return t('issue.notRunning')
    case 'staleRun': return t('issue.staleRun')
    case 'tooManyRuns': return t('issue.tooManyRuns', { limit: failure.limit })
    case 'sessionInUse': return t('issue.sessionInUse')
    case 'failed': return t('issue.failed', { message: failure.message })
    /* v8 ignore next -- closed GameFailure issue union exhaustiveness guard */
    default: return assertNever(failure, 'GameFailure.issue')
  }
}

function StageMessage({ state, t }: { readonly state: GameState; readonly t: Translate }): ReactNode {
  const { run, runtime } = state
  if (run !== null && LIVE_PHASES.has(run.phase)) return null
  if ((run !== null && ACTIVE_PHASES.has(run.phase)) || runtime.state === 'installing') {
    return (
      <div className={css.overlay}>
        <div className={css.message} role="status">
          <StateDot state="ongoing" />
          <p>{run !== null && ACTIVE_PHASES.has(run.phase) ? t(PHASE_KEYS[run.phase]) : installText(runtime, t)}</p>
        </div>
      </div>
    )
  }
  if (run !== null) return <div className={css.overlay}><Ended run={run} t={t} /></div>
  if (runtime.state === 'missing') {
    return <div className={css.overlay}><div className={css.message}><p>{t('runtime.missing')}</p></div></div>
  }
  if (runtime.state === 'failed') {
    return (
      <div className={css.overlay}>
        <div className={css.message} role="alert"><p>{t('runtime.failed', { message: runtime.message ?? '' })}</p></div>
      </div>
    )
  }
  return (
    <div className={css.overlay}>
      <div className={css.message}>
        <p className={css.messageTitle}>{t('empty.title')}</p>
        <p>{t('empty.hint')}</p>
      </div>
    </div>
  )
}

function Ended({ run, t }: { readonly run: GodotRunView; readonly t: Translate }): ReactNode {
  const title = run.phase === 'exited' ? t('ended.exited') : run.phase === 'crashed' ? t('ended.crashed') : t('ended.failed')
  return (
    <div className={css.message} role={run.phase === 'exited' ? 'status' : 'alert'}>
      <p className={css.messageTitle}>{title}</p>
      {typeof run.exitCode === 'number' && <p>{t('ended.code', { code: run.exitCode })}</p>}
      {typeof run.signal === 'string' && <p>{t('ended.signal', { signal: run.signal })}</p>}
      {run.message !== undefined && <pre className={css.messageDetail}>{run.message}</pre>}
    </div>
  )
}

/**
 * The game window and frame sizes and mouse mode that pointer input maps against.
 * @param run - the current run.
 * @param drawn - size of the last drawn frame.
 * @returns the event-time input target.
 */
function inputTarget(run: GodotRunView | null, drawn: PixelSize | undefined): GameInputTarget {
  const size = run?.width !== undefined && run.height !== undefined ? { width: run.width, height: run.height } : drawn ?? EMPTY_SIZE
  return { window: size, image: drawn ?? size, mouseMode: run?.mouseMode ?? 0 }
}

/* oxlint-disable typescript/no-non-null-assertion -- React sets the element refs before these effects run. */
function Viewport({ run, visible, connected, input, openFrames, captureKeyboard, t }: {
  readonly run: GodotRunView | null
  readonly visible: boolean
  /** Whether the follow stream delivers; a stopped stream leaves the run's last reported phase, which may be outdated. */
  readonly connected: boolean
  readonly input: GameTabInjected['input']
  readonly openFrames: GameTabInjected['openFrames']
  readonly captureKeyboard: GameTabInjected['captureKeyboard']
  readonly t: Translate
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawn = useRef<PixelSize | undefined>(undefined)
  const latest = useRef(run)
  latest.current = run
  const releaseId = useId()
  const [focused, setFocused] = useState(false)
  const live = connected && run !== null && LIVE_PHASES.has(run.phase)
  const runId = run?.runId
  const streaming = live && visible ? runId : undefined
  const mouseMode = run?.mouseMode

  useEffect(() => {
    const node = canvas.current!
    drawn.current = undefined
    node.getContext('2d')?.clearRect(0, 0, node.width, node.height)
  }, [runId])

  useEffect(() => {
    if (streaming === undefined) return
    const node = canvas.current!
    const lifetime = new AbortController()
    const presenter = new FramePresenter({
      decode: decodeFrame,
      schedule: nextFrame,
      draw: (bitmap) => {
        drawFrame(node, bitmap)
        drawn.current = { width: bitmap.width, height: bitmap.height }
      },
    })
    void readFrames({
      open: signal => openFrames(streaming, signal),
      onRecord: (record) => { presenter.push(record) },
      signal: lifetime.signal,
    })
    return () => {
      lifetime.abort()
      presenter.dispose()
    }
  }, [streaming, openFrames])

  useEffect(() => {
    if (streaming === undefined) return
    return bindGameInput({
      element: host.current!,
      canvas: canvas.current!,
      target: () => inputTarget(latest.current, drawn.current),
      send: events => input(streaming, events),
      schedule: nextFrame,
      captureKeyboard,
    })
  }, [streaming, input, captureKeyboard])

  useEffect(() => {
    if (mouseMode !== MOUSE_MODE_CAPTURED && document.pointerLockElement === canvas.current) document.exitPointerLock()
  }, [mouseMode])

  return (
    <div ref={host} className={css.viewport} tabIndex={0} role="application" aria-label={t('viewport.label')}
      aria-describedby={live ? releaseId : undefined}
      data-focused={focused || undefined} onFocus={() => { setFocused(true) }} onBlur={() => { setFocused(false) }}>
      <canvas ref={canvas} className={css.canvas} />
      {live && <span id={releaseId} className={css.visuallyHidden}>{t('viewport.release')}</span>}
      {live && !focused && <span className={css.hint}>{t('viewport.hint')}</span>}
      {live && focused && <span className={css.hint} data-transient="" aria-hidden="true">{t('viewport.release')}</span>}
    </div>
  )
}
/* oxlint-enable typescript/no-non-null-assertion */

function LogDrawer({ run, logs, open, onToggle, t }: {
  readonly run: GodotRunView | null
  readonly logs: readonly GodotLogEntry[]
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: Translate
}): ReactNode {
  const errors = run?.errorCount ?? 0
  const warnings = run?.warningCount ?? 0
  return (
    <section className={css.drawer}>
      <button type="button" className={css.drawerHeader} aria-expanded={open} onClick={onToggle}>
        <span className={css.drawerTitle}>{t('logs.title')}</span>
        <span className={css.count} data-tone="error" data-active={errors > 0 || undefined} role="img" aria-label={t('logs.errors', { count: errors })}>
          <IconCloseCircleFillRegular size={12} />
          <span aria-hidden="true">{errors}</span>
        </span>
        <span className={css.count} data-tone="warning" data-active={warnings > 0 || undefined} role="img"
          aria-label={t('logs.warnings', { count: warnings })}>
          <IconWarningTriangleOutlineRegular size={12} />
          <span aria-hidden="true">{warnings}</span>
        </span>
        {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronUpOutlineRegular size={14} />}
      </button>
      {open && (logs.length === 0
        ? <p className={css.logEmpty}>{t('logs.empty')}</p>
        : <ol className={css.logList}>{logs.toReversed().map(entry => <LogRow key={entry.seq} entry={entry} />)}</ol>)}
    </section>
  )
}

function LogRow({ entry }: { readonly entry: GodotLogEntry }): ReactNode {
  return (
    <li className={css.logRow} data-level={entry.level}>
      <span className={css.logMessage}>{entry.message}</span>
      {entry.file !== undefined && (
        <span className={css.logLocation}>{entry.line === undefined ? entry.file : `${entry.file}:${String(entry.line)}`}</span>
      )}
    </li>
  )
}
