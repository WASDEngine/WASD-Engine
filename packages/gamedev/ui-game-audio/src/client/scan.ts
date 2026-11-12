/**
 * The Audio tab's walk of a Session's workspace for sounds, through the `workspaceFiles.list` Remote: folder level by
 * folder level, a few listings at a time, it collects every file of a listed audio format, skipping hidden folders
 * (a name starting with `.`, such as `.godot` and `.git`) and `node_modules`, and stops at the configured folder and
 * sound caps. A folder reached again through a link is not listed twice, because the Host reports a listed folder by
 * the path it resolves to.
 */
import { audioFormatOf, type AudioFormat } from '@deepseek-ai/dsh-game-audio/audio'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** One sound the walk found. */
export interface SoundEntry {
  /** Workspace path: relative to the project folder and `/`-separated. */
  readonly path: string
  readonly name: string
  /** Workspace path of the folder holding the sound; empty for the project folder itself. */
  readonly folder: string
  readonly format: AudioFormat
  /** File size in bytes, when the filesystem reports it. */
  readonly bytes?: number
}

/** What one walk found. */
export interface SoundScan {
  /** Sounds ordered by folder, then by name. */
  readonly sounds: readonly SoundEntry[]
  /** A cap stopped the walk or cut a folder's listing, so sounds may be missing. */
  readonly truncated: boolean
  /** Folders below the project folder whose listing failed; their sounds are missing. */
  readonly unreadable: number
}

/** Caps of one walk. */
export interface ScanLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Sounds collected before the walk stops. */
  readonly maxSounds: number
}

/**
 * List one workspace folder.
 * @param path - workspace path of the folder; `.` names the project folder.
 * @param signal - cancellation.
 * @returns the listing, or the Remote failure.
 */
export type ListFolder = (path: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceDirectoryListing>>

/** Folder listings in flight at once. */
const LISTINGS_AT_ONCE = 6

/** Orders folder paths and file names as people read them: case-insensitively, with numbers by value. */
export const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order sounds by folder, then by name.
 * @param left - one sound.
 * @param right - another sound.
 * @returns the comparison.
 */
export function compareSounds(left: SoundEntry, right: SoundEntry): number {
  return NAME_ORDER.compare(left.folder, right.folder) || NAME_ORDER.compare(left.name, right.name)
}

/**
 * Walk the project for sounds.
 * @param list - the bound folder listing.
 * @param limits - the folder and sound caps.
 * @param signal - cancellation; the walk stops and rejects with its reason.
 * @returns the sounds found, or the failure of the project folder's own listing.
 */
export async function scanSounds(list: ListFolder, limits: ScanLimits, signal: AbortSignal): Promise<RemoteResult<SoundScan>> {
  signal.throwIfAborted()
  const root = await list('.', signal)
  signal.throwIfAborted()
  if (!root.ok) return root
  const sounds: SoundEntry[] = []
  const seen = new Set<string>()
  let truncated = false
  let unreadable = 0
  let listings = 1
  /** Take one listing's sounds and return its subfolders. */
  const take = (listing: WorkspaceDirectoryListing): string[] => {
    if (seen.has(listing.path)) return []
    seen.add(listing.path)
    if (listing.truncated) truncated = true
    const folders: string[] = []
    for (const entry of listing.entries) {
      const path = listing.path === '' ? entry.name : `${listing.path}/${entry.name}`
      if (entry.type === 'directory') {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') folders.push(path)
        continue
      }
      const format = entry.type === 'file' ? audioFormatOf(entry.name) : undefined
      if (format === undefined) continue
      if (sounds.length >= limits.maxSounds) {
        truncated = true
        continue
      }
      sounds.push({ path, name: entry.name, folder: listing.path, format, ...entry.size === undefined ? {} : { bytes: entry.size } })
    }
    return folders
  }
  let level = take(root.value)
  while (level.length > 0) {
    const room = limits.maxFolders - listings
    if (room <= 0 || sounds.length >= limits.maxSounds) {
      truncated = true
      break
    }
    const batch = level.slice(0, room)
    if (batch.length < level.length) truncated = true
    listings += batch.length
    const next: string[] = []
    for (let start = 0; start < batch.length; start += LISTINGS_AT_ONCE) {
      const results = await Promise.all(batch.slice(start, start + LISTINGS_AT_ONCE).map(folder => list(folder, signal)))
      signal.throwIfAborted()
      for (const result of results) {
        if (result.ok) next.push(...take(result.value))
        // A folder removed while the walk ran has no sounds left to miss.
        else if (result.error.code !== 'workspace-file/not-found') unreadable += 1
      }
    }
    level = next
  }
  return { ok: true, value: { sounds: sounds.sort(compareSounds), truncated, unreadable } }
}
