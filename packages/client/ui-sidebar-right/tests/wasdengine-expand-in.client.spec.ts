// @vitest-environment jsdom
/**
 * WASDEngine fork guard for `expandIn`, through which WASD Engine Plugins shows the agent's Browser tab while the user
 * types in the composer: it expands one Session's collapsed column, recorded like any expansion, and leaves the input
 * focus where it is, where `toggleExpanded` moves it into the column's pane; an expanded column and a Session whose
 * store was never adopted are left alone. `wasdengine/FORK.md` (repository root) runs this spec after every upstream
 * merge.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSidebarRightController } from '../src/client/service.ts'
import { openWithPaneFocus } from '../src/client/shell/close-focus.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { guideDefinition } from '../src/client/tabs/guide/definition.ts'

const SESSION = 's-expand' as SessionId

afterEach(() => { document.body.replaceChildren() })

/** A controller over an adopted store of {@link SESSION} on screen, whose seat renders one docked pane. */
function harness() {
  const tabs = new SidebarRightTabRegistry(new Context())
  tabs.register(guideDefinition((key: string) => key))
  const { controller, adopt, show } = createSidebarRightController(tabs, vi.fn(), {
    autoFullscreen: () => false,
    openWithFocus: (sessionId, open) => { openWithPaneFocus(document, sessionId, open) },
    closeWithFocus: (_sessionId, _paneId, close) => { close() },
  })
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create()
  adopt(SESSION, store)
  show(SESSION)
  const seat = document.createElement('div')
  seat.dataset.sidebarRightSession = SESSION
  seat.dataset.sidebarRightOpen = ''
  const pane = document.createElement('section')
  pane.tabIndex = -1
  pane.dataset.dockkitPane = 'pane'
  seat.append(pane)
  const composer = document.createElement('textarea')
  document.body.append(seat, composer)
  const entries = (): number => store.getSnapshot().bySession[SESSION]?.history.entries.length ?? 0
  return { controller, pane, composer, entries }
}

it('expands a collapsed column without moving the input focus, where toggleExpanded focuses the pane', () => {
  const { controller, pane, composer, entries } = harness()
  composer.focus()
  const before = entries()
  controller.expandIn(SESSION)
  expect(controller.isExpanded()).toBe(true)
  expect(entries()).toBe(before + 1)
  expect(document.activeElement).toBe(composer)
  controller.expandIn(SESSION)
  expect(entries()).toBe(before + 1)
  controller.toggleExpanded()
  expect(controller.isExpanded()).toBe(false)
  controller.toggleExpanded()
  expect(document.activeElement).toBe(pane)
})

it('leaves a Session whose store the window never adopted alone', () => {
  const { controller } = harness()
  controller.expandIn('s-unadopted' as SessionId)
  expect(controller.isExpanded()).toBe(false)
})
