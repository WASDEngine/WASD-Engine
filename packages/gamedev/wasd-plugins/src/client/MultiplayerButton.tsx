/**
 * The Multiplayer button of a game project's Session, in the Session header after Release and Add-ons. Its dialog shows
 * how the project goes online: before setup, the two ways with what each costs; player-hosted, that it is free; with a
 * dedicated server, the game's servers with their state, players, and bandwidth, and a link to the site's servers
 * page. Its buttons ask the Session's agent to set multiplayer up, test it, or offer the server sizes, so the user
 * chooses and confirms in the conversation; the dialog itself changes nothing. It shows only for a Session of a game
 * project whose Peer may prompt it.
 */
import { useState } from 'react'
import { Button, IconLoadingOutlineRegular, IconUsersOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WasdMultiplayerView, WasdServerSummary } from '../types.ts'
import type { NS, WasdPluginsUiKey } from './locales.ts'
import css from './MultiplayerButton.module.css'

/** What a dialog button asks the Session's agent to do. */
export type MultiplayerRequest = 'setup' | 'test' | 'server'

/** Registration-side operations of the Multiplayer button. */
export interface MultiplayerButtonInjected {
  /**
   * Read a project's multiplayer.
   * @param projectDir - absolute game project folder.
   * @returns the project's view, or the reason it could not be read.
   */
  readonly readMultiplayer: (projectDir: string) => Promise<{ readonly view: WasdMultiplayerView } | { readonly error: string }>
  /**
   * Ask the Session's agent for a multiplayer step.
   * @param sessionId - the Session.
   * @param request - the step.
   * @returns undefined once the prompt is queued, else why it was not.
   */
  readonly ask: (sessionId: SessionId, request: MultiplayerRequest) => Promise<string | undefined>
}

/** Props of {@link MultiplayerButton}. */
export type MultiplayerButtonProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<MultiplayerButtonInjected>

type Loaded = { readonly state: 'loading' } | { readonly state: 'ready'; readonly view: WasdMultiplayerView } | { readonly state: 'failed'; readonly message: string }

/** The copy of each server state the site reports. */
const STATE_KEYS: Readonly<Record<string, WasdPluginsUiKey>> = {
  awaiting_confirmation: 'multiplayer.state.awaitingConfirmation',
  waiting_for_build: 'multiplayer.state.waitingForBuild',
  waiting_for_capacity: 'multiplayer.state.waitingForCapacity',
  starting: 'multiplayer.state.starting',
  running: 'multiplayer.state.running',
  sleeping: 'multiplayer.state.sleeping',
  stopped: 'multiplayer.state.stopped',
  stopped_bandwidth: 'multiplayer.state.stoppedBandwidth',
  suspended: 'multiplayer.state.suspended',
  crashed: 'multiplayer.state.crashed',
}

/**
 * Render the Multiplayer button and its dialog.
 * @param props - composed slot props.
 * @returns the button, or null when the Session has no game project or its Peer may not prompt it.
 */
