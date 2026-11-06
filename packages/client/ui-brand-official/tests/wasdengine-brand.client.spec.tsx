// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the in-app brand mark: the occupants the plugin registers, and the
 * keycap paths and colors the mark shares with the Desktop icon sources and the Web favicons.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WASDENGINE_KEYCAP, WASDENGINE_KEYS, WasdengineMark, applyWasdengineBrand } from '../src/client/wasdengine-brand.tsx'

afterEach(cleanup)

const MARK_SLOTS = ['sidebar.brand.mark', 'conversation.hero.brand.mark'] as const

const DESKTOP_SOURCES = ['icon-macos.svg', 'icon-windows.svg'] as const

/** The drop shadow a keycap carries on a light ground; the mark omits it. */
const SHADOW = { fill: '#2B3A55', opacity: '0.16' } as const

/** One keycap group: its placement, its drawn paths with their fills, and how many shadow paths it carries. */
interface KeyGroup {
  transform: string | null
  paths: (string | null)[][]
  shadows: number
}

function svgDocument(path: string): Document {
  return new DOMParser().parseFromString(readFileSync(new URL(path, import.meta.url), 'utf8'), 'image/svg+xml')
}

function keyGroups(groups: Iterable<Element>): KeyGroup[] {
  return [...groups].map((group) => {
    const paths = [...group.children].filter(child => child.tagName === 'path')
    const shadow = (path: Element): boolean => path.getAttribute('fill-opacity') !== null
    for (const path of paths.filter(shadow)) {
      expect([path.getAttribute('fill'), path.getAttribute('fill-opacity')]).toEqual([SHADOW.fill, SHADOW.opacity])
    }
    return {
      transform: group.getAttribute('transform'),
      paths: paths.filter(path => !shadow(path)).map(path => [path.getAttribute('d'), path.getAttribute('fill')]),
      shadows: paths.filter(shadow).length,
    }
  })
}

function markGroups(container: ParentNode): KeyGroup[] {
  return keyGroups(container.querySelectorAll('svg > g'))
}

describe('WASDEngine brand mark', () => {
  it('renders the four keycaps in their brand colors at the requested width', () => {
    const sidebar = render(<WasdengineMark size={24} />)
    const mark = sidebar.container.querySelector('svg')
    expect(mark?.getAttribute('width')).toBe('24')
    expect(Number(mark?.getAttribute('height'))).toBeCloseTo(24 * 501.75 / 762.75)
    expect(mark?.getAttribute('viewBox')).toBe('176.125 284.125 762.75 501.75')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('class')).toBeNull()
    const groups = markGroups(sidebar.container)
    expect(groups.map(group => group.transform)).toEqual(WASDENGINE_KEYS.map(({ x, y }) => `translate(${String(x)} ${String(y)})`))
    for (const group of groups) {
      expect(group.paths.map(([d]) => d)).toEqual(WASDENGINE_KEYCAP.map(({ d }) => d))
      expect(group.shadows).toBe(0)
    }
    // The raised W key is purple; A, S, and D are white keys; every outline is ink.
    expect(groups.map(group => group.paths.find((_, index) => WASDENGINE_KEYCAP[index]?.part === 'top')?.[1]))
      .toEqual(['#A585FF', '#FFFFFF', '#FFFFFF', '#FFFFFF'])
    expect(new Set(groups.map(group => group.paths.at(-1)?.[1]))).toEqual(new Set(['#17181D']))

    const hero = render(<WasdengineMark size={34} className="hero-mark" />)
    expect(hero.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    expect(hero.container.querySelector('svg')?.getAttribute('class')).toBe('hero-mark')
  })

  it.each(DESKTOP_SOURCES)('draws the keycaps of the Desktop icon source %s', (file) => {
    const view = render(<WasdengineMark size={24} />)
    const source = keyGroups(svgDocument(`../../../../apps/desktop/wasdengine/${file}`).querySelectorAll('[id="tray-glyph"] > g'))
    expect(source.map(({ transform, paths }) => ({ transform, paths }))).toEqual(
      markGroups(view.container).map(({ transform, paths }) => ({ transform, paths })))
    expect(source.map(group => group.shadows)).toEqual([1, 1, 1, 1])
  })

  it('ships the same keycaps as the Web favicons, with the shadow only on the light one', () => {
    const view = render(<WasdengineMark size={24} />)
    const mark = markGroups(view.container).map(({ transform, paths }) => ({ transform, paths }))
    for (const [file, shadows] of [['favicon.svg', 1], ['favicon-dark.svg', 0]] as const) {
      const favicon = keyGroups(svgDocument(`../../../../apps/web/public/${file}`).querySelectorAll('svg > g'))
      expect(favicon.map(({ transform, paths }) => ({ transform, paths })), file).toEqual(mark)
      expect(favicon.map(group => group.shadows), file).toEqual([shadows, shadows, shadows, shadows])
    }
  })

  it('fills both brand-mark slots with the mark and withdraws them on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: Object.fromEntries(MARK_SLOTS.map(name => [name, { kind: 'single', scope: 'root' }])),
    } as never, () => null)
    const fiber = ctx.plugin({ inject: ['slots'], apply: applyWasdengineBrand })
    await fiber.await()
    for (const name of MARK_SLOTS) expect(slots.entries(name).map(entry => entry.component)).toEqual([WasdengineMark])
    await fiber.dispose()
    for (const name of MARK_SLOTS) expect(slots.entries(name)).toHaveLength(0)
  })
})
