/**
 * Installing, reinstalling, and removing add-ons in a game project, the backups of what removals and replacements take
 * out, changes that stay inside the project, and the Blender add-on store.
 */
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { addonView, BACKUPS_DIR, GameAddonManager, STORE_INDEX, STORE_MARKER, type ImportReport } from '../src/manager.ts'
import { NOTICES_FILE } from '../src/notices.ts'
import { GameAddonPathError, isProjectPath, within } from '../src/paths.ts'
import { GameAddonRecordError, readRecord } from '../src/record.ts'
import {
  catalogEntries, editableCatalogEntries, entriesWithTreeAssets, fakeDownloads, PROJECT_GODOT, scratch, TREE_ASSETS_ARCHIVE, TREES_ARCHIVE,
  URLS, writeCatalog, writeProject, type FakeDownloads, type Scratch,
} from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

interface Setup {
  readonly manager: GameAddonManager
  readonly project: string
  readonly store: string
  readonly downloads: FakeDownloads
  readonly imports: string[]
  readonly changed: string[]
}

/**
 * @param importReport - what each import reports; null for a Host without a Godot runtime.
 * @param entries - the catalog's entries; the test catalog by default.
 */
async function setup(
  importReport: ImportReport | null = { issues: [] },
  entries?: Record<string, unknown>,
  files: Readonly<Record<string, string>> = {},
): Promise<Setup> {
  dir = await scratch('manager')
  const catalogDir = await writeCatalog(dir.root, entries)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(catalogDir, path)), { recursive: true })
    await writeFile(join(catalogDir, path), text)
  }
  const catalog = await loadCatalog(catalogDir)
  const project = await writeProject(join(dir.root, 'game'))
  const store = join(dir.root, 'store')
  const downloads = fakeDownloads()
  const imports: string[] = []
  const changed: string[] = []
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: downloads.fetch },
    blenderStore: store,
    assetsDir: join(dir.root, 'assets'),
    importProject: (projectDir) => {
      imports.push(projectDir)
      return Promise.resolve(importReport ?? undefined)
    },
    now: () => new Date('2026-11-11T12:00:00Z'),
    changed: (projectDir) => { changed.push(projectDir) },
  })
  return { manager, project, store, downloads, imports, changed }
}

/** Catalog files of the camera add-on's two overlay folders: one in its own folder, one beside the entries. */
const OVERLAY_FILES = { 'test-camera/overlay/rig.gd.import': '[remap]\n', 'camera-tools/tools/framing.gd': 'extends SceneTree\n' }

/** The test catalog's entries with the camera add-on naming both overlay folders. */
function overlayEntries(): Record<string, Record<string, unknown>> {
  const entries = editableCatalogEntries()
  const godot = (entries['test-camera'] as Record<string, unknown>).godot as Record<string, unknown>
  godot.overlay = ['test-camera/overlay', 'camera-tools']
  return entries
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()
}

/** Symbolic links need a privilege on Windows, so the specs that make them run elsewhere. */
const linking = it.skipIf(process.platform === 'win32')

/** Write a record that names one Godot add-on with the given paths, as a project from elsewhere could carry it. */
async function writeRecordWith(project: string, id: string, paths: readonly string[]): Promise<void> {
  await mkdir(join(project, '.wasdengine'), { recursive: true })
  const addon = { id, title: 'Test Camera', host: 'godot', version: '1.2.0', license: 'MIT', paths, installedAt: '2026-11-11T12:00:00.000Z' }
  await writeFile(join(project, '.wasdengine', 'addons.json'), `${JSON.stringify({ format: 1, addons: [addon] }, null, 2)}\n`)
}

/** A folder outside the project holding one file, which no change of the project may move or delete. */
async function outsideFolder(root: string, name: string): Promise<string> {
  const folder = join(root, 'outside', name)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'keep.txt'), 'mine\n')
  return folder
}

