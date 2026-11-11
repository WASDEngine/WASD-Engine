/**
 * A project needs an import until an import step ends normally, and again once a file that the import reads changes;
 * the operations on one project run one at a time.
 */
import { mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotCommandOutcome } from '../src/command.ts'
import { CLASS_CACHE_FILE, importArgv, importFailure, ProjectImports, type ImportOptions } from '../src/imports.ts'
import { launcherArgv } from '../src/runtime.ts'
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

interface Fixture {
  readonly dir: Scratch
  readonly project: string
  readonly imports: ProjectImports
  /** Run an import step of the project, a little after the files written before it. */
  importNow(overrides?: Partial<ImportOptions>): Promise<GodotCommandOutcome>
  outdated(): Promise<boolean>
}

async function fixture(config: FakeGodotConfig = {}): Promise<Fixture> {
  const dir = await scratch('imports')
  folders.push(dir)
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  await writeFile(join(project, 'player.gd'), 'class_name Player\nextends Node\n')
  const imports = new ProjectImports()
  return {
    dir,
    project,
    imports,
    async importNow(overrides = {}) {
      // File times and the step's start compare at millisecond precision; a file written in the same millisecond counts as changed.
      await tick()
      return imports.import({
        subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project,
        hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, ...overrides,
      })
    },
    outdated: () => imports.outdated(project, signal),
  }
}

/** Write a file below the project after the latest import step began. */
async function change(project: string, path: string, text = ''): Promise<void> {
  await tick()
  await mkdir(join(project, path, '..'), { recursive: true })
  await writeFile(join(project, path), text)
}

describe('import step descriptions', () => {
  const libgodot = { kind: 'libgodot', runner: '/rt/godot_runner', library: '/rt/libgodot.dylib' } as const

  it('builds the headless import command line', () => {
    expect(importArgv(libgodot, 42, '/p')).toEqual([...launcherArgv(libgodot, 42, []), '--headless', '--path', '/p', '--import'])
  })

  it.each([
    [{ exit: { exitCode: 0, signal: null }, timedOut: false, stdout: '', stderr: '' }, undefined],
    [{ exit: { exitCode: null, signal: 'SIGTERM' }, timedOut: true, stdout: '', stderr: '' }, 'did not finish within 1.5 s'],
    [{ exit: { exitCode: 134, signal: null }, timedOut: false, stdout: '', stderr: 'handle_crash: Program crashed with signal 11\n' }, 'ended abnormally (exit code 134: Program crashed with signal 11)'],
    [{ exit: { exitCode: 1, signal: null }, timedOut: false, stdout: 'handle_crash: stdout crash\n', stderr: '' }, 'ended abnormally (exit code 1: stdout crash)'],
    [{ exit: { exitCode: null, signal: 'SIGKILL' }, timedOut: false, stdout: '', stderr: '' }, 'ended abnormally (signal SIGKILL)'],
  ] as const)('describes how a step ended: %j', (outcome, failure) => {
    expect(importFailure(outcome, 1500)).toBe(failure)
  })
})