export function MultiplayerButton({ sessionId, useWorkspaces, useAccess, t, readMultiplayer, ask }: MultiplayerButtonProps) {
  const projectDir = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const mayPrompt = useAccess('session/prompt')
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()
  if (projectDir === undefined || !mayPrompt) return null

  const show = (): void => {
    setOpen(true)
    setFailure(undefined)
    setLoaded({ state: 'loading' })
    void readMultiplayer(projectDir).then((result) => {
      setLoaded('view' in result ? { state: 'ready', view: result.view } : { state: 'failed', message: result.error })
    })
  }
  const close = (): void => {
    if (!sending) setOpen(false)
  }
  const request = async (step: MultiplayerRequest): Promise<void> => {
    setSending(true)
    setFailure(undefined)
    const refused = await ask(sessionId, step)
    setSending(false)
    if (refused !== undefined) {
      setFailure(t('multiplayer.failed', { message: refused }))
      return
    }
    setOpen(false)
  }
  const view = loaded.state === 'ready' ? loaded.view : undefined
  const notGodot = view !== undefined && !view.godot
  const stateLabel = (server: WasdServerSummary): string => {
    const key = STATE_KEYS[server.state]
    return key === undefined ? server.state : t(key)
  }
  // Players only count on a running server; elsewhere the site always reports 0.
  const serverLine = (server: WasdServerSummary): string => [
    server.size,
    stateLabel(server),
    ...server.state === 'running' ? [t('multiplayer.players', { players: server.players })] : [],
    ...server.bandwidthPercent === undefined ? [] : [t('multiplayer.bandwidth', { percent: server.bandwidthPercent })],
  ].join(' · ')

  return (
    <>
      <button type="button" className={css.trigger} onClick={show} title={t('multiplayer.tooltip')}>
        <IconUsersOutlineRegular size={14} className={css.icon} />
        {t('multiplayer.button')}
      </button>
      <Modal
        open={open}
        onClose={close}
        className={css.dialog ?? ''}
        title={t('multiplayer.title')}
        closeLabel={t('multiplayer.close')}
        description={t('multiplayer.description')}
        footer={(
          <div className={css.footer}>
            <Button variant="ghost" onClick={close} disabled={sending}>{t('multiplayer.close')}</Button>
            {view?.mode !== undefined && (
              <Button variant="outline" onClick={() => { void request('test') }} disabled={sending}>{t('multiplayer.test')}</Button>
            )}
            {view?.mode === 'dedicated' && (
              <Button variant="primary" onClick={() => { void request('server') }} disabled={sending}>{t('multiplayer.addServer')}</Button>
            )}
            {view !== undefined && view.mode === undefined && !notGodot && (
              <Button
                variant="primary"
                onClick={() => { void request('setup') }}
                disabled={sending}
                icon={sending ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : undefined}
              >
                {t('multiplayer.setup')}
              </Button>
            )}
          </div>
        )}
      >
        <div className={css.body}>
          {loaded.state === 'loading' && <p className={css.status}><IconLoadingOutlineRegular size={14} className={css.spinner} /></p>}
          {loaded.state === 'failed' && <p className={css.warning}>{t('multiplayer.loadFailed', { message: loaded.message })}</p>}
          {notGodot && <p className={css.warning}>{t('multiplayer.notGodot')}</p>}
          {view !== undefined && !notGodot && view.mode === undefined && (
            <div className={css.modes}>
              <section className={css.mode}>
                <h3 className={css.modeTitle}>{t('multiplayer.hostedTitle')}</h3>
                <p className={css.modeBody}>{t('multiplayer.hostedBody')}</p>
              </section>
              <section className={css.mode}>
                <h3 className={css.modeTitle}>{t('multiplayer.dedicatedTitle')}</h3>
                <p className={css.modeBody}>{t('multiplayer.dedicatedBody')}</p>
              </section>
            </div>
          )}
          {view?.mode === 'player_hosted' && <p className={css.status}>{t('multiplayer.hostedCurrent')}</p>}
          {view?.mode === 'dedicated' && (
            <>
              <p className={css.status}>{t('multiplayer.dedicatedCurrent')}</p>
              <h3 className={css.modeTitle}>{t('multiplayer.servers')}</h3>
              {view.servers.length === 0 && view.error === undefined && <p className={css.status}>{t('multiplayer.noServers')}</p>}
              {view.servers.length > 0 && (
                <ul className={css.servers}>
                  {view.servers.map(server => (
                    <li key={server.id} className={css.server}>
                      <span className={css.serverName}>{server.name}</span>
                      <span className={css.serverMeta}>{serverLine(server)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {view.error !== undefined && <p className={css.warning}>{t('multiplayer.serversFailed', { message: view.error })}</p>}
              <p className={css.status}>
                <a href={view.serversUrl} target="_blank" rel="noreferrer noopener">{t('multiplayer.manage')}</a>
              </p>
            </>
          )}
          {failure !== undefined && <p className={css.warning} role="alert">{failure}</p>}
        </div>
      </Modal>
    </>
  )
}
