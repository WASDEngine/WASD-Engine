/** The picker's folder tree and search: which folders hold assets, how rows draw, which open, and how search ranks. */
import { describe, expect, it } from 'vitest'
import { formatOf } from '../src/client/formats.ts'
import { compareAssets, type AssetEntry } from '../src/client/scan.ts'
import { buildTree, initialOpen, rowsAbove, searchAssets, treeRows, type TreeRow } from '../src/client/tree.ts'

function asset(path: string): AssetEntry {
  const format = formatOf(path)
  if (format === undefined) throw new Error(`no format for ${path}`)
  const slash = path.lastIndexOf('/')
  return { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format }
}

const ASSETS = [
  'icon.svg',
  'assets/models/archer.glb',
  'assets/models/barracks.glb',
  'assets/models/archer_basecolor.png',
  'assets/models/src/archer.blend',
  'assets/textures/grass.png',
  'assets/ui/icons/gold.png',
  'assets/ui/icons/wood.png',
  'docs/art_reference.webp',
].map(asset).sort(compareAssets)

function labels(rows: readonly TreeRow[]): string[] {
  return rows.map(row => `${'  '.repeat(row.depth)}${row.kind === 'folder' ? `${row.open ? 'v' : '>'} ${row.label}/ (${String(row.node.count)})` : row.asset.name}`)
}

describe('buildTree', () => {
  it('nests folders by name with their asset counts and drops folders a filter empties', () => {
    const root = buildTree(ASSETS, 'all')
    expect(root.count).toBe(9)
    expect(root.folders.map(folder => [folder.name, folder.count])).toEqual([['assets', 7], ['docs', 1]])
    expect(root.assets.map(entry => entry.name)).toEqual(['icon.svg'])
    const models = buildTree(ASSETS, 'model')
    expect(models.count).toBe(3)
    expect(models.folders.map(folder => folder.path)).toEqual(['assets'])
    expect(models.folders[0]?.folders.map(folder => folder.path)).toEqual(['assets/models'])
    expect(buildTree([], 'all')).toEqual({ path: '', name: '', folders: [], assets: [], count: 0 })
  })
})

describe('treeRows', () => {
  it('draws folders before assets, opens only open folders, and joins chains of single folders', () => {
    const root = buildTree(ASSETS, 'all')
    expect(labels(treeRows(root, new Set()))).toEqual(['> assets/ (7)', '> docs/ (1)', 'icon.svg'])
    expect(labels(treeRows(root, new Set(['assets', 'assets/models', 'assets/ui/icons'])))).toEqual([
      'v assets/ (7)',
      '  v models/ (4)',
      '    > src/ (1)',
      '    archer.glb',
      '    archer_basecolor.png',
      '    barracks.glb',
      '  > textures/ (1)',
      '  v ui/icons/ (2)',
      '    gold.png',
      '    wood.png',
      '> docs/ (1)',
      'icon.svg',
    ])
  })

  it('keys a joined row by its innermost folder', () => {
    const rows = treeRows(buildTree(ASSETS, 'all'), new Set(['assets']))
    const joined = rows.find(row => row.kind === 'folder' && row.label === 'ui/icons')
    expect(joined?.kind === 'folder' && joined.node.path).toBe('assets/ui/icons')
  })
})

describe('open folders', () => {
  it('opens the folders above an asset, by row key, and nothing for an asset the tree does not hold', () => {
    const root = buildTree(ASSETS, 'all')
    expect(rowsAbove(root, 'assets/ui/icons/gold.png')).toEqual(['assets', 'assets/ui/icons'])
    expect(rowsAbove(root, 'assets/models/src/archer.blend')).toEqual(['assets', 'assets/models', 'assets/models/src'])
    expect(rowsAbove(root, 'icon.svg')).toEqual([])
    expect(rowsAbove(root, 'assets/missing.png')).toEqual([])
  })

  it('first opens the top folders and the selected asset\'s folders', () => {
    const root = buildTree(ASSETS, 'all')
    expect(initialOpen(root, undefined)).toEqual(['assets', 'docs'])
    expect(initialOpen(root, 'assets/textures/grass.png')).toEqual(['assets', 'docs', 'assets/textures'])
  })
})

describe('searchAssets', () => {
  it('ranks name matches first, matches paths too, keeps the filter, and returns nothing for a blank query', () => {
    expect(searchAssets(ASSETS, 'archer', 'all').map(entry => entry.path)).toEqual([
      'assets/models/archer.glb',
      'assets/models/archer_basecolor.png',
      'assets/models/src/archer.blend',
    ])
    expect(searchAssets(ASSETS, 'ARCHER', 'image').map(entry => entry.path)).toEqual(['assets/models/archer_basecolor.png'])
    expect(searchAssets(ASSETS, 'icons/', 'all').map(entry => entry.name)).toEqual(['gold.png', 'wood.png'])
    expect(searchAssets(ASSETS, '   ', 'all')).toEqual([])
    expect(searchAssets(ASSETS, 'zzz', 'all')).toEqual([])
  })

  it('keeps only assets that contain the query when any do, and matches characters in order otherwise', () => {
    // `bar` is in barracks.glb's name; the in-order match would also find `archer_basecolor.png` (b…a…r).
    expect(searchAssets(ASSETS, 'bar', 'all').map(entry => entry.name)).toEqual(['barracks.glb'])
    // No asset contains `arcbl`, so assets with those letters in order match, the closest first.
    expect(searchAssets(ASSETS, 'arcbl', 'all').map(entry => entry.path))
      .toEqual(['assets/models/src/archer.blend', 'assets/models/archer_basecolor.png'])
  })
})
