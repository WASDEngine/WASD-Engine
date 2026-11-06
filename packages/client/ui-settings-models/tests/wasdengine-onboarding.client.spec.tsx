// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the look and copy of the models onboarding: the onboarding modal draws the brand kit
 * lockup of the Desktop welcome window above its title, the fork's sheet styles every class the modal and the API key
 * step use and finds the key editor's buttons where it expects them, and the API key step asks for a WASD Engine API
 * token in every language. `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { brandModelsDictionaries } from '../src/client/wasdengine-copy.ts'
import { WasdengineLockup } from '../src/client/wasdengine-onboarding.tsx'

afterEach(cleanup)

// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const read = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')
const paths = (svg: string): string[] => [...svg.matchAll(/ d="([^"]+)"/gu)].map(match => match[1]!)
const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

it('draws the logo above the title of every onboarding step', () => {
  render(<OnboardingModal title="Add an API key to get started"><p>Step body</p></OnboardingModal>)
  const dialog = screen.getByRole('dialog', { name: 'Add an API key to get started' })
  const logo = dialog.querySelector('svg[viewBox="0 0 1064.31 105.88"]')
  expect(logo).not.toBeNull()
  expect(logo!.compareDocumentPosition(screen.getByRole('heading', { name: 'Add an API key to get started' })) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy()
})

it('draws the lockup of the Desktop welcome window and of the sign-in dialog', () => {
  const { container } = render(<WasdengineLockup />)
  const drawn = [...container.querySelectorAll('path')].map(path => path.getAttribute('d'))
  expect(drawn).toEqual(paths(read('../../../../apps/desktop/renderer/assets/welcome-brand.svg')))
  const signIn = read('../../ui-settings-account/src/client/wasdengine-sign-in.tsx')
  const signInPaths = [...signIn.matchAll(/\['(M[^']+)', '#/gu)].map(match => match[1])
  signInPaths.push(/const LOCKUP_WORDMARK = '([^']+)'/u.exec(signIn)?.[1])
  expect(drawn).toEqual(signInPaths)
  expect(container.querySelectorAll('path[fill="currentColor"]')).toHaveLength(1)
})

it('styles every class of the onboarding modal and the API key step from the fork sheet', () => {
  const sheet = read('../src/client/wasdengine-onboarding.module.css')
  for (const [file, binding] of [['OnboardingModal.tsx', 'css'], ['DeepSeekOnboardingDialog.tsx', 'styles']] as const) {
    const source = read(`../src/client/${file}`)
    expect(source, file).toContain(`import ${binding} from './wasdengine-onboarding.module.css'\n`)
    const used = new Set([...source.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'gu'))].map(match => match[1]!))
    expect(used.size, file).toBeGreaterThan(1)
    for (const name of used) expect(sheet, `${file}: ${name}`).toMatch(new RegExp(`\\.${name}\\b`, 'u'))
  }
  expect(read('../src/client/OnboardingModal.tsx')).toContain('<WasdengineLockup className={css.lockup} />')
})

it('finds the key editor\'s buttons where the fork sheet styles them', () => {
  // The sheet styles `.editor > div > :last-child`: the credential-only block ends with EditorFooter.
  expect(read('../src/client/ProviderEditor.tsx')).toMatch(/\n {6}<EditorFooter\n[\s\S]*?\n {6}\/>\n {4}<\/div>\n {2}\)\n\}/u)
  // Its first button cancels and its second saves.
  expect([...read('../src/client/EditorFooter.tsx').matchAll(/className=\{styles\['(\w+)'\]\}/gu)].map(match => match[1]))
    .toEqual(['editorActions', 'secondaryButton', 'primaryButton'])
})

it.each(Object.keys(dictionaries))('asks for a WASD Engine API token in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const branded = brandModelsDictionaries(dictionaries)[language]
  expect(Object.keys(branded)).toEqual(Object.keys(dictionaries[language]))
  expect(branded.onboardingDescription).toContain('WASD Engine')
  expect(branded.onboardingDescription).not.toMatch(/DeepSeek/u)
  expect(dictionaries[language].onboardingDescription).toMatch(/DeepSeek/u)
})

it('shows only the sign-in occupant without API key entry', () => {
  const dialog = read('../src/client/DeepSeekOnboardingDialog.tsx')
  expect(dialog).toContain('const [apiKey, setApiKey] = useState(explicit && apiKeyEntry)')
  expect(dialog).toContain("renderSlot('settings.models.sign-in', { complete, useApiKey: () => { setApiKey(apiKeyEntry) } }, { fallback: apiKeyEntry ? editor : null })")
})

it('registers the branded dictionaries and refuses copy that no longer matches them', () => {
  expect(read('../src/client/index.ts')).toContain('ctx.locale.register(NS, brandModelsDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
  expect(() => brandModelsDictionaries({ en: {} })).toThrow('WASD Engine models copy: en has no message onboardingDescription')
  expect(() => brandModelsDictionaries({ eo: {} })).toThrow('WASD Engine models copy: eo has no WASD Engine copy')
})
