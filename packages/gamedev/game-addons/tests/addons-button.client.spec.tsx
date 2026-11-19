// @vitest-environment jsdom
/**
 * The Session header's Add-ons button: shown for a Session in a Workspace, it opens a dialog that lists the catalog by
 * application with each add-on's presence in the game and a switch that turns it on or off for agents, showing only
 * what the Host accepted.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AddonsButton, type AddonsButtonInjected, type AddonsButtonProps } from '../src/client/AddonsButton.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import type { GameAddonPresence, GameAddonsProjectView, GameAddonView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')

function addon(id: string, title: string, host: GameAddonView['host'], presence: GameAddonPresence | undefined, extra: Partial<GameAddonView> = {}): GameAddonView {
  return {
    id, title, host, version: '1.0', summary: `${title} summary.`, useWhen: `${title} use.`, tags: [], stages: ['content'],
    license: 'MIT', homepage: `https://example.test/${id}`, bytes: 2 * 1024 * 1024, conflicts: [], allowed: true,
    ...presence === undefined ? {} : { presence }, ...extra,
  }
}

/** An add-on that ships inside its application, so nothing is downloaded. */
function withoutBytes(view: GameAddonView): GameAddonView {
  const { bytes: _bytes, ...rest } = view
  return rest
}

/**
 * @param off - ids of the add-ons that the user turned off.
 * @param project - whether the Workspace folder holds a game project, whose presence each add-on then shows.
 */
function view(off: ReadonlySet<string> = new Set(), project = true): GameAddonsProjectView {
  const presence = (state: GameAddonPresence): GameAddonPresence | undefined => project ? state : undefined
  return {
    ...project ? { projectDir: '/games/neon' } : {},
    icons: { cam: 'data:image/png;base64,aWNvbg==' },
    addons: [
      addon('cam', 'Cam', 'godot', presence({ state: 'absent' }), { credit: 'Cam by Someone' }),
      addon('talk', 'Talk', 'godot', presence({ state: 'found', version: '0.9' })),
      withoutBytes(addon('rig', 'Rig', 'blender', presence({ state: 'installed', version: '5.2.3' }))),
      addon('humans', 'Humans', 'blender', presence({ state: 'absent' }), { assets: { license: 'CC0-1.0', bytes: 1024, homepage: 'https://example.test/pack' } }),
    ].map(entry => ({ ...entry, allowed: !off.has(entry.id) })),
  }
}

function button(options: {
  readonly path?: string
  readonly read?: AddonsButtonInjected['readProject']
  readonly setAllowed?: AddonsButtonInjected['setAllowed']
} = {}) {
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: options.path === undefined ? [] : [{
      workspaceId: brandString<WorkspaceId>('w1'), path: options.path, title: 'Game', sessionIds: [SESSION],
      createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
    }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const readProject = vi.fn<AddonsButtonInjected['readProject']>(options.read ?? (() => Promise.resolve({ value: view() })))
  const setAllowed = vi.fn<AddonsButtonInjected['setAllowed']>(options.setAllowed ?? (() => Promise.reject(new Error('unused'))))
  const props: AddonsButtonProps = {
    ...({} as AddonsButtonProps),
    sessionId: SESSION,
    useWorkspaces: bindSnapshotSelector(workspaces),
    t,
    readProject,
    setAllowed,
  }
  render(<AddonsButton {...props} />)
  return { readProject, setAllowed }
}

async function open(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['addons.button'] })) })
  return screen.getByRole('dialog', { name: en['addons.title'] })
}

/** A switch of the dialog by the add-on's title. */
function toggle(dialog: HTMLElement, title: string): HTMLElement {
  return within(dialog).getByRole('switch', { name: `Let agents use ${title}` })
}

/**
 * A Host whose switches start with some add-ons off and change as `setAllowed` asks.
 * @param initiallyOff - ids of the add-ons that start off.
 */
function host(initiallyOff: readonly string[] = []) {
  const off = new Set(initiallyOff)
  return {
    off,
    read: (): Promise<{ readonly value: GameAddonsProjectView }> => Promise.resolve({ value: view(off) }),
    setAllowed: (id: string, allowed: boolean): Promise<{ readonly value: undefined }> => {
      if (allowed) off.delete(id)
      else off.add(id)
      return Promise.resolve({ value: undefined })
    },
  }
}

