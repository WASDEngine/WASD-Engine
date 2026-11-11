/**
 * Test catalogs, archives, projects, and downloads for the game add-on specs: a catalog folder written into a scratch
 * directory with zip archives built in memory, and a fetch that serves them by URL and counts requests.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import type { GameAddon } from '../src/types.ts'

/** A scratch folder removed by {@link Scratch.cleanup}. */
export interface Scratch {
  readonly root: string
  cleanup(): Promise<void>
}

/**
 * Create a scratch folder.
 * @param label - name part of the folder.
 * @returns the folder and its cleanup.
 */
export async function scratch(label: string): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), `dsh-game-addons-${label}-`))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * A zip archive from text files.
 * @param files - archive paths and their text.
 * @returns the archive bytes.
 */
export function zip(files: Readonly<Record<string, string>>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])))
}

/**
 * The pin of an archive.
 * @param url - its URL.
 * @param bytes - its bytes.
 * @param root - installed folder inside it.
 * @returns the catalog's archive fields.
 */
export function pin(url: string, bytes: Uint8Array, root: string): NonNullable<GameAddon['archive']> {
  return { url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, root }
}

/** The Godot camera add-on's archive: a repository archive with the add-on, a demo, and the license at the top. */
export const CAMERA_ARCHIVE = zip({
  'camera-1.2.0/LICENSE': 'MIT License\n\nCopyright (c) 2026 Test Author\n',
  'camera-1.2.0/README.md': '# Camera\n',
  'camera-1.2.0/demo/demo.tscn': '[gd_scene format=3]\n',
  'camera-1.2.0/addons/test_camera/plugin.cfg': '[plugin]\n\nname="Test Camera"\nversion="1.2.0"\nscript="plugin.gd"\n',
  'camera-1.2.0/addons/test_camera/plugin.gd': '@tool\nextends EditorPlugin\n',
  'camera-1.2.0/addons/test_camera/manager.gd': 'extends Node\n',
  'camera-1.2.0/addons/test_camera/nodes/rig.gd': 'class_name TestRig\nextends Node3D\n',
  '__MACOSX/camera-1.2.0/._LICENSE': 'metadata',
})

/** A second camera add-on that does the same job. */
export const OTHER_CAMERA_ARCHIVE = zip({ 'addons/other_camera/plugin.cfg': '[plugin]\n\nname="Other"\nversion="0.1"\nscript="plugin.gd"\n', 'addons/other_camera/plugin.gd': '@tool\nextends EditorPlugin\n' })

/** The Blender extension's archive, as extensions.blender.org serves one. */
export const TREES_ARCHIVE = zip({ 'blender_manifest.toml': 'schema_version = "1.0.0"\nid = "test_trees"\n', '__init__.py': 'def register():\n    pass\n\ndef unregister():\n    pass\n' })

/** An asset pack for the Blender trees add-on: a folder of bark textures inside a top folder. */
export const TREE_ASSETS_ARCHIVE = zip({ 'tree-assets/bark/oak.txt': 'oak bark', 'tree-assets/README.txt': 'CC0 bark textures' })

/** URLs of the test archives. */
export const URLS = {
  camera: 'https://example.test/camera-1.2.0.zip',
  otherCamera: 'https://example.test/other-camera.zip',
  trees: 'https://example.test/test_trees-2.0.0.zip',
  treeAssets: 'https://assets.example.test/tree-assets.zip',
} as const

/**
 * The test catalog's entries with an asset pack and a setup script for the Blender trees add-on, as JSON values.
 * @returns a fresh copy of {@link catalogEntries} with the pack.
 */
export function entriesWithTreeAssets(): Record<string, Record<string, unknown>> {
  const entries = editableCatalogEntries()
  const trees = entries['test-trees'] as Record<string, unknown>
  trees.assets = { ...pin(URLS.treeAssets, TREE_ASSETS_ARCHIVE, 'tree-assets'), license: 'CC0-1.0', homepage: 'https://assets.example.test/' }
  trees.blender = { module: 'test_trees', kind: 'extension', setup: 'setup.py' }
  return entries
}

/**
 * The test catalog's entries as JSON values that a test may change into invalid ones.
 * @returns a fresh copy of {@link catalogEntries}.
 */
export function editableCatalogEntries(): Record<string, Record<string, unknown>> {
  return JSON.parse(JSON.stringify(catalogEntries())) as Record<string, Record<string, unknown>>
}

