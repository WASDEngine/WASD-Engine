/**
 * WASD Engine game projects (fork-owned; `wasdengine/FORK.md` lists the fork changes): the
 * Create game project dialog. While the Host serves the `gameProject` Remote, the dialog
 * replaces Add workspace: the sidebar button, the add shortcut, and the hero picker's add
 * entry open it, and it opens by itself, with no way to dismiss it, while the Host's first
 * use waits for a game project and none is registered. It creates the project folder on the
 * Host, adopts it as a Workspace, and opens a new Session in it; Open existing folder hands
 * over to the sidebar's directory flow. While the forge bundle is installed and off, it
 * offers to turn the bundle on, so that a new Session in a project that already has Sessions
 * starts in its own worktree.
 */
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GameProjectDefaults } from '@deepseek-ai/dsh-api-workspace-controller/types'
// Type-only: pulls the generated `gameProject` and `pluginManager` Remote namespaces.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Checkbox, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StartSessionOptions } from '../navigation.ts'
import type { WorkspaceShortcutState } from '../shortcuts.ts'
import { de, en, es, fr, ja, pt, ru, zh, type GameProjectKey } from './locales.ts'
import css from './game-project.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Create game project dialog. */
    gameProject: GameProjectKey
  }
}

/** Dictionary namespace of the dialog. */
const NS = 'gameProject'

/** The bundle whose New Session option starts a Session in its own worktree. */
export const WORKTREE_BUNDLE = '@deepseek-ai/dsh-experimental-forge-bundle'

/** What the Host answered about game projects: `off` when it does not serve them. */
export type GameProjectHost =
  | { readonly status: 'pending' }
  | { readonly status: 'off' }
  | ({ readonly status: 'on' } & GameProjectDefaults)

/** Whether the dialog offers worktrees: `offer` while the forge bundle is installed and off. */
export type WorktreeOffer = 'offer' | 'on' | 'unavailable'

/** State the openers and the dialog share. */
export interface GameProjectState {
  readonly host: GameProjectHost
  /** Whether a user action asked for the dialog. */
  readonly requested: boolean
  readonly worktrees: WorktreeOffer
}

/** Outcome of one creation attempt; a failure carries the Host's error code and message. */
export type GameProjectOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Business face of the dialog. */
export interface GameProjectDialogInjected {
  hooks: {
    /** Host answer, open request, and worktree offer. */
    gameProjects: HostObservable<GameProjectState>
    /** The sidebar's directory flow requests, which hide the dialog while a folder is picked. */
    workspaceShortcuts: HostObservable<WorkspaceShortcutState>
    /** Whether a directory flow occupies the sidebar, which Open existing folder needs. */
    directoryFlow: HostObservable<boolean>
  }
  /**
   * Create, adopt, and open a game project, then turn worktrees on when asked.
   * @param name - folder name.
   * @param directory - parent folder.
   * @param worktrees - whether to turn the forge bundle on afterwards.
   * @returns the outcome; never rejects.
   */
  createGameProject: (name: string, directory: string, worktrees: boolean) => Promise<GameProjectOutcome>
  /** Close the dialog and open the sidebar's directory flow. */
  openExistingFolder: () => void
  /** Close a dialog a user action opened. */
  settleGameProject: () => void
}

/** Props of the dialog entry in `shell.overlay`. */
export type GameProjectDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & Omit<GameProjectDialogInjected, 'hooks'>
  & PropsHooks<GameProjectDialogInjected['hooks']>

/** Services and requests the dialog builds on. */
export interface GameProjectDependencies {
  readonly workspaces: Pick<IWorkspaces, 'create'>
  readonly startSession: (workspaceId: WorkspaceId, options: StartSessionOptions) => void
  readonly shortcuts: { readonly state: HostObservable<WorkspaceShortcutState>; readonly add: () => void }
  readonly directoryFlow: HostObservable<boolean>
}

/** Openers of the dialog. */
export interface GameProjectControls {
  /**
   * Open the dialog while the Host serves game projects.
   * @returns whether it opened; the caller falls back to Add workspace otherwise.
   */
  readonly request: () => boolean
}

/**
 * Register the dictionaries, and, while the composition serves the `gameProject` Remote,
 * the dialog; ask the Host whether it serves game projects then and after every
 * reconnection. The worktree option needs the `pluginManager` Remote as well.
 * @param ctx - ui-workspace plugin context.
 * @param dependencies - Workspace adoption, navigation, and the sidebar's directory flow.
 * @returns the dialog's opener.
 */
