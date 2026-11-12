/**
 * The static check imports a project whose import data may be outdated, reports actionable problems per script, and
 * fails clearly when the check process ends early.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHECK_SCRIPT_LIMIT, checkProject, checkScripts, GodotCheckError, selectScripts,
  type CheckOptions, type ProjectCheck, type ProjectCheckOptions,
} from '../src/check.ts'
import { ProjectImports } from '../src/imports.ts'
import {
  configureFake, fakeLog, scratch, subprocessFixture, until, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture,
} from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal
const tick = (milliseconds = 20) => new Promise(resolve => setTimeout(resolve, milliseconds))
/** Deadline of a spec that starts several fake Godot processes, which a loaded machine starts slowly. */
const PROCESSES_TIMEOUT = 30_000

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

/** A scratch folder that the next teardown removes. */
async function folder(prefix: string): Promise<Scratch> {
  const created = await scratch(prefix)
  folders.push(created)
  return created
}

async function check(config: FakeGodotConfig, paths: readonly string[], overrides: Partial<CheckOptions> = {}) {
  const dir = await folder('check')
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  return checkScripts({
    subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, checkScript: '/check.gd',
    paths, hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, ...overrides,
  })
}

/** A project with two scripts, one declaring a class that the other uses, checked through {@link checkProject}. */
interface ProjectFixture {
  readonly dir: Scratch
  readonly project: string
  check(paths: readonly string[], overrides?: Partial<ProjectCheckOptions>): Promise<ProjectCheck>
}

async function projectFixture(config: FakeGodotConfig): Promise<ProjectFixture> {
  const dir = await folder('check-project')
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  await writeFile(join(project, 'art.gd'), 'class_name Art\nextends RefCounted\n')
  await writeFile(join(project, 'player.gd'), 'extends Node\nvar art: Art\n')
  const imports = new ProjectImports()
  return {
    dir,
    project,
    async check(paths, overrides = {}) {
      // File times and an import's start compare at millisecond precision; a file written in the same millisecond counts as changed.
      await tick()
      return checkProject({
        imports, subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project,
        checkScript: '/check.gd', paths, hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, ...overrides,
      })
    },
  }
}

/** The fake's processes in launch order, `import` or `check`, with `imported` where an import step finished. */
async function processes(project: string): Promise<string[]> {
  return (await fakeLog(project)).flatMap((entry) => {
    const argv = entry.argv as string[] | undefined
    if (argv !== undefined) return [argv.includes('--import') ? 'import' : 'check']
    return entry.imported === true ? ['imported'] : []
  })
}

posix('checkProject', () => {
  it('imports a project before its first check and again after its files change', async () => {
    const f = await projectFixture({ check: {} })
    expect(await f.check(['res://art.gd', 'res://player.gd'])).toEqual({ scripts: [{ path: 'res://art.gd', issues: [] }, { path: 'res://player.gd', issues: [] }] })
    expect(await processes(f.project)).toEqual(['import', 'imported', 'check'])
    await f.check(['res://player.gd'])
    expect(await processes(f.project)).toEqual(['import', 'imported', 'check', 'check'])
    await writeFile(join(f.project, 'player.gd'), 'extends Node\nvar art := Art.new()\n')
    await f.check(['res://player.gd'])
    expect(await processes(f.project)).toEqual(['import', 'imported', 'check', 'check', 'import', 'imported', 'check'])
  }, PROCESSES_TIMEOUT)

  it('warns when the import before the check ends abnormally or runs out of time, and imports again before the next check', async () => {
    const f = await projectFixture({ import: { exitCode: 134, stderr: 'handle_crash: Program crashed with signal 11\n' }, check: {} })
    expect(await f.check(['res://art.gd'])).toEqual({
      scripts: [{ path: 'res://art.gd', issues: [] }],
      importWarning: 'The Godot import step before the check ended abnormally (exit code 134: Program crashed with signal 11), so errors about class_name classes or imported assets may be false.',
    })
    await configureFake(f.project, { import: { delayMs: 5000 }, check: {} })
    expect((await f.check(['res://art.gd'], { timeoutMs: 1500 })).importWarning)
      .toBe('The Godot import step before the check did not finish within 1.5 s, so errors about class_name classes or imported assets may be false.')
    expect(await processes(f.project)).toEqual(['import', 'imported', 'check', 'import', 'check'])
  }, PROCESSES_TIMEOUT)

  it('fails when the import cannot start, and stops it when cancelled', async () => {
    const f = await projectFixture({ import: { delayMs: 5000 }, check: {} })
    const missing = await f.check(['res://art.gd'], { runtime: { kind: 'libgodot', runner: join(f.dir.root, 'no-godot'), library: '/no-libgodot' } })
      .catch((caught: unknown) => caught)
    expect(missing).toBeInstanceOf(GodotCheckError)
    expect((missing as Error).message).toMatch(/^The Godot import step could not start: /u)
    const controller = new AbortController()
    const pending = f.check(['res://art.gd'], { signal: controller.signal })
    await until(async () => (await processes(f.project)).includes('import'))
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(await processes(f.project)).toEqual(['import'])
  }, PROCESSES_TIMEOUT)

  it('checks without importing again once a concurrent check imported the project', async () => {
    const f = await projectFixture({ import: { delayMs: 300 }, check: {} })
    const [art, player] = await Promise.all([f.check(['res://art.gd']), f.check(['res://player.gd'])])
    expect(art).toEqual({ scripts: [{ path: 'res://art.gd', issues: [] }] })
    expect(player).toEqual({ scripts: [{ path: 'res://player.gd', issues: [] }] })
    expect(await processes(f.project)).toEqual(['import', 'imported', 'check', 'check'])
  }, PROCESSES_TIMEOUT)
})

