// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the in-app brand mark: the occupants the plugin registers, and the
 * keycap geometry the mark shares with the Desktop icon sources and the Web favicons.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WasdengineMark, applyWasdengineBrand } from '../src/client/wasdengine-brand.tsx'

afterEach(cleanup)

const MARK_SLOTS = ['sidebar.brand.mark', 'conversation.hero.brand.mark'] as const

const DESKTOP_SOURCES = ['icon-macos.svg', 'icon-windows.svg'] as const

/** Keycap rectangles and letter strokes of one drawn mark, in document order. */
interface MarkGeometry {
  keys: (string | null)[][]
  letters: (string | null)[][]
}

function svgDocument(path: string): Document {
  return new DOMParser().parseFromString(readFileSync(new URL(path, import.meta.url), 'utf8'), 'image/svg+xml')
}

function markGeometry(root: ParentNode): MarkGeometry {
  return {
    keys: [...root.querySelectorAll('g[mask] > rect')]
      .map(rect => ['x', 'y', 'width', 'height', 'rx'].map(name => rect.getAttribute(name))),
    letters: [...root.querySelectorAll('mask path')].map(path => [
      path.getAttribute('transform'), path.getAttribute('d'), path.parentElement?.getAttribute('stroke-width') ?? null,
    ]),
  }
}

/** The same geometry read from a Desktop icon source's `tray-glyph` key groups and `glyph-*` letters. */
function desktopGeometry(source: Document): MarkGeometry {
  const glyphs = new Map([...source.querySelectorAll('defs > path')].map(path => [`#${path.getAttribute('id') ?? ''}`, path.getAttribute('d')]))
  const groups = [...source.querySelectorAll('[id="tray-glyph"] > g')]
  return {
    keys: groups.map((group) => {
      const [, x, y] = /^translate\((\d+) (\d+)\)$/u.exec(group.getAttribute('transform') ?? '') ?? []
      const rect = group.querySelector('rect')
      return [x ?? null, y ?? null, ...['width', 'height', 'rx'].map(name => rect?.getAttribute(name) ?? null)]
    }),
    letters: groups.map((group) => {
      const [, x, y] = /^translate\((\d+) (\d+)\)$/u.exec(group.getAttribute('transform') ?? '') ?? []
      const letter = group.querySelector('use')
      expect(letter?.getAttribute('transform')).toBe('translate(60 47) scale(1.3)')
      return [
        `translate(${String(Number(x) + 60)} ${String(Number(y) + 47)}) scale(1.3)`,
        glyphs.get(letter?.getAttribute('href') ?? '') ?? null,
        letter?.getAttribute('stroke-width') ?? null,
      ]
    }),
  }
}

describe('WASDEngine brand mark', () => {
  it('renders the WASD keycaps in the host ink at the requested width', () => {
    const sidebar = render(<WasdengineMark size={24} />)
    const mark = sidebar.container.querySelector('svg')
    expect(mark?.getAttribute('width')).toBe('24')
    expect(Number(mark?.getAttribute('height'))).toBeCloseTo(24 * 528 / 806)
    expect(mark?.getAttribute('viewBox')).toBe('149 280 806 528')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('class')).toBeNull()
    expect(sidebar.container.querySelector('g[mask]')?.getAttribute('fill')).toBe('currentColor')
    expect(markGeometry(sidebar.container).keys).toHaveLength(4)

    const hero = render(<WasdengineMark size={34} className="hero-mark" />)
    expect(hero.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    expect(hero.container.querySelector('svg')?.getAttribute('class')).toBe('hero-mark')
  })

  it('cuts the letters through a mask of its own in every mounted mark', () => {
    const view = render(<><WasdengineMark size={24} /><WasdengineMark size={34} /></>)
    const masks = [...view.container.querySelectorAll('mask')].map(mask => mask.getAttribute('id'))
    expect(new Set(masks).size).toBe(2)
    expect([...view.container.querySelectorAll('g[mask]')].map(group => group.getAttribute('mask')))
      .toEqual(masks.map(id => `url(#${id ?? ''})`))
  })

  it.each(DESKTOP_SOURCES)('draws the keycaps and letters of the Desktop icon source %s', (file) => {
    const view = render(<WasdengineMark size={24} />)
    expect(markGeometry(view.container)).toEqual(desktopGeometry(svgDocument(`../../../../apps/desktop/wasdengine/${file}`)))
  })

  it('ships the same mark as the Web favicons in fixed light and dark ink', () => {
    const view = render(<WasdengineMark size={24} />)
    for (const [file, ink] of [['favicon.svg', '#000'], ['favicon-dark.svg', '#fff']] as const) {
      const favicon = svgDocument(`../../../../apps/web/public/${file}`)
      expect(markGeometry(favicon)).toEqual(markGeometry(view.container))
      expect(favicon.querySelector('g[mask]')?.getAttribute('fill')).toBe(ink)
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
