/** The static check reports actionable problems per script and fails clearly when the check process ends early. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_SCRIPT_LIMIT, checkScripts, GodotCheckError, selectScripts, type CheckOptions } from '../src/check.ts'
import { scratch, subprocessFixture, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

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

posix('checkScripts', () => {
  it('keeps located problems and attributes an unlocated failure to its script', async () => {
    const result = await check({
      check: {
        errors: {
          'res://a.gd': [
            { level: 'script_error', message: 'Parse Error', file: 'res://a.gd', line: 0, function: 'GDScript::reload' },
            { level: 'error', message: 'Failed to load', file: 'modules/x.cpp', line: 4, function: 'load' },
          ],
          'res://missing.gd': [
            { level: 'warning', message: 'just a warning', file: 'core/a.cpp', line: 1, function: 'f' },
            { level: 'error', message: 'File not found', file: 'core/b.cpp', line: 2, function: 'g' },
          ],
          'res://warned.gd': [{ level: 'warning', message: 'only a warning', file: 'core/a.cpp', line: 1, function: 'f' }],
        },
      },
    }, ['res://a.gd', 'res://missing.gd', 'res://warned.gd', 'res://clean.gd'])
    expect(result).toEqual([
      { path: 'res://a.gd', issues: [{ level: 'script_error', file: 'res://a.gd', message: 'Parse Error' }] },
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
    expect(await selectScripts(project, dir.root, undefined, signal)).toEqual({ paths: ['res://levels/one.gd', 'res://main.gd'], total: 2 })
    expect(await selectScripts(project, dir.root, ['game/levels', 'res://levels/one.gd', join(project, 'main.gd')], signal))
      .toEqual({ paths: ['res://levels/one.gd', 'res://main.gd'], total: 3 })
    await expect(selectScripts(project, dir.root, ['game/project.godot'], signal)).rejects.toThrow('is not a .gd script.')
    expect(CHECK_SCRIPT_LIMIT).toBe(400)
  })
})
