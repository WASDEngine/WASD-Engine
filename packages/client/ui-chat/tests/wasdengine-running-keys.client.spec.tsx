// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the running icon: the running status shows the keycaps of the WASD Engine mark instead
 * of the whale tail, each key drawn with the mark's paths where the mark places it and colored with the purple tones
 * of its W key, the press moves only each cap's `translate`, outside reduced motion, and the status text is purple.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import { WasdengineRunningKeys } from '../src/client/chat/wasdengine-running-keys.tsx'
import css from '../src/client/chat/wasdengine-running-keys.module.css'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const read = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')
const brand = read('../../ui-brand-official/src/client/wasdengine-brand.tsx')
const sheet = read('../src/client/chat/wasdengine-running-keys.module.css')

const brandParts = new Map([...brand.matchAll(/\{ part: '(\w+)', tone: '(\w+)', d: '([^']+)' \}/gu)]
  .map(([, part, tone, d]) => [part!, { tone: tone!, d: d! }]))
const brandKeys = [...brand.matchAll(/\{ key: '(\w)', x: (\d+), y: (\d+), tone: '\w+' \}/gu)]
  .map(([, key, x, y]) => ({ key: key!, x: Number(x), y: Number(y) }))
const bounds = /const BOUNDS = \{ x: ([\d.]+), y: ([\d.]+), width: ([\d.]+), height: ([\d.]+) \}/u.exec(brand)!.slice(1).map(Number)
const block = (selector: string, from = sheet): string =>
  new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{([^}]*)\\}`, 'u').exec(from)![1]!
const declaration = (rules: string, property: string): string => new RegExp(`${property}: ([^;]+);`, 'u').exec(rules)![1]!

function drawn(svg: Element): { tone: string | undefined; d: string }[] {
  const tones = new Map(['top', 'side', 'front', 'ink'].map(tone => [css[tone], tone]))
  return [...svg.querySelectorAll('path')].map(path => ({ tone: tones.get(path.getAttribute('class') ?? ''), d: path.getAttribute('d')! }))
}

describe('WasdengineRunningKeys', () => {
  it('draws the four keycaps of the brand mark, W first, hidden from assistive technology', () => {
    const { container } = render(<WasdengineRunningKeys />)
    const icon = container.firstElementChild!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect([...icon.children].map(key => key.getAttribute('data-key'))).toEqual(brandKeys.map(({ key }) => key))
    expect(brandKeys.map(({ key }) => key)).toEqual(['w', 'a', 's', 'd'])
    const outline = brandParts.get('outline')!
    for (const key of icon.children) {
      const [base, cap] = [...key.children]
      expect(base?.tagName).toBe('svg')
      expect(cap?.className).toBe(css.cap)
      const [rim, diagonals] = drawn(base!).slice(5)
      const [top, topRing] = drawn(cap!.firstElementChild!)
      expect(drawn(base!).slice(0, 5)).toEqual(['body', 'topEdge', 'leftSide', 'rightSide', 'front'].map(part => brandParts.get(part)))
      expect(top).toEqual(brandParts.get('top'))
      expect([rim, topRing, diagonals].map(part => part?.tone)).toEqual(['ink', 'ink', 'ink'])
      expect(rim!.d + topRing!.d + diagonals!.d).toBe(outline.d)
      expect(outline.tone).toBe('ink')
    }
    expect(container.querySelector('[style]')).toBeNull()
    expect(container.querySelector('animate')).toBeNull()
  })

  it('places each key where the brand mark draws it, in a box of the mark\'s aspect ratio', () => {
    const { container } = render(<WasdengineRunningKeys />)
    const [frameX, frameY, frameSize] = container.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number)
    const [boundsX, boundsY, boundsWidth, boundsHeight] = bounds
    expect(declaration(block('.keys'), 'width')).toBe(
      `calc((${declaration(block('.keys'), 'height').slice('calc('.length, -1)}) * ${(boundsWidth! / boundsHeight!).toFixed(6)})`)
    expect(Number.parseFloat(declaration(block('.key'), 'width'))).toBeCloseTo(frameSize! / boundsWidth! * 100, 3)
    expect(Number.parseFloat(declaration(block('.key'), 'height'))).toBeCloseTo(frameSize! / boundsHeight! * 100, 3)
    for (const { key, x, y } of brandKeys) {
      expect(Number.parseFloat(declaration(block(`.${key}`), 'left')), key).toBeCloseTo((x + frameX! - boundsX!) / boundsWidth! * 100, 3)
      expect(Number.parseFloat(declaration(block(`.${key}`), 'top')), key).toBeCloseTo((y + frameY! - boundsY!) / boundsHeight! * 100, 3)
    }
  })

  it('colors the keys with the purple tones of the brand mark\'s W key and a deep purple ink', () => {
    const highlight = /highlight: \{ top: '(#\w+)', side: '(#\w+)', front: '(#\w+)', ink: '#\w+' \}/u.exec(brand)!.slice(1)
    const keys = block('.keys')
    expect(['top', 'side', 'front'].map(tone => declaration(keys, `--wasdengine-key-${tone}`))).toEqual(highlight)
    expect(declaration(keys, '--wasdengine-key-ink')).toBe('#3A1E8C')
    expect(declaration(block(':global(body[data-ds-dark-theme]) .keys'), '--wasdengine-key-ink')).toBe('#2A1566')
  })

  it('presses each cap through its translate alone, and only without a reduced-motion preference', () => {
    const [still, moving] = sheet.split('@media (prefers-reduced-motion: no-preference) {')
    expect(moving).toBeDefined()
    expect(still).not.toMatch(/\banimation(-name)?:/u)
    expect(moving).toMatch(/\n {2}\.cap \{\n {4}animation: wasdengine-key-press /u)
    const frames = /@keyframes wasdengine-key-press \{([\s\S]*?)\n\}/u.exec(sheet)![1]!
    const properties = new Set([...frames.matchAll(/([\w-]+):/gu)].map(([, property]) => property))
    expect([...properties].sort()).toEqual(['animation-timing-function', 'translate'])
  })
})

describe('RunningStatus with the WASD Engine keys', () => {
  it('shows the keycaps before the status text instead of the whale tail', () => {
    const t = makeTranslate(en, commonEn)
    const { container } = render(<RunningStatus startTime={undefined} paused={false} t={t} />)
    const content = container.querySelector('[data-chat-running] > :last-child')!
    expect(content.firstElementChild?.hasAttribute('data-wasdengine-running-keys')).toBe(true)
    expect(content.textContent).toBe('Deep diving')
    expect(container.querySelector('svg[viewBox="0 0 16 16"]')).toBeNull()
  })

  it('turns the status text purple through the deep-diving tokens of upstream\'s running rule', () => {
    const running = block('.running', read('../src/client/chat/ChatView.module.css'))
    expect(declaration(running, 'color')).toBe('var(--dsw-alias-label-deep-diving)')
    expect(declaration(running, '--dsw-alias-label-shimmer')).toBe('var(--dsw-alias-label-deep-diving-shimmer)')
    const t = makeTranslate(en, commonEn)
    const { container } = render(<RunningStatus startTime={undefined} paused={false} t={t} />)
    expect(container.querySelector('[data-chat-running] > * > [data-wasdengine-running-keys]')).not.toBeNull()
    const tokens = (rules: string) => ['', '-shimmer'].map(suffix => declaration(rules, `--dsw-alias-label-deep-diving${suffix}`))
    expect(tokens(block(':global([data-chat-running]):has(> * > .keys)'))).toEqual(['#7C4DFF', '#5838B7'])
    const dark = tokens(block(':global(body[data-ds-dark-theme] [data-chat-running]):has(> * > .keys)'))
    expect(dark).toEqual(['#A585FF', '#BFADFF'])
    expect(dark[0]).toBe(/highlight: \{ top: '(#\w+)'/u.exec(brand)![1])
  })
})
