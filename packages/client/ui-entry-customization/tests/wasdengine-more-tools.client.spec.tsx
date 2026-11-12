// @vitest-environment jsdom
/**
 * WASDEngine fork guard for More tools: the right sidebar guide's More menu lists the cards that are off the guide,
 * which in WASD Engine are New terminal and Code review and changes, each with its card's glyph in the keycap purple
 * and without a pin control, and then plugin browsing and creation after a separator.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, within } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightGuideActionsOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply, inject } from '../src/client/index.ts'
import css from '../src/client/EntryMenu.module.css'

const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() }
  finally { runtimes.clear(); cleanup() }
})

// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const read = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')

/** Fixed-palette artwork, like the terminal's blue strokes. */
function Glyph({ size, className }: IconProps) {
  return <svg data-glyph width={size} height={size} className={className}><path stroke="#679EFE" d="M1 1h4" /></svg>
}

/** The guide's cards as its More card hands them over; Notes registered no glyph. */
const CARDS: SidebarRightGuideActionsOwnerProps['entries'] = [
  { id: 'forge-panel:review', label: 'Code review and changes', pinned: false, icon: Glyph },
  { id: 'terminal:new', label: 'New terminal', pinned: false, icon: Glyph },
  { id: 'browser:new', label: 'New browser', pinned: true, icon: Glyph },
  { id: 'notes:open', label: 'Notes', pinned: false },
]

async function bench({ navigation = true }: { navigation?: boolean } = {}) {
  const onOpen = vi.fn<(id: string) => void>(), onPinnedChange = vi.fn<(id: string, pinned: boolean) => void>()
  const onDismiss = vi.fn<() => void>(), openList = vi.fn()
  function Guide({ renderSlot }: PropsRenderSlots<'sidebar.right.tab.guide.actions'>) {
    return <div role="menu" aria-label="More tools">
      {renderSlot('sidebar.right.tab.guide.actions', { entries: CARDS, onOpen, onPinnedChange, onDismiss })}
    </div>
  }
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale('en')
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      if (navigation) ctx.provide('pluginNavigation', { openList } as never)
      ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
    },
  })
  await runtime.root.declare({
    'sidebar.panellist.actions': { kind: 'list', scope: 'root' },
    'conversation.session.header.views.actions': { kind: 'list', scope: 'root' },
    'sidebar.right.tab.guide.actions': { kind: 'list', scope: 'root' },
  }, Guide)
  await runtime.mount({ inject: [...inject], apply })
  const menu = within(runtime.renderRoot().getByRole('menu', { name: 'More tools' }))
  return { menu, onOpen, onPinnedChange, onDismiss, openList }
}

describe('More tools', () => {
  it('lists the cards off the guide with their glyphs and no pin control, then browsing and creation', async () => {
    const b = await bench()
    expect(b.menu.getAllByRole('menuitem').map(row => row.textContent))
      .toEqual(['Code review and changes', 'New terminal', 'Notes', 'Browse other plugins', 'Create your plugin'])
    const [separator, ...others] = b.menu.getAllByRole('separator')
    expect(others).toEqual([])
    const notes = b.menu.getByRole('menuitem', { name: 'Notes' })
    const browse = b.menu.getByRole('menuitem', { name: 'Browse other plugins' })
    expect(notes.compareDocumentPosition(separator!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator!.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const name of ['Code review and changes', 'New terminal']) {
      const glyph = b.menu.getByRole('menuitem', { name }).querySelector('svg[data-glyph]')
      expect(glyph?.getAttribute('width')).toBe('16')
      expect(glyph?.parentElement?.className).toBe(`${css.entryIcon} ${css.guideIcon}`)
      expect(glyph?.parentElement?.getAttribute('aria-hidden')).toBe('true')
    }
    expect(notes.querySelector('svg')).toBeNull()
    expect(b.menu.queryByRole('menuitem', { name: /^Pin / })).toBeNull()
    fireEvent.click(b.menu.getByRole('menuitem', { name: 'New terminal' }))
    expect(b.onOpen).toHaveBeenCalledExactlyOnceWith('terminal:new')
    expect(b.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(b.onOpen.mock.invocationCallOrder[0]!)
    expect(b.onPinnedChange).not.toHaveBeenCalled()
    fireEvent.click(browse)
    expect(b.openList).toHaveBeenCalledExactlyOnceWith()
  })

  it('separates creation from the cards while plugin browsing is unavailable', async () => {
    const b = await bench({ navigation: false })
    expect(b.menu.getAllByRole('menuitem').map(row => row.textContent))
      .toEqual(['Code review and changes', 'New terminal', 'Notes', 'Create your plugin'])
    expect(b.menu.getAllByRole('separator')).toHaveLength(1)
  })

  it('draws a card glyph in the purple of the guide card, with fixed artwork colors following it', () => {
    const sheet = read('../src/client/EntryMenu.module.css')
    const guide = read('../../ui-sidebar-right/src/client/tabs/guide/GuideBody.module.css')
    for (const rule of [
      '.guideIcon { color: #7C4DFF; }',
      ':global(body[data-ds-dark-theme]) .guideIcon { color: #A585FF; }',
      ".guideIcon [stroke]:not([stroke='none']) { stroke: currentColor; }",
      ".guideIcon [fill]:not([fill='none']) { fill: currentColor; }",
    ]) expect(sheet).toContain(rule)
    expect(guide).toContain('color: #7C4DFF;')
    expect(guide).toContain('color: #A585FF;')
  })
})
