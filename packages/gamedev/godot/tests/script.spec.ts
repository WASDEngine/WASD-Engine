/**
 * `godot_script`, which runs a SceneTree script against the project headless, and `importProject`, the import step for
 * other Host plugins, against the fake runner.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { callTool, compose, text, type Composition } from './composition.ts'
import { configureFake, fakeLog } from './helpers.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(): Promise<Composition> {
  composition = await compose()
  await mkdir(join(composition.project, 'tests'), { recursive: true })
  await writeFile(join(composition.project, 'tests', 'run.gd'), 'extends SceneTree\n')
  return composition
}

describe('godot_script', () => {
  it('runs a project script headless with user arguments and reports its exit code and output', async () => {
    const c = await composed()
    await configureFake(c.project, { script: { stdout: 'Run Summary\n---- All tests passed! ----\n', stderr: 'SCRIPT ERROR: Parse Error: x\n   at: f (res://tests/bad.gd:3)\n', exitCode: 1 } })
    const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd', args: ['-gdir=res://tests', '-gexit'] })
    expect(result.isError).toBe(false)
    const [first, ...rest] = text(result).split('\n')
    expect(first).toMatch(/^res:\/\/tests\/run\.gd could not run: the Godot runner failed with exit code 1 after \d+\.\d s\.$/u)
    expect(rest).toEqual([
      'Engine errors (1):',
      '[script_error] res://tests/bad.gd:3: Parse Error: x',
      'Output:',
      'Run Summary',
      '---- All tests passed! ----',
      'SCRIPT ERROR: Parse Error: x',
      '   at: f (res://tests/bad.gd:3)',
    ])
    const [entry] = (await fakeLog(c.project)).filter(line => line.argv !== undefined)
    expect(entry?.argv).toEqual(['--headless', '--path', c.project, '--script', 'res://tests/run.gd', '--', '-gdir=res://tests', '-gexit'])
  })

  it('takes a path relative to the working directory, and keeps the end of a long output', async () => {
    const c = await composed()
    await configureFake(c.project, { script: { stdout: Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n') } })
    const result = await callTool(c, 'godot_script', { script: 'game/tests/run.gd' })
    expect(result.value).toMatchObject({ script: 'res://tests/run.gd', exitCode: 0, timedOut: false })
    const value = result.value as { output: string; omittedLines: number }
    expect(value.output.length).toBeLessThanOrEqual(6000)
    expect(value.output.endsWith(`line 399 ${'x'.repeat(40)}`)).toBe(true)
    expect(value.omittedLines).toBeGreaterThan(0)
    expect(text(result)).toContain('earlier lines left out')
    expect(text(result)).toMatch(/^res:\/\/tests\/run\.gd finished after \d+\.\d s\. /u)
    expect(text(result)).toContain('The built-in Godot does not report the script\'s own exit code; read the result from its output.')
  })

  it('imports the project first when runs import first, and lists the import\'s errors before the script\'s', async () => {
    composition = await compose({ config: { importBeforeRun: true } })
    const c = composition
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'run.gd'), 'extends SceneTree\n')
    await configureFake(c.project, { import: { stderr: 'ERROR: Failed loading resource: res://a.png\nWARNING: slow\n' }, script: { stdout: 'done\n' } })
    const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd' })
    expect(result.value).toMatchObject({ issues: [{ level: 'error', message: 'Failed loading resource: res://a.png' }], totalIssues: 1, output: 'done' })
    expect((await fakeLog(c.project)).filter(line => line.argv !== undefined).map(line => (line.argv as string[]).includes('--import') ? 'import' : 'script')).toEqual(['import', 'script'])
  })

  it('stops a script at its time limit', async () => {
    const c = await composed()
    await configureFake(c.project, { script: { delayMs: 5000 } })
    const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd', timeout_seconds: 1 })
    expect(result.value).toMatchObject({ timedOut: true })
    expect(result.value).not.toHaveProperty('exitCode')
    expect(text(result)).toMatch(/did not finish within its time limit/u)
  })

  it('refuses a script outside the project, a missing one, one that is not GDScript, and a bad time limit', async () => {
    const c = await composed()
    await writeFile(join(c.project, 'notes.txt'), 'x')
    expect(text(await callTool(c, 'godot_script', { script: '/etc/hosts' }))).toContain('is outside the project')
    expect(text(await callTool(c, 'godot_script', { script: 'res://missing.gd' }))).toContain('res://missing.gd does not exist')
    expect(text(await callTool(c, 'godot_script', { script: 'res://notes.txt' }))).toContain('res://notes.txt is not a .gd script')
    expect(text(await callTool(c, 'godot_script', { script: 'res://tests/run.gd', timeout_seconds: 0 }))).toContain('timeout_seconds must be an integer from 1 to 900')
  })
})

describe('importProject', () => {
  it('imports once with the editor plugins loaded and reports errors and an abnormal end', async () => {
    const c = await composed()
    await configureFake(c.project, { import: { stderr: 'ERROR: Failed loading resource: res://addons/x/icon.svg\nWARNING: deprecated\n', exitCode: 3 } })
    const report = await c.godot.importProject(c.project, new AbortController().signal)
    expect(report?.issues).toEqual([
      { level: 'error', message: 'Failed loading resource: res://addons/x/icon.svg' },
      { level: 'warning', message: 'deprecated' },
      { level: 'warning', message: 'The Godot import step ended abnormally (exit code 3); imported resources may be incomplete.' },
    ])
    const [entry] = (await fakeLog(c.project)).filter(line => line.argv !== undefined)
    expect(entry?.argv).toEqual(['--headless', '--path', c.project, '--import'])
  })

  it('turns off the Blender importer first in a project that holds a .blend file, and reports it before the import\'s issues', async () => {
    const c = await composed()
    await writeFile(join(c.project, 'ship.blend'), 'blend')
    await configureFake(c.project, { import: { stderr: 'WARNING: deprecated\n' } })
    const report = await c.godot.importProject(c.project, new AbortController().signal)
    expect(report?.issues.map(issue => issue.level)).toEqual(['warning', 'warning'])
    expect(report?.issues[0]?.message).toContain('because of res://ship.blend')
    expect(await readFile(join(c.project, 'project.godot'), 'utf8')).toContain('import/blender/enabled=false')
  })

  it('returns nothing without a runtime', async () => {
    composition = await compose({ config: { runnerPath: '', libgodotPath: '', runtimeManifestUrl: 'http://127.0.0.1:9/manifest.json' } })
    expect(await composition.godot.importProject(composition.project, new AbortController().signal)).toBeUndefined()
  })
})
