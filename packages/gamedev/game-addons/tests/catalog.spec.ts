/** Loading and searching the add-on catalog. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GameAddonCatalogError, loadCatalog, MAX_ICON_BYTES, parseGuide, searchCatalog } from '../src/catalog.ts'
import { editableCatalogEntries, pin, scratch, TREE_ASSETS_ARCHIVE, URLS, writeCatalog, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

async function catalogWith(change: (entries: Record<string, Record<string, unknown>>) => void): Promise<string> {
  dir = await scratch('catalog')
  const entries = editableCatalogEntries()
  change(entries)
  return await writeCatalog(dir.root, entries)
}

describe('loadCatalog', () => {
  it('loads every entry with its guide header, Godot add-ons first and each group by title', async () => {
    const catalog = await loadCatalog(await catalogWith(() => {}))
    expect(catalog.entries.map(entry => entry.id)).toEqual(['other-camera', 'test-camera', 'test-rig', 'test-trees'])
    expect(catalog.get('test-camera')?.godot?.autoloads).toEqual([{ name: 'TestCameraManager', path: 'res://addons/test_camera/manager.gd' }])
    expect(catalog.guide('test-trees')).toEqual({ name: 'test-trees', description: 'test-trees is installed in this project. Load before using it.' })
    expect(catalog.folder('test-trees')).toBe(join(catalog.dir, 'test-trees'))
    expect(catalog.get('missing')).toBeUndefined()
  })

  it('skips folders without addon.json', async () => {
    const path = await catalogWith(() => {})
    await mkdir(join(path, 'references'), { recursive: true })
    expect((await loadCatalog(path)).entries).toHaveLength(4)
  })

  it.each([
    ['an id that differs from its folder', (entries: Record<string, Record<string, unknown>>) => { (entries['test-camera'] as Record<string, unknown>).id = 'camera' }, /must equal its folder name/u],
    ['a malformed SHA-256', (entries: Record<string, Record<string, unknown>>) => { ((entries['test-camera'] as Record<string, unknown>).archive as Record<string, unknown>).sha256 = 'abc' }, /not a valid add-on entry/u],
    ['an archive path with ..', (entries: Record<string, Record<string, unknown>>) => { ((entries['test-camera'] as Record<string, unknown>).archive as Record<string, unknown>).root = 'a/../b' }, /not a valid add-on entry/u],
    ['an unknown field', (entries: Record<string, Record<string, unknown>>) => { (entries['test-camera'] as Record<string, unknown>).extra = 1 }, /not a valid add-on entry/u],
    ['an http archive', (entries: Record<string, Record<string, unknown>>) => { ((entries['test-camera'] as Record<string, unknown>).archive as Record<string, unknown>).url = 'http://example.test/a.zip' }, /not a valid add-on entry/u],
    ['a Godot add-on without an archive', (entries: Record<string, Record<string, unknown>>) => { delete (entries['other-camera'] as Record<string, unknown>).archive }, /needs an archive/u],
    ['an autoload outside the add-on folder', (entries: Record<string, Record<string, unknown>>) => {
      ((entries['test-camera'] as Record<string, unknown>).godot as Record<string, unknown>).autoloads = [{ name: 'X', path: 'res://elsewhere/x.gd' }]
    }, /must point inside res:\/\/addons\/test_camera\//u],
    ['a core Blender add-on with an archive', (entries: Record<string, Record<string, unknown>>) => {
      (entries['test-rig'] as Record<string, unknown>).archive = (entries['test-trees'] as Record<string, unknown>).archive
    }, /core add-on has none/u],
    ['a conflict with an unknown id', (entries: Record<string, Record<string, unknown>>) => { (entries['test-trees'] as Record<string, unknown>).conflicts = ['nope'] }, /conflict nope is not another catalog add-on/u],
    ['a Godot add-on with an asset pack', (entries: Record<string, Record<string, unknown>>) => {
      (entries['test-camera'] as Record<string, unknown>).assets = { ...pin(URLS.treeAssets, TREE_ASSETS_ARCHIVE, ''), license: 'CC0-1.0', homepage: 'https://assets.example.test/' }
    }, /only a Blender add-on has an asset pack/u],
    ['a setup script that is not in the folder', (entries: Record<string, Record<string, unknown>>) => {
      (entries['test-trees'] as Record<string, unknown>).blender = { module: 'test_trees', kind: 'extension', setup: 'setup.py' }
    }, /Cannot read the setup script of test-trees/u],
    ['a Blender add-on with a license file', (entries: Record<string, Record<string, unknown>>) => {
      const archive = (entries['test-trees'] as Record<string, unknown>).archive as Record<string, unknown>
      archive.license = 'LICENSE'
    }, /archive\.license applies only to Godot add-ons/u],
    ['a Blender add-on without its bpy version', (entries: Record<string, Record<string, unknown>>) => { (entries['test-trees'] as Record<string, unknown>).verified = { date: '2026-11-11' } }, /verified\.bpy is missing/u],
  ])('rejects %s', async (_case, change, message) => {
    await expect(loadCatalog(await catalogWith(change))).rejects.toThrow(message)
  })

  it('reads an icon as a data URL, and refuses a missing, oversized, or scripted one', async () => {
    const withIcon = (file: string) => (entries: Record<string, Record<string, unknown>>) => {
      (entries['test-camera'] as Record<string, unknown>).icon = { file, source: 'https://example.test/camera.svg', license: 'MIT' }
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>'
    const good = await catalogWith(withIcon('icon.svg'))
    await writeFile(join(good, 'test-camera', 'icon.svg'), svg)
    const catalog = await loadCatalog(good)
    expect(catalog.icons).toEqual({ 'test-camera': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` })
    await expect(loadCatalog(await catalogWith(withIcon('icon.png')))).rejects.toThrow(/Cannot read the icon/u)
    const big = await catalogWith(withIcon('icon.png'))
    await writeFile(join(big, 'test-camera', 'icon.png'), new Uint8Array(MAX_ICON_BYTES + 1))
    await expect(loadCatalog(big)).rejects.toThrow(/at most 16384 fit/u)
    for (const bad of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><image href="https://example.test/a.png"/></svg>']) {
      const scripted = await catalogWith(withIcon('icon.svg'))
      await writeFile(join(scripted, 'test-camera', 'icon.svg'), bad)
      await expect(loadCatalog(scripted)).rejects.toThrow(/scripts or external references/u)
    }
  })

  it('rejects a guide whose name differs from its add-on id, and a guide without frontmatter', async () => {
    const path = await catalogWith(() => {})
    await writeFile(join(path, 'test-rig', 'SKILL.md'), '---\nname: rig\ndescription: x\n---\nbody\n')
    await expect(loadCatalog(path)).rejects.toThrow(/name rig must equal the add-on id test-rig/u)
    await writeFile(join(path, 'test-rig', 'SKILL.md'), '# no frontmatter\n')
    await expect(loadCatalog(path)).rejects.toThrow(GameAddonCatalogError)
  })

  it('rejects an unreadable catalog folder', async () => {
    await expect(loadCatalog('/nonexistent/catalog')).rejects.toThrow(/Cannot read the add-on catalog/u)
  })
})

describe('parseGuide', () => {
  it('splits frontmatter and body as skill files are read, with CRLF line ends', () => {
    expect(parseGuide('---\r\nname: x\r\ndescription: "Does: things"\r\n---\r\n\r\n# X\r\n', 'x')).toEqual({ name: 'x', description: 'Does: things', body: '\r\n# X\r\n' })
    expect(() => parseGuide('---\nname: x\n', 'x')).toThrow(/does not close/u)
    expect(() => parseGuide('---\nname: [\n---\n', 'x')).toThrow(/invalid YAML/u)
    expect(() => parseGuide('---\nname: x\n---\n', 'x')).toThrow(/needs string name and description/u)
  })
})

describe('searchCatalog', () => {
  it('ranks by id and title over tags over descriptions, filters by host and stage, and lists everything without words', async () => {
    const catalog = await loadCatalog(await catalogWith(() => {}))
    expect(searchCatalog(catalog.entries, { text: 'camera' }).map(entry => entry.id)).toEqual(['other-camera', 'test-camera'])
    expect(searchCatalog(catalog.entries, { text: 'I need a smoothing camera for my game' }).map(entry => entry.id)).toEqual(['test-camera', 'other-camera'])
    expect(searchCatalog(catalog.entries, { text: 'procedural' }).map(entry => entry.id)).toEqual(['test-trees'])
    expect(searchCatalog(catalog.entries, { text: 'rigging characters' }).map(entry => entry.id)).toEqual(['test-rig'])
    expect(searchCatalog(catalog.entries, { text: 'zzz' })).toEqual([])
    expect(searchCatalog(catalog.entries, { host: 'blender' }).map(entry => entry.id)).toEqual(['test-rig', 'test-trees'])
    expect(searchCatalog(catalog.entries, { stage: 'polish' }).map(entry => entry.id)).toEqual(['other-camera', 'test-camera'])
    expect(searchCatalog(catalog.entries, { text: 'the and plugin' })).toHaveLength(4)
  })
})
