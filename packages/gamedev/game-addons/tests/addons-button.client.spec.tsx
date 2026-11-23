// @vitest-environment jsdom
/**
 * The Session header's Add-ons button: shown for a Session in a Workspace, it opens a dialog that lists the catalog by
 * category with each add-on's presence in the game and a switch that turns it on or off for agents, showing only
 * what the Host accepted, and narrows the list to what a search finds.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AddonsButton, type AddonsButtonInjected, type AddonsButtonProps } from '../src/client/AddonsButton.tsx'
import { CATEGORY_HEADINGS, CATEGORY_ORDER } from '../src/client/categories.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import type { GameAddonPresence, GameAddonsProjectView, GameAddonView } from '../src/types.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('session-1')

function addon(id: string, title: string, host: GameAddonView['host'], presence: GameAddonPresence | undefined, extra: Partial<GameAddonView> = {}): GameAddonView {
  return {
    id, title, host, version: '1.0', category: 'gameplay', cue: `${title} in a few words`, summary: `${title} summary.`, useWhen: `${title} use.`, tags: [], stages: ['content'],
    license: 'MIT', homepage: `https://example.test/${id}`, bytes: 2 * 1024 * 1024, conflicts: [], allowed: true,
    ...presence === undefined ? {} : { presence }, ...extra,
  }
}

/** An add-on that ships inside its application, so nothing is downloaded. */
function withoutBytes(view: GameAddonView, shipsWith: NonNullable<GameAddonView['shipsWith']> = 'blender'): GameAddonView {
  const { bytes: _bytes, ...rest } = view
  return { ...rest, shipsWith }
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
    // In catalog order: Godot add-ons first, each application's by title.
    addons: [
      addon('cam', 'Cam', 'godot', presence({ state: 'absent' }), { credit: 'Cam by Someone', category: 'camera', tags: ['follow'] }),
      addon('talk', 'Talk', 'godot', presence({ state: 'found', version: '0.9' })),
      withoutBytes(addon('wasd-sea', 'WASD Sea', 'godot', presence({ state: 'absent' }), { category: 'environment' }), 'app'),
      addon('humans', 'Humans', 'blender', presence({ state: 'absent' }), { category: 'characters', assets: { license: 'CC0-1.0', bytes: 1024, homepage: 'https://example.test/pack' } }),
      withoutBytes(addon('rig', 'Rig', 'blender', presence({ state: 'installed', version: '5.2.3' }), { category: 'characters' })),
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

  it('lists the add-ons under their categories with their facts, presence in the game, and a switch that is on by default', async () => {
    const { readProject } = button({ path: '/games' })
    const dialog = await open()
    expect(readProject).toHaveBeenCalledWith('/games')
    // A section for each category that holds an add-on, in the order of the catalog's index.
    expect(within(dialog).getAllByRole('region').map(section => section.getAttribute('aria-label'))).toEqual([
      en['addons.category.environment'], en['addons.category.characters'], en['addons.category.gameplay'], en['addons.category.camera'],
    ])
    const camera = within(dialog).getByRole('region', { name: en['addons.category.camera'] })
    expect(within(camera).getByRole('link', { name: 'Cam' }).getAttribute('href')).toBe('https://example.test/cam')
    // Cam has an icon. Talk, which has none, gets a tile with its first letter, and WASD Sea one with the letter after "WASD".
    expect(within(camera).getByRole('listitem').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
    const talk = within(within(dialog).getByRole('region', { name: en['addons.category.gameplay'] })).getByRole('listitem')
    expect(talk.querySelector('img')).toBeNull()
    expect(talk.firstElementChild?.textContent).toBe('T')
    expect(within(within(dialog).getByRole('region', { name: en['addons.category.environment'] })).getByRole('listitem').firstElementChild?.textContent).toBe('S')
    expect(within(dialog).getAllByText('1.0 · MIT · 2.0 MB')).toHaveLength(2)
    // WASD Sea is WASD Engine's own, so nothing is downloaded for it, as for Rig, which ships inside Blender.
    expect(within(dialog).getByText(`1.0 · MIT · ${en['addons.shipsWithApp']}`)).toBeTruthy()
    expect(within(camera).getByText('Use it when: Cam use.')).toBeTruthy()
    expect(within(camera).getByText('Its license requires this credit in the game: Cam by Someone')).toBeTruthy()
    // Talk is in the game as a copy without a record, Rig as an installation; Cam and Humans are not.
    expect(within(camera).queryByText(en['addons.inGame'])).toBeNull()
    expect(within(talk).getByText(en['addons.inGame'])).toBeTruthy()
    // The Blender add-ons stand among the others of their category, each marked as one.
    const characters = within(dialog).getByRole('region', { name: en['addons.category.characters'] })
    expect(within(characters).getAllByRole('link').map(link => link.textContent)).toEqual(['Humans', 'Rig'])
    expect(within(characters).getAllByText(en['addons.blenderAddon'])).toHaveLength(2)
    expect(within(dialog).getAllByText(en['addons.blenderAddon'])).toHaveLength(2)
    expect(within(characters).getByText(`1.0 · MIT · ${en['addons.shipsWithBlender']}`)).toBeTruthy()
    expect(within(characters).getByText('1.0 · MIT · 2.0 MB · with CC0-1.0 assets')).toBeTruthy()
    expect(within(characters).getAllByText(en['addons.inGame'])).toHaveLength(1)
    for (const title of ['Cam', 'Talk', 'WASD Sea', 'Rig', 'Humans']) expect(toggle(dialog, title).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).queryByRole('button', { name: /^Install|^Remove/u })).toBeNull()
  })

  it('opens with the search field focused and narrows the list to the add-ons that hold every word typed', async () => {
    button({ path: '/games' })
    const dialog = await open()
    const search = within(dialog).getByRole('textbox', { name: en['addons.search'] })
    expect(document.activeElement).toBe(search)
    const titles = (): (string | null)[] => within(dialog).queryAllByRole('link').map(link => link.textContent)
    const type = (text: string): void => { fireEvent.change(search, { target: { value: text } }) }
    // A word of a title, of a search word, of a category's heading, and the application each find their add-ons.
    type('sea')
    expect(titles()).toEqual(['WASD Sea'])
    expect(within(dialog).getAllByRole('region')).toHaveLength(1)
    type('FOLLOW')
    expect(titles()).toEqual(['Cam'])
    type('characters')
    expect(titles()).toEqual(['Humans', 'Rig'])
    type('blender')
    expect(titles()).toEqual(['Humans', 'Rig'])
    type('  blender   rig ')
    expect(titles()).toEqual(['Rig'])
    expect(within(dialog).queryByText(en['addons.noMatch'])).toBeNull()
    type('rig nothing')
    expect(titles()).toEqual([])
    expect(within(dialog).getByText(en['addons.noMatch'])).toBeTruthy()
    type('')
    expect(titles()).toHaveLength(5)
    // The next opening starts without the last search.
    type('sea')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['addons.close'] })) })
    const again = await open()
    expect(within(again).getByRole<HTMLInputElement>('textbox', { name: en['addons.search'] }).value).toBe('')
    expect(within(again).getAllByRole('link')).toHaveLength(5)
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

describe('the Add-ons dialog\'s sections', () => {
  it('follow the order of the catalog\'s index, each under a heading of its own', () => {
    // The order of CATEGORIES in src/catalog.ts, which tests/prompt.spec.ts pins: an agent reads the index in it.
    expect(CATEGORY_ORDER).toEqual(['environment', 'rendering', 'characters', 'physics', 'gameplay', 'camera', 'interface', 'two-d', 'kits', 'assets', 'testing'])
    const headings = CATEGORY_ORDER.map(category => en[CATEGORY_HEADINGS[category]])
    expect(new Set(headings).size).toBe(headings.length)
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