describe('GameAddonManager.install for Godot', () => {
  it('unpacks the add-on folder with its license, enables it, writes the notice and record, and imports twice', async () => {
    const { manager, project, downloads, imports, changed } = await setup({ issues: ['res://addons/test_camera/rig.gd:3: warning'] })
    const result = await manager.install(project, 'test-camera', {}, signal)
    expect(result).toMatchObject({ projectDir: project, unchanged: false, importIssues: ['res://addons/test_camera/rig.gd:3: warning'], notes: [] })
    expect(result.addon).toEqual({
      id: 'test-camera', title: 'Test Camera', host: 'godot', version: '1.2.0', license: 'MIT', source: URLS.camera,
      sha256: result.addon.sha256, paths: ['addons/test_camera'], installedAt: '2026-11-11T12:00:00.000Z',
    })
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['LICENSE', 'manager.gd', 'nodes/rig.gd', 'plugin.cfg', 'plugin.gd'])
    const godot = await readFile(join(project, 'project.godot'), 'utf8')
    expect(godot).toBe(`${PROJECT_GODOT}\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/test_camera/plugin.cfg")\n\n[autoload]\n\nTestCameraManager="*res://addons/test_camera/manager.gd"\n\n[test_camera]\n\ngeneral/smoothing=true\n`)
    const notices = await readFile(join(project, NOTICES_FILE), 'utf8')
    expect(notices).toContain('<!-- wasd-addon:test-camera -->\n## Test Camera 1.2.0\n\n- License: MIT\n- Copyright (c) 2026 Test Author\n- Source: https://example.test/camera\n\n```text\nMIT License')
    expect(await readRecord(project)).toEqual([result.addon])
    expect(imports).toEqual([project, project])
    expect(changed).toEqual([project])
    expect(downloads.requests).toEqual([URLS.camera])
    // No staging or trash folders are left behind.
    expect(await readdir(join(project, '.wasdengine'))).toEqual(['addons.json'])
  })

  it('adds the files of its catalog overlay folders to the add-on folder', async () => {
    const { manager, project } = await setup(undefined, overlayEntries(), OVERLAY_FILES)
    await manager.install(project, 'test-camera', {}, signal)
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['LICENSE', 'manager.gd', 'nodes/rig.gd', 'plugin.cfg', 'plugin.gd', 'rig.gd.import', 'tools/framing.gd'])
    expect(await readFile(join(project, 'addons', 'test_camera', 'tools', 'framing.gd'), 'utf8')).toBe('extends SceneTree\n')
  })

  it('refuses an overlay file that would replace a file of the archive, leaving the project as it was', async () => {
    const { manager, project } = await setup(undefined, overlayEntries(), { ...OVERLAY_FILES, 'camera-tools/plugin.cfg': '[plugin]\n' })
    await expect(manager.install(project, 'test-camera', {}, signal))
      .rejects.toThrow('The catalog file camera-tools/plugin.cfg would replace a file of the Test Camera archive.')
    expect(await readdir(project)).toEqual(['.wasdengine', 'project.godot'])
    expect(await readdir(join(project, '.wasdengine'))).toEqual([])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
  })

  it('reinstalls at the same version without downloading, repairing project.godot entries a user deleted', async () => {
    const { manager, project, downloads } = await setup()
    const first = await manager.install(project, 'test-camera', {}, signal)
    await writeFile(join(project, 'project.godot'), PROJECT_GODOT)
    const again = await manager.install(project, 'test-camera', {}, signal)
    expect(again.unchanged).toBe(true)
    expect(again.addon).toEqual(first.addon)
    expect(again.notes).toEqual(['project.godot had lost some of the add-on\'s settings; they were written again.'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toContain('TestCameraManager="*res://addons/test_camera/manager.gd"')
    expect(downloads.requests).toEqual([URLS.camera])
  })

  it('installs again when the recorded folder was deleted', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    await import('node:fs/promises').then(fs => fs.rm(join(project, 'addons', 'test_camera'), { recursive: true }))
    const again = await manager.install(project, 'test-camera', {}, signal)
    expect(again.unchanged).toBe(false)
    expect(await tree(join(project, 'addons', 'test_camera'))).toContain('plugin.cfg')
  })

  it('refuses a copy found in addons/ without replace, and replaces it with replace', async () => {
    const { manager, project } = await setup()
    await mkdir(join(project, 'addons', 'test_camera'), { recursive: true })
    await writeFile(join(project, 'addons', 'test_camera', 'plugin.cfg'), '[plugin]\nversion="0.9"\n')
    await writeFile(join(project, 'addons', 'test_camera', 'old.gd'), 'extends Node\n')
    expect((await manager.presence(project)).get('test-camera')).toEqual({ state: 'found', version: '0.9' })
    await expect(manager.install(project, 'test-camera', {}, signal)).rejects.toThrow(/addons\/test_camera \(version 0\.9\) is already in the project without a WASD Engine record/u)
    const replaced = await manager.install(project, 'test-camera', { replace: true }, signal)
    expect(await tree(join(project, 'addons', 'test_camera'))).not.toContain('old.gd')
    expect((await manager.presence(project)).get('test-camera')).toEqual({ state: 'installed', version: '1.2.0' })
    // The replaced copy is kept as the add-on's backup, and no trash or staging folder stays behind.
    expect(replaced.notes).toContain(`The addons/test_camera folder it replaced is kept in ${BACKUPS_DIR}/test-camera/addons/test_camera.`)
    expect(await tree(join(project, BACKUPS_DIR, 'test-camera'))).toEqual(['addons/test_camera/old.gd', 'addons/test_camera/plugin.cfg'])
    expect((await readdir(join(project, '.wasdengine'))).sort()).toEqual(['addons.json', 'backups'])
  })

  it('refuses an add-on that does the job of one already in the project, and an autoload name in use', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'other-camera', {}, signal)
    await expect(manager.install(project, 'test-camera', {}, signal)).rejects.toThrow(/Other Camera \(other-camera\) is already in this project/u)
    await manager.remove(project, 'other-camera', signal)
    await writeFile(join(project, 'project.godot'), `${PROJECT_GODOT}\n[autoload]\n\nTestCameraManager="*res://mine.gd"\n`)
    await expect(manager.install(project, 'test-camera', {}, signal)).rejects.toThrow(/autoload TestCameraManager already points to res:\/\/mine\.gd/u)
    await expect(manager.install(project, 'nope', {}, signal)).rejects.toThrow(/No catalog add-on has the id "nope"/u)
  })

  it('puts the previous folder and project.godot back when a step fails', async () => {
    const { manager, project } = await setup()
    await mkdir(join(project, 'addons', 'test_camera'), { recursive: true })
    await writeFile(join(project, 'addons', 'test_camera', 'mine.gd'), 'extends Node\n')
    // A folder where the notices file belongs makes the notice step fail after the add-on took its place.
    await mkdir(join(project, NOTICES_FILE))
    await expect(manager.install(project, 'test-camera', { replace: true }, signal)).rejects.toThrow()
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['mine.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    expect(await readRecord(project)).toEqual([])
    expect(await readdir(join(project, '.wasdengine'))).toEqual([])
  })

  it('notes a skipped import without a Godot runtime and the credit a license requires', async () => {
    const { manager, project } = await setup(null)
    const result = await manager.install(project, 'other-camera', {}, signal)
    expect(result.notes).toEqual([
      'No Godot runtime is installed, so the project was not imported; godot_run imports it once Godot is installed.',
      'Its license requires this credit in the game: Other Camera by Other',
    ])
    expect(await readFile(join(project, NOTICES_FILE), 'utf8')).toContain('- Credit required in the game: Other Camera by Other')
    // Its archive has no license file, so the notice carries the MIT License with the entry's copyright line.
    expect(await readFile(join(project, NOTICES_FILE), 'utf8')).toContain('```text\nMIT License\n\nCopyright (c) 2026 Other\n\nPermission is hereby granted, free of charge,')
  })
})

