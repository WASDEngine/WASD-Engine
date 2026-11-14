/**
 * `godot_script`, which runs a SceneTree script against the project headless, and `importProject`, the import step for
 * other Host plugins, against the fake runner.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const [first, folder, ...rest] = text(result).split('\n')
    expect(first).toMatch(/^res:\/\/tests\/run\.gd could not run: the Godot runner failed with exit code 1 after \d+\.\d s\.$/u)
    const folderPattern = /^Its folder \/.+\/\.godot\/wasd-script-runs\/\d{8}T\d{9}Z-[0-9a-f]{6}\/1 keeps stdout\.log and stderr\.log; /u
    expect(folder).toMatch(folderPattern)
    expect(folder).toMatch(/; files the script wrote to WASD_OUTPUT_DIR \(files\/\): no files\.$/u)
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

/** A run of a call with runs, as the result value holds it. */
type RunValue = {
  readonly name: string
  readonly args: string[]
  readonly folder: string
  readonly status: string
  readonly files: string[]
}

/** The value of a call with runs. */
type RunsValue = {
  readonly resultsDir: string
  readonly parallel: number
  readonly fixedFps: number
  readonly runs: RunValue[]
}

/** One script run that the fake runner recorded: its HOME and its real-time span. */
interface ScriptSpan {
  readonly home: string | null
  readonly start: number
  readonly end: number
}

/** The fake runner's records of the script runs that ended. */
async function scriptSpans(project: string): Promise<ScriptSpan[]> {
  return (await fakeLog(project)).filter(line => line.scripted === true).map(line => ({
    home: line.home as string | null, start: line.startedAt as number, end: line.endedAt as number,
  }))
}

/** The most spans that cover one moment. */
function mostAtOnce(spans: readonly ScriptSpan[]): number {
  return Math.max(...spans.map(span => spans.filter(other => other.start < span.end && span.start < other.end).length))
}

