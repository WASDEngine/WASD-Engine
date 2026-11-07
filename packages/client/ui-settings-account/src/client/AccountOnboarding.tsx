/** Account choice inside the model credential onboarding step. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import type {} from './wasdengine-sign-in-alternative.ts'

/** @param props - onboarding completion, account state and actions. @returns account dialog while signed out. */
export function AccountOnboarding({
  complete, useApiKey, apiKeyEntry, useAccount, useTheme, setOnboarding, showLogin, start, cancel, renderSlot, t,
}:
  PropsRuntime<'settings.models.sign-in'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>
  & Partial<PropsRenderSlots<'settings.account.onboarding.alternative'>>) {
  const account = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  useEffect(() => { setOnboarding(true); return () => { setOnboarding(false) } }, [setOnboarding])
  useEffect(() => { if (account.view?.status === 'credential-stored') complete() }, [account.view?.status, complete])
  if (!account.view || account.view.status === 'credential-stored') return null
  return <SignInDialog account={account} colorScheme={colorScheme} start={start} cancel={cancel} t={t}
    close={() => { showLogin(false); complete() }}
    useApiKey={apiKeyEntry === false ? undefined : () => { showLogin(false); useApiKey() }}
    renderAlternative={renderSlot && (owner => renderSlot('settings.account.onboarding.alternative', owner))} />
}