describe('AddonsButton', () => {
  it('shows only for a Session in a Workspace', () => {
    button({})
    expect(screen.queryByRole('button', { name: en['addons.button'] })).toBeNull()
    cleanup()
    button({ path: '/games' })
    expect(screen.getByRole('button', { name: en['addons.button'] }).title).toBe(en['addons.tooltip'])
  })

  it('lists Godot and Blender add-ons with their facts, presence in the game, and a switch that is on by default', async () => {
    const { readProject } = button({ path: '/games' })
    const dialog = await open()
    expect(readProject).toHaveBeenCalledWith('/games')
    const godot = within(dialog).getByRole('region', { name: en['addons.godot'] })
    expect(within(godot).getByRole('link', { name: 'Cam' }).getAttribute('href')).toBe('https://example.test/cam')
    // Cam has an icon; Talk, which has none, gets a tile with its first letter.
    const rows = within(godot).getAllByRole('listitem')
    expect(rows[0]?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
    expect(rows[1]?.querySelector('img')).toBeNull()
    expect(rows[1]?.firstElementChild?.textContent).toBe('T')
    expect(within(godot).getAllByText('1.0 · MIT · 2.0 MB')).toHaveLength(2)
    expect(within(godot).getByText('Use it when: Cam use.')).toBeTruthy()
    expect(within(godot).getByText('Its license requires this credit in the game: Cam by Someone')).toBeTruthy()
    // Talk is in the game as a copy without a record, Rig as an installation; Cam and Humans are not.
    expect(within(rows[0]!).queryByText(en['addons.inGame'])).toBeNull()
    expect(within(rows[1]!).getByText(en['addons.inGame'])).toBeTruthy()
    const blender = within(dialog).getByRole('region', { name: en['addons.blender'] })
    expect(within(blender).getByText(`1.0 · MIT · ${en['addons.shipsWithBlender']}`)).toBeTruthy()
    expect(within(blender).getByText('1.0 · MIT · 2.0 MB · with CC0-1.0 assets')).toBeTruthy()
    expect(within(blender).getAllByText(en['addons.inGame'])).toHaveLength(1)
    for (const title of ['Cam', 'Talk', 'Rig', 'Humans']) expect(toggle(dialog, title).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).queryByRole('button', { name: /^Install|^Remove/u })).toBeNull()
  })

  it('lists the add-ons and their switches for a Workspace without a game project, with no presence', async () => {
    button({ path: '/games', read: () => Promise.resolve({ value: view(new Set(['rig']), false) }) })
    const dialog = await open()
    expect(within(dialog).queryByText(en['addons.inGame'])).toBeNull()
    expect(toggle(dialog, 'Cam').getAttribute('aria-checked')).toBe('true')
    expect(toggle(dialog, 'Rig').getAttribute('aria-checked')).toBe('false')
  })

  it('turns an add-on off and on again, showing the switch the Host accepted and what changed for agents', async () => {
    const state = host()
    const { setAllowed } = button({ path: '/games', read: state.read, setAllowed: state.setAllowed })
    const dialog = await open()
    await act(async () => { fireEvent.click(toggle(dialog, 'Cam')) })
    expect(setAllowed).toHaveBeenLastCalledWith('cam', false)
    expect(toggle(dialog, 'Cam').getAttribute('aria-checked')).toBe('false')
    expect(within(dialog).getByRole('status').textContent).toBe('Agents no longer use Cam.')
    await act(async () => { fireEvent.click(toggle(dialog, 'Cam')) })
    expect(setAllowed).toHaveBeenLastCalledWith('cam', true)
    expect(toggle(dialog, 'Cam').getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('status').textContent).toBe('Agents can use Cam again.')
    // Rig is in the game, which keeps it when agents may no longer use it.
    await act(async () => { fireEvent.click(toggle(dialog, 'Rig')) })
    expect(toggle(dialog, 'Rig').getAttribute('aria-checked')).toBe('false')
    expect(within(dialog).getByRole('status').textContent).toBe('Agents no longer use Rig. This game still has it; ask the agent to remove it if the game should not use it.')
  })

  it('disables every switch while a change is saved', async () => {
    let finish: (() => void) | undefined
    const state = host()
    button({
      path: '/games',
      read: state.read,
      setAllowed: (id, allowed) => new Promise((resolve) => {
        finish = () => { void state.setAllowed(id, allowed).then(resolve) }
      }),
    })
    const dialog = await open()
    await act(async () => { fireEvent.click(toggle(dialog, 'Cam')) })
    expect((toggle(dialog, 'Talk') as HTMLButtonElement).disabled).toBe(true)
    expect((toggle(dialog, 'Cam') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finish?.() })
    expect((toggle(dialog, 'Talk') as HTMLButtonElement).disabled).toBe(false)
    expect(toggle(dialog, 'Cam').getAttribute('aria-checked')).toBe('false')
  })

  it('reports a failed read, and a refused change that leaves the switch as it was', async () => {
    button({ path: '/games', read: () => Promise.resolve({ error: 'Permission denied.' }) })
    expect((await open()).textContent).toContain('Could not read the add-ons. Permission denied.')
    cleanup()
    button({ path: '/games', setAllowed: () => Promise.resolve({ error: 'The profile is read-only.' }) })
    const dialog = await open()
    await act(async () => { fireEvent.click(toggle(dialog, 'Cam')) })
    expect(within(dialog).getByRole('status').textContent).toBe('Could not change Cam. The profile is read-only.')
    expect(toggle(dialog, 'Cam').getAttribute('aria-checked')).toBe('true')
  })
})

describe('add-on dialog copy', () => {
  it('has every key in every language with the same placeholders', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1] as string).sort()
    for (const dictionary of [zh, ja, es, fr, de, ru, pt]) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
      for (const [key, text] of Object.entries(en)) {
        expect(placeholders(dictionary[key as keyof typeof en]), key).toEqual(placeholders(text))
      }
    }
  })
})
