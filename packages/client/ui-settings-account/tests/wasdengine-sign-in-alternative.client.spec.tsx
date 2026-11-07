// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the sign-in dialog's alternative: while the dialog offers sign-in, it renders the
 * alternative's offer among its buttons; the offer opens the alternative's panel under the logo and the close
 * button, its Back returns to sign-in, and its close closes the dialog. `wasdengine/FORK.md` (repository root) runs
 * this spec after every upstream merge.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { afterEach, expect, it, vi } from 'vitest'
import { SignInDialog } from '../src/client/SignInDialog.tsx'
import { en, type AccountKey } from '../src/client/locales.ts'
import { brandAccountDictionaries } from '../src/client/wasdengine-copy.ts'
import type { SignInAlternativeOwner } from '../src/client/wasdengine-sign-in-alternative.ts'

afterEach(cleanup)

const copy = brandAccountDictionaries({ en }).en
const t = (key: AccountKey): string => copy[key]
const links = { usageUrl: '', topUpUrl: '' }

/** An alternative that records what the dialog passed it. */
function alternative() {
  const owners: SignInAlternativeOwner[] = []
  const render = (owner: SignInAlternativeOwner) => {
    owners.push(owner)
    return owner.view === 'offer'
      ? <button type="button" className={owner.classNames.secondaryButton} onClick={owner.open}>Use another agent</button>
      : <div className={owner.classNames.content}>
        <h2 className={owner.classNames.title}>Another agent</h2>
        <button type="button" onClick={owner.back}>Back</button>
        <button type="button" onClick={owner.close}>Finish</button>
      </div>
  }
  return { owners, render }
}

function dialog(view: AccountView, renderAlternative?: (owner: SignInAlternativeOwner) => React.ReactNode, close = vi.fn()) {
  render(<SignInDialog
    account={{ view, details: undefined, avatar: undefined, failed: false }}
    colorScheme="dark" start={vi.fn(async () => {})} cancel={vi.fn(async () => {})} close={close} t={t}
    renderAlternative={renderAlternative}
  />)
  return close
}

it('offers the alternative below Sign in, and shows its panel in place of the welcome', () => {
  const { owners, render: renderAlternative } = alternative()
  dialog({ status: 'signed-out', attempt: null, links }, renderAlternative)
  expect(screen.getAllByRole('button').map(button => button.textContent || button.getAttribute('aria-label')))
    .toEqual([copy.close, 'Use another agent', copy.signIn])
  const offered = owners.at(-1) as SignInAlternativeOwner
  expect(offered.view).toBe('offer')
  for (const name of Object.values(offered.classNames)) expect(name).not.toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Use another agent' }))
  expect(screen.getByRole('heading', { name: 'Another agent' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: copy.signIn })).toBeNull()
  expect(screen.queryByText('Build games with an agent at the keys.')).toBeNull()
  expect(document.querySelector('svg[viewBox="0 0 1064.31 105.88"]')).not.toBeNull()
  expect(screen.getByRole('button', { name: copy.close })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('button', { name: copy.signIn })).toBeTruthy()
})

it('closes the dialog from the panel', () => {
  const close = dialog({ status: 'signed-out', attempt: null, links }, alternative().render)
  fireEvent.click(screen.getByRole('button', { name: 'Use another agent' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
  expect(close).toHaveBeenCalledOnce()
})

it('offers no alternative while a sign-in runs or failed', () => {
  const attempt = { id: 'attempt', phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' }
  dialog({ status: 'signed-out', attempt, links } as AccountView, alternative().render)
  expect(screen.queryByRole('button', { name: 'Use another agent' })).toBeNull()
  cleanup()
  dialog({ status: 'signed-out', attempt: { id: 'attempt', phase: 'failed', errorCode: 'no-response' }, links } as AccountView, alternative().render)
  expect(screen.queryByRole('button', { name: 'Use another agent' })).toBeNull()
})