export function applyGameProjects(ctx: Context, dependencies: GameProjectDependencies): GameProjectControls {
  const state = createSnapshotStore<GameProjectState>({ host: { status: 'pending' }, requested: false, worktrees: 'unavailable' })
  const update = (change: Partial<GameProjectState>): void => { state.set({ ...state.getSnapshot(), ...change }) }
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-workspace: game project dictionaries')

  /** The plugin manager while the composition serves it. */
  let plugins: Context['remote']['pluginManager'] | undefined
  ctx.inject(['remote.pluginManager'], (inner) => {
    plugins = inner.remote.pluginManager
    inner.effect(() => () => { plugins = undefined }, 'ui-workspace: game project plugin manager')
  })
  const readWorktreeOffer = (): void => {
    if (plugins === undefined) {
      update({ worktrees: 'unavailable' })
      return
    }
    plugins.listBundles().then((result) => {
      const bundle = result.ok ? result.value.find(entry => entry.name === WORKTREE_BUNDLE) : undefined
      update({ worktrees: bundle === undefined ? 'unavailable' : bundle.enabled ? 'on' : 'offer' })
    }, (reason: unknown) => {
      // Without a plugin list the dialog has no worktree option to offer.
      console.warn('game project: plugin list unavailable:', reason)
      update({ worktrees: 'unavailable' })
    })
  }
  const enableWorktrees = (): void => {
    plugins?.setBundleEnabled(WORKTREE_BUNDLE, true).then((result) => {
      if (result.ok && result.value.application !== 'failed') update({ worktrees: 'on' })
      else console.warn('game project: worktrees were not turned on:', result.ok ? result.value.error : result.error)
    }, (reason: unknown) => { console.warn('game project: worktrees were not turned on:', reason) })
  }
  const settle = (): void => { update({ requested: false }) }

  ctx.inject(['remote.gameProject', 'slots'], (inner) => {
    const remote = inner.remote.gameProject
    let generation = 0
    const readHost = (): void => {
      const current = ++generation
      remote.defaults().then((result) => {
        if (current !== generation) return
        update({ host: result.ok ? { status: 'on', ...result.value } : { status: 'off' } })
        if (result.ok && result.value.required) readWorktreeOffer()
      }, (_reason: unknown) => {
        // A Host without game projects keeps Add workspace as upstream ships it.
        if (current === generation) update({ host: { status: 'off' } })
      })
    }
    readHost()
    inner.on('connection/reset', readHost)
    inner.effect(() => () => {
      generation += 1
      update({ host: { status: 'pending' }, requested: false })
    }, 'ui-workspace: game project Host answer')

    const createGameProject = async (name: string, directory: string, worktrees: boolean): Promise<GameProjectOutcome> => {
      try {
        const created = await remote.create({ name, directory })
        if (!created.ok) return { ok: false, code: created.error.code, message: created.error.message }
        // Adoption is idempotent and merges the row into the Client list that navigation reads.
        const workspace = await dependencies.workspaces.create({ path: created.value.workspace.path })
        settle()
        dependencies.startSession(workspace.workspaceId, { clearPreviousDraft: false })
      } catch (error: unknown) {
        return { ok: false, code: 'gameProject/create-failed', message: error instanceof Error ? error.message : String(error) }
      }
      if (worktrees) enableWorktrees()
      return { ok: true }
    }
    const injected = (): GameProjectDialogInjected => ({
      hooks: { gameProjects: state, workspaceShortcuts: dependencies.shortcuts.state, directoryFlow: dependencies.directoryFlow },
      createGameProject,
      openExistingFolder: () => {
        settle()
        dependencies.shortcuts.add()
      },
      settleGameProject: settle,
    })
    inner.slots.inject('shell.overlay', () => inner.slots.register({
      name: 'shell.overlay', id: 'workspace.game-project', locale: NS, inject: injected,
    }, GameProjectDialog))
  })
  return {
    request: () => {
      if (state.getSnapshot().host.status !== 'on') return false
      update({ requested: true })
      readWorktreeOffer()
      return true
    },
  }
}

/**
 * The `shell.overlay` entry: the dialog while a user action asked for it, or while first
 * use waits for a game project and none is registered; nothing while the sidebar's
 * directory flow picks a folder, for a Peer that may not create one, or while the Host does
 * not serve game projects.
 * @param props - shared state, the creation and hand-over callbacks, and the locale seat.
 * @returns the dialog, or null.
 */
