// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the sign-in dialog's look: the dialog draws the brand kit lockup of the Desktop
 * welcome window, welcomes with the WASD Engine tagline while it offers sign-in, keeps its state titles otherwise,
 * takes every class it uses from the fork's stylesheet, and offers sign-in only when no API key entry is given.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { afterEach, expect, it, vi } from 'vitest'
import { SignInDialog } from '../src/client/SignInDialog.tsx'
import { en, type AccountKey } from '../src/client/locales.ts'
import { brandAccountDictionaries } from '../src/client/wasdengine-copy.ts'
import { WasdengineLockup } from '../src/client/wasdengine-sign-in.tsx'

afterEach(cleanup)

const copy = brandAccountDictionaries({ en }).en
const t = (key: AccountKey): string => copy[key]
const links = { usageUrl: '', topUpUrl: '' }
// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const read = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')

function dialog(view: AccountView, offerApiKey = true) {
  return render(<SignInDialog
    account={{ view, details: undefined, avatar: undefined, failed: false }}
    colorScheme="dark" start={vi.fn(async () => {})} cancel={vi.fn(async () => {})} close={vi.fn()} useApiKey={offerApiKey ? vi.fn() : undefined} t={t}
  />)
}

it('welcomes with the WASD Engine logo and tagline above the sign-in and API key buttons', () => {
  dialog({ status: 'signed-out', attempt: null, links })
  expect(document.querySelector('[data-welcome] svg[viewBox="0 0 1064.31 105.88"]')).not.toBeNull()
  expect(screen.getByText(copy.onboardingWelcome, { exact: false }).textContent).toBe('Welcome to WASD Engine')
  expect(screen.getByText('Build games with an agent at the keys.')).toBeTruthy()
  expect(screen.getByRole('dialog', { name: copy.loginTitle })).toBeTruthy()
  expect(screen.getByRole('button', { name: copy.signIn })).toBeTruthy()
  expect(screen.getByRole('button', { name: copy.addApiKey })).toBeTruthy()
})

it('keeps the logo and shows the state title while the browser sign-in runs', () => {
  const attempt = { id: 'attempt', phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' }
  dialog({ status: 'signed-out', attempt, links } as AccountView)
  expect(document.querySelector('[data-welcome]')).toBeNull()
  expect(document.querySelector('svg[viewBox="0 0 1064.31 105.88"]')).not.toBeNull()
  expect(screen.queryByText('Build games with an agent at the keys.')).toBeNull()
  expect(screen.getByRole('heading', { name: copy.browserTitle })).toBeTruthy()
})

it('offers sign-in only without API key entry, and still cancels a running sign-in', () => {
  dialog({ status: 'signed-out', attempt: null, links }, false)
  expect(screen.getAllByRole('button').map(button => button.textContent || button.getAttribute('aria-label')))
    .toEqual([copy.close, copy.signIn])
  cleanup()
  const attempt = { id: 'attempt', phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' }
  dialog({ status: 'signed-out', attempt, links } as AccountView, false)
  expect(screen.getByRole('button', { name: copy.cancel })).toBeTruthy()
  expect(screen.queryByRole('button', { name: copy.addApiKey })).toBeNull()
})

it('takes every class of the dialog from the fork stylesheet', () => {
  const source = read('../src/client/SignInDialog.tsx')
  expect(source).toContain("import css from './wasdengine-sign-in.module.css'\n")
  expect(source).toContain('<WasdengineSignInBrand welcome={welcome} t={t} />')
  const sheet = read('../src/client/wasdengine-sign-in.module.css')
  const used = new Set([...source.matchAll(/\bcss\.(\w+)/gu)].map(match => match[1]!))
  expect(used.size).toBeGreaterThan(5)
  for (const name of used) expect(sheet, name).toMatch(new RegExp(`\\.${name}\\b`, 'u'))
})

it('draws the lockup of the Desktop welcome window, with the wordmark in the text color', () => {
  const { container } = render(<WasdengineLockup />)
  const welcome = read('../../../../apps/desktop/renderer/assets/welcome-brand.svg')
  const expected = [...welcome.matchAll(/ d="([^"]+)"/gu)].map(match => match[1])
  expect(expected).toHaveLength(29)
  expect([...container.querySelectorAll('path')].map(path => path.getAttribute('d'))).toEqual(expected)
  expect(container.querySelectorAll('path[fill="currentColor"]')).toHaveLength(1)
})