describe('godot_script runs', () => {
  it('keeps a run\'s output and the files it wrote to WASD_OUTPUT_DIR in a folder of its own, and lists the files', async () => {
    const c = await composed()
    await configureFake(c.project, { script: { stdout: 'measured\n', stderr: 'ERROR: boom\n', files: { 'result.json': '{"ok":true}', 'frames/0001.png': 'png' } } })
    const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd' })
    const value = result.value as { folder: string; files: string[]; totalFiles: number }
    expect(value.files).toEqual(['frames/0001.png', 'result.json'])
    expect(value.totalFiles).toBe(2)
    expect(await readFile(join(value.folder, 'stdout.log'), 'utf8')).toBe('measured\n')
    expect(await readFile(join(value.folder, 'stderr.log'), 'utf8')).toBe('ERROR: boom\n')
    expect(await readFile(join(value.folder, 'files', 'result.json'), 'utf8')).toBe('{"ok":true}')
    // One run keeps the project's own user:// folder.
    expect(await scriptSpans(c.project)).toEqual([expect.objectContaining({ home: process.env.HOME ?? null })])
    const [entry] = (await fakeLog(c.project)).filter(line => line.scripted === true)
    expect(entry?.outputDir).toBe(join(value.folder, 'files'))
    expect(text(result)).toContain('files the script wrote to WASD_OUTPUT_DIR (files/): frames/0001.png, result.json.')
  })

  it('runs the script once per run, as many at once as the slots allow, each with its arguments, folder, and user:// home', async () => {
    composition = await compose({ config: { maxScripts: 2 } })
    const c = composition
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'run.gd'), 'extends SceneTree\n')
    await configureFake(c.project, { script: { delayMs: 300, stdout: 'probe done\n', files: { 'out.txt': 'x' } } })
    const result = await callTool(c, 'godot_script', {
      script: 'res://tests/run.gd', args: ['--suite'], fixed_fps: 60, runs: [{ args: ['--body=a'], name: 'body a' }, { args: ['--body=b'] }, { name: 'third' }],
    })
    expect(result.isError, text(result)).toBe(false)
    const value = result.value as RunsValue
    expect(value).toMatchObject({ parallel: 2, fixedFps: 60 })
    expect(value.runs.map(run => [run.name, run.args, run.status, run.files])).toEqual([
      ['body a', ['--suite', '--body=a'], 'finished', ['out.txt']],
      [undefined, ['--suite', '--body=b'], 'finished', ['out.txt']],
      ['third', ['--suite'], 'finished', ['out.txt']],
    ])
    expect(value.runs.map(run => basename(run.folder))).toEqual(['1-body-a', '2', '3-third'])
    const spans = await scriptSpans(c.project)
    expect(mostAtOnce(spans)).toBe(2)
    expect(spans.map(span => span.home).sort()).toEqual(value.runs.map(run => join(run.folder, 'home')).sort())
    const argv = (await fakeLog(c.project)).flatMap(line => line.argv === undefined ? [] : [line.argv as string[]])
    expect(argv).toContainEqual(['--headless', '--path', c.project, '--fixed-fps', '60', '--script', 'res://tests/run.gd', '--', '--suite', '--body=a'])
    const summary = JSON.parse(await readFile(join(value.resultsDir, 'summary.json'), 'utf8')) as { runs: RunValue[] }
    expect(summary.runs.map(run => run.status)).toEqual(['finished', 'finished', 'finished'])
    const lines = text(result).split('\n')
    expect(lines[0]).toMatch(/^Ran res:\/\/tests\/run\.gd 3 times, up to 2 at a time at a fixed 60 FPS, in \d+\.\d s: 3 finished\.$/u)
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^1 body a: finished in \d+\.\d s; files: out\.txt; last line: probe done$/u),
      expect.stringMatching(/^2: finished in \d+\.\d s; files: out\.txt; last line: probe done$/u),
      expect.stringMatching(/^3 third: finished in \d+\.\d s; files: out\.txt; last line: probe done$/u),
    ])
  })

  it('runs exclusive runs one at a time while no other script runs', async () => {
    composition = await compose({ config: { maxScripts: 4 } })
    const c = composition
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'run.gd'), 'extends SceneTree\n')
    await configureFake(c.project, { script: { delayMs: 200 } })
    const [alone, others] = await Promise.all([
      callTool(c, 'godot_script', { script: 'res://tests/run.gd', exclusive: true, runs: [{ name: 'a' }, { name: 'b' }] }),
      callTool(c, 'godot_script', { script: 'res://tests/run.gd', runs: [{ name: 'c' }, { name: 'd' }] }),
    ])
    expect((alone.value as RunsValue).parallel).toBe(1)
    const homes = new Set((alone.value as RunsValue).runs.map(run => join(run.folder, 'home')))
    const spans = await scriptSpans(c.project)
    expect(spans).toHaveLength(4)
    for (const span of spans.filter(candidate => homes.has(candidate.home ?? ''))) {
      expect(spans.filter(other => other !== span && other.start < span.end && span.start < other.end)).toEqual([])
    }
    expect((others.value as RunsValue).runs.map(run => run.status)).toEqual(['finished', 'finished'])
  })

  it('keeps the newest call folders of a project and deletes older ones', async () => {
    composition = await compose({ config: { keptScriptResults: 2 } })
    const c = composition
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'run.gd'), 'extends SceneTree\n')
    const folders: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd' })
      folders.push(basename(join((result.value as { folder: string }).folder, '..')))
    }
    expect((await readdir(join(c.project, '.godot', 'wasd-script-runs'))).sort()).toEqual(folders.slice(1).sort())
  })

  it('refuses an empty or too long list of runs, a long run name, and a fixed frame rate outside its range', async () => {
    const c = await composed()
    expect(text(await callTool(c, 'godot_script', { script: 'res://tests/run.gd', runs: [] }))).toContain('runs must hold from 1 to 64 runs.')
    expect(text(await callTool(c, 'godot_script', { script: 'res://tests/run.gd', runs: Array.from({ length: 65 }, () => ({})) }))).toContain('runs must hold from 1 to 64 runs.')
    expect(text(await callTool(c, 'godot_script', { script: 'res://tests/run.gd', runs: [{ name: 'x'.repeat(61) }] }))).toContain('A run\'s name must have from 1 to 60 characters.')
    expect(text(await callTool(c, 'godot_script', { script: 'res://tests/run.gd', fixed_fps: 0 }))).toContain('fixed_fps must be an integer from 1 to 1000.')
    expect((await fakeLog(c.project)).filter(line => line.scripted === true)).toEqual([])
  })

  it('reports a run that could not start beside the runs that did', async () => {
    composition = await compose({ config: { maxScripts: 1, minAvailableMemoryBytes: 1024 ** 3 } })
    const c = composition
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'run.gd'), 'extends SceneTree\n')
    await configureFake(c.project, { script: { stdout: 'ok\n' } })
    const memory = vi.spyOn(process, 'availableMemory')
    // The second run finds too little memory available.
    memory.mockReturnValueOnce(64 * 1024 ** 3).mockReturnValueOnce(1024)
    try {
      const result = await callTool(c, 'godot_script', { script: 'res://tests/run.gd', runs: [{ name: 'first' }, { name: 'second' }] })
      expect((result.value as RunsValue).runs.map(run => run.status)).toEqual(['finished', 'not-started'])
      expect(text(result)).toMatch(/^2 second: did not start: .+memory/mu)
    } finally {
      memory.mockRestore()
    }
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