describe('GameAddonManager.remove', () => {
  it('moves the recorded folder to its backup, removes its project.godot entries, notice, and record, and names files that still use it', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    await manager.install(project, 'test-trees', {}, signal)
    await mkdir(join(project, 'scenes'), { recursive: true })
    await writeFile(join(project, 'scenes', 'level.tscn'), '[ext_resource path="res://addons/test_camera/nodes/rig.gd"]\n')
    await writeFile(join(project, 'player.gd'), 'func _ready():\n\tTestCameraManager.follow(self)\n')
    await writeFile(join(project, 'clean.gd'), 'extends Node\n')
    const result = await manager.remove(project, 'test-camera', signal)
    expect(result).toEqual({
      id: 'test-camera', projectDir: project, removed: ['addons/test_camera'], backup: `${BACKUPS_DIR}/test-camera`, references: ['player.gd', 'scenes/level.tscn'],
    })
    await expect(lstat(join(project, 'addons', 'test_camera'))).rejects.toThrow(/ENOENT/u)
    expect(await tree(join(project, BACKUPS_DIR))).toEqual([
      '.gitignore', 'test-camera/addons/test_camera/LICENSE', 'test-camera/addons/test_camera/manager.gd',
      'test-camera/addons/test_camera/nodes/rig.gd', 'test-camera/addons/test_camera/plugin.cfg', 'test-camera/addons/test_camera/plugin.gd',
    ])
    expect(await readFile(join(project, BACKUPS_DIR, '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    await expect(readFile(join(project, NOTICES_FILE), 'utf8')).rejects.toThrow(/ENOENT/u)
    expect((await readRecord(project)).map(addon => addon.id)).toEqual(['test-trees'])
    await expect(manager.remove(project, 'test-camera', signal)).rejects.toThrow(/Test Camera is not in this project/u)
  })

  it('removes a catalog add-on found in addons/ without a record', async () => {
    const { manager, project } = await setup()
    await mkdir(join(project, 'addons', 'other_camera'), { recursive: true })
    await writeFile(join(project, 'addons', 'other_camera', 'plugin.cfg'), '[plugin]\n')
    expect(await manager.remove(project, 'other-camera', signal)).toMatchObject({ removed: ['addons/other_camera'], references: [] })
    expect((await manager.presence(project)).get('other-camera')).toEqual({ state: 'absent' })
  })

  it('keeps a project setting that another installed add-on also sets', async () => {
    const entries = catalogEntries()
    const shared = { section: 'filesystem', key: 'import/blender/enabled', value: 'false' }
    for (const id of ['test-camera', 'other-camera'] as const) {
      const entry = entries[id] as { conflicts?: unknown; godot: { settings?: readonly unknown[] } }
      delete entry.conflicts
      entry.godot.settings = [...entry.godot.settings ?? [], shared]
    }
    const { manager, project } = await setup({ issues: [] }, entries)
    await manager.install(project, 'test-camera', {}, signal)
    await manager.install(project, 'other-camera', {}, signal)
    await manager.remove(project, 'other-camera', signal)
    const kept = await readFile(join(project, 'project.godot'), 'utf8')
    expect(kept).toContain('import/blender/enabled=false')
    expect(kept).toContain('general/smoothing=true')
    await manager.remove(project, 'test-camera', signal)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
  })

  it('keeps only the latest backup of an add-on', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    await writeFile(join(project, 'addons', 'test_camera', 'mine.gd'), 'extends Node\n')
    await manager.remove(project, 'test-camera', signal)
    expect(await tree(join(project, BACKUPS_DIR, 'test-camera'))).toContain('addons/test_camera/mine.gd')
    await manager.install(project, 'test-camera', {}, signal)
    await manager.remove(project, 'test-camera', signal)
    expect(await tree(join(project, BACKUPS_DIR, 'test-camera'))).not.toContain('addons/test_camera/mine.gd')
    expect(await tree(join(project, BACKUPS_DIR, 'test-camera'))).toContain('addons/test_camera/plugin.cfg')
  })

  it('keeps a notices file with text of the developer\'s own', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    const path = join(project, NOTICES_FILE)
    await writeFile(path, `${await readFile(path, 'utf8')}\n## My music\n\nCC-BY by Someone\n`)
    await manager.remove(project, 'test-camera', signal)
    const rest = await readFile(path, 'utf8')
    expect(rest).not.toContain('wasd-addon:test-camera')
    expect(rest).toContain('## My music')
  })
})

