/**
 * The Session header's Release button, after the agent preset label: it opens a dialog that names the project's last
 * release, takes optional release notes, and on Release asks the Session's agent to release the game, so the export
 * and upload run as a turn the user watches in the chat. It shows only for a Session of a game project whose Peer
 * may prompt it.
 */
import { useId, useState } from 'react'
import { Button, IconLoadingOutlineRegular, IconShareOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WasdProjectView } from '../types.ts'
import type { NS } from './locales.ts'
import css from './ReleaseButton.module.css'

/** Longest release notes the dialog takes; the release tool keeps at most 1000 characters. */
export const NOTES_LIMIT = 1000

/** Registration-side operations of the Release button. */
export interface ReleaseButtonInjected {
  /**
   * Read what a project released.
   * @param projectDir - absolute game project folder.
   * @returns the project's view, or the reason it could not be read.
   */
  readonly readProject: (projectDir: string) => Promise<{ readonly view: WasdProjectView } | { readonly error: string }>
  /**
   * Ask the Session's agent to release the game.
   * @param sessionId - the Session.
   * @param notes - release notes; empty asks the agent to write them.
   * @returns undefined once the prompt is queued, else why it was not.
   */
  readonly startRelease: (sessionId: SessionId, notes: string) => Promise<string | undefined>
}

/** Props of {@link ReleaseButton}. */
export type ReleaseButtonProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<ReleaseButtonInjected>

type Loaded = { readonly state: 'loading' } | { readonly state: 'ready'; readonly view: WasdProjectView } | { readonly state: 'failed'; readonly message: string }

/**
 * Render the Release button and its dialog.
 * @param props - composed slot props.
 * @returns the button, or null when the Session has no game project or its Peer may not prompt it.
 */
export function ReleaseButton({ sessionId, useWorkspaces, useAccess, t, readProject, startRelease }: ReleaseButtonProps) {
  const projectDir = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const mayPrompt = useAccess('session/prompt')
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const notesId = useId()
  if (projectDir === undefined || !mayPrompt) return null

  const show = (): void => {
    setOpen(true)
    setFailure(undefined)
    setLoaded({ state: 'loading' })
    void readProject(projectDir).then((result) => {
      setLoaded('view' in result ? { state: 'ready', view: result.view } : { state: 'failed', message: result.error })
    })
  }
  const close = (): void => {
    if (!sending) setOpen(false)
  }
  const release = async (): Promise<void> => {
    setSending(true)
    setFailure(undefined)
    const refused = await startRelease(sessionId, notes.trim())
    setSending(false)
    if (refused !== undefined) {
      setFailure(t('release.failed', { message: refused }))
      return
    }
    setNotes('')
    setOpen(false)
  }
  const notGodot = loaded.state === 'ready' && !loaded.view.godot
  const game = loaded.state === 'ready' ? loaded.view.game : undefined

  return (
    <>
      <button type="button" className={css.trigger} onClick={show} title={t('release.tooltip')}>
        <IconShareOutlineRegular size={14} className={css.icon} />
        {t('release.button')}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('release.title')}
        closeLabel={t('release.close')}
        description={t('release.description')}
        footer={(
          <div className={css.footer}>
            <Button variant="ghost" onClick={close} disabled={sending}>{t('release.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => { void release() }}
              disabled={sending || notGodot || loaded.state === 'loading'}
              icon={sending ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : undefined}
            >
              {t('release.confirm')}
            </Button>
          </div>
        )}
      >
        <div className={css.body}>
          {loaded.state === 'loading' && <p className={css.status}><IconLoadingOutlineRegular size={14} className={css.spinner} /></p>}
          {loaded.state === 'failed' && <p className={css.warning}>{t('release.loadFailed', { message: loaded.message })}</p>}
          {notGodot && <p className={css.warning}>{t('release.notGodot')}</p>}
          {game !== undefined && (
            <p className={css.status}>
              {t('release.latest', { version: game.version })}
              {' · '}
              <a href={game.url} target="_blank" rel="noreferrer noopener">{t('release.open')}</a>
            </p>
          )}
          <div className={css.field}>
            <label className={css.label} htmlFor={notesId}>{t('release.notes')}</label>
            <textarea
              id={notesId}
              aria-describedby={`${notesId}-hint`}
              className={css.notes}
              value={notes}
              maxLength={NOTES_LIMIT}
              rows={4}
              placeholder={t('release.notesPlaceholder')}
              onChange={(event) => { setNotes(event.currentTarget.value) }}
              disabled={sending || notGodot}
              data-modal-autofocus
            />
            <span id={`${notesId}-hint`} className={css.hint}>{t('release.notesHint')}</span>
          </div>
          {failure !== undefined && <p className={css.warning} role="alert">{failure}</p>}
        </div>
      </Modal>
    </>
  )
}
