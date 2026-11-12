// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the guide's More tools: the plugin starts the guide with New terminal and Code review and
 * changes unpinned, so the guide leaves their cards out and its More card hands them, with their glyphs, to the More
 * tools menu, a plugin reload starts over from that list, and the card ids are the ones the terminal and the forge
 * panel register. `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RenderOpts } from '@deepseek-ai/dsh-client-ui-slots'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { GuideInjected } from '../src/client/index.ts'
import type { SidebarRightGuideActionsOwnerProps } from '../src/client/contract/slots.ts'
import { GuideBody, type GuideBodyProps } from '../src/client/tabs/guide/GuideBody.tsx'
import { GUIDE_ID } from '../src/client/tabs/guide/definition.ts'
import { WASDENGINE_GUIDE_MORE_TOOLS } from '../src/client/tabs/guide/wasdengine-more-tools.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 's-more-tools' as SessionId
const SHORTCUT_CATALOG: readonly never[] = []
const unused = (): never => { throw new Error('The guide body reads no other framework hooks') }

// The jsdom environment replaces the URL global, so file paths resolve from this file's path string.
const read = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')

function ForgeGlyph({ size }: IconProps): ReactNode { return <svg data-glyph="forge" width={size} /> }
function TerminalGlyph({ size }: IconProps): ReactNode { return <svg data-glyph="terminal" width={size} /> }
function BrowserGlyph({ size }: IconProps): ReactNode { return <svg data-glyph="browser" width={size} /> }

/** Boot the plugin over recording slot, locale, and frame faces; the tab registry is the plugin's own. */
async function boot() {
  const ctx = new Context()
  const registered: { name: string; key?: string; inject?: (sessionId: SessionId) => unknown }[] = []
  const slots = {
    inject: vi.fn((_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register)),
    register: vi.fn((options: { name: string; key?: string; inject?: (sessionId: SessionId) => unknown }) => {
      registered.push(options)
      return () => { registered.splice(registered.indexOf(options), 1) }
    }),
    entriesOfSlot: vi.fn((name: string) => registered.filter(entry => entry.name === name)),
    subscribe: vi.fn(() => () => {}),
  }
  const menus = new MenuRegistry(vi.fn())
  onTestFinished(() => { menus.dispose() })
  ctx.provide('contextMenus', { register: menus.register.bind(menus), open: vi.fn() } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', { bind: vi.fn(() => (key: string) => key), register: vi.fn(() => () => {}) } as never)
  ctx.provide('shortcuts', { runtime: 'web', register: () => () => {},
    catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(),
    panelInfo: createSnapshotStore<{ activePanelId: string | null }>({ activePanelId: null }) } as never)
  ctx.provide('resources', { pin: vi.fn() } as never)
  ctx.provide('sessions', { retain: vi.fn(() => ({ ready: Promise.resolve(), release: vi.fn() })) } as never)
  ctx.provide('uiSession', { adapter: { current: createSnapshotStore<{ key: SessionId | undefined }>({ key: undefined }) } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const guide = (): GuideInjected => {
    const entry = registered.find(candidate => candidate.name === 'sidebar.right.pane.tab' && candidate.key === GUIDE_ID)
    if (entry?.inject === undefined) throw new Error('expected the guide body registration')
    return entry.inject(SESSION) as GuideInjected
  }
  return { ctx, fiber, slots, guide }
}

describe('guide More tools', () => {
  it('starts with New terminal and Code review and changes unpinned, and a reload starts over', async () => {
    expect(WASDENGINE_GUIDE_MORE_TOOLS).toEqual(['terminal:new', 'forge-panel:review'])
    const first = await boot()
    expect(first.guide().hooks.entryPins.getSnapshot()).toEqual(['terminal:new', 'forge-panel:review'])
    first.guide().setPinned('terminal:new', true)
    expect(first.guide().hooks.entryPins.getSnapshot()).toEqual(['forge-panel:review'])
    await first.fiber.dispose()
    const second = await boot()
    expect(second.guide().hooks.entryPins.getSnapshot()).toEqual(['terminal:new', 'forge-panel:review'])
  })

  it('leaves the two cards off the guide and hands them to More tools with their glyphs', async () => {
    const h = await boot()
    const register = (kind: string, id: string, order: number, icon?: ComponentType<IconProps>) =>
      h.ctx.sidebarRightTabs.register({
        id: `provider/${kind}`, kind, title: () => kind,
        guide: [{ id, order, title: () => `${kind} title`, ...icon === undefined ? {} : { icon } }],
      })
    register('files', 'workspace', 10)
    register('forge-panel', 'review', 15, ForgeGlyph)
    register('terminal', 'new', 20, TerminalGlyph)
    register('browser', 'new', 30, BrowserGlyph)
    h.slots.register({ name: 'sidebar.right.tab.guide.actions' })
    const injected = h.guide()
    let owner: SidebarRightGuideActionsOwnerProps | undefined
    const openTab = vi.fn(), close = vi.fn()
    const props: GuideBodyProps = {
      sessionId: SESSION, useSession: unused, useProjection: unused, useConversation: unused,
      useInput: unused, useChat: unused, useTrajectory: unused, usePanelInfo: unused, useSessions: unused,
      useSessionStatus: unused, useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
      ...allowAllAccess, useContextMenu: contextMenuHook(),
      inputActions: { insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
        addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
      SessionProvider: ({ children }) => children,
      useShortcuts: bindSnapshotSelector(injected.hooks.shortcuts),
      useGuideEntries: bindSnapshotSelector(injected.hooks.guideEntries),
      useEntryPins: bindSnapshotSelector(injected.hooks.entryPins),
      useEntryActions: bindSnapshotSelector(injected.hooks.entryActions),
      setPinned: injected.setPinned,
      useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-guide' as PaneId, isFloating: false },
        tab: { id: 'tab-guide' as TabId, kind: 'guide', contentId: 'sidebar://guide', title: 'Start', visible: true,
          signal: new AbortController().signal, navigation: { address: 'sidebar://guide', params: undefined, revision: 0 },
          actions: { bindCommands: vi.fn(() => vi.fn()), openResource: vi.fn(), openTab, close } } }),
      t: makeTranslate(en),
      renderSlotChain: vi.fn<GuideBodyProps['renderSlotChain']>((_seat, _owner, options) => options?.fallback),
      renderSlot: vi.fn((slot: string, slotProps: unknown, options?: RenderOpts) => {
        if (slot !== 'sidebar.right.tab.guide.actions') return options?.fallback
        owner = slotProps as SidebarRightGuideActionsOwnerProps
        return <button type="button" role="menuitem">Guide action</button>
      }),
    }
    const view = render(<GuideBody {...props} />)
    const cards = [...view.container.querySelectorAll('[data-sidebar-right-guide-entry]')]
    expect(cards.map(card => card.getAttribute('data-sidebar-right-guide-entry'))).toEqual(['files', 'browser'])
    fireEvent.click(view.getByRole('button', { name: 'More tools' }))
    expect(owner?.entries).toEqual([
      { id: 'forge-panel:review', label: 'forge-panel title', pinned: false, icon: ForgeGlyph },
      { id: 'terminal:new', label: 'terminal title', pinned: false, icon: TerminalGlyph },
      { id: 'browser:new', label: 'browser title', pinned: true, icon: BrowserGlyph },
    ])
    owner?.onOpen('terminal:new')
    expect(openTab).toHaveBeenCalledExactlyOnceWith('terminal', { replaceTab: true })
    expect(close).toHaveBeenCalledOnce()
  })

  it('names the cards that the terminal and the forge panel register', () => {
    const terminal = read('../../ui-sidebar-terminal/src/client/index.ts')
    const forge = read('../../../experimental/client-ui-forge/src/client/mount.ts')
    const terminalCard = /kind: '([\w-]+)',[^\n]*\n\s*guide: \[\{ id: '([\w-]+)'/u.exec(terminal)
    const forgeKind = /export const TAB_KIND = '([\w-]+)'/u.exec(forge)
    const forgeCard = /kind: TAB_KIND,[^\n]*\n\s*guide: \[\{\s*id: '([\w-]+)'/u.exec(forge)
    expect([`${terminalCard?.[1]}:${terminalCard?.[2]}`, `${forgeKind?.[1]}:${forgeCard?.[1]}`]).toEqual(WASDENGINE_GUIDE_MORE_TOOLS)
  })
})
