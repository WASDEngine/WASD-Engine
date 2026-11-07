/**
 * The sign-in dialog's alternative: the offer to set WASD Engine up with another agent, and the panel with the
 * setup prompt to paste into that agent, its copy button, and whether an agent connected.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCheckOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { ServerSnapshot } from './source.ts'
import css from './AgentSetup.module.css'

/** How long the copy button says Copied, in milliseconds. */
const COPIED_MS = 2000

/** Registration-side dependencies of {@link AgentSetup}. */
export interface AgentSetupInjected {
  /** The followed server; the renderer binds it as `useServer`. */
  readonly hooks: { readonly server: HostObservable<ServerSnapshot> }
  /**
   * Put text on the clipboard.
   * @param text - the prompt.
   * @returns whether the host accepted the write.
   */
  readonly copyText: (text: string) => Promise<boolean>
}

/** Props of {@link AgentSetup}. */
export type AgentSetupProps = PropsRuntime<'settings.account.onboarding.alternative'> & PropsLocale<typeof NS> & InjectFace<AgentSetupInjected>

/** The status line under the prompt. */
function Status({ snapshot, t }: { snapshot: ServerSnapshot; t: AgentSetupProps['t'] }) {
  const view = snapshot.view
  if (snapshot.disconnected) return <p className={css.status} role="status">{t('status.disconnected')}</p>
  if (view === null || view.state === 'starting') {
    return <p className={css.status} role="status"><IconLoadingOutlineRegular className={css.spinner} size={14} />{t('status.starting')}</p>
  }
  if (view.state === 'failed') return <p className={css.status} data-failed="" role="status">{t('status.failed', { message: view.message ?? '' })}</p>
  const client = view.clients[0]
  if (client !== undefined) {
    return <p className={css.status} data-connected="" role="status"><IconCheckOutlineRegular size={14} />{t('status.connected', { name: client.title })}</p>
  }
  return <p className={css.status} role="status"><IconLoadingOutlineRegular className={css.spinner} size={14} />{t('status.waiting')}</p>
}

/**
 * Render the alternative as the dialog asks for it.
 * @param props - the dialog's view and actions, the followed server, and copy.
 * @returns the offer's button, or the setup panel.
 */
export function AgentSetup({ view, open, back, close, classNames, useServer, copyText, t }: AgentSetupProps) {
  const snapshot = useServer(value => value)
  const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null)
  const promptArea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => { setCopied(null) }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])
  if (view === 'offer') {
    return <Button variant="outline" className={classNames.secondaryButton} onClick={open}>{t('offer')}</Button>
  }
  const prompt = snapshot.view?.prompt
  const connected = snapshot.view?.state === 'listening' && snapshot.view.clients.length > 0
  const copy = (): void => {
    if (prompt === undefined) return
    void copyText(prompt).then((accepted) => {
      setCopied(accepted ? 'copied' : 'copyFailed')
      if (accepted) return
      // A host that refuses clipboard writes, such as an embedded browser, still copies a keyboard selection.
      promptArea.current?.focus()
      promptArea.current?.select()
    })
  }
  const copyButton = (variant: 'primary' | 'outline'): ReactNode => (
    <Button variant={variant} className={variant === 'primary' ? classNames.primaryButton : classNames.secondaryButton}
      disabled={prompt === undefined} onClick={copy}>
      {t(copied ?? 'copy')}
    </Button>
  )
  return <>
    <div className={`${classNames.content} ${css.panel}`}>
      <h2 className={classNames.title}>{t('title')}</h2>
      <p className={classNames.description}>{t('description')}</p>
      <textarea ref={promptArea} className={css.prompt} readOnly rows={8} value={prompt ?? ''} aria-label={t('prompt.label')}
        onFocus={(event) => { event.currentTarget.select() }} />
      <Status snapshot={snapshot} t={t} />
    </div>
    {/* The row stacks its children upward, so the first one sits at the bottom. */}
    <div className={classNames.actions}>
      {connected ? copyButton('outline') : <Button variant="outline" className={classNames.secondaryButton} onClick={back}>{t('back')}</Button>}
      {connected ? <Button variant="primary" className={classNames.primaryButton} onClick={close}>{t('done')}</Button> : copyButton('primary')}
    </div>
  </>
}
