/**
 * The Export / Share button of a game project's Session: in the Session header after the agent preset label, and in
 * the New Session row before the branch controls while the Session is blank, since the header shows no actions until
 * the first prompt. It opens a dialog with three choices: share the game on WASD Engine's Explore page, share it with
 * a private link that stays off Explore, or export it for Windows and macOS on this computer. Sharing names the
 * project's last release and whether the choice changes who can find the game, takes optional release notes and the
 * desktop downloads to offer on the game's page, offers to release as a new game once the project has a game, and says
 * when the folder releases the same game as another folder, as a copy does. Each choice asks the Session's agent to do
 * the work, so the recording, the builds, and the upload run as a turn the user watches in the chat. The button shows
 * only for a Session of a game project whose Peer may prompt it.
 */
import { useId, useState } from 'react'
import {
  Button, Checkbox, IconDownloadOutlineRegular, IconGlobeOutlineRegular, IconLinkOutlineRegular, IconLoadingOutlineRegular,
  IconShareOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WasdDesktopPlatform, WasdProjectView, WasdVisibility } from '../types.ts'
import type { NS, WasdPluginsUiKey } from './locales.ts'
import css from './ExportShareButton.module.css'

/** Longest release notes the dialog takes; the release tool keeps at most 1000 characters. */
export const NOTES_LIMIT = 1000

/** The desktop platforms the dialog offers, in the order they build. */
export const DESKTOP_PLATFORMS: readonly WasdDesktopPlatform[] = ['windows', 'macos']

/**
 * Which game a share from the dialog goes to: `linked`, the project's game, or a new game for a project without one;
 * `same`, the project's game, chosen for a folder that shares it with another folder; `new`, a new game.
 */
export type ReleaseTarget = 'linked' | 'same' | 'new'

/** What the dialog asks the agent to share. */
export interface ShareRequest {
  /** Who can find the game from this version on. */
  readonly visibility: WasdVisibility
  /** Release notes; empty asks the agent to write them. */
  readonly notes: string
  /** Which game the release goes to. */
  readonly target: ReleaseTarget
  /** Desktop platforms to offer as downloads of this version, in build order. */
  readonly desktop: readonly WasdDesktopPlatform[]
}

/**
 * Where a button registration sits: `header` among the Session header actions, or `newSession` in the New Session
 * row, which shows the button only while the Session is blank, at the row's control height.
 */
export type ExportSharePlacement = 'header' | 'newSession'

/** Registration-side placement and operations of the Export / Share button. */
export interface ExportShareInjected {
  /** The registration's slot. */
  readonly placement: ExportSharePlacement
  /**
   * Read what a project released.
   * @param projectDir - absolute game project folder.
   * @returns the project's view, or the reason it could not be read.
   */
  readonly readProject: (projectDir: string) => Promise<{ readonly view: WasdProjectView } | { readonly error: string }>
  /**
   * Ask the Session's agent to share the game on WASD Engine.
   * @param sessionId - the Session.
   * @param request - visibility, notes, target game, and desktop downloads.
   * @returns undefined once the prompt is queued, else why it was not.
   */
  readonly startShare: (sessionId: SessionId, request: ShareRequest) => Promise<string | undefined>
  /**
   * Ask the Session's agent to export the game for desktop platforms.
   * @param sessionId - the Session.
   * @param platforms - the platforms, in build order.
   * @returns undefined once the prompt is queued, else why it was not.
   */
  readonly startExport: (sessionId: SessionId, platforms: readonly WasdDesktopPlatform[]) => Promise<string | undefined>
}

/** Props of {@link ExportShareButton}; the New Session options pass the same Session props as the header actions. */
export type ExportShareButtonProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<ExportShareInjected>

type Loaded = { readonly state: 'loading' } | { readonly state: 'ready'; readonly view: WasdProjectView } | { readonly state: 'failed'; readonly message: string }

/** The dialog's three choices. */
type Choice = 'explore' | 'private' | 'export'

/** One choice's icon, label, hint, and confirm button. */
interface ChoiceCopy {
  readonly choice: Choice
  readonly icon: typeof IconGlobeOutlineRegular
  readonly label: WasdPluginsUiKey
  readonly hint: WasdPluginsUiKey
  readonly confirm: WasdPluginsUiKey
}

/** The choices in the order the dialog lists them. */
const CHOICES: readonly ChoiceCopy[] = [
  { choice: 'explore', icon: IconGlobeOutlineRegular, label: 'share.explore', hint: 'share.exploreHint', confirm: 'share.confirmExplore' },
  { choice: 'private', icon: IconLinkOutlineRegular, label: 'share.private', hint: 'share.privateHint', confirm: 'share.confirmPrivate' },
  { choice: 'export', icon: IconDownloadOutlineRegular, label: 'share.export', hint: 'share.exportHint', confirm: 'share.confirmExport' },
]

