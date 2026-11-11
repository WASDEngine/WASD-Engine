// @vitest-environment jsdom
/**
 * The Session header's Add-ons button: shown for a Session in a Workspace, it opens a dialog that lists the catalog by
 * application with each add-on's presence, installs one at a click, and removes one after a confirmation.
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

function addon(id: string, title: string, host: GameAddonView['host'], presence: GameAddonPresence, extra: Partial<GameAddonView> = {}): GameAddonView {
  return {
    id, title, host, version: '1.0', summary: `${title} summary.`, useWhen: `${title} use.`, tags: [], stages: ['content'],
    license: 'MIT', homepage: `https://example.test/${id}`, bytes: 2 * 1024 * 1024, conflicts: [], presence, ...extra,
  }
}

/** An add-on that ships inside its application, so nothing is downloaded. */
function withoutBytes(view: GameAddonView): GameAddonView {
  const { bytes: _bytes, ...rest } = view
  return rest
}

function view(presence: Readonly<Record<string, GameAddonPresence>> = {}): GameAddonsProjectView {
  return {
    projectDir: '/games/neon',
    icons: { cam: 'data:image/png;base64,aWNvbg==' },
    addons: [
      addon('cam', 'Cam', 'godot', presence.cam ?? { state: 'absent' }, { credit: 'Cam by Someone' }),
      addon('talk', 'Talk', 'godot', presence.talk ?? { state: 'found', version: '0.9' }),
      withoutBytes(addon('rig', 'Rig', 'blender', presence.rig ?? { state: 'installed', version: '5.2.3' })),
      addon('humans', 'Humans', 'blender', presence.humans ?? { state: 'absent' }, { assets: { license: 'CC0-1.0', bytes: 1024, homepage: 'https://example.test/pack' } }),
    ],
  }
}

function button(options: {
  readonly path?: string
  readonly read?: AddonsButtonInjected['readProject']
  readonly install?: AddonsButtonInjected['install']
  readonly remove?: AddonsButtonInjected['remove']
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
  const install = vi.fn<AddonsButtonInjected['install']>(options.install ?? (() => Promise.reject(new Error('unused'))))
  const remove = vi.fn<AddonsButtonInjected['remove']>(options.remove ?? (() => Promise.reject(new Error('unused'))))
  const props: AddonsButtonProps = {
    ...({} as AddonsButtonProps),
    sessionId: SESSION,
    useWorkspaces: bindSnapshotSelector(workspaces),
    t,
    readProject,
    install,
    remove,
  }
  render(<AddonsButton {...props} />)
  return { readProject, install, remove }
}

async function open(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['addons.button'] })) })
  return screen.getByRole('dialog', { name: en['addons.title'] })
}

describe('AddonsButton', () => {
  it('shows only for a Session in a Workspace', () => {
    button({})
    expect(screen.queryByRole('button', { name: en['addons.button'] })).toBeNull()
    cleanup()
    button({ path: '/games' })
    expect(screen.getByRole('button', { name: en['addons.button'] }).title).toBe(en['addons.tooltip'])
  })

  it('lists Godot and Blender add-ons with their facts and presence', async () => {
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
    expect(within(godot).getByText(en['addons.found'])).toBeTruthy()
    const blender = within(dialog).getByRole('region', { name: en['addons.blender'] })
    expect(within(blender).getByText(`1.0 · MIT · ${en['addons.shipsWithBlender']}`)).toBeTruthy()
    expect(within(blender).getByText('1.0 · MIT · 2.0 MB · with CC0-1.0 assets')).toBeTruthy()
    expect(within(blender).getByText(en['addons.installed'])).toBeTruthy()
    expect(within(blender).getByRole('button', { name: 'Remove Rig' })).toBeTruthy()
  })

  it('installs at a click and shows the new presence', async () => {
    let installed = false
    const { install } = button({
      path: '/games',
      read: () => Promise.resolve({ value: view(installed ? { cam: { state: 'installed', version: '1.0' } } : {}) }),
      install: () => {
        installed = true
        return Promise.resolve({ value: { addon: { id: 'cam', title: 'Cam', host: 'godot', version: '1.0', license: 'MIT', paths: ['addons/cam'], installedAt: 'now' }, projectDir: '/games/neon', unchanged: false, importIssues: [], notes: [] } })
      },
    })
    const dialog = await open()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Install Cam' })) })
    expect(install).toHaveBeenCalledWith('/games', 'cam')
    expect(within(dialog).getByRole('status').textContent).toBe('Installed Cam. The agent now has its guide.')
    expect(within(dialog).getByRole('button', { name: 'Remove Cam' })).toBeTruthy()
  })

  it('removes only after confirmation and names files that still use the add-on', async () => {
    const { remove } = button({
      path: '/games',
      remove: () => Promise.resolve({ value: { id: 'rig', projectDir: '/games/neon', removed: [], references: ['a.gd', 'b.tscn'] } }),
    })
    const dialog = await open()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Rig' })) })
    expect(remove).not.toHaveBeenCalled()
    const question = within(dialog).getByRole('alert')
    expect(question.textContent).toContain('Remove Rig? Scenes and scripts that use it stop working.')
    await act(async () => { fireEvent.click(within(question).getByRole('button', { name: en['addons.cancel'] })) })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Rig' })) })
    await act(async () => { fireEvent.click(within(within(dialog).getByRole('alert')).getByRole('button', { name: en['addons.remove'] })) })
    expect(remove).toHaveBeenCalledWith('/games', 'rig')
    expect(within(dialog).getByRole('status').textContent).toBe('Removed Rig. These files still use it: a.gd, b.tscn')
  })

  it('reports a failed read and a failed change', async () => {
    button({ path: '/games', read: () => Promise.resolve({ error: 'No project.godot in /games.' }) })
    expect((await open()).textContent).toContain('Could not read this project\'s add-ons. No project.godot in /games.')
    cleanup()
    button({ path: '/games', install: () => Promise.resolve({ error: 'Download failed.' }) })
    const dialog = await open()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Install Cam' })) })
    expect(within(dialog).getByRole('status').textContent).toBe('Could not change Cam. Download failed.')
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