/** The test catalog's entries, by folder. */
export function catalogEntries(): Record<string, GameAddon> {
  return {
    'test-camera': {
      id: 'test-camera',
      title: 'Test Camera',
      host: 'godot',
      version: '1.2.0',
      summary: 'Virtual cameras that follow and frame targets.',
      useWhen: 'The camera must follow a moving target with smoothing.',
      avoidWhen: 'A fixed Camera2D is enough.',
      tags: ['camera', '2d', '3d'],
      stages: ['prototype', 'polish'],
      license: 'MIT',
      copyright: 'Copyright (c) 2026 Test Author',
      homepage: 'https://example.test/camera',
      archive: { ...pin(URLS.camera, CAMERA_ARCHIVE, 'camera-1.2.0/addons/test_camera'), license: 'camera-1.2.0/LICENSE' },
      godot: {
        addonDir: 'test_camera',
        plugin: 'plugin.cfg',
        autoloads: [{ name: 'TestCameraManager', path: 'res://addons/test_camera/manager.gd' }],
        settings: [{ section: 'test_camera', key: 'general/smoothing', value: 'true' }],
        importTwice: true,
      },
      conflicts: ['other-camera'],
      verified: { godot: '4.7.2', date: '2026-11-11' },
    },
    'other-camera': {
      id: 'other-camera',
      title: 'Other Camera',
      host: 'godot',
      version: '0.1',
      summary: 'Another camera add-on.',
      useWhen: 'Never in tests.',
      tags: ['camera'],
      stages: ['polish'],
      license: 'MIT',
      copyright: 'Copyright (c) 2026 Other',
      credit: 'Other Camera by Other',
      homepage: 'https://example.test/other',
      archive: pin(URLS.otherCamera, OTHER_CAMERA_ARCHIVE, 'addons/other_camera'),
      godot: { addonDir: 'other_camera', plugin: 'plugin.cfg' },
      conflicts: ['test-camera'],
      verified: { godot: '4.7.2', date: '2026-11-11' },
    },
    'test-trees': {
      id: 'test-trees',
      title: 'Test Trees',
      host: 'blender',
      version: '2.0.0',
      summary: 'Procedural trees for game budgets.',
      useWhen: 'The game needs many low-poly trees.',
      tags: ['trees', 'procedural'],
      stages: ['content'],
      license: 'GPL-3.0-or-later',
      copyright: 'Copyright (c) 2026 Tree Author',
      homepage: 'https://example.test/trees',
      archive: pin(URLS.trees, TREES_ARCHIVE, ''),
      blender: { module: 'test_trees', kind: 'extension' },
      verified: { bpy: '5.2.3', date: '2026-11-11' },
    },
    'test-rig': {
      id: 'test-rig',
      title: 'Test Rig',
      host: 'blender',
      version: '5.2.3',
      summary: 'Control rigs that ship inside Blender.',
      useWhen: 'A character needs a rig.',
      tags: ['rigging', 'character'],
      stages: ['content'],
      license: 'GPL-2.0-or-later',
      copyright: 'Copyright (c) Blender Foundation',
      homepage: 'https://example.test/rig',
      blender: { module: 'rigify', kind: 'core' },
      verified: { bpy: '5.2.3', date: '2026-11-11' },
    },
  }
}

/** The guide of an entry. */
export function guideText(id: string, extra = ''): string {
  return `---\nname: ${id}\ndescription: ${id} is installed in this project. Load before using it.\n---\n\n# ${id}\n\nUse it like this.${extra}\n`
}

/**
 * Write a catalog folder.
 * @param root - folder to write into.
 * @param entries - entries by folder; the defaults from {@link catalogEntries}.
 * @returns the catalog folder.
 */
export async function writeCatalog(root: string, entries: Readonly<Record<string, unknown>> = catalogEntries()): Promise<string> {
  const dir = join(root, 'catalog')
  for (const [folder, entry] of Object.entries(entries)) {
    await mkdir(join(dir, folder), { recursive: true })
    await writeFile(join(dir, folder, 'addon.json'), `${JSON.stringify(entry, null, 2)}\n`)
    await writeFile(join(dir, folder, 'SKILL.md'), guideText(folder))
  }
  return dir
}

/** The `project.godot` of a fresh test project, with a multi-line input map. */
export const PROJECT_GODOT = [
  '; Engine configuration file.',
  '',
  'config_version=5',
  '',
  '[application]',
  '',
  'config/name="Test Game"',
  'config/features=PackedStringArray("4.7")',
  '',
  '[input]',
  '',
  'jump={',
  '"deadzone": 0.5,',
  '"events": [Object(InputEventKey,"keycode":32)]',
  '}',
  '',
].join('\n')

/**
 * Write a Godot project.
 * @param dir - project folder.
 * @param text - its `project.godot`.
 * @returns the folder.
 */
export async function writeProject(dir: string, text = PROJECT_GODOT): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project.godot'), text)
  return dir
}

/** A fetch that serves the test archives and records each request. */
export interface FakeDownloads {
  readonly requests: string[]
  readonly fetch: (url: string, signal: AbortSignal) => Promise<Response>
}

/**
 * Serve archives by URL; unknown URLs answer 404.
 * @param archives - URL to bytes; the test archives by default.
 * @returns the fetch and its requests.
 */
export function fakeDownloads(archives: Readonly<Record<string, Uint8Array>> = {
  [URLS.camera]: CAMERA_ARCHIVE,
  [URLS.otherCamera]: OTHER_CAMERA_ARCHIVE,
  [URLS.trees]: TREES_ARCHIVE,
  [URLS.treeAssets]: TREE_ASSETS_ARCHIVE,
}): FakeDownloads {
  const requests: string[] = []
  return {
    requests,
    fetch: (url: string, signal: AbortSignal): Promise<Response> => {
      signal.throwIfAborted()
      requests.push(url)
      const bytes = archives[url]
      return Promise.resolve(bytes === undefined ? new Response('missing', { status: 404 }) : new Response(bytes.slice()))
    },
  }
}
