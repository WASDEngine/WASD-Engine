/**
 * The project scan: the game project tabs' walk of a Session's workspace (`walkWorkspace` in `project-tab.ts`) that
 * collects every file whose extension the Assets tab lists, and notes the Godot scenes and resources, which may define
 * 2D animations over the images, and the folders holding `project.godot`, against which their `res://` paths resolve.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { formatOf, type AssetFormat } from './formats.ts'
import { NAME_ORDER, walkWorkspace, type ListFolder } from './project-tab.ts'

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
  /** Workspace paths of the Godot scenes and resources (`.tscn`, `.tres`), at most {@link MAX_GODOT_FILES}. */
  readonly godotFiles: readonly string[]
  /** Workspace paths of the folders holding `project.godot`; empty for the project folder itself. */
  readonly godotProjects: readonly string[]
}

/** Godot scenes and resources one scan notes. */
export const MAX_GODOT_FILES = 2000

/** Caps of one scan. */
export interface ScanLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Assets collected before the walk stops. */
  readonly maxAssets: number
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
  const godotFiles: string[] = []
  const godotProjects: string[] = []
  const caps = { maxFolders: limits.maxFolders, maxFiles: limits.maxAssets }
  const walk = await walkWorkspace(list, caps, signal, (file): AssetEntry | undefined => {
    if (file.name === 'project.godot') godotProjects.push(file.folder)
    if (/\.t(?:scn|res)$/iu.test(file.name) && godotFiles.length < MAX_GODOT_FILES) godotFiles.push(file.path)
    const format = formatOf(file.name)
    return format === undefined ? undefined : { ...file, format }
  })
  if (!walk.ok) return walk
  godotFiles.sort((left, right) => NAME_ORDER.compare(left, right))
  const { files, truncated, unreadable } = walk.value
  return { ok: true, value: { assets: [...files].sort(compareAssets), truncated, unreadable, godotFiles, godotProjects } }
}