posix('ProjectImports.outdated', () => {
  it('needs an import until a step ends normally, then again after a script or an asset changes', async () => {
    const f = await fixture()
    expect(await f.outdated()).toBe(true)
    expect(await f.importNow()).toMatchObject({ exit: { exitCode: 0, signal: null }, timedOut: false })
    expect(await f.outdated()).toBe(false)
    await change(f.project, 'player.gd', 'class_name Hero\nextends Node\n')
    expect(await f.outdated()).toBe(true)
    await f.importNow()
    expect(await f.outdated()).toBe(false)
    await change(f.project, 'art/dot.png', 'PNG')
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('ignores the files and folders that the import skips or writes', async () => {
    const f = await fixture()
    await mkdir(join(f.project, 'tools'))
    await writeFile(join(f.project, 'tools', '.gdignore'), '')
    await mkdir(join(f.project, 'nested'))
    await writeFile(join(f.project, 'nested', 'project.godot'), 'config_version=5\n')
    await f.importNow()
    for (const path of ['player.gd.uid', 'art/dot.png.import', '.notes.txt', '.cache/old.gd', '.godot/editor/filesystem_cache10', 'tools/build.gd', 'nested/other.gd']) {
      await change(f.project, path)
    }
    // A link to a missing file and a link to a folder name no file that the import reads.
    await symlink(join(f.dir.root, 'missing.png'), join(f.project, 'broken.png'))
    await symlink(join(f.project, 'tools'), join(f.project, 'linked'))
    expect(await f.outdated()).toBe(false)
    await change(f.project, 'levels/one.gd')
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('counts a file moved into the project with an older modification time', async () => {
    const f = await fixture()
    const outside = join(f.dir.root, 'downloaded.png')
    await writeFile(outside, 'PNG')
    await utimes(outside, new Date('2020-01-01'), new Date('2020-01-01'))
    await f.importNow()
    expect(await f.outdated()).toBe(false)
    await tick()
    await rename(outside, join(f.project, 'downloaded.png'))
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('needs an import while the class cache is missing', async () => {
    const f = await fixture()
    await f.importNow()
    expect(await readFile(join(f.project, '.godot', CLASS_CACHE_FILE), 'utf8')).toBe('list=[]\n')
    await rm(join(f.project, '.godot', CLASS_CACHE_FILE))
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('reads the class cache from the data folder that project.godot names, and skips that folder', async () => {
    const f = await fixture({ import: { classCache: false } })
    const settings = await readFile(join(f.project, 'project.godot'), 'utf8')
    await writeFile(join(f.project, 'project.godot'), settings.replace('[application]\n', '[application]\n\nconfig/use_hidden_project_data_directory=false\n'))
    await mkdir(join(f.project, 'godot'))
    await writeFile(join(f.project, 'godot', CLASS_CACHE_FILE), 'list=[]\n')
    await f.importNow()
    await change(f.project, 'godot/editor/filesystem_cache10')
    expect(await f.outdated()).toBe(false)
    await rm(join(f.project, 'godot', CLASS_CACHE_FILE))
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('stays outdated after a step that fails, runs out of time, or is cancelled', async () => {
    const f = await fixture({ import: { exitCode: 1 } })
    expect(await f.importNow()).toMatchObject({ exit: { exitCode: 1 }, timedOut: false })
    expect(await f.outdated()).toBe(true)
    await configureFake(f.project, { import: { delayMs: 5000 } })
    expect(await f.importNow({ timeoutMs: 1000 })).toMatchObject({ timedOut: true })
    expect(await f.outdated()).toBe(true)
    const started = async (): Promise<number> => (await fakeLog(f.project)).filter(entry => (entry.argv as string[] | undefined)?.includes('--import')).length
    const controller = new AbortController()
    const cancelled = f.importNow({ signal: controller.signal })
    await until(async () => await started() === 3)
    controller.abort(new Error('cancelled'))
    expect(await cancelled).toMatchObject({ timedOut: false })
    expect(await f.outdated()).toBe(true)
    await configureFake(f.project, {})
    await f.importNow()
    expect(await f.outdated()).toBe(false)
  }, PROCESSES_TIMEOUT)

  it('rejects a step whose process cannot start', async () => {
    const f = await fixture()
    await expect(f.importNow({ runtime: { kind: 'libgodot', runner: join(f.dir.root, 'no-godot'), library: '/no-libgodot' } })).rejects.toThrow()
    expect(await f.outdated()).toBe(true)
  }, PROCESSES_TIMEOUT)
})

describe('ProjectImports.exclusive', () => {
  it('runs the operations on one project one at a time, and those on other projects at once', async () => {
    const imports = new ProjectImports()
    const events: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const first = imports.exclusive('/games/one', async () => {
      events.push('first started')
      await gate.promise
      events.push('first ended')
      return 1
    }, signal)
    const second = imports.exclusive('/games/one/', async () => { events.push('second'); return 2 }, signal)
    const other = imports.exclusive('/games/two', async () => { events.push('other'); return 3 }, signal)
    expect(await other).toBe(3)
    await tick()
    expect(events).toEqual(['first started', 'other'])
    gate.resolve(undefined)
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(events).toEqual(['first started', 'other', 'first ended', 'second'])
  })

  it('stops a cancelled wait without running its operation, and runs later operations after the earlier ones', async () => {
    const imports = new ProjectImports()
    const events: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const first = imports.exclusive('/games/one', async () => { await gate.promise; events.push('first') }, signal)
    const controller = new AbortController()
    const cancelled = imports.exclusive('/games/one', async () => { events.push('cancelled') }, controller.signal)
    const third = imports.exclusive('/games/one', async () => { events.push('third') }, signal)
    controller.abort(new Error('stop waiting'))
    await expect(cancelled).rejects.toThrow('stop waiting')
    await tick()
    expect(events).toEqual([])
    gate.resolve(undefined)
    await Promise.all([first, third])
    expect(events).toEqual(['first', 'third'])
  })

  it('moves on after an operation fails', async () => {
    const imports = new ProjectImports()
    await expect(imports.exclusive('/games/one', async () => { throw new Error('import broke') }, signal)).rejects.toThrow('import broke')
    expect(await imports.exclusive('/games/one', async () => 'next', signal)).toBe('next')
  })
})