describe('GameAddonManager changes stay inside the project', () => {
  linking('refuses a record path outside the add-on\'s folder, even through a link, and changes nothing', async () => {
    const { manager, project } = await setup()
    const documents = await outsideFolder(dir!.root, 'Documents')
    await symlink(dirname(documents), join(project, 'home'))
    await writeRecordWith(project, 'test-camera', ['home/Documents'])
    const record = await readFile(join(project, '.wasdengine', 'addons.json'), 'utf8')
    await expect(manager.remove(project, 'test-camera', signal))
      .rejects.toThrow('.wasdengine/addons.json lists home/Documents for Test Camera, outside its folder addons/test_camera, so nothing was removed.')
    expect(await tree(documents)).toEqual(['keep.txt'])
    expect(await readFile(join(project, '.wasdengine', 'addons.json'), 'utf8')).toBe(record)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
  })

  it.each([
    ['..\\..\\Documents'], ['addons\\test_camera'], ['C:/Users/me/Documents'], ['C:\\Users\\me\\Documents'], ['addons/../../Documents'],
    ['/Users/me/Documents'], ['addons//test_camera'], ['addons/./test_camera'], ['addons/test_camera\u0000'],
  ])('reads a record path %j as invalid, so nothing is removed', async (path) => {
    const { manager, project } = await setup()
    await writeRecordWith(project, 'test-camera', [path])
    await expect(manager.remove(project, 'test-camera', signal)).rejects.toThrow(GameAddonRecordError)
    expect(isProjectPath(path)).toBe(false)
  })

  linking('does not follow an addons folder that links outside the project', async () => {
    const { manager, project } = await setup()
    const elsewhere = await outsideFolder(dir!.root, 'test_camera')
    await writeFile(join(elsewhere, 'plugin.cfg'), '[plugin]\nversion="0.9"\n')
    await symlink(dirname(elsewhere), join(project, 'addons'))
    expect((await manager.presence(project)).get('test-camera')).toEqual({ state: 'found', version: '0.9' })
    await expect(manager.remove(project, 'test-camera', signal)).rejects.toThrow(GameAddonPathError)
    await expect(manager.install(project, 'test-camera', { replace: true }, signal)).rejects.toThrow(/addons in .* leads outside the project/u)
    expect(await tree(dirname(elsewhere))).toEqual(['test_camera/keep.txt', 'test_camera/plugin.cfg'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    expect(await readRecord(project)).toEqual([])
  })

  linking('does not write state through a .wasdengine folder that links outside the project', async () => {
    const { manager, project } = await setup()
    const state = await outsideFolder(dir!.root, 'state')
    await symlink(state, join(project, '.wasdengine'))
    await expect(manager.install(project, 'test-camera', {}, signal)).rejects.toThrow(/\.wasdengine\/staging in .* leads outside the project/u)
    await expect(manager.install(project, 'test-rig', {}, signal)).rejects.toThrow(GameAddonPathError)
    expect(await tree(state)).toEqual(['keep.txt'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
  })

  linking('moves a linked add-on folder as the link, leaving what it points to', async () => {
    const { manager, project } = await setup()
    const linked = await outsideFolder(dir!.root, 'camera')
    await writeFile(join(linked, 'plugin.cfg'), '[plugin]\n')
    await mkdir(join(project, 'addons'))
    await symlink(linked, join(project, 'addons', 'test_camera'))
    expect(await manager.remove(project, 'test-camera', signal)).toMatchObject({ removed: ['addons/test_camera'], backup: `${BACKUPS_DIR}/test-camera` })
    expect(await readlink(join(project, BACKUPS_DIR, 'test-camera', 'addons', 'test_camera'))).toBe(linked)
    expect(await tree(linked)).toEqual(['keep.txt', 'plugin.cfg'])
  })

  it('tells whether a path lies in a folder on POSIX and Windows', () => {
    expect(within('/games/neon', '/games/neon/addons/x', posix)).toBe(true)
    expect(within('/games/neon', '/games/neon', posix)).toBe(true)
    expect(within('/games/neon', '/games/neon2', posix)).toBe(false)
    expect(within('/games/neon', '/games', posix)).toBe(false)
    expect(within('/games/neon', '/games/neon/../other', posix)).toBe(false)
    expect(within('/games/neon', '/games/neon/..foo', posix)).toBe(true)
    expect(within('C:\\games\\neon', 'C:\\games\\neon\\addons\\x', win32)).toBe(true)
    expect(within('C:\\games\\neon', 'c:\\GAMES\\NEON\\addons', win32)).toBe(true)
    expect(within('C:\\games\\neon', 'C:\\games\\neon2', win32)).toBe(false)
    expect(within('C:\\games\\neon', 'C:\\Users\\me\\Documents', win32)).toBe(false)
    expect(within('C:\\games\\neon', 'D:\\games\\neon', win32)).toBe(false)
    expect(within('C:\\games\\neon', '\\\\server\\share\\neon', win32)).toBe(false)
  })

  it('accepts record paths of / separated segments', () => {
    for (const path of ['addons/test_camera', 'addons/test_camera/nodes', 'addons/a.b-c', 'addons/..foo']) expect(isProjectPath(path)).toBe(true)
    for (const path of ['', '.', '..', 'addons/', '/addons', 'addons/..', 'C:', 'a:b', 'addons\\x', 'addons/\u0007x']) expect(isProjectPath(path)).toBe(false)
  })
})

describe('GameAddonManager for Blender', () => {
  it('unpacks an extension once into the store with its marker and index, and records it in the project', async () => {
    const { manager, project, store, downloads, imports } = await setup()
    const result = await manager.install(project, 'test-trees', {}, signal)
    expect(result.addon).toMatchObject({ id: 'test-trees', host: 'blender', version: '2.0.0', source: URLS.trees, paths: [] })
    expect(result.notes).toEqual(['In each Blender Session, run `import wasd_addons; wasd_addons.enable("test-trees")` with mcp__wasd_blender__execute_python before using Test Trees.'])
    expect(await tree(store)).toEqual([STORE_INDEX, `test_trees/${STORE_MARKER}`, 'test_trees/__init__.py', 'test_trees/blender_manifest.toml'])
    expect(JSON.parse(await readFile(join(store, STORE_INDEX), 'utf8'))).toEqual({
      format: 1,
      addons: { 'test-rig': { module: 'rigify', kind: 'core', version: '5.2.3' }, 'test-trees': { module: 'test_trees', kind: 'extension', version: '2.0.0' } },
    })
    const second = join(dir!.root, 'second')
    await writeProject(second)
    expect((await manager.install(second, 'test-trees', {}, signal)).unchanged).toBe(false)
    expect((await manager.install(second, 'test-trees', {}, signal)).unchanged).toBe(true)
    expect(downloads.requests).toEqual([URLS.trees])
    expect(imports).toEqual([])
    // Removing it from one project leaves the store for the others.
    await manager.remove(project, 'test-trees', signal)
    expect(await tree(store)).toContain('test_trees/__init__.py')
    expect((await manager.presence(project)).get('test-trees')).toEqual({ state: 'absent' })
  })

  it('unpacks an asset pack beside the store, indexes its folder and setup script, and drops both archives from the cache', async () => {
    const { manager, project, store, downloads } = await setup(undefined, entriesWithTreeAssets(), { 'test-trees/setup.py': 'def setup(module, assets):\n    pass\n' })
    await manager.install(project, 'test-trees', {}, signal)
    const assets = join(dir!.root, 'assets')
    expect(await tree(assets)).toEqual([`test-trees/${STORE_MARKER}`, 'test-trees/README.txt', 'test-trees/bark/oak.txt'])
    const index = JSON.parse(await readFile(join(store, STORE_INDEX), 'utf8')) as { addons: Record<string, unknown> }
    expect(index.addons['test-trees']).toEqual({
      module: 'test_trees', kind: 'extension', version: '2.0.0',
      setup: join(manager.catalog.folder('test-trees'), 'setup.py'), assets: join(assets, 'test-trees'),
    })
    expect(await readdir(join(dir!.root, 'archives'))).toEqual([])
    const second = join(dir!.root, 'second')
    await writeProject(second)
    await manager.install(second, 'test-trees', {}, signal)
    expect(downloads.requests).toEqual([URLS.trees, URLS.treeAssets])
    expect(addonView(manager.catalog.get('test-trees')!)).toMatchObject({
      bytes: TREES_ARCHIVE.byteLength + TREE_ASSETS_ARCHIVE.byteLength,
      assets: { license: 'CC0-1.0', bytes: TREE_ASSETS_ARCHIVE.byteLength, homepage: 'https://assets.example.test/' },
    })
  })

  it('records a core add-on without a download', async () => {
    const { manager, project, downloads } = await setup()
    const result = await manager.install(project, 'test-rig', {}, signal)
    expect(result.addon).toEqual({ id: 'test-rig', title: 'Test Rig', host: 'blender', version: '5.2.3', license: 'GPL-2.0-or-later', paths: [], installedAt: '2026-11-11T12:00:00.000Z' })
    expect(downloads.requests).toEqual([])
    expect(await manager.guided(project)).toEqual(['test-rig'])
  })
})

describe('GameAddonManager.search', () => {
  it('shows each add-on\'s presence in a project', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-rig', {}, signal)
    const views = await manager.search({ text: 'rig' }, project)
    expect(views.map(view => [view.id, view.presence])).toEqual([['test-rig', { state: 'installed', version: '5.2.3' }]])
    expect((await manager.search({ host: 'godot' }, undefined)).map(view => [view.id, view.presence, view.bytes !== undefined])).toEqual([
      ['other-camera', undefined, true], ['test-camera', undefined, true],
    ])
  })
})
