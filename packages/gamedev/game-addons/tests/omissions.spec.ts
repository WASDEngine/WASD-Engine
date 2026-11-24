/**
 * What an installation leaves out of the game project and rewrites: the paths an entry's `archive.exclude` names, such
 * as demos that a Web release would pack, and, for a project archive such as a starter kit, its `project.godot`, import
 * cache, and export presets, with the kit's `res://` paths rewritten to the add-on folder.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unpackFolder } from '../src/archive.ts'
import { loadCatalog } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { PROJECT_ROOT_SKIPPED, rebaseProjectPaths } from '../src/project-root.ts'
import { editableCatalogEntries, fakeDownloads, pin, scratch, writeCatalog, writeProject, zip, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

/** An add-on whose folder carries a demo and screenshots beside its scripts. */
const HEAVY_ARCHIVE = zip({
  'heavy-2.0/LICENSE': 'MIT License\n\nCopyright (c) 2026 Heavy Author\n',
  'heavy-2.0/addons/heavy/plugin.cfg': '[plugin]\n\nname="Heavy"\nversion="2.0"\nscript="plugin.gd"\n',
  'heavy-2.0/addons/heavy/plugin.gd': '@tool\nextends EditorPlugin\n',
  'heavy-2.0/addons/heavy/trail.gd': 'class_name HeavyTrail\nextends Node3D\n',
  'heavy-2.0/addons/heavy/Trail.cs': 'public partial class Trail {}\n',
  'heavy-2.0/addons/heavy/demo/demo.tscn': '[gd_scene format=3]\n',
  'heavy-2.0/addons/heavy/demo/big.glb': 'model',
  'heavy-2.0/addons/heavy/screenshots/shot.png': 'image',
  'heavy-2.0/addons/heavy/demonstration.gd': 'extends Node\n',
})

/** A starter kit: a whole Godot project whose scenes and scripts name its files from the project root. */
const KIT_ARCHIVE = zip({
  'kit-main/LICENSE.md': 'MIT License\n\nCopyright (c) 2026 Kit Author\n',
  'kit-main/project.godot': 'config_version=5\n\n[application]\n\nconfig/name="Kit"\nrun/main_scene="res://scenes/main.tscn"\n',
  'kit-main/export_presets.cfg': '[preset.0]\n\nname="Web"\n',
  'kit-main/.godot/uid_cache.bin': 'cache',
  'kit-main/screenshots/kit.png': 'image',
  'kit-main/scenes/main.tscn': '[gd_scene load_steps=3 format=3 uid="uid://kitmain"]\n\n[ext_resource type="Script" uid="uid://kitplayer" path="res://scripts/player.gd" id="1"]\n[ext_resource type="PackedScene" path="res://models/crate.glb" id="2"]\n',
  'kit-main/scripts/player.gd': 'extends CharacterBody3D\n\nconst BULLET := preload("res://scenes/bullet.tscn")\nconst DATA := "user://save.json"\n',
  'kit-main/scripts/audio.gd': 'extends Node\n',
  'kit-main/models/crate.glb': 'model',
  'kit-main/models/crate.glb.import': '[remap]\n\npath="res://.godot/imported/crate.glb-1.scn"\n\n[deps]\n\nsource_file="res://models/crate.glb"\n',
})

const HEAVY_URL = 'https://example.test/heavy-2.0.zip'
const KIT_URL = 'https://example.test/kit-main.zip'

function entries(): Record<string, Record<string, unknown>> {
  const all = editableCatalogEntries()
  all['test-heavy'] = {
    id: 'test-heavy',
    title: 'Test Heavy',
    host: 'godot',
    version: '2.0',
    category: 'rendering',
    cue: 'trails with a demo left out',
    summary: 'Trails.',
    useWhen: 'A blade needs a trail.',
    tags: ['trail'],
    stages: ['polish'],
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Heavy Author',
    homepage: 'https://example.test/heavy',
    archive: { ...pin(HEAVY_URL, HEAVY_ARCHIVE, 'heavy-2.0/addons/heavy'), license: 'heavy-2.0/LICENSE', exclude: ['demo', 'screenshots', 'Trail.cs'] },
    godot: { addonDir: 'heavy', plugin: 'plugin.cfg' },
    verified: { godot: '4.7.2', date: '2026-11-21' },
  }
  all['test-kit'] = {
    id: 'test-kit',
    title: 'Test Kit',
    host: 'godot',
    version: '1.0',
    category: 'kits',
    cue: 'a starter project',
    summary: 'A starter project.',
    useWhen: 'A new game of this genre.',
    tags: ['kit'],
    stages: ['prototype'],
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Kit Author',
    homepage: 'https://example.test/kit',
    archive: { ...pin(KIT_URL, KIT_ARCHIVE, 'kit-main'), exclude: ['screenshots'], projectRoot: true },
    godot: { addonDir: 'test_kit', autoloads: [{ name: 'Audio', path: 'res://addons/test_kit/scripts/audio.gd' }] },
    verified: { godot: '4.7.2', date: '2026-11-21' },
  }
  return all
}

async function setup(): Promise<{ manager: GameAddonManager; project: string }> {
  dir = await scratch('omissions')
  const catalog = await loadCatalog(await writeCatalog(dir.root, entries()))
  const project = await writeProject(join(dir.root, 'game'))
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: fakeDownloads({ [HEAVY_URL]: HEAVY_ARCHIVE, [KIT_URL]: KIT_ARCHIVE }).fetch },
    blenderStore: join(dir.root, 'store'),
    assetsDir: join(dir.root, 'assets'),
    importProject: () => Promise.resolve({ issues: [] }),
    now: () => new Date('2026-11-21T12:00:00Z'),
    changed: () => {},
    allowed: () => true,
  })
  return { manager, project }
}

