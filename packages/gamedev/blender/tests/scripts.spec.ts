/**
 * `run_script` runs: one process per run with its own folder, output log, files, and Blender user folder; the runs of
 * every call within the server's places, their time limits, and the computer's available memory; cancellation and
 * shutdown; and the call folders kept. A Node stand-in plays the worker script's script mode.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MachineResources } from '@deepseek-ai/dsh-app-mcp'
import type { WorkerLaunch } from '../src/environment.ts'
import { BlenderScriptError, BlenderScripts, runFolderName, type ScriptCall, type ScriptCallReport } from '../src/scripts.ts'
import type { BlenderServerOptions } from '../src/types.ts'

const FAKE_RUN = fileURLToPath(new URL('fixtures/fake-run.mjs', import.meta.url))
const GiB = 1024 ** 3

let root = ''
let dataRoot = ''
let project = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-blender-scripts-'))
  dataRoot = join(root, 'data')
  project = join(root, 'game', 'tools')
  await mkdir(project, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function options(overrides: Partial<BlenderServerOptions> = {}): BlenderServerOptions {
  return {
    dataRoot, backend: 'auto', bpyVersion: '5.2.3', pythonVersion: '3.13', uvPath: '', blenderPath: '', startupTimeoutMs: 30_000,
    requestTimeoutMs: 600_000, toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerMemoryBytes: 0,
    workerCores: 0, minAvailableMemoryBytes: 0, workerIdleTimeoutMs: 600_000, addonStore: '', maxScripts: 2, scriptMemoryBytes: 0,
    scriptCores: 0, keptScriptResults: 20, scriptLogBytes: 1024 * 1024, ...overrides,
  }
}

function machine(available = 8 * GiB): MachineResources {
  return { totalMemoryBytes: 16 * GiB, cores: 8, availableMemoryBytes: () => available }
}

const LAUNCH: WorkerLaunch = {
  backend: 'bpy', shipped: true, repair: '', argv: [process.execPath, FAKE_RUN], env: { PATH: process.env.PATH ?? '' }, notes: ['Unpacked bpy.'],
}

function scripts(overrides: Partial<BlenderServerOptions> = {}, resources = machine()): BlenderScripts {
  return new BlenderScripts(options(overrides), { launch: async () => LAUNCH, machine: resources })
}

/** Write a plan for the stand-in as the script file, and return its path. */
async function plan(name: string, value: object): Promise<string> {
  const path = join(project, name)
  await writeFile(path, JSON.stringify(value))
  return path
}

function call(script: string, fields: Partial<ScriptCall> = {}): ScriptCall {
  return { script, runs: [{ args: [] }], timeoutMs: 30_000, callTimeoutMs: 60_000, ...fields }
}

async function received(folder: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(folder, 'files', 'received.json'), 'utf8')) as Record<string, unknown>
}

const signal = (): AbortSignal => new AbortController().signal

describe('runFolderName', () => {
  it('keeps letters, digits, dots, underscores, and dashes of at most 40 characters', () => {
    expect(runFolderName('walk cycle/v2')).toBe('walk-cycle-v2')
    expect(runFolderName('..hidden..')).toBe('hidden')
    expect(runFolderName('???')).toBe('')
    expect(runFolderName('a'.repeat(39) + '-b')).toBe('a'.repeat(39))
  })
})

