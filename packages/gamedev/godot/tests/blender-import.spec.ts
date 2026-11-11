/**
 * Turning off Godot's Blender importer, which makes a headless editor skip every import of a project that holds a
 * `.blend` file: the `project.godot` edit and the scan that decides when it is needed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { turnOffBlenderImport, withBlenderImportOff } from '../src/blender-import.ts'

const signal = new AbortController().signal
const PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Blend"\n'

describe('withBlenderImportOff', () => {
  it('adds the filesystem section, or the key at the top of an existing one', () => {
    expect(withBlenderImportOff(PROJECT)).toBe(`${PROJECT}\n[filesystem]\n\nimport/blender/enabled=false\n`)
    expect(withBlenderImportOff('config_version=5')).toBe('config_version=5\n\n[filesystem]\n\nimport/blender/enabled=false\n')
    expect(withBlenderImportOff('[filesystem]\n\nimport/fbx/enabled=true\n\n[rendering]\n\nx=1\n'))
      .toBe('[filesystem]\n\nimport/blender/enabled=false\nimport/fbx/enabled=true\n\n[rendering]\n\nx=1\n')
  })

  it('switches an enabled importer off, keeps Windows line ends, and leaves one that is off alone', () => {
    expect(withBlenderImportOff('[filesystem]\r\n\r\nimport/blender/enabled=true\r\n')).toBe('[filesystem]\r\n\r\nimport/blender/enabled=false\r\n')
    expect(withBlenderImportOff('[filesystem]\n\nimport/blender/enabled = false\n')).toBeUndefined()
    // The same key in another section is a different setting.
    expect(withBlenderImportOff('[other]\n\nimport/blender/enabled=false\n')).toBe('[other]\n\nimport/blender/enabled=false\n\n[filesystem]\n\nimport/blender/enabled=false\n')
  })
})

describe('turnOffBlenderImport', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function project(files: Readonly<Record<string, string>>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'dsh-godot-blend-'))
    await writeFile(join(root, 'project.godot'), PROJECT)
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    return root
  }

  it('leaves a project alone when the editor scan reaches no .blend file', async () => {
    const dir = await project({
      'models/ship.glb': 'glb',
      '.hidden/ship.blend': 'blend',
      'art/.gdignore': '',
      'art/ship.blend': 'blend',
      '.godot/imported/ship.blend': 'blend',
      'models/ship.blend1': 'backup',
    })
    await expect(turnOffBlenderImport(dir, signal)).resolves.toBeUndefined()
    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toBe(PROJECT)
  })

  it('turns the importer off once for a .blend file the scan reaches, whatever its letter case', async () => {
    const dir = await project({ 'models/Ship.BLEND': 'blend', 'models/ship.glb': 'glb' })
    expect(await turnOffBlenderImport(dir, signal)).toBe(
      'Turned off Godot\'s Blender import in project.godot (filesystem/import/blender/enabled=false) because of res://models/Ship.BLEND: '
      + 'this Godot cannot import .blend files, and while the importer was on, no file of the project imported. '
      + 'Export Blender models to .glb with the Blender tools and keep the .blend files as their sources.',
    )
    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toContain('[filesystem]\n\nimport/blender/enabled=false\n')
    await expect(turnOffBlenderImport(dir, signal)).resolves.toBeUndefined()
  })
})