async function tree(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1).split('\\').join('/')).sort()
}

describe('unpackFolder omissions', () => {
  it('leaves out excluded files and whole folders, but not a file whose name only starts like one', async () => {
    dir = await scratch('omit')
    const archivePath = join(dir.root, 'heavy.zip')
    await writeFile(archivePath, HEAVY_ARCHIVE)
    const target = join(dir.root, 'out')
    expect(await unpackFolder(archivePath, 'heavy-2.0/addons/heavy', target, signal, { exclude: ['demo', 'Trail.cs'], skip: ['screenshots', 'absent'] }))
      .toEqual(['demonstration.gd', 'plugin.cfg', 'plugin.gd', 'trail.gd'])
    expect(await tree(target)).toEqual(['demonstration.gd', 'plugin.cfg', 'plugin.gd', 'trail.gd'])
  })

  it('refuses an exclude path that the archive lacks, and a root that the omissions empty', async () => {
    dir = await scratch('omit')
    const archivePath = join(dir.root, 'heavy.zip')
    await writeFile(archivePath, HEAVY_ARCHIVE)
    await expect(unpackFolder(archivePath, 'heavy-2.0/addons/heavy', join(dir.root, 'a'), signal, { exclude: ['demo', 'examples'] }))
      .rejects.toThrow(/has nothing at examples under heavy-2\.0\/addons\/heavy, which its catalog entry leaves out/u)
    await expect(unpackFolder(archivePath, 'heavy-2.0/addons/heavy/demo', join(dir.root, 'b'), signal, { skip: ['demo.tscn', 'big.glb'] }))
      .rejects.toThrow(/no files under heavy-2\.0\/addons\/heavy\/demo/u)
  })
})

describe('installing with omissions', () => {
  it('installs an add-on without the paths its entry excludes', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-heavy', {}, signal)
    expect(await tree(join(project, 'addons', 'heavy'))).toEqual(['LICENSE', 'demonstration.gd', 'plugin.cfg', 'plugin.gd', 'trail.gd'])
  })

  it('installs a project archive as one add-on folder: no project.godot, cache, or presets, and res:// paths that name the folder', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-kit', {}, signal)
    const folder = join(project, 'addons', 'test_kit')
    expect(await tree(folder)).toEqual(['LICENSE.md', 'models/crate.glb', 'models/crate.glb.import', 'scenes/main.tscn', 'scripts/audio.gd', 'scripts/player.gd'])
    expect(await readFile(join(folder, 'scenes', 'main.tscn'), 'utf8')).toBe('[gd_scene load_steps=3 format=3 uid="uid://kitmain"]\n\n'
      + '[ext_resource type="Script" uid="uid://kitplayer" path="res://addons/test_kit/scripts/player.gd" id="1"]\n'
      + '[ext_resource type="PackedScene" path="res://addons/test_kit/models/crate.glb" id="2"]\n')
    expect(await readFile(join(folder, 'scripts', 'player.gd'), 'utf8')).toBe('extends CharacterBody3D\n\nconst BULLET := preload("res://addons/test_kit/scenes/bullet.tscn")\nconst DATA := "user://save.json"\n')
    // Godot writes an import file's paths again at the next import, so the installation leaves them.
    expect(await readFile(join(folder, 'models', 'crate.glb.import'), 'utf8')).toContain('source_file="res://models/crate.glb"')
    const projectFile = await readFile(join(project, 'project.godot'), 'utf8')
    expect(projectFile).toContain('Audio="*res://addons/test_kit/scripts/audio.gd"')
    expect(projectFile).toContain('config/name="Test Game"')
    const removed = await manager.remove(project, 'test-kit', signal)
    expect(removed.removed).toEqual(['addons/test_kit'])
  })

  it('names the root entries a project archive never brings, and rewrites only text files', async () => {
    expect(PROJECT_ROOT_SKIPPED).toEqual(['project.godot', '.godot', 'export_presets.cfg'])
    dir = await scratch('rebase')
    await writeFile(join(dir.root, 'a.gd'), 'var a := "res://a.png"\n')
    await writeFile(join(dir.root, 'b.png'), 'res://b.png')
    await rebaseProjectPaths(dir.root, ['a.gd', 'b.png'], 'res://addons/kit/', signal)
    expect(await readFile(join(dir.root, 'a.gd'), 'utf8')).toBe('var a := "res://addons/kit/a.png"\n')
    expect(await readFile(join(dir.root, 'b.png'), 'utf8')).toBe('res://b.png')
  })
})

describe('entries with omissions', () => {
  it('rejects exclude and projectRoot on a Blender add-on, and a project archive with an editor plugin', async () => {
    dir = await scratch('invalid')
    const blender = editableCatalogEntries()
    ;(blender['test-trees']!.archive as Record<string, unknown>).exclude = ['docs']
    await expect(loadCatalog(await writeCatalog(join(dir.root, 'a'), blender))).rejects.toThrow(/archive\.exclude and archive\.projectRoot apply only to Godot add-ons/u)
    const kit = entries()
    ;(kit['test-kit']!.godot as Record<string, unknown>).plugin = 'plugin.cfg'
    await expect(loadCatalog(await writeCatalog(join(dir.root, 'b'), kit))).rejects.toThrow(/a project archive has no editor plugin of its own/u)
  })
})