describe('BlenderScripts', () => {
  it('runs one run in the script\'s folder with its own files and Blender user folder, and keeps its output', async () => {
    const script = await plan('bake.json', { print: ['loading', '', 'baked 3 clips'], printError: ['warning: slow'], files: { 'clips/walk.json': '{}' } })
    const blend = join(project, 'hero.blend')
    await writeFile(blend, '')
    const report = await scripts().run(call(script, { blend, runs: [{ args: ['--fps', '30'] }] }), signal())
    const run = report.runs[0]!
    expect(report).toMatchObject({ script, blend, runtime: 'the bpy module that WASD Engine ships', parallel: 1, notes: ['Unpacked bpy.'] })
    expect(run).toMatchObject({ args: ['--fps', '30'], status: 'finished', exitCode: 0, lastLine: 'warning: slow', files: ['clips/walk.json', 'received.json'], totalFiles: 2 })
    expect(run.folder).toBe(join(report.resultsDir, '1'))
    expect(report.resultsDir.startsWith(join(dataRoot, 'script-runs'))).toBe(true)
    expect(report.output).toBe('loading\n\nbaked 3 clips\nwarning: slow')
    expect(report.omittedLines).toBe(0)
    expect(await received(run.folder)).toMatchObject({
      args: ['--fps', '30'], cwd: await realpath(project), blend, script, user: join(run.folder, 'blender-user'), userExists: true, pipe: true,
    })
    // The Blender user folder goes with the run; the log and the summary stay.
    expect(existsSync(join(run.folder, 'blender-user'))).toBe(false)
    expect(await readFile(join(run.folder, 'output.log'), 'utf8')).toBe('loading\n\nbaked 3 clips\nwarning: slow\n')
    expect(JSON.parse(await readFile(join(report.resultsDir, 'summary.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)))
  })

  it('runs named runs at most as many at once as its places allow, each with its own status', async () => {
    const log = join(root, 'order.log')
    const script = await plan('batch.json', {
      log,
      runs: {
        a: { sleepMs: 300 }, b: { sleepMs: 300 }, c: { exit: 3, print: ['Traceback (most recent call last):', 'ValueError: bad clip'] },
        d: { signal: 'SIGKILL' }, e: { sleepMs: 5000 },
      },
    })
    const runner = scripts({ maxScripts: 2 })
    expect(runner.limit).toBe(2)
    const report = await runner.run(call(script, {
      timeoutMs: 1500,
      runs: [{ args: ['a'], name: 'walk cycle' }, { args: ['b'] }, { args: ['c'], name: '!!' }, { args: ['d'] }, { args: ['e'], name: 'slow' }],
    }), signal())
    expect(report.parallel).toBe(2)
    expect(report.output).toBeUndefined()
    expect(report.runs.map(run => run.folder.slice(report.resultsDir.length + 1))).toEqual(['1-walk-cycle', '2', '3', '4', '5-slow'])
    expect(report.runs.map(run => run.status)).toEqual(['finished', 'finished', 'failed', 'failed', 'timed-out'])
    expect(report.runs[0]).toMatchObject({ name: 'walk cycle', args: ['a'], exitCode: 0 })
    expect(report.runs[2]).toMatchObject({ exitCode: 3, lastLine: 'ValueError: bad clip' })
    expect(report.runs[3]).toMatchObject({ signal: 'SIGKILL' })
    expect(report.runs[3]!.exitCode).toBeUndefined()
    expect(report.runs[4]!.exitCode).toBeUndefined()
    expect(report.runs[4]!.signal).toBeUndefined()
    // Never more than two runs between a start and an end.
    let running = 0
    let most = 0
    for (const line of (await readFile(log, 'utf8')).trim().split('\n').sort((x, y) => Number(x.split(' ')[2]) - Number(y.split(' ')[2]))) {
      running += line.startsWith('start') ? 1 : -1
      most = Math.max(most, running)
    }
    expect(most).toBe(2)
  })

  it('shares its places among calls, first come first served', async () => {
    const log = join(root, 'calls.log')
    const script = await plan('slow.json', { log, sleepMs: 300 })
    const runner = scripts({ maxScripts: 1 })
    const [first, second] = await Promise.all([
      runner.run(call(script, { runs: [{ args: ['one'] }] }), signal()),
      runner.run(call(script, { runs: [{ args: ['two'] }] }), signal()),
    ])
    expect([first.runs[0]!.status, second.runs[0]!.status]).toEqual(['finished', 'finished'])
    expect((await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(' ').slice(0, 2).join(' ')))
      .toEqual(['start one', 'end one', 'start two', 'end two'])
  })

  it('starts no run after the call\'s time ran out and stops the runs that still run then', async () => {
    const script = await plan('long.json', { sleepMs: 5000 })
    const started = Date.now()
    const report = await scripts({ maxScripts: 1 }).run(call(script, { callTimeoutMs: 800, runs: [{ args: [] }, { args: [] }] }), signal())
    expect(Date.now() - started).toBeLessThan(4000)
    expect(report.runs.map(run => run.status)).toEqual(['timed-out', 'not-started'])
    expect(report.runs[1]).toMatchObject({ reason: 'The call\'s 1 seconds ran out before the run could start.', durationMs: 0, files: [], totalFiles: 0 })
  })

  it('starts no run while the computer has less memory available than a worker start needs', async () => {
    const script = await plan('any.json', {})
    const report = await scripts({ minAvailableMemoryBytes: GiB }, machine(GiB / 2)).run(call(script), signal())
    expect(report.runs[0]).toMatchObject({ status: 'not-started' })
    expect(report.runs[0]!.reason)
      .toMatch(/^The computer has 512\.0 MiB of memory available, less than the 1\.0 GiB that starting a Blender script run needs/u)
    expect(report.output).toBeUndefined()
  })

  it('sizes its places by the computer\'s memory and processors', () => {
    expect(scripts({ maxScripts: 8, scriptMemoryBytes: 2 * GiB, scriptCores: 2 }).limit).toBe(4)
    expect(scripts({ maxScripts: 8, scriptMemoryBytes: 4 * GiB, scriptCores: 0 }).limit).toBe(4)
    expect(scripts({ maxScripts: 3, scriptMemoryBytes: 0, scriptCores: 0 }).limit).toBe(3)
  })

  it('cuts output.log at scriptLogBytes and says so, and keeps the end of the output in the report', async () => {
    const script = await plan('loud.json', { bytes: 5000, print: ['', 'last line'] })
    const report = await scripts({ scriptLogBytes: 1000 }).run(call(script), signal())
    const log = await readFile(join(report.runs[0]!.folder, 'output.log'), 'utf8')
    expect(log).toBe(`${'x'.repeat(1000)}\n[WASD Engine left out the output after its first 1000 bytes.]\n`)
    expect(report.runs[0]).toMatchObject({ status: 'finished', outputCut: true, lastLine: 'last line' })
    expect(report.output?.endsWith('\nlast line')).toBe(true)
  })

  it('stops the processes that a run left running once it exits', async () => {
    const script = await plan('orphan.json', { orphan: true })
    const started = Date.now()
    const report = await scripts().run(call(script), signal())
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(report.runs[0]!.status).toBe('finished')
    const orphan = (await received(report.runs[0]!.folder)).orphan as number
    expect(() => process.kill(orphan, 0)).toThrow()
  })

  it('stops its runs when the call is cancelled', async () => {
    const script = await plan('wait.json', { sleepMs: 30_000 })
    const controller = new AbortController()
    const started = Date.now()
    const running = scripts().run(call(script, { runs: [{ args: [] }, { args: [] }, { args: [] }] }), controller.signal)
    setTimeout(() => { controller.abort(new Error('cancelled by the agent')) }, 300)
    await expect(running).rejects.toThrow('cancelled by the agent')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('stops its runs and refuses calls after close', async () => {
    const script = await plan('wait.json', { sleepMs: 30_000 })
    const runner = scripts()
    const running = runner.run(call(script), signal())
    await new Promise(resolve => setTimeout(resolve, 300))
    runner.close()
    expect((await running).runs[0]).toMatchObject({ status: 'failed', signal: 'SIGKILL' })
    await expect(runner.run(call(script), signal())).rejects.toThrow(new BlenderScriptError('The Blender server is shutting down.'))
  })

  it('refuses a missing script or .blend file before it prepares Blender', async () => {
    let launched = 0
    const runner = new BlenderScripts(options(), { launch: async () => { launched += 1; return LAUNCH }, machine: machine() })
    await expect(runner.run(call(join(project, 'missing.py')), signal())).rejects.toThrow(`The script ${join(project, 'missing.py')} does not exist.`)
    await expect(runner.run(call(project), signal())).rejects.toThrow(`The script ${project} is not a file.`)
    const script = await plan('ok.json', {})
    await expect(runner.run(call(script, { blend: join(project, 'gone.blend') }), signal())).rejects.toThrow(/^The \.blend file .* does not exist\.$/u)
    expect(launched).toBe(0)
  })

  it('says why a run could not start', async () => {
    const script = await plan('ok.json', {})
    const missing: WorkerLaunch = { ...LAUNCH, argv: [join(root, 'no-such-blender')] }
    const report = await new BlenderScripts(options(), { launch: async () => missing, machine: machine() }).run(call(script), signal())
    expect(report.runs[0]).toMatchObject({ status: 'not-started' })
    expect(report.runs[0]!.reason).toMatch(/^The run could not start: spawn .*no-such-blender ENOENT$/u)
  })

  it('keeps the newest keptScriptResults call folders', async () => {
    const script = await plan('quick.json', {})
    const runner = scripts({ keptScriptResults: 2 })
    const reports: ScriptCallReport[] = []
    for (let index = 0; index < 3; index += 1) reports.push(await runner.run(call(script), signal()))
    const left = await readdir(join(dataRoot, 'script-runs'))
    expect(left.sort()).toEqual(reports.slice(1).map(report => report.resultsDir.slice(join(dataRoot, 'script-runs').length + 1)).sort())
  })
})
