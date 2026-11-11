/**
 * The picker's two views of one scan: the folder tree, whose rows depend on which folders are open, and the ranked
 * search results. A folder that holds no asset, directly or below, is not in the tree; a folder whose only content is
 * one folder shares a row with it (`ui/icons`), keyed by the inner folder.
 */
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssetKind } from './formats.ts'
import { compareNames, NAME_ORDER, type AssetEntry } from './scan.ts'

/** One folder of the tree. */
export interface FolderNode {
  /** Workspace path; empty for the project folder. */
  readonly path: string
  /** The folder's name; empty for the project folder. */
  readonly name: string
  /** Child folders that hold assets, by name. */
  readonly folders: readonly FolderNode[]
  /** Assets directly in the folder, by name. */
  readonly assets: readonly AssetEntry[]
  /** Assets in the folder and below it. */
  readonly count: number
}

/** One drawn row of the folder tree. */
export type TreeRow =
  | {
    readonly kind: 'folder'
    /** The innermost folder of the row; its path keys the row and its open state. */
    readonly node: FolderNode
    /** The row's label: the folder's name, or the names of a chain of single folders joined by `/`. */
    readonly label: string
    /** Nesting level; 0 for the project folder's children. */
    readonly depth: number
    readonly open: boolean
  }
  | { readonly kind: 'asset'; readonly asset: AssetEntry; readonly depth: number }

/** Which assets the picker shows. */
export type KindFilter = 'all' | AssetKind

interface MutableFolder {
  readonly path: string
  readonly name: string
  readonly folders: Map<string, MutableFolder>
  readonly assets: AssetEntry[]
}

/**
 * Build the folder tree of a scan.
 * @param assets - the scan's assets, ordered by folder and name.
 * @param filter - the kinds to keep; folders left without assets drop out.
 * @returns the project folder's node.
 */
export function buildTree(assets: readonly AssetEntry[], filter: KindFilter): FolderNode {
  const root: MutableFolder = { path: '', name: '', folders: new Map(), assets: [] }
  for (const asset of assets) {
    if (filter !== 'all' && asset.format.kind !== filter) continue
    let folder = root
    if (asset.folder !== '') {
      for (const name of asset.folder.split('/')) {
        let next = folder.folders.get(name)
        if (next === undefined) {
          next = { path: folder.path === '' ? name : `${folder.path}/${name}`, name, folders: new Map(), assets: [] }
          folder.folders.set(name, next)
        }
        folder = next
      }
    }
    folder.assets.push(asset)
  }
  const freeze = (folder: MutableFolder): FolderNode => {
    const folders = [...folder.folders.values()].sort((left, right) => NAME_ORDER.compare(left.name, right.name)).map(freeze)
    const own = [...folder.assets].sort((left, right) => compareNames(left.name, right.name))
    return {
      path: folder.path,
      name: folder.name,
      folders,
      assets: own,
      count: own.length + folders.reduce((sum, child) => sum + child.count, 0),
    }
  }
  return freeze(root)
}

/**
 * The folder a row stands for after joining a chain of folders that each hold only one folder.
 * @param node - the outer folder of the chain.
 * @returns the innermost folder and the joined label.
 */
function compact(node: FolderNode): { readonly node: FolderNode; readonly label: string } {
  let current = node
  let label = node.name
  while (current.assets.length === 0 && current.folders.length === 1) {
    current = current.folders[0] as FolderNode
    label = `${label}/${current.name}`
  }
  return { node: current, label }
}

/**
 * The rows the tree draws: folders before assets at each level, and the contents of open folders after their row.
 * @param root - the project folder's node.
 * @param open - workspace paths of the open folders.
 * @returns the rows in drawing order.
 */
export function treeRows(root: FolderNode, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (folder: FolderNode, depth: number): void => {
    for (const child of folder.folders) {
      const { node, label } = compact(child)
      const expanded = open.has(node.path)
      rows.push({ kind: 'folder', node, label, depth, open: expanded })
      if (expanded) visit(node, depth + 1)
    }
    for (const asset of folder.assets) rows.push({ kind: 'asset', asset, depth })
  }
  visit(root, 0)
  return rows
}

/**
 * The workspace paths of the folders that hold an asset, outermost first, as the tree keys their rows.
 * @param root - the project folder's node.
 * @param asset - workspace path of the asset.
 * @returns the row keys to open so the asset's row is drawn; empty when the tree does not hold the asset.
 */
export function rowsAbove(root: FolderNode, asset: string): string[] {
  const keys: string[] = []
  let folder = root
  for (;;) {
    if (folder.assets.some(candidate => candidate.path === asset)) return keys
    const child = folder.folders.find(candidate => asset.startsWith(`${candidate.path}/`))
    if (child === undefined) return []
    const { node } = compact(child)
    keys.push(node.path)
    folder = node
  }
}

/**
 * Folders open when the picker first draws a scan: the project folder's children, so the top of the tree shows, and
 * the folders above the selected asset.
 * @param root - the project folder's node.
 * @param selected - workspace path of the selected asset, if any.
 * @returns row keys to open.
 */
export function initialOpen(root: FolderNode, selected: string | undefined): string[] {
  const keys = new Set(root.folders.map(child => compact(child).node.path))
  if (selected !== undefined) for (const key of rowsAbove(root, selected)) keys.add(key)
  return [...keys]
}

/**
 * Rank assets by a search query, matched against the file name and the workspace path. Assets whose name or path
 * contains the query, ignoring case, are the results when there are any; otherwise the query matches its characters
 * in order, as the app's menus do, so an abbreviation or a typo still finds an asset.
 * @param assets - the scan's assets.
 * @param query - the typed text; blank returns no results.
 * @param filter - the kinds to keep.
 * @returns the matching assets, best match first.
 */
export function searchAssets(assets: readonly AssetEntry[], query: string, filter: KindFilter): AssetEntry[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const candidates = assets
    .filter(asset => filter === 'all' || asset.format.kind === filter)
    .map(asset => ({ name: asset.name, label: asset.path, asset }))
  const lower = trimmed.toLowerCase()
  const containing = candidates.filter(candidate => candidate.label.toLowerCase().includes(lower))
  return rankByName(containing.length > 0 ? containing : candidates, trimmed).map(candidate => candidate.asset)
}
