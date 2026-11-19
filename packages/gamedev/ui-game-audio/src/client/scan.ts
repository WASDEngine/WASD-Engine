/**
 * The Audio tab's walk of a Session's workspace for sounds: the game project tabs' walk (`walkWorkspace` of
 * `@deepseek-ai/dsh-client-ui-game-assets/client/project-tab`), which collects every file of a listed audio format and stops at
 * the configured folder and sound caps.
 */
import { audioFormatOf, type AudioFormat } from '@deepseek-ai/dsh-game-audio/audio'
import { NAME_ORDER, walkWorkspace, type ListFolder } from '@deepseek-ai/dsh-client-ui-game-assets/client/project-tab'
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
  const caps = { maxFolders: limits.maxFolders, maxFiles: limits.maxSounds }
  const walk = await walkWorkspace(list, caps, signal, (file): SoundEntry | undefined => {
    const format = audioFormatOf(file.name)
    return format === undefined ? undefined : { ...file, format }
  })
  if (!walk.ok) return walk
  const { files, truncated, unreadable } = walk.value
  return { ok: true, value: { sounds: [...files].sort(compareSounds), truncated, unreadable } }
}
