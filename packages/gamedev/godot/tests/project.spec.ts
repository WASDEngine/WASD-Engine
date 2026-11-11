/** Project discovery finds the nearest project.godot, reads its settings, and maps res:// paths. */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GodotProjectError, listProjectFiles, parseProjectSettings, projectDataDirectory, PROJECT_SEARCH_DEPTH, readGodotProject,
  resolveGodotProject, resolveProjectPath, resolveScene, toResPath,
} from '../src/project.ts'

let root: string
const signal = new AbortController().signal

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-godot-project-')) })
afterEach(async () => {
  await chmod(join(root, 'locked'), 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

async function project(dir: string, text = 'config_version=5\n[application]\nconfig/name="Game"\n'): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project.godot'), text)
  return dir
}

describe('parseProjectSettings', () => {
  it('reads the name and main scene of the application section', () => {
    const text = [
      '; Engine configuration file.', 'config_version=5', '', '[application]', '',
      'config/name="Say \\"hi\\"\\tnow\\nplease \\\\ok"', 'run/main_scene="uid://b12"', 'config/features=PackedStringArray("4.7")', '',
      '[input]', 'run/main_scene="res://elsewhere.tscn"', 'ui_left={', '"deadzone": 0.5', '}',
    ].join('\r\n')
    expect(parseProjectSettings(text)).toEqual({ name: 'Say "hi"\tnow\nplease \\ok', mainScene: 'uid://b12' })
  })

  it('ignores values that are not plain strings and reports absent settings as missing', () => {
    expect(parseProjectSettings('[application]\nconfig/name=StringName("x")\nrun/main_scene\n')).toEqual({})
    expect(parseProjectSettings('')).toEqual({})
  })
})

describe('projectDataDirectory', () => {
  it('names the hidden data folder unless the application section turns it off', () => {
    expect(projectDataDirectory('config_version=5\n[application]\nconfig/name="Game"\n')).toBe('.godot')
    expect(projectDataDirectory('[application]\nconfig/use_hidden_project_data_directory=false\n')).toBe('godot')
    expect(projectDataDirectory('[application]\nconfig/use_hidden_project_data_directory=true\n')).toBe('.godot')
    expect(projectDataDirectory('[rendering]\nconfig/use_hidden_project_data_directory=false\n')).toBe('.godot')
  })
})

describe('resolveGodotProject', () => {
  it('finds the shallowest project in name order and skips tool folders', async () => {
    await project(join(root, 'node_modules', 'pkg'))
    await project(join(root, '.godot', 'x'))
    await project(join(root, 'b', 'game'))
    await project(join(root, 'a', 'deeper', 'game'))
    await project(join(root, 'c', 'game'), '[application]\nrun/main_scene="res://main.tscn"\n')
    await writeFile(join(root, 'notes.txt'), '')
    expect(await resolveGodotProject(root, undefined, signal)).toEqual({ dir: join(root, 'b', 'game'), name: 'Game' })
  })

  it('prefers the working directory itself and stops below the search depth', async () => {
    await project(root)
    expect((await resolveGodotProject(root, undefined, signal)).dir).toBe(root)
    const other = await mkdtemp(join(tmpdir(), 'dsh-godot-depth-'))
    try {
      const levels = Array.from({ length: PROJECT_SEARCH_DEPTH + 1 }, (_, index) => `l${index}`)
      await project(join(other, ...levels))
      await expect(resolveGodotProject(other, undefined, signal)).rejects.toThrow(GodotProjectError)
      await project(join(other, ...levels.slice(0, PROJECT_SEARCH_DEPTH)))
      expect((await resolveGodotProject(other, undefined, signal)).dir).toBe(join(other, ...levels.slice(0, PROJECT_SEARCH_DEPTH)))
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('reports where it searched when no project exists', async () => {
    await mkdir(join(root, 'empty'))
    const error = await resolveGodotProject(join(root, 'empty'), undefined, signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GodotProjectError)
    expect(error).toMatchObject({ directory: join(root, 'empty'), message: expect.stringContaining('No project.godot') as string })
    await expect(resolveGodotProject(join(root, 'missing'), undefined, signal)).rejects.toThrow(GodotProjectError)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips unreadable folders', async () => {
    await project(join(root, 'locked', 'game'))
    await chmod(join(root, 'locked'), 0)
    await expect(resolveGodotProject(root, undefined, signal)).rejects.toThrow(GodotProjectError)
  })

  it('resolves a requested folder or project.godot path relative to the working directory', async () => {
    await project(join(root, 'games', 'one'))
    expect((await resolveGodotProject(root, 'games/one', signal)).dir).toBe(join(root, 'games', 'one'))
    expect((await resolveGodotProject(root, 'games/one/project.godot', signal)).dir).toBe(join(root, 'games', 'one'))
    await expect(resolveGodotProject(root, 'games', signal)).rejects.toMatchObject({ directory: join(root, 'games') })
    await writeFile(join(root, 'file'), '')
    await expect(resolveGodotProject(root, 'file', signal)).rejects.toThrow(GodotProjectError)
  })

  it.skipIf(process.platform === 'win32')('reports file system failures other than absence', async () => {
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    await expect(resolveGodotProject(root, 'loop-a', signal)).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(resolveGodotProject(join(root, 'loop-a'), undefined, signal)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('stops when cancelled', async () => {
    await project(join(root, 'game'))
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(resolveGodotProject(root, undefined, controller.signal)).rejects.toThrow('stop')
    await expect(resolveGodotProject(root, 'game', controller.signal)).rejects.toThrow('stop')
  })
})

describe('project files', () => {
  it('lists scripts in path order up to a limit and counts all of them', async () => {
    await project(root)
    await mkdir(join(root, 'b'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, 'a.gd'), '')
    await writeFile(join(root, 'b', 'c.gd'), '')
    await writeFile(join(root, 'b', 'd.txt'), '')
    await writeFile(join(root, '.git', 'e.gd'), '')
    expect(await listProjectFiles(root, '.gd', 10, signal)).toEqual({ files: [join(root, 'a.gd'), join(root, 'b', 'c.gd')], total: 2 })
    expect(await listProjectFiles(root, '.gd', 1, signal)).toEqual({ files: [join(root, 'a.gd')], total: 2 })
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(listProjectFiles(root, '.gd', 1, controller.signal)).rejects.toThrow('stop')
  })

  it('maps between file paths and res:// paths inside the project only', async () => {
    const dir = await project(join(root, 'game'))
    expect(toResPath(dir, join(dir, 'scenes', 'a.gd'))).toBe('res://scenes/a.gd')
    expect(resolveProjectPath(dir, root, 'res://scenes/a.gd')).toBe(join(dir, 'scenes', 'a.gd'))
    expect(resolveProjectPath(dir, root, 'game/b.gd')).toBe(join(dir, 'b.gd'))
    expect(resolveProjectPath(dir, root, join(dir, '..foo.gd'))).toBe(join(dir, '..foo.gd'))
    expect(resolveProjectPath(dir, root, 'other.gd')).toBeUndefined()
    expect(resolveProjectPath(dir, root, 'res://../x.gd')).toBeUndefined()
    expect(resolveProjectPath(dir, root, '.')).toBeUndefined()
    expect((await readGodotProject(dir)).name).toBe('Game')
  })

  it('accepts uid scenes and existing res:// scenes', async () => {
    const dir = await project(join(root, 'game'))
    await writeFile(join(dir, 'level.tscn'), '')
    const game = { dir }
    expect(await resolveScene(game, 'uid://abc')).toBe('uid://abc')
    expect(await resolveScene(game, 'res://level.tscn')).toBe('res://level.tscn')
    await expect(resolveScene(game, 'res://missing.tscn')).rejects.toThrow('does not exist')
    await expect(resolveScene(game, 'level.tscn')).rejects.toThrow('res:// or uid://')
  })
})
