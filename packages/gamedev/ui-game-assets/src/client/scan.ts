/**
 * The project scan: a breadth-first walk of a Session's workspace through the `workspaceFiles.list` Remote that
 * collects every file whose extension the Assets tab lists. The walk skips hidden folders (a name starting with `.`,
 * such as `.godot` and `.git`) and `node_modules`, lists a few folders at a time, and stops at the configured folder
 * and asset caps. A folder reached a second time, through a link to a folder already listed, is not listed again,
 * because the Host reports a listed folder by the path it resolves to.
 */
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { formatOf, type AssetFormat } from './formats.ts'

/** One asset the scan found. */
export interface AssetEntry {
  /** Workspace path: relative to the project folder and `/`-separated. */
  readonly path: string
  /** File name. */
  readonly name: string
  /** Workspace path of the folder holding the asset; empty for the project folder itself. */
  readonly folder: string
  /** The asset's format. */
  readonly format: AssetFormat
  /** File size in bytes, when the filesystem reports it. */
  readonly bytes?: number
}

/** What one scan found. */
export interface AssetScan {
  /** Assets ordered by folder, then by name. */
  readonly assets: readonly AssetEntry[]
  /** A cap stopped the walk or cut a folder's listing, so assets may be missing. */
  readonly truncated: boolean
  /** Folders below the project folder whose listing failed; their assets are missing. */
  readonly unreadable: number
}

/** Caps of one scan. */
export interface ScanLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Assets collected before the walk stops. */
  readonly maxAssets: number
}

/**
 * List one workspace folder.
 * @param path - workspace path of the folder; `.` names the project folder.
 * @param signal - cancellation.
 * @returns the listing, or the Remote failure.
 */
export type ListFolder = (path: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceDirectoryListing>>

/** Folder listings in flight at once. */
const LIST_CONCURRENCY = 6

/** Folder names the walk never enters, besides hidden folders. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules'])

/** Orders folder paths and file names the way people read them: case-insensitively, with numbers by value. */
export const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Whether the walk enters a folder.
 * @param name - the folder's name.
 * @returns false for a hidden folder and for `node_modules`.
 */
export function entersFolder(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_FOLDERS.has(name)
}

/**
 * Join a listed folder's workspace path and a child's name.
 * @param folder - the listed folder; empty for the project folder.
 * @param name - the child's name.
 * @returns the child's workspace path.
 */
export function childPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/**
 * Order file names by the name without its extension, then by the extension, so `hero.glb` precedes `hero_skin.png`.
 * @param left - one name.
 * @param right - another name.
 * @returns the collator's comparison.
 */
export function compareNames(left: string, right: string): number {
  const split = (name: string): readonly [string, string] => {
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot + 1)]
  }
  const [leftStem, leftExtension] = split(left)
  const [rightStem, rightExtension] = split(right)
  return NAME_ORDER.compare(leftStem, rightStem) || NAME_ORDER.compare(leftExtension, rightExtension) || NAME_ORDER.compare(left, right)
}

/**
 * Order assets by folder, then by name.
 * @param left - one asset.
 * @param right - another asset.
 * @returns the comparison.
 */
export function compareAssets(left: AssetEntry, right: AssetEntry): number {
  return NAME_ORDER.compare(left.folder, right.folder) || compareNames(left.name, right.name)
}

/**
 * Walk the project for assets.
 * @param list - the bound folder listing.
 * @param limits - the folder and asset caps.
 * @param signal - cancellation; the walk stops listing and rejects with the signal's reason.
 * @returns the assets found, or the failure of the project folder's own listing.
 */
export async function scanAssets(list: ListFolder, limits: ScanLimits, signal: AbortSignal): Promise<RemoteResult<AssetScan>> {
  signal.throwIfAborted()
  const root = await list('.', signal)
  signal.throwIfAborted()
  if (!root.ok) return root
  const assets: AssetEntry[] = []
  const visited = new Set<string>([root.value.path])
  const queue: string[] = []
  let truncated = false
  let unreadable = 0
  let listed = 1
  const take = (listing: WorkspaceDirectoryListing): void => {
    if (listing.truncated) truncated = true
    for (const entry of listing.entries) {
      const path = childPath(listing.path, entry.name)
      if (entry.type === 'directory') {
        if (entersFolder(entry.name)) queue.push(path)
        continue
      }
      if (entry.type !== 'file') continue
      const format = formatOf(entry.name)
      if (format === undefined) continue
      if (assets.length >= limits.maxAssets) {
        truncated = true
        continue
      }
      assets.push({
        path, name: entry.name, folder: listing.path, format, ...entry.size === undefined ? {} : { bytes: entry.size },
      })
    }
  }
  take(root.value)
  const settle = (result: RemoteResult<WorkspaceDirectoryListing>): void => {
    if (!result.ok) {
      // A folder removed while the walk ran has no assets left to miss.
      if (result.error.code !== 'workspace-file/not-found') unreadable += 1
      return
    }
    if (visited.has(result.value.path)) return
    visited.add(result.value.path)
    take(result.value)
  }
  // A listing that rejects ends the walk with its reason, once the listings in flight settled.
  const outcome = await new Promise<{ readonly kind: 'done' } | { readonly kind: 'rejected'; readonly reason: unknown }>((resolve) => {
    let active = 0
    let rejection: { readonly reason: unknown } | undefined
    // Starts listings up to the concurrency while folders wait and no cap is reached; resolves once none is in flight.
    const pump = (): void => {
      while (active < LIST_CONCURRENCY && queue.length > 0 && rejection === undefined && !signal.aborted) {
        if (assets.length >= limits.maxAssets || listed >= limits.maxFolders) {
          truncated = true
          break
        }
        const path = queue.shift() as string
        listed += 1
        active += 1
        list(path, signal).then((result) => {
          active -= 1
          if (rejection === undefined && !signal.aborted) settle(result)
          pump()
        }, (reason: unknown) => {
          active -= 1
          rejection ??= { reason }
          pump()
        })
      }
      if (active === 0) resolve(rejection === undefined ? { kind: 'done' } : { kind: 'rejected', reason: rejection.reason })
    }
    pump()
  })
  signal.throwIfAborted()
  if (outcome.kind === 'rejected') throw outcome.reason
  return { ok: true, value: { assets: assets.sort(compareAssets), truncated, unreadable } }
}
