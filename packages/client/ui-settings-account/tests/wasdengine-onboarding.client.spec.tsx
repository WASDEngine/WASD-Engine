// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the desktop onboarding: the welcome and purpose headings show the brand kit lockup, with
 * WASD Engine kept as their text, where upstream writes the product name; the welcome introduction sets the product
 * name in bold in every language; and the Game programming card shows the Godot, Blender, GIMP, and SuperCollider
 * tiles in place of upstream's code-file icons. `wasdengine/FORK.md` (repository root) runs this spec after every
 * upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OnboardingPurposeStep } from '../src/client/OnboardingPurposeStep.tsx'
import { OnboardingWelcomeStep } from '../src/client/OnboardingWelcomeStep.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type AccountKey } from '../src/client/locales.ts'
import { brandAccountDictionaries, WASDENGINE_PRODUCT_NAME } from '../src/client/wasdengine-copy.ts'
import { emphasizeWasdengine, WasdengineHeadingBrand } from '../src/client/wasdengine-onboarding.tsx'

afterEach(cleanup)

const dictionaries = brandAccountDictionaries({ en, zh, ja, es, fr, de, ru, pt })

function welcome(locale: keyof typeof dictionaries) {
  const copy = dictionaries[locale]
  const t = (key: AccountKey): string => copy[key]
  render(<OnboardingWelcomeStep t={t} locale={locale} heading={createRef<HTMLHeadingElement>()} busy={false} onStart={vi.fn()} />)
  return copy
}

it('heads the welcome step with the WASD Engine lockup in place of the product name', () => {
  const copy = welcome('en')
  const heading = screen.getByRole('heading', { level: 1, name: 'Welcome to WASD Engine' })
  expect(heading.textContent).toBe(`${copy.onboardingWelcome} ${copy.onboardingBrand}`)
  expect(heading.querySelector('svg[viewBox="0 0 1064.31 105.88"][aria-hidden="true"]')).not.toBeNull()
  expect(heading.querySelector('em')).toBeNull()
})

it('introduces game development with the product name in bold', () => {
  welcome('en')
  const introduction = screen.getByText((_content, element) => element?.tagName === 'P'
    && element.textContent === 'WASD Engine works in a local project folder and uses tools to read and write files on your computer. '
      + 'It can help you create game logic, 2D and 3D game assets, music, SFX, and more.')
  expect([...introduction.querySelectorAll('strong')].map(strong => strong.textContent)).toEqual(['WASD Engine'])
})

it('sets the product name in bold wherever a language places it', () => {
  for (const locale of ['zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const) {
    const copy = welcome(locale)
    const introduction = screen.getByText((_content, element) => element?.tagName === 'P' && element.textContent === copy.onboardingIntroduction)
    expect(introduction.querySelector('strong')?.textContent).toBe(WASDENGINE_PRODUCT_NAME)
    cleanup()
  }
})

it('emphasizes each occurrence of the product name and leaves other text alone', () => {
  const paragraph = render(<p>{emphasizeWasdengine('Use WASD Engine, then WASD Engine again.')}</p>).container.querySelector('p')
  expect(paragraph?.textContent).toBe('Use WASD Engine, then WASD Engine again.')
  expect([...paragraph?.querySelectorAll('strong') ?? []].map(strong => strong.textContent)).toEqual(['WASD Engine', 'WASD Engine'])
  cleanup()
  expect(render(<p>{emphasizeWasdengine('No product name.')}</p>).container.innerHTML).toBe('<p>No product name.</p>')
  cleanup()
  render(<h1>Hi <WasdengineHeadingBrand label="WASD Engine" /></h1>)
  expect(screen.getByRole('heading', { name: 'Hi WASD Engine' })).toBeTruthy()
})

// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The SVG a tile shows: the bundler inlines a small asset as a data URL and serves a larger one by path. */
function tileSource(href: string | null | undefined): string {
  const inline = 'data:image/svg+xml;base64,'
  if (href === null || href === undefined) return ''
  return href.startsWith(inline) ? Buffer.from(href.slice(inline.length), 'base64').toString('utf8') : readFileSync(resolve(repository, `.${href}`), 'utf8')
}

function purpose(chosen: 'office' | 'development' | 'both' | null) {
  const copy = dictionaries.en
  render(<OnboardingPurposeStep t={(key: AccountKey): string => copy[key]} heading={createRef<HTMLHeadingElement>()} busy={false}
    purpose={chosen} onSelect={vi.fn()} onContinue={vi.fn()} />)
  return copy
}

it('heads the purpose step with the WASD Engine lockup in place of the product name', () => {
  const copy = purpose(null)
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.textContent).toBe(`${copy.onboardingPurposePrefix} ${copy.onboardingBrand} ${copy.onboardingPurposeSuffix}`)
  expect(heading.querySelector('svg[viewBox="0 0 1064.31 105.88"][aria-hidden="true"]')).not.toBeNull()
  expect(heading.querySelector('em')).toBeNull()
})

it('shows the game tools on the selected Game programming card and keeps the document icons on the other', () => {
  purpose('both')
  const tiles = [...document.querySelectorAll('[data-wasdengine-tool]')]
  expect(tiles.map(tile => tile.getAttribute('data-wasdengine-tool'))).toEqual(['godot', 'blender', 'gimp', 'supercollider'])
  const credits = ['the Godot Engine logo', 'the Blender logo mark', 'Wilber, the GIMP logo', 'SuperCollider Cube SVG, Nathan Ho 2015']
  tiles.forEach((tile, index) => {
    expect(tileSource(tile.querySelector('image')?.getAttribute('href'))).toContain(credits[index])
  })
  // The Game design & writing card keeps upstream's five document icons beside the four tool tiles.
  const rows = [...document.querySelectorAll('span[aria-hidden="true"]')].filter(row => row.querySelector('svg') !== null && row.children.length > 1)
  expect(rows.map(row => row.children.length).sort()).toEqual([4, 5])
  cleanup()
  purpose('office')
  expect(document.querySelectorAll('[data-wasdengine-tool]')).toHaveLength(0)
})