export function GameProjectDialog({
  useGameProjects, useWorkspaceShortcuts, useDirectoryFlow, useWorkspaces, useRemoteAccess,
  createGameProject, openExistingFolder, settleGameProject, t,
}: GameProjectDialogProps) {
  const host = useGameProjects(state => state.host)
  const requested = useGameProjects(state => state.requested)
  const worktrees = useGameProjects(state => state.worktrees)
  const picking = useWorkspaceShortcuts(state => state.addRequested || state.directoryBusy)
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  const empty = useWorkspaces(state => state.phase === 'ready' && state.items.length === 0)
  const mayCreate = useRemoteAccess('gameProject/create')
  const mayAdopt = useRemoteAccess('workspace/create')
  if (host.status !== 'on' || !mayCreate || !mayAdopt) return null
  const required = host.required && empty
  if (picking || (!required && !requested)) return null
  return (
    <GameProjectForm
      required={required}
      suggested={host.directory}
      worktrees={worktrees}
      flowAvailable={flowAvailable}
      createGameProject={createGameProject}
      openExistingFolder={openExistingFolder}
      close={settleGameProject}
      t={t}
    />
  )
}

/** One opening of the dialog: the draft and the in-flight attempt live and die with it. */
function GameProjectForm({ required, suggested, worktrees, flowAvailable, createGameProject, openExistingFolder, close, t }: {
  required: boolean
  suggested: string | null
  worktrees: WorktreeOffer
  flowAvailable: boolean
  createGameProject: GameProjectDialogInjected['createGameProject']
  openExistingFolder: () => void
  close: () => void
  t: GameProjectDialogProps['t']
}) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState(suggested ?? '')
  const [isolate, setIsolate] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // IME composition: Enter that commits a composition must not submit.
  const composing = useRef(false)
  const trimmedName = name.trim()
  const trimmedDirectory = directory.trim()
  const blocked = creating || trimmedName === '' || trimmedDirectory === ''
  const title = required ? t('title.required') : t('title')
  const dismiss = (): void => {
    if (!required && !creating) close()
  }
  const submit = (): void => {
    if (blocked) return
    setCreating(true)
    setError(null)
    void createGameProject(trimmedName, trimmedDirectory, worktrees === 'offer' && isolate).then((outcome) => {
      // A created project closes the dialog through the project list or the settled request.
      if (outcome.ok) return
      setCreating(false)
      switch (outcome.code) {
        case 'gameProject/exists':
          setError(t('error.exists', { name: trimmedName }))
          break
        case 'gameProject/invalid-name':
          setError(t('error.invalidName'))
          break
        case 'gameProject/invalid-directory':
          setError(t('error.invalidDirectory'))
          break
        default:
          setError(t('error.failed', { message: outcome.message }))
      }
    })
  }
  const enter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !composing.current) {
      event.preventDefault()
      submit()
    }
  }
  return (
    <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        {!required && (
          <button type="button" className={css.close} aria-label={t('action.close')} disabled={creating} onClick={dismiss}>
            <IconCloseOutlineRegular size={14} />
          </button>
        )}
      </div>
      <div className={css.body}>
        <p className={css.description}>{t('description')}</p>
        <label className={css.field}>
          <span className={css.label}>{t('field.name')}</span>
          <input
            className={css.input}
            value={name}
            placeholder={t('placeholder.name')}
            data-modal-autofocus
            disabled={creating}
            onChange={(event) => { setName(event.target.value); setError(null) }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onKeyDown={enter}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('field.location')}</span>
          <input
            className={css.input}
            value={directory}
            spellCheck={false}
            disabled={creating}
            onChange={(event) => { setDirectory(event.target.value); setError(null) }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onKeyDown={enter}
          />
          <span className={css.hint}>{suggested === null ? t('hint.noLocation') : t('hint.location')}</span>
        </label>
        {worktrees === 'offer' && (
          <div className={css.option}>
            <Checkbox checked={isolate} disabled={creating} onChange={setIsolate} label={t('worktrees.label')} />
            <span className={css.hint}>{t('worktrees.hint')}</span>
          </div>
        )}
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </div>
      <div className={css.footer}>
        {flowAvailable && (
          <Button variant="ghost" className={css.secondary} disabled={creating} onClick={openExistingFolder}>
            {t('action.openExisting')}
          </Button>
        )}
        {!required && <Button variant="outline" disabled={creating} onClick={dismiss}>{t('action.cancel')}</Button>}
        <Button variant="primary" disabled={blocked} onClick={submit}>{creating ? t('action.creating') : t('action.create')}</Button>
      </div>
    </Modal>
  )
}
