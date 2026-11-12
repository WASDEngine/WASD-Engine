/**
 * The Audio tab's list: every sound with its kind and header facts, filtered by kind, then either grouped under its
 * folder, folder by folder in the project's order, or, while the listener searches, ranked by how well its name or
 * path matches, best first.
 */
import { audioCategoryOf, type AudioCategory, type AudioProbe } from '@deepseek-ai/dsh-game-audio/audio'
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SoundEntry, SoundScan } from './scan.ts'
import type { ProbeEntry, ViewState } from './source.ts'

/** One sound of the list. */
export interface SoundItem {
  readonly entry: SoundEntry
  readonly kind: AudioCategory
  /** What its headers said, once they were read. */
  readonly probe?: AudioProbe
}

/** One row of the list: a folder heading, or a sound. */
export type ListRow =
  | { readonly type: 'folder'; readonly folder: string; readonly count: number; readonly open: boolean }
  | { readonly type: 'sound'; readonly item: SoundItem; readonly withFolder: boolean }

/**
 * The sounds of a walk with their kinds.
 * @param scan - the walk.
 * @param probes - what the sounds' headers said.
 * @returns the sounds in the walk's order.
 */
export function soundItems(scan: SoundScan, probes: ReadonlyMap<string, ProbeEntry>): SoundItem[] {
  return scan.sounds.map((entry) => {
    const known = probes.get(entry.path)
    const probe = known !== undefined && known.bytes === entry.bytes ? known.probe : undefined
    return { entry, kind: audioCategoryOf(entry.path, probe?.seconds).category, ...probe === undefined ? {} : { probe } }
  })
}

/**
 * The sounds the list shows, in its order.
 * @param items - every sound.
 * @param view - the search text and kind filter.
 * @returns the shown sounds: folder by folder without a search, best match first with one.
 */
export function shownSounds(items: readonly SoundItem[], view: Pick<ViewState, 'query' | 'filter'>): readonly SoundItem[] {
  const ofKind = view.filter === 'all' ? items : items.filter(item => item.kind === view.filter)
  const query = view.query.trim()
  if (query === '') return ofKind
  return rankByName(ofKind.map(item => ({ name: item.entry.name, label: item.entry.path, item })), query).map(match => match.item)
}

/**
 * The rows of the list.
 * @param shown - the shown sounds, from {@link shownSounds}.
 * @param view - the search text and the folders folded shut.
 * @returns folder headings with their sounds, or, while searching, the ranked sounds with their folders.
 */
export function listRows(shown: readonly SoundItem[], view: Pick<ViewState, 'query' | 'closed'>): ListRow[] {
  if (view.query.trim() !== '') return shown.map(item => ({ type: 'sound', item, withFolder: true }))
  const rows: ListRow[] = []
  const closed = new Set(view.closed)
  let index = 0
  while (index < shown.length) {
    const folder = shown[index]?.entry.folder ?? ''
    let end = index
    while (end < shown.length && shown[end]?.entry.folder === folder) end += 1
    const open = !closed.has(folder)
    rows.push({ type: 'folder', folder, count: end - index, open })
    if (open) for (const item of shown.slice(index, end)) rows.push({ type: 'sound', item, withFolder: false })
    index = end
  }
  return rows
}

/**
 * The sound a step away from the selected one among the rows' sounds, for the arrow keys.
 * @param rows - the list's rows.
 * @param selected - workspace path of the selected sound, if any.
 * @param step - `1` for the next sound, `-1` for the previous one.
 * @returns the sound to select; the first or last one without a selection; undefined past either end.
 */
export function stepSound(rows: readonly ListRow[], selected: string | undefined, step: 1 | -1): SoundItem | undefined {
  const sounds = rows.flatMap(row => row.type === 'sound' ? [row.item] : [])
  const at = sounds.findIndex(item => item.entry.path === selected)
  if (at < 0) return step === 1 ? sounds[0] : sounds[sounds.length - 1]
  return sounds[at + step]
}
