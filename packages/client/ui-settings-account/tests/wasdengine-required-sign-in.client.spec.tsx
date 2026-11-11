// @vitest-environment jsdom
/**
 * WASD Engine's required sign-in (fork-owned drift spec; `wasdengine/FORK.md` lists the fork changes): with
 * `signInRequired`, the sign-in dialogs offer no way to close them, Cancel only ends the browser attempt, and losing
 * the sign-in reopens the Get started dialog through the onboarding coordinator, in any view. Without it, the dialogs
 * keep upstream's close button.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountMenu } from '../src/client/AccountMenu.tsx'
import { AccountOnboarding } from '../src/client/AccountOnboarding.tsx'
import type { AccountSectionInjected, AccountSnapshot } from '../src/client/AccountSection.tsx'
import { SignInDialog } from '../src/client/SignInDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const id = 'login-attempt' as SignInAttemptId
const links = { usageUrl: '', topUpUrl: '' }
const t = makeTranslate(en)
const theme: ThemeSnapshot = {
  preference: 'dark', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'dark', colorScheme: 'dark', tokens: {} }, themes: [], revision: 0,
}

function signedOut(attempt: AccountView['attempt'] = null): AccountSnapshot {
  return { view: { status: 'signed-out', attempt, links }, details: undefined, avatar: undefined, failed: false }
}

function dialog(attempt: AccountView['attempt'], required: boolean) {
  const props = { start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), close: vi.fn() }
  render(<SignInDialog account={signedOut(attempt)} colorScheme="dark" t={t} required={required} {...props} />)
  return props
}

it('offers sign-in alone, with no close button, and stays open on Escape and a click outside', () => {
  const props = dialog(null, true)
  expect(screen.queryByRole('button', { name: en.close })).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([en.signIn])
  fireEvent.keyDown(document, { key: 'Escape' })
  const mask = document.querySelector('[role="presentation"] > [aria-hidden="true"]')
  expect(mask).not.toBeNull()
  fireEvent.click(mask!)
  expect(props.close).not.toHaveBeenCalled()
})

it('ends a browser attempt on Cancel and Escape without closing', async () => {
  const props = dialog({ id, phase: 'waiting-browser', authorizeUrl: 'https://app.example/dsh/authorize?state=example' }, true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })
  expect(props.cancel).toHaveBeenCalledExactlyOnceWith(id)
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
  expect(props.cancel).toHaveBeenCalledTimes(2)
  expect(props.close).not.toHaveBeenCalled()
})

it('keeps upstream\'s close button when sign-in is optional', () => {
  const props = dialog(null, false)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.close).toHaveBeenCalledOnce()
})

function onboardingProps(account: () => AccountSnapshot, signInRequired: boolean) {
  const unused = (): never => { throw new Error('AccountOnboarding does not consume global hooks') }
  const globals: GlobalStandardProps = {
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
  }
  return {
    ...globals, signInRequired, apiKeyEntry: false,
    hasRunningAccountTasks: vi.fn(async () => false),
    complete: vi.fn(), useApiKey: vi.fn(), setOnboarding: vi.fn(), showLogin: vi.fn(),
    useAccount: <T,>(select: (snapshot: AccountSnapshot) => T) => select(account()),
    useTheme: <T,>(select: (snapshot: ThemeSnapshot) => T) => select(theme),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    contactUs: vi.fn(), t, refreshAccount: vi.fn(async () => {}),
    avatarFailed: vi.fn(),
  }
}

it('keeps the Get started step until the sign-in is stored', () => {
  let account = signedOut()
  const props = onboardingProps(() => account, true)
  const view = render(<AccountOnboarding {...props} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.close })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(props.complete).not.toHaveBeenCalled()
  account = { ...account, view: { status: 'credential-stored', attempt: null, links } }
  view.rerender(<AccountOnboarding {...props} />)
  expect(props.complete).toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

function menu(signInRequired: boolean | undefined) {
  let account: AccountSnapshot = { view: undefined, details: undefined, avatar: undefined, failed: false }
  const openOnboarding = vi.fn<(id: string) => void>()
  const operations: AccountSectionInjected = {
    ...signInRequired === undefined ? {} : { signInRequired },
    hooks: {
      account: { getSnapshot: () => account, subscribe: () => () => {} },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} },
    },
    hasRunningAccountTasks: vi.fn(async () => false), contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    refreshAccount: vi.fn(async () => {}), avatarFailed: vi.fn(),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
  }
  const element = () => <AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false} wide
    useAccount={select => select(account)} useTheme={select => select(theme)}
    openOnboarding={openOnboarding} openSettings={() => {}} t={t} />
  const view = render(element())
  return {
    openOnboarding,
    set: (status: AccountView['status'] | undefined) => {
      account = { ...account, view: status === undefined ? undefined : { status, attempt: null, links } }
      view.rerender(element())
    },
  }
}

it('reopens Get started when the sign-in is lost, also across a reconnection, and not on first use', () => {
  const { openOnboarding, set } = menu(true)
  // First use: the onboarding coordinator shows Get started on its own.
  set('signed-out')
  expect(openOnboarding).not.toHaveBeenCalled()
  set('credential-stored')
  set('signed-out')
  expect(openOnboarding).toHaveBeenCalledExactlyOnceWith('deepseek-official')
  set('signed-out')
  expect(openOnboarding).toHaveBeenCalledOnce()
  set('credential-stored')
  set(undefined)
  set('signed-out')
  expect(openOnboarding).toHaveBeenCalledTimes(2)
})

it('leaves upstream\'s menu alone when sign-in is optional', () => {
  for (const required of [false, undefined]) {
    const { openOnboarding, set } = menu(required)
    set('credential-stored')
    set('signed-out')
    expect(openOnboarding).not.toHaveBeenCalled()
    cleanup()
  }
})