posix('checkScripts', () => {
  it('keeps located problems once each and attributes an unlocated failure to its script', async () => {
    const result = await check({
      check: {
        errors: {
          'res://a.gd': [
            { level: 'script_error', message: 'Parse Error', file: 'res://a.gd', line: 0, function: 'GDScript::reload' },
            { level: 'error', message: 'Failed to load', file: 'modules/x.cpp', line: 4, function: 'load' },
          ],
          // The add-on plugin's load and the view script's own load both compile the view script.
          'res://addons/v/view.gd': [
            { level: 'script_error', message: 'Cannot find member', file: 'res://addons/v/view.gd', line: 6, function: 'GDScript::reload' },
            { level: 'script_error', message: 'Cannot find member', file: 'res://addons/v/view.gd', line: 6, function: 'GDScript::reload' },
            { level: 'script_error', message: 'Cannot find member', file: 'res://addons/v/view.gd', line: 7, function: 'GDScript::reload' },
          ],
          'res://missing.gd': [
            { level: 'warning', message: 'just a warning', file: 'core/a.cpp', line: 1, function: 'f' },
            { level: 'error', message: 'File not found', file: 'core/b.cpp', line: 2, function: 'g' },
          ],
          'res://warned.gd': [{ level: 'warning', message: 'only a warning', file: 'core/a.cpp', line: 1, function: 'f' }],
        },
      },
    }, ['res://a.gd', 'res://addons/v/view.gd', 'res://missing.gd', 'res://warned.gd', 'res://clean.gd'])
    expect(result).toEqual([
      { path: 'res://a.gd', issues: [{ level: 'script_error', file: 'res://a.gd', message: 'Parse Error' }] },
      {
        path: 'res://addons/v/view.gd',
        issues: [
          { level: 'script_error', file: 'res://addons/v/view.gd', line: 6, message: 'Cannot find member' },
          { level: 'script_error', file: 'res://addons/v/view.gd', line: 7, message: 'Cannot find member' },
        ],
      },
      { path: 'res://missing.gd', issues: [{ level: 'error', file: 'res://missing.gd', message: 'File not found' }] },
      { path: 'res://warned.gd', issues: [] },
      { path: 'res://clean.gd', issues: [] },
    ])
  })

  it.each([
    [{ check: { omit: ['res://b.gd'], stderr: 'fatal\n', exitCode: 1 } }, ['res://b.gd'], 'The Godot check ended (exit code 1) before checking res://b.gd.\nLast output:\nfatal'],
    [{ check: { garbage: ['res://b.gd'], invalid: ['res://c.gd'] } }, ['res://b.gd', 'res://c.gd'], 'The Godot check ended (exit code 0) before checking res://b.gd and 1 more scripts.'],
    [{ check: { omit: ['res://b.gd'], stdout: 'from stdout\n' } }, ['res://b.gd'], 'Last output:\nfrom stdout'],
  ])('fails when scripts go unreported: %j', async (config, paths, message) => {
    const error = await check(config, paths).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GodotCheckError)
    expect((error as Error).message).toContain(message)
  })

  it('fails when the check runs out of time and stops when cancelled', async () => {
    await expect(check({ check: { delayMs: 3000 } }, ['res://a.gd'], { timeoutMs: 200 })).rejects.toThrow('The Godot check did not finish within 0.2 s before checking res://a.gd.')
    const controller = new AbortController()
    const pending = check({ check: { delayMs: 3000 } }, ['res://a.gd'], { signal: controller.signal })
    setTimeout(() => { controller.abort(new Error('cancelled')) }, 300)
    await expect(pending).rejects.toThrow('cancelled')
  })
})

describe('selectScripts', () => {
  it('selects the whole project, folders, and files without duplicates', async () => {
    const dir = await folder('select')
    const project = await writeProject(join(dir.root, 'game'))
    await mkdir(join(project, 'levels'), { recursive: true })
    await writeFile(join(project, 'main.gd'), '')
    await writeFile(join(project, 'levels', 'one.gd'), '')
    // The backup of a removed add-on is WASD Engine's project state, not a script of the game.
    await mkdir(join(project, '.wasdengine', 'backups', 'gut', 'addons', 'gut'), { recursive: true })
    await writeFile(join(project, '.wasdengine', 'backups', 'gut', 'addons', 'gut', 'gut.gd'), '')
    expect(await selectScripts(project, dir.root, undefined, signal)).toEqual({ paths: ['res://levels/one.gd', 'res://main.gd'], total: 2 })
    expect(await selectScripts(project, dir.root, ['game/levels', 'res://levels/one.gd', join(project, 'main.gd')], signal))
      .toEqual({ paths: ['res://levels/one.gd', 'res://main.gd'], total: 3 })
    await expect(selectScripts(project, dir.root, ['game/project.godot'], signal)).rejects.toThrow('is not a .gd script.')
    expect(CHECK_SCRIPT_LIMIT).toBe(400)
  })
})