const PLATFORM_LABELS: Readonly<Record<WasdDesktopPlatform, WasdPluginsUiKey>> = { windows: 'desktop.windows', macos: 'desktop.macos' }
const PLATFORM_HINTS: Readonly<Record<WasdDesktopPlatform, WasdPluginsUiKey>> = { windows: 'export.windowsHint', macos: 'export.macosHint' }

/**
 * A set of platforms with one switched.
 * @param platforms - the platforms.
 * @param platform - the platform to switch.
 * @param on - whether it is in the set afterwards.
 * @returns the platforms in build order.
 */
function toggled(platforms: readonly WasdDesktopPlatform[], platform: WasdDesktopPlatform, on: boolean): WasdDesktopPlatform[] {
  return DESKTOP_PLATFORMS.filter(item => item === platform ? on : platforms.includes(item))
}

/**
 * Render the Export / Share button and its dialog.
 * @param props - composed slot props.
 * @returns the button, or null when the Session has no game project, its Peer may not prompt it, or the New Session
 * row shows a Session that is no longer blank, whose header has the button.
 */
export function ExportShareButton({
  sessionId, useWorkspaces, useAccess, useSession, t, placement, readProject, startShare, startExport,
}: ExportShareButtonProps) {
  const projectDir = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const mayPrompt = useAccess('session/prompt')
  const blank = useSession(state => state.blank)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [choice, setChoice] = useState<Choice>('explore')
  const [notes, setNotes] = useState('')
  const [newGame, setNewGame] = useState(false)
  const [downloads, setDownloads] = useState<readonly WasdDesktopPlatform[]>([])
  const [platforms, setPlatforms] = useState<readonly WasdDesktopPlatform[]>(DESKTOP_PLATFORMS)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const id = useId()
  if (projectDir === undefined || !mayPrompt || (placement === 'newSession' && !blank)) return null

  const show = (): void => {
    setOpen(true)
    setFailure(undefined)
    setNewGame(false)
    setChoice('explore')
    setLoaded({ state: 'loading' })
    void readProject(projectDir).then((result) => {
      setLoaded('view' in result ? { state: 'ready', view: result.view } : { state: 'failed', message: result.error })
      // A private game's next share is private too unless the user picks Explore.
      if ('view' in result && result.view.game?.visibility === 'private') setChoice(current => current === 'explore' ? 'private' : current)
    })
  }
  const close = (): void => {
    if (!sending) setOpen(false)
  }
  const view = loaded.state === 'ready' ? loaded.view : undefined
  const game = view?.game
  const sharedWith = view?.sharedWith
  const notGodot = view !== undefined && !view.godot
  const sharing = choice !== 'export'
  const confirm = async (): Promise<void> => {
    setSending(true)
    setFailure(undefined)
    let refused: string | undefined
    if (sharing) {
      const target: ReleaseTarget = game === undefined ? 'linked' : newGame ? 'new' : sharedWith === undefined ? 'linked' : 'same'
      refused = await startShare(sessionId, { visibility: choice === 'private' ? 'private' : 'public', notes: notes.trim(), target, desktop: downloads })
    } else {
      refused = await startExport(sessionId, platforms)
    }
    setSending(false)
    if (refused !== undefined) {
      setFailure(t(sharing ? 'share.failed' : 'export.failed', { message: refused }))
      return
    }
    setNotes('')
    setOpen(false)
  }
  // Releasing to the project's game changes who can find it when the choice differs from the game's visibility.
  const change = game === undefined || newGame
    ? undefined
    : choice === 'private' && game.visibility === 'public' ? t('share.toPrivate', { title: game.title })
      : choice === 'explore' && game.visibility === 'private' ? t('share.toPublic', { title: game.title }) : undefined
  const confirmLabel = CHOICES.find(item => item.choice === choice)?.confirm ?? 'share.confirmExplore'
  const blocked = sending || notGodot || loaded.state === 'loading' || (choice === 'export' && platforms.length === 0)

  return (
    <>
      <button type="button" className={css.trigger} data-placement={placement} onClick={show} title={t('share.tooltip')}>
        <IconShareOutlineRegular size={14} className={css.icon} />
        {t('share.button')}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('share.title')}
        closeLabel={t('share.close')}
        description={t('share.description')}
        footer={(
          <div className={css.footer}>
            <Button variant="ghost" onClick={close} disabled={sending}>{t('share.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => { void confirm() }}
              disabled={blocked}
              icon={sending ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : undefined}
            >
              {t(confirmLabel)}
            </Button>
          </div>
        )}
      >
        <div className={css.body}>
          <div className={css.choices} role="radiogroup" aria-label={t('share.choice')}>
            {CHOICES.map(({ choice: value, icon: Icon, label, hint }) => (
              <label key={value} className={css.choice} data-selected={choice === value ? '' : undefined}>
                <input
                  type="radio"
                  name={`${id}-choice`}
                  className={css.radio}
                  value={value}
                  checked={choice === value}
                  disabled={sending}
                  aria-describedby={`${id}-${value}-hint`}
                  onChange={() => { setChoice(value) }}
                  {...value === 'explore' ? { 'data-modal-autofocus': true } : {}}
                />
                <Icon size={18} className={css.choiceIcon} />
                <span className={css.choiceText}>
                  <span className={css.choiceLabel}>{t(label)}</span>
                  <span id={`${id}-${value}-hint`} className={css.hint}>{t(hint)}</span>
                </span>
              </label>
            ))}
          </div>
          {loaded.state === 'loading' && <p className={css.status}><IconLoadingOutlineRegular size={14} className={css.spinner} /></p>}
          {loaded.state === 'failed' && <p className={css.warning}>{t('share.loadFailed', { message: loaded.message })}</p>}
          {notGodot && <p className={css.warning}>{t('share.notGodot')}</p>}
          {sharing && game !== undefined && (
            <p className={css.status}>
              {t('share.latest', { version: game.version })}
              {' · '}
              {t(game.visibility === 'private' ? 'share.isPrivate' : 'share.onExplore')}
              {' · '}
              <a href={game.url} target="_blank" rel="noreferrer noopener">{t('share.open')}</a>
            </p>
          )}
          {sharing && change !== undefined && <p className={css.notice}>{change}</p>}
          {sharing && game !== undefined && sharedWith !== undefined && <p className={css.warning}>{t('share.copy', { folder: sharedWith })}</p>}
          {sharing && (
            <>
              <div className={css.field}>
                <label className={css.label} htmlFor={`${id}-notes`}>{t('share.notes')}</label>
                <textarea
                  id={`${id}-notes`}
                  aria-describedby={`${id}-notes-hint`}
                  className={css.notes}
                  value={notes}
                  maxLength={NOTES_LIMIT}
                  rows={3}
                  placeholder={t('share.notesPlaceholder')}
                  onChange={(event) => { setNotes(event.currentTarget.value) }}
                  disabled={sending || notGodot}
                />
                <span id={`${id}-notes-hint`} className={css.hint}>{t('share.notesHint')}</span>
              </div>
              <fieldset className={css.field}>
                <legend className={css.label}>{t('share.downloads')}</legend>
                <div className={css.platforms}>
                  {DESKTOP_PLATFORMS.map(platform => (
                    <Checkbox
                      key={platform}
                      checked={downloads.includes(platform)}
                      onChange={(on) => { setDownloads(current => toggled(current, platform, on)) }}
                      label={t(PLATFORM_LABELS[platform])}
                      disabled={sending || notGodot}
                    />
                  ))}
                </div>
                <span className={css.hint}>{t('share.downloadsHint')}</span>
              </fieldset>
              {game !== undefined && (
                <div className={css.field}>
                  <Checkbox checked={newGame} onChange={setNewGame} label={t('share.newGame')} disabled={sending || notGodot} />
                  <span className={css.hint}>{t('share.newGameHint', { title: game.title })}</span>
                </div>
              )}
            </>
          )}
          {!sharing && (
            <fieldset className={css.field}>
              <legend className={css.label}>{t('export.platforms')}</legend>
              <div className={css.platformList}>
                {DESKTOP_PLATFORMS.map(platform => (
                  <div key={platform} className={css.platformRow}>
                    <Checkbox
                      checked={platforms.includes(platform)}
                      onChange={(on) => { setPlatforms(current => toggled(current, platform, on)) }}
                      label={t(PLATFORM_LABELS[platform])}
                      disabled={sending || notGodot}
                    />
                    <span className={css.hint}>{t(PLATFORM_HINTS[platform])}</span>
                  </div>
                ))}
              </div>
              <span className={css.hint}>{t('export.where')}</span>
            </fieldset>
          )}
          {failure !== undefined && <p className={css.warning} role="alert">{failure}</p>}
        </div>
      </Modal>
    </>
  )
}
