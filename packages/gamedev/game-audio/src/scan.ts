/**
 * The Host's walk of a game project for sounds: a breadth-first listing of the project folder that collects every
 * file of a listed audio format, skipping hidden folders (a name starting with `.`, such as `.godot` and `.git`) and
 * `node_modules`, following links to folders once, and stopping at the configured folder and sound caps.
 * @module @deepseek-ai/dsh-game-audio/src/scan
 */
import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { audioFormatOf, type AudioFormat } from './audio/formats.ts'

/** One sound the walk found. */
export interface SoundFile {
  /** Workspace path: relative to the project folder and `/`-separated. */
  readonly path: string
  /** Workspace path of the folder holding it; empty for the project folder. */
  readonly folder: string
  readonly name: string
  readonly format: AudioFormat
  /** File size in bytes. */
  readonly bytes: number
  /** Modification time in milliseconds since the epoch. */
  readonly modified: number
}

/** What one walk found. */
export interface SoundScan {
  /** Sounds ordered by folder, then by name. */
  readonly sounds: readonly SoundFile[]
  /** A cap stopped the walk, so sounds may be missing. */
  readonly truncated: boolean
  /** Folders below the project folder that could not be listed; their sounds are missing. */
  readonly unreadable: number
}

/** Caps of one walk. */
export interface SoundScanLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Sounds collected before the walk stops. */
  readonly maxSounds: number
}

/** Orders folder paths and file names as people read them: case-insensitively, with numbers by value. */
export const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Whether the walk enters a folder.
 * @param name - the folder's name.
 * @returns false for a hidden folder and for `node_modules`.
 */
export function entersFolder(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules'
}

/** What a directory entry is, following a link once. */
async function entryKind(directory: string, entry: Dirent): Promise<{ readonly kind: 'file' | 'folder' | 'other'; readonly bytes?: number; readonly modified?: number }> {
  if (entry.isDirectory()) return { kind: 'folder' }
  if (!entry.isFile() && !entry.isSymbolicLink()) return { kind: 'other' }
  let info
  try {
    info = await stat(join(directory, entry.name))
  } catch {
    // ENOENT or EACCES: a dangling link or an entry removed while the walk ran holds no sound.
    return { kind: 'other' }
  }
  if (info.isDirectory()) return { kind: 'folder' }
  return info.isFile() ? { kind: 'file', bytes: info.size, modified: info.mtimeMs } : { kind: 'other' }
}

/**
 * Walk a project folder for sounds.
 * @param project - absolute path of the project folder.
 * @param limits - the folder and sound caps.
 * @param signal - cancellation; the walk rejects with its reason.
 * @returns the sounds found.
 * @throws when the project folder itself cannot be listed.
 */
export async function scanSounds(project: string, limits: SoundScanLimits, signal: AbortSignal): Promise<SoundScan> {
  const sounds: SoundFile[] = []
  const visited = new Set<string>([await realpath(project)])
  const queue: string[] = ['']
  let truncated = false
  let unreadable = 0
  let listed = 0
  while (queue.length > 0) {
    signal.throwIfAborted()
    if (listed >= limits.maxFolders || sounds.length >= limits.maxSounds) {
      truncated = true
      break
    }
    const folder = queue.shift() ?? ''
    const directory = folder === '' ? project : join(project, ...folder.split('/'))
    listed += 1
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (folder === '') throw error
      unreadable += 1
      continue
    }
    for (const entry of entries) {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`
      const format = audioFormatOf(entry.name)
      if (format === undefined && !entry.isDirectory() && !entry.isSymbolicLink()) continue
      const found = await entryKind(directory, entry)
      if (found.kind === 'folder') {
        if (!entersFolder(entry.name)) continue
        // A link back to a listed folder is not listed again.
        const real = await realpath(join(directory, entry.name)).catch(() => undefined)
        if (real === undefined || visited.has(real)) continue
        visited.add(real)
        queue.push(path)
      } else if (found.kind === 'file' && format !== undefined) {
        if (sounds.length >= limits.maxSounds) {
          truncated = true
          continue
        }
        sounds.push({ path, folder, name: entry.name, format, bytes: found.bytes ?? 0, modified: found.modified ?? 0 })
      }
    }
  }
  sounds.sort((left, right) => NAME_ORDER.compare(left.folder, right.folder) || NAME_ORDER.compare(left.name, right.name))
  return { sounds, truncated, unreadable }
}
