/** Account authorization dialog; errors allow retry after cancelling any active attempt. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import { authorizeUrlWithTheme } from './authorize-url.ts'
// WASD Engine: the fork's sheet styles every class below in the look of the welcome window.
import css from './wasdengine-sign-in.module.css'
import { WasdengineSignInBrand } from './wasdengine-sign-in.tsx'
import type { SignInAlternativeOwner } from './wasdengine-sign-in-alternative.ts'

/** @param props - safe account state, localized copy, and user actions. @returns login dialog. */
export function SignInDialog({ account, colorScheme, start, cancel, close, useApiKey, renderAlternative, t }: {
  account: AccountSnapshot
  /** Resolved scheme of the active application theme; the copied link carries it. */
  colorScheme: 'light' | 'dark'
  start: () => Promise<void>
  cancel: (id: SignInAttemptId) => Promise<void>
  close: () => void
  /** Switch to API key entry; absent, the dialog offers sign-in only. */
  useApiKey?: (() => void) | undefined
  /** WASD Engine: render the dialog's sign-in alternative slot; absent, the dialog offers no alternative. */
  renderAlternative?: ((owner: SignInAlternativeOwner) => ReactNode) | undefined
  t: (key: AccountKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [alternative, setAlternative] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copyResult, setCopyResult] = useState<{ messageKey: 'copiedLink' | 'copyFailed' } | null>(null)
  const attempt = account.view?.attempt
  useEffect(() => { setCopyResult(null) }, [attempt?.id, attempt?.authorizeUrl])
  useEffect(() => {
    if (copyResult === null) return
    const timer = setTimeout(() => { setCopyResult(null) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyResult])
  const authorizeUrl = attempt?.authorizeUrl
  const phase = attempt?.phase
  const active = busy || phase === 'initializing' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
  const expired = phase === 'expired'
  const localFailure = failed || account.loginFailed || account.failed
  const error = localFailure || phase === 'failed'
  const failureKey = !localFailure
    && phase === 'failed' && attempt?.errorCode === 'no-response' ? 'noResponse' : 'failed'
  const waiting = active && !error
  const welcome = !active && !error && !expired
  const committing = phase === 'committing'
  useEffect(() => { if (account.view?.status === 'credential-stored') close() }, [account.view?.status, close])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const dismiss = () => {
    if (committing || busy) return
    if (active && attempt) void run(async () => { await cancel(attempt.id); close() })
    else close()
  }
  const retry = async () => {
    if (active && attempt) await cancel(attempt.id)
    await start()
  }
  const copyLink = async (authorizeUrl: string) => {
    try {
      await navigator.clipboard.writeText(authorizeUrlWithTheme(authorizeUrl, colorScheme))
      setCopyResult({ messageKey: 'copiedLink' })
    } catch { setCopyResult({ messageKey: 'copyFailed' }) }
  }
  const title = error ? t('failureTitle') : active ? t('browserTitle') : expired ? t('timeoutTitle') : t('loginTitle')
  const alternativeOwner = (view: SignInAlternativeOwner['view']): SignInAlternativeOwner => ({
    view, open: () => { setAlternative(true) }, back: () => { setAlternative(false) }, close: dismiss,
    classNames: {
      content: css.content as string, title: css.title as string, description: css.description as string,
      actions: css.actions as string, primaryButton: css.primaryButton as string, secondaryButton: css.secondaryButton as string,
    },
  })
  if (alternative && welcome && renderAlternative !== undefined) {
    return <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
      <div className={css.content}>
        <WasdengineSignInBrand welcome={false} t={t} />
        <button type="button" className={css.close} aria-label={t('close')} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      {renderAlternative(alternativeOwner('panel'))}
    </Modal>
  }
  return <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
    <div className={css.content} data-welcome={welcome || undefined}>
      <WasdengineSignInBrand welcome={welcome} t={t} />
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        <button type="button" className={css.close} aria-label={t('close')} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      {waiting ? <p className={css.description}>
        {t('browserPrompt')}<button type="button" className={css.link} disabled={!authorizeUrl}
          onClick={authorizeUrl ? () => { void copyLink(authorizeUrl) } : undefined}>
          {t(copyResult?.messageKey ?? 'copyLink')}
        </button>{t('browserDescription')}
      </p> : <p className={css.description}>
        {error ? t(failureKey) : expired ? t('timeoutDescription') : t('loginDescription')}
      </p>}
    </div>
    <div className={css.actions}>
      {welcome && renderAlternative !== undefined ? renderAlternative(alternativeOwner('offer')) : null}
      {active || useApiKey !== undefined ? <Button variant="outline" className={css.secondaryButton} disabled={committing || busy}
        onClick={active ? dismiss : useApiKey}>{t(active ? 'cancel' : 'addApiKey')}</Button> : null}
      <Button variant="primary" className={css.primaryButton} disabled={busy || committing || waiting || account.view === undefined}
        aria-label={waiting ? t('waiting') : undefined} onClick={() => { void run(retry) }}>
        {waiting ? <IconLoadingOutlineRegular className={css.spinner} /> : t(expired || error ? 'retry' : 'signIn')}
      </Button>
    </div>
  </Modal>
}
