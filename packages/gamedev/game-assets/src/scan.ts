/**
 * The Host's walk of a game project for the asset tools: a breadth-first listing of the project folder that collects
 * every file of a listed format with its size. Like the Assets tab's scan, it skips hidden folders (a name starting
 * with `.`, such as `.godot` and `.git`) and `node_modules`, lists a folder reached again through a link once, and
 * stops at the folder and asset caps. A link is followed only when its real path lies inside the project folder's, so
 * that a link inside the project lists nothing outside it.
 * @module @deepseek-ai/dsh-game-assets/src/scan
 */
import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { formatOf, NAME_ORDER, type ExportCandidate } from './formats.ts'

/** One asset the walk found. */
export interface ProjectAsset extends ExportCandidate {
  /** File size in bytes. */
  readonly bytes: number
}

/** What one walk found. */
export interface ProjectScan {
  /** Assets ordered by folder, then by name. */
  readonly assets: readonly ProjectAsset[]
  /** A cap stopped the walk, so assets may be missing. */
  readonly truncated: boolean
  /** Folders below the project folder that could not be listed; their assets are missing. */
  readonly unreadable: number
}

/** Caps of one walk. */
export interface ScanLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Assets collected before the walk stops. */
  readonly maxAssets: number
}

/** One folder's listing. */
interface Listed {
  readonly folder: string
  readonly entries: Dirent[]
}

/** Folder listings in flight at once. */
const LIST_CONCURRENCY = 8

/** Folder names the walk never enters, besides hidden folders. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules'])

/**
 * Whether a real path lies inside a folder's real path, or is the folder.
 * @param folder - the folder's real path.
 * @param path - the real path.
 * @returns whether `path` is `folder` or below it.
 */
export function insideFolder(folder: string, path: string): boolean {
  const inside = relative(folder, path)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

/**
 * Whether the walk enters a folder.
 * @param name - the folder's name.
 * @returns false for a hidden folder and for `node_modules`.
 */
export function entersFolder(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_FOLDERS.has(name)
}

/**
 * Walk a project folder.
 * @param root - absolute path of the project folder.
 * @param limits - the walk's caps.
 * @param signal - cancellation.
 * @returns the assets found.
 * @throws when the project folder itself cannot be listed, or on cancellation.
 */
export async function scanProject(root: string, limits: ScanLimits, signal: AbortSignal): Promise<ProjectScan> {
  const assets: ProjectAsset[] = []
  const realRoot = await realpath(root)
  const seen = new Set<string>([realRoot])
  let pending: string[] = ['']
  let listed = 0
  let truncated = false
  let full = false
  let unreadable = 0
  while (pending.length > 0 && !full) {
    signal.throwIfAborted()
    const batch = pending.slice(0, LIST_CONCURRENCY)
    pending = pending.slice(batch.length)
    const results = await Promise.all(batch.map(async (folder): Promise<Listed | undefined> => {
      try {
        return { folder, entries: await readdir(join(root, folder), { withFileTypes: true }) }
      } catch (error) {
        if (folder === '') throw error
        return undefined
      }
    }))
    for (const result of results) {
      listed += 1
      if (result === undefined) {
        unreadable += 1
        continue
      }
      const { folder, entries } = result
      const children: string[] = []
      for (const entry of [...entries].sort((left, right) => NAME_ORDER.compare(left.name, right.name))) {
        const path = folder === '' ? entry.name : `${folder}/${entry.name}`
        const absolute = join(root, path)
        let directory = entry.isDirectory()
        let file = entry.isFile()
        if (entry.isSymbolicLink()) {
          try {
            // A link counts only where it leads inside the project.
            if (!insideFolder(realRoot, await realpath(absolute))) continue
            const target = await stat(absolute)
            directory = target.isDirectory()
            file = target.isFile()
          } catch {
            // ENOENT, ELOOP, or EACCES: a dangling, looping, or unreadable link names nothing to list.
            continue
          }
        }
        if (directory) {
          if (!entersFolder(entry.name)) continue
          let real: string
          try {
            real = await realpath(absolute)
          } catch {
            // ENOENT: the folder went away during the walk.
            continue
          }
          if (seen.has(real)) continue
          seen.add(real)
          children.push(path)
          continue
        }
        const format = file ? formatOf(entry.name) : undefined
        if (format === undefined) continue
        if (assets.length >= limits.maxAssets) {
          truncated = true
          full = true
          break
        }
        let bytes = 0
        try {
          bytes = (await stat(absolute)).size
        } catch {
          // ENOENT: the file went away during the walk.
          continue
        }
        assets.push({ path, name: entry.name, folder, format, bytes })
      }
      if (full) break
      pending.push(...children)
    }
    // Listed and waiting folders together stay within the folder cap; the folders cut are not listed.
    if (listed + pending.length > limits.maxFolders) {
      pending = pending.slice(0, Math.max(0, limits.maxFolders - listed))
      truncated = true
    }
  }
  assets.sort((left, right) => NAME_ORDER.compare(left.folder, right.folder) || NAME_ORDER.compare(left.name, right.name))
  return { assets, truncated, unreadable }
}
