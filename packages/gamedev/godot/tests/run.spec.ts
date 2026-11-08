/** A run launches Godot, authenticates the harness, serves requests, collects logs, streams frames, and ends cleanly. */
import { join } from 'node:path'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { frameStream } from '../src/frames.ts'
import { LogSequence } from '../src/logs.ts'
import type { HarnessFrame } from '../src/protocol.ts'
import {
  gameArgv, GodotRequestError, GodotRunStateError, importArgv, launcherArgv, LIMIT_FPS, MAX_INPUT_EVENTS, MAX_LOG_MESSAGE_CHARS,
  type GodotRun, type GodotRunSpec,
} from '../src/run.ts'
import type { GodotInputEvent } from '../src/types.ts'
import { fakeLog, fakeRequests, launch, runSpec, scratch, subprocessFixture, until, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal
const tick = (milliseconds = 20) => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Scratch folder of the latest {@link start}. */
let dir: Scratch | undefined
const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
const runs: GodotRun[] = []

afterEach(async () => {
  await Promise.all(runs.splice(0).map(run => run.stop()))
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
  dir = undefined
})

interface Started {
  readonly run: GodotRun
  readonly project: string
  readonly warnings: string[]
}

type Overrides = Partial<GodotRunSpec> | ((project: string) => Partial<GodotRunSpec>)

async function start(
  config: FakeGodotConfig,
  overrides: Overrides = {},
  options: { subprocess?: (real: SubprocessRuntime) => SubprocessRuntime } = {},
): Promise<Started> {
  dir = await scratch('run')
  folders.push(dir)
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  const warnings: string[] = []
  const subprocess = options.subprocess?.(host.subprocess) ?? host.subprocess
  const run = launch(subprocess, runSpec(dir.fakeGodot, project, typeof overrides === 'function' ? overrides(project) : overrides), warnings, new LogSequence())
  runs.push(run)
  return { run, project, warnings }
}

/**
 * Wrap the subprocess service so that a run's abort does not reach its game process.
 * @param hold - ends the processes instead.
 * @param onAbort - called when a run aborts its process.
 * @returns the wrapper factory for {@link start}.
 */
function outliving(hold: AbortSignal, onAbort: () => void = () => {}): (real: SubprocessRuntime) => SubprocessRuntime {
  return real => Object.create(real, {
    spawn: {
      value: (spec: SubprocessSpawnSpec) => {
        spec.signal?.addEventListener('abort', onAbort, { once: true })
        return real.spawn({ ...spec, signal: hold })
      },
    },
  }) as SubprocessRuntime
}

async function running(config: FakeGodotConfig, overrides: Partial<GodotRunSpec> = {}): Promise<Started> {
  const started = await start(config, overrides)
  await started.run.started()
  expect(started.run.view().phase).toBe('running')
  return started
}

describe('command lines', () => {
  const libgodot = { kind: 'libgodot', runner: '/rt/godot_runner', library: '/rt/libgodot.dylib' } as const

  it('prefixes LibGodot arguments with the runner and its parent watch', () => {
    expect(launcherArgv(libgodot, 42, ['--path', '/p'])).toEqual(['/rt/godot_runner', '--libgodot', '/rt/libgodot.dylib', '--parent-pid', '42', '--', '--path', '/p'])
  })

  it('builds the import and game command lines', () => {
    const spec = runSpec('/bin/godot', '/p', { runtime: libgodot, windowless: true, size: { width: 800, height: 600 }, scene: 'res://level.tscn', harnessPath: '/h.gd' })
    expect(importArgv(spec)).toEqual([...launcherArgv(libgodot, process.pid, []), '--headless', '--path', '/p', '--import'])
    expect(gameArgv(spec, 1234, 'abc')).toEqual([
      ...launcherArgv(libgodot, process.pid, []), '--path', '/p', '--embedded', '--script', '/h.gd', '--audio-driver', 'Dummy',
      '--resolution', '800x600', '--', '--wasd-port=1234', '--wasd-token=abc', '--wasd-scene=res://level.tscn',
    ])
    const windowed = runSpec('/bin/godot_runner', '/p', { muted: false, harnessPath: '/h.gd' })
    expect(gameArgv(windowed, 1, 't'))
      .toEqual([...launcherArgv(windowed.runtime, process.pid, []), '--path', '/p', '--script', '/h.gd', '--', '--wasd-port=1', '--wasd-token=t'])
  })
})

posix('starting', () => {
  it('runs the import step first and logs its errors and warnings', async () => {
    const { run, project } = await start({
      import: { stdout: 'progress line\n', stderr: 'ERROR: bad import\n   at: load (res://a.png:1)\nWARNING: careful\n' },
      game: {},
    }, { importBeforeRun: true })
    const phases: string[] = []
    run.subscribe(() => { phases.push(run.view().phase) })
    await run.started()
    expect(phases.indexOf('starting')).toBeLessThan(phases.indexOf('running'))
    expect(run.view()).toMatchObject({ phase: 'running', errorCount: 1, warningCount: 1 })
    expect(run.logs.last(10)).toMatchObject([
      { source: 'import', level: 'error', message: 'bad import', file: 'res://a.png', line: 1, function: 'load' },
      { source: 'import', level: 'warning', message: 'careful' },
    ])
    // The runner passes Godot the command line after its own `--libgodot ... --` options, which the fake records.
    const spec = runSpec(dir?.fakeGodot as string, project, { importBeforeRun: true })
    const expected = importArgv(spec).slice(launcherArgv(spec.runtime, spec.hostPid, []).length)
    expect((await fakeLog(project))[0]).toEqual({ argv: expected })
  })

  it.each([
    [{ exitCode: 134, stderr: 'handle_crash: Program crashed with signal 11\n' }, 'ended abnormally (exit code 134: Program crashed with signal 11)'],
    [{ exitCode: 1, stdout: 'handle_crash: stdout crash\n' }, 'ended abnormally (exit code 1: stdout crash)'],
    [{ signal: 'SIGKILL' }, 'ended abnormally (signal SIGKILL)'],
  ])('keeps running after an abnormal import end and warns: %j', async (importer, message) => {
    const { run } = await start({ import: importer, game: {} }, { importBeforeRun: true })
    await run.started()
    expect(run.view().phase).toBe('running')
    expect(run.logs.last(5).at(-1)).toMatchObject({ source: 'import', level: 'warning', message: expect.stringContaining(message) as string })
  })

  it('fails when the import step times out or cannot start', async () => {
    const slow = await start({ import: { delayMs: 5000 }, game: {} }, { importBeforeRun: true, importTimeoutMs: 200 })
    await slow.run.started()
    expect(slow.run.view()).toMatchObject({ phase: 'failed', message: 'The Godot import step did not finish within 0.2 s.' })
    expect(slow.run.outputTail(5)).toBe('')
    await slow.run.stop()
    const missing = await start({}, { importBeforeRun: true, runtime: { kind: 'libgodot', runner: join(dir?.root as string, 'no-godot'), library: '/no-libgodot' } })
    await missing.run.started()
    expect(missing.run.view()).toMatchObject({ phase: 'failed', message: expect.stringContaining('The Godot import step could not start') as string })
  })

  it('ends as exited when stopped during the import step', async () => {
    const { run } = await start({ import: { delayMs: 5000 }, game: {} }, { importBeforeRun: true })
    await until(() => run.view().phase === 'importing')
    await run.stop()
    expect(run.view()).toMatchObject({ phase: 'exited' })
    expect(run.view().message).toBeUndefined()
  })

  it('fails with the process output when the game exits before connecting', async () => {
    const { run } = await start({ game: { stderr: 'SCRIPT ERROR: Parse Error: oops\n   at: GDScript::reload (res://main.gd:2)\n', exitBeforeConnect: 3 } })
    await run.started()
    expect(run.view()).toMatchObject({ phase: 'failed', exitCode: 3, errorCount: 1 })
    expect(run.view().message).toBe('The game exited before it connected (exit code 3).\nLast output:\nSCRIPT ERROR: Parse Error: oops\n   at: GDScript::reload (res://main.gd:2)')
    expect(run.logs.last(5)).toMatchObject([{ source: 'process', level: 'script_error', file: 'res://main.gd', line: 2 }])
    await run.stop()
    await expect(run.wait({ frames: 1 }, signal)).rejects.toThrow('no longer running')
  })

  it('fails when the game cannot be spawned or the spawn throws', async () => {
    const missing = await start({}, { runtime: { kind: 'libgodot', runner: join('/nonexistent', 'godot_runner'), library: '/no-libgodot' } })
    await missing.run.started()
    expect(missing.run.view()).toMatchObject({ phase: 'failed', message: expect.stringContaining('The game could not start: spawn') as string })
    const thrown = await start({}, {}, {
      subprocess: real => Object.create(real, { spawn: { value: () => { throw new Error('spawn exploded') } } }) as SubprocessRuntime,
    })
    await thrown.run.started()
    expect(thrown.run.view()).toMatchObject({ phase: 'failed', message: 'The game could not start: Error: spawn exploded' })
  })

  it('fails when the game does not connect in time, refusing a late hello', async () => {
    const hold = new AbortController()
    try {
      // The game connects with its valid token only after the deadline, and outlives the run's abort until the Host closes the connection.
      const { run, project } = await start(
        { game: { connectDelayMs: 300 } },
        { startTimeoutMs: 100 },
        { subprocess: outliving(hold.signal) },
      )
      const phases: string[] = []
      run.subscribe(() => { phases.push(run.view().phase) })
      await run.started()
      expect(run.view()).toMatchObject({ phase: 'failed', message: 'The game did not connect within 0.1 s.' })
      expect(phases).not.toContain('running')
      expect(await fakeLog(project)).toContainEqual({ closed: true })
    } finally {
      hold.abort()
    }
  })

  it('accepts a hello that shares its chunk with a message above the limit before authentication', async () => {
    const firstLogs = Array.from({ length: 1500 }, (_, index) => ({ level: 'stdout', message: `line ${index} ${'x'.repeat(40)}`, time_ms: index }))
    const { run } = await running({ game: { first: 'withLogs', firstLogs } }, { maxLogEntries: 2000 })
    await until(() => run.logs.lastSeq >= firstLogs.length)
    expect(run.logs.last(1)).toMatchObject([{ source: 'game', level: 'stdout', message: expect.stringMatching(/^line 1499 /u) as string }])
  })

  it('ends as exited when stopped while starting', async () => {
    const { run, project } = await start({ game: { connect: 'never' } })
    await until(async () => (await fakeLog(project)).length > 0)
    await run.stop()
    expect(run.view()).toMatchObject({ phase: 'exited' })
    expect(run.view().signal).toBe('SIGTERM')
  })

  it.each([
    [{ first: 'frame' }],
    [{ first: 'status' }],
    [{ first: 'garbage' }],
    [{ token: 'x' }],
    [{ token: '0'.repeat(32) }],
  ])('refuses a connection that does not authenticate: %j', async (game) => {
    const { run } = await start({ game })
    await run.started()
    expect(run.view()).toMatchObject({ phase: 'failed', message: 'The game exited before it connected (exit code 0).' })
  })

  it('refuses a harness speaking another protocol', async () => {
    const { run } = await start({ game: { protocol: 2 } })
    await run.started()
    expect(run.view()).toMatchObject({ phase: 'failed', message: 'The game harness speaks protocol 2; this Host speaks 1.' })
  })

  it('accepts the real harness after an idle connection and closes the idle one', async () => {
    const { run, project } = await running({ game: { decoy: true, displayServer: 'embedded', scene: '' } }, { scene: 'res://level.tscn' })
    expect(run.view()).toMatchObject({ windowless: true, scene: 'res://level.tscn', projectName: 'Fake game', launch: { scene: 'res://level.tscn' } })
    await run.stop()
    expect((await fakeLog(project)).filter(entry => entry.closed === true)).toHaveLength(1)
  })
})

posix('messages and requests', () => {
  it('records status, logs, and a repeated hello', async () => {
    const long = 'x'.repeat(MAX_LOG_MESSAGE_CHARS + 10)
    const { run } = await running({
      game: {
        repeatHello: true,
        logs: [
          { level: 'stdout', message: long, time_ms: 1 },
          { level: 'warning', message: 'w', file: '', line: 0, function: '', time_ms: 2 },
          { level: 'script_error', message: 'e', file: 'res://p.gd', line: 9, function: 'f', backtrace: [{ function: 'f', file: 'res://p.gd', line: 9 }], time_ms: 3 },
        ],
        statusIntervalMs: 40,
      },
    })
    await until(() => run.logs.lastSeq >= 3)
    const [first, second, third] = run.logs.last(3)
    expect(first?.message).toHaveLength(MAX_LOG_MESSAGE_CHARS + 1)
    expect(second).toEqual({ seq: 2, runId: 'run-1', source: 'game', level: 'warning', message: 'w', time: expect.any(Number) as number })
    expect(third).toMatchObject({ level: 'script_error', file: 'res://p.gd', line: 9, function: 'f', backtrace: [{ function: 'f', file: 'res://p.gd', line: 9 }] })
    await until(() => (run.view().frame ?? 0) > 2)
    expect(run.view()).toMatchObject({ fps: 60, mouseMode: 0, scene: 'res://main.tscn', errorCount: 1, warningCount: 1, launch: {} })
  })

  it('reports the start request’s scene and size apart from the scene that runs', async () => {
    const { run } = await running({ game: {} }, { scene: 'res://level.tscn', size: { width: 320, height: 200 } })
    await until(() => run.view().scene === 'res://main.tscn')
    expect(run.view().launch).toEqual({ scene: 'res://level.tscn', width: 320, height: 200 })
  })

  it('answers every request type and tracks pause state', async () => {
    const { run, project } = await running({ game: { imageFirst: true, tree: { name: 'Main', class: 'Node2D' }, evalValue: [1, 2] } })
    expect(LIMIT_FPS).toBe(10)
    const shot = await run.screenshot(1280, signal)
    expect(shot.meta).toMatchObject({ width: 640, windowWidth: 640 })
    expect(await run.input([{ kind: 'key', key: 'W', pressed: true }], signal)).toMatchObject({ events: 1 })
    expect(await run.wait({ frames: 6 }, signal)).toMatchObject({ frames: 6, paused: false })
    expect(await run.wait({ seconds: 0.05 }, signal)).toMatchObject({ seconds: 0.05 })
    expect(await run.setPaused(true, signal)).toMatchObject({ paused: true })
    expect(run.view().phase).toBe('paused')
    expect(await run.setPaused(false, signal)).toMatchObject({ paused: false })
    expect(run.view().phase).toBe('running')
    expect(await run.step(3, signal)).toMatchObject({ frames: 3, paused: true })
    expect(run.view().phase).toBe('paused')
    expect(await run.evaluate('scene.name', undefined, signal)).toEqual({ value: [1, 2], valueType: 'String' })
    expect(await run.tree('/root/Main', 2, 10, signal)).toEqual({ tree: { name: 'Main', class: 'Node2D' }, truncated: false })
    expect(await run.tree(undefined, 2, 10, signal)).toMatchObject({ truncated: false })
    const requests = await fakeRequests(project)
    expect(requests.find(request => request.type === 'eval')).not.toHaveProperty('node')
    expect(requests.filter(request => request.type === 'tree')[0]).toMatchObject({ node: '/root/Main', depth: 2, maxNodes: 10 })
    // Each limit is the time the request needs, with frames at 10 per second, plus requestTimeoutMs.
    expect(requests.filter(request => ['input', 'wait', 'step'].includes(request.type as string)).map(request => [request.type, request.timeoutMs])).toEqual([
      ['input', 5100], ['wait', 5600], ['wait', 5050], ['step', 5300],
    ])
  })

  it('limits an input sequence to its waits, a frame per wait, and requestTimeoutMs, and reports a sequence that its limit ended', async () => {
    const { run, project } = await running({ game: { replies: { input: 'timedOut', step: 'timedOut' } } })
    const events: GodotInputEvent[] = [
      { kind: 'key', key: 'W', pressed: true, hold: 30 }, { wait: 0.25 }, { wait: 0 }, { wait: 1.5 }, { kind: 'key', key: 'W', pressed: false },
    ]
    expect(await run.input(events, signal)).toMatchObject({ events: 2, timedOut: true, cancelled: false })
    expect(await run.step(8, signal)).toMatchObject({ frames: 4, paused: true, timedOut: true, cancelled: false })
    expect(run.view().phase).toBe('paused')
    const requests = await fakeRequests(project)
    // 1.75 s of waits, three frames at 10 per second, and requestTimeoutMs; the 30 s hold releases outside the sequence.
    expect(requests.find(request => request.type === 'input')).toMatchObject({ timeoutMs: 1750 + 300 + 5000 })
    expect(requests.find(request => request.type === 'step')).toMatchObject({ frames: 8, timeoutMs: 800 + 5000 })
  })

  it('serves concurrent requests and screenshots answered before their image', async () => {
    const { run, project } = await running({ game: { logs: [] } })
    expect(run.godotVersion).toBe('4.7.2-stable (fake)')
    const waiting = run.wait({ seconds: 0.3 }, signal)
    const [shot, value] = await Promise.all([run.screenshot(320, signal), run.evaluate('position', '/root/Main/Player', signal)])
    expect(shot.png.toString('latin1')).toBe('PNG-BYTES')
    expect(shot.meta).toMatchObject({ width: 320, height: 180, windowWidth: 640, windowHeight: 360 })
    expect(value).toEqual({ value: 'position', valueType: 'String' })
    expect(await waiting).toMatchObject({ seconds: 0.3 })
    expect((await fakeRequests(project)).find(request => request.type === 'eval')).toMatchObject({ node: '/root/Main/Player' })
  })

  it('ignores stray images and late answers', async () => {
    const { run } = await running({ game: { stray: 'eval', statusIntervalMs: 40, replies: { tree: 'slow:400' } } }, { requestTimeoutMs: 200 })
    expect(await run.evaluate('1', undefined, signal)).toMatchObject({ valueType: 'String' })
    await expect(run.tree(undefined, 1, 1, signal)).rejects.toThrow('The game did not answer tree within 0.2 s.')
    await tick(400)
    expect(await run.evaluate('2', undefined, signal)).toMatchObject({ value: '2' })
  })

  it('reports refused requests with or without a reason', async () => {
    const { run } = await running({ game: { replies: { eval: 'error', tree: 'noerror' } } })
    await expect(run.evaluate('x', undefined, signal)).rejects.toThrow(new GodotRequestError('fake eval failure'))
    await expect(run.tree(undefined, 1, 1, signal)).rejects.toThrow('The game refused the request.')
  })

  it('cancels a request on abort', async () => {
    const { run } = await running({ game: {} })
    const controller = new AbortController()
    const waiting = run.wait({ seconds: 1.5 }, controller.signal)
    controller.abort(new Error('caller left'))
    await expect(waiting).rejects.toThrow('caller left')
    await expect(run.wait({ frames: 1 }, controller.signal)).rejects.toThrow('caller left')
  })

  it('bounds a wait for seconds in real time and asks the game to drop the waits and sequences that the Host abandons', async () => {
    const { run, project } = await running({ game: { replies: { input: 'none', eval: 'none' } } }, { requestTimeoutMs: 2000 })
    expect(await run.wait({ seconds: 0.05 }, signal)).toMatchObject({ seconds: 0.05, timedOut: false, cancelled: false })
    const left = new AbortController()
    const sequence = run.input([{ wait: 5 }], left.signal)
    const value = run.evaluate('x', undefined, left.signal)
    await until(async () => (await fakeRequests(project)).some(request => request.type === 'eval'))
    left.abort(new Error('caller left'))
    await expect(sequence).rejects.toThrow('caller left')
    await expect(value).rejects.toThrow('caller left')
    await until(async () => (await fakeRequests(project)).some(request => request.type === 'cancel'))
    const requests = await fakeRequests(project)
    expect(requests.find(request => request.type === 'wait')).toMatchObject({ seconds: 0.05, timeoutMs: 2050 })
    expect(requests.filter(request => request.type === 'cancel')).toEqual([
      { type: 'cancel', id: expect.any(Number) as number, request: requests.find(request => request.type === 'input')?.id },
    ])
  })

  it('fails waiting requests when the game stops responding, but not while it keeps sending', async () => {
    const lively = await running({ game: { statusIntervalMs: 40, replies: { wait: 'none' } } }, { requestTimeoutMs: 200 })
    const controller = new AbortController()
    const waiting = lively.run.wait({ seconds: 5 }, controller.signal)
    await tick(400)
    controller.abort(new Error('done waiting'))
    await expect(waiting).rejects.toThrow('done waiting')
    await lively.run.stop()
    const frozen = await running({ game: { freezeOn: 'wait' } }, { requestTimeoutMs: 200 })
    await expect(frozen.run.wait({ seconds: 5 }, signal)).rejects.toThrow(/The game stopped responding: it sent nothing for/u)
    await until(async () => (await fakeRequests(frozen.project)).some(request => request.type === 'cancel'))
  })

  it('refuses requests before the game connects', async () => {
    const { run } = await start({ game: { connect: 'never' } })
    await until(() => run.view().phase === 'starting')
    await expect(run.evaluate('x', undefined, signal)).rejects.toThrow(new GodotRunStateError('The game is not accepting requests.'))
    expect(() => { run.sendUserInput([{ wait: 0 }]) }).toThrow(GodotRunStateError)
  })
})

posix('frames', () => {
  it('starts streaming at connect for an early sink and stops when the last sink leaves', async () => {
    const { run, project } = await start({ game: {} })
    const frames: HarnessFrame[] = []
    const first = run.subscribeFrames({ frame: (frame) => { frames.push(frame) }, end: () => {} })
    await run.started()
    await until(() => frames.length >= 2)
    const second = run.subscribeFrames({ frame: () => {}, end: () => {} })
    first()
    first()
    second()
    await until(async () => (await fakeRequests(project)).filter(request => request.type === 'stream').length === 2)
    expect((await fakeRequests(project)).filter(request => request.type === 'stream')).toEqual([{ type: 'stream', id: expect.any(Number) as number, fps: 50, quality: 0.5, maxWidth: 320, lossless: true }, { type: 'stream', id: expect.any(Number) as number, fps: 0 }])
    expect(frames[0]).toMatchObject({ seq: 1, width: 320, height: 360 })
  })

  it('ends sinks with the run and ends late sinks at once', async () => {
    const { run } = await running({ game: {} })
    let ended = 0
    run.subscribeFrames({ frame: () => {}, end: () => { ended += 1 } })
    await run.stop()
    expect(ended).toBe(1)
    const late = run.subscribeFrames({ frame: () => {}, end: () => { ended += 1 } })
    expect(ended).toBe(2)
    late()
  })

  it('warns about a failed stream request only while the run lives', async () => {
    const failing = await running({ game: { replies: { stream: 'error' } } })
    const leave = failing.run.subscribeFrames({ frame: () => {}, end: () => {} })
    await until(() => failing.warnings.length > 0)
    expect(failing.warnings[0]).toBe('Godot frame streaming request failed: fake stream failure')
    leave()
    await failing.run.stop()
    const silent = await running({ game: { replies: { stream: 'none' } } })
    silent.run.subscribeFrames({ frame: () => {}, end: () => {} })
    await tick()
    await silent.run.stop()
    expect(silent.warnings).toEqual([])
  })
})

posix('user input', () => {
  it('sends one batch at a time, merging motion and trimming the backlog', async () => {
    const { run, project } = await running({ game: {} })
    run.sendUserInput([{ kind: 'key', key: 'W', pressed: true }, { wait: 0.2 }])
    run.sendUserInput([{ kind: 'mouse_motion', x: 1, y: 1, dx: 1 }, { kind: 'mouse_motion', x: 2, y: 3, dy: 2 }, { kind: 'key', key: 'W', pressed: false }])
    run.sendUserInput([{ kind: 'mouse_motion', x: 4, y: 4, dy: 1 }, { kind: 'mouse_motion', x: 5, y: 5, dx: 3 }])
    await until(async () => (await fakeRequests(project)).filter(request => request.type === 'input').length === 2)
    const inputs = (await fakeRequests(project)).filter(request => request.type === 'input')
    // Game tab input carries no real-time limit, so a batch behind an agent sequence still delivers its releases.
    expect(inputs.map(request => 'timeoutMs' in request)).toEqual([false, false])
    expect(inputs[1]?.events).toEqual([
      { kind: 'mouse_motion', x: 2, y: 3, dx: 1, dy: 2 },
      { kind: 'key', key: 'W', pressed: false },
      { kind: 'mouse_motion', x: 5, y: 5, dx: 3, dy: 1 },
    ])
    run.sendUserInput([{ wait: 0.2 }])
    const flood: GodotInputEvent[] = Array.from({ length: MAX_INPUT_EVENTS + 20 }, (_, index) => ({ kind: 'key', keycode: index + 1, pressed: true }))
    run.sendUserInput(flood)
    await until(async () => (await fakeRequests(project)).filter(request => request.type === 'input').length === 4)
    const last = (await fakeRequests(project)).filter(request => request.type === 'input')[3]?.events as GodotInputEvent[]
    expect(last).toHaveLength(MAX_INPUT_EVENTS)
    expect(last[0]).toEqual({ kind: 'key', keycode: 21, pressed: true })
  })

  it('warns about rejected input only while the run lives', async () => {
    const { run, warnings } = await running({ game: {} })
    run.sendUserInput([{ kind: 'key', key: 'BadKey', pressed: true }])
    await until(() => warnings.length > 0)
    expect(warnings).toEqual(['Godot rejected user input: unknown key BadKey'])
    run.sendUserInput([{ wait: 2 }])
    await run.stop()
    expect(warnings).toHaveLength(1)
    expect(() => { run.sendUserInput([{ wait: 0 }]) }).toThrow('The game is no longer running.')
  })
})

posix('ending', () => {
  it('reports a crash with the output after the connection closed', async () => {
    const { run } = await running({ game: { exitOn: { type: 'eval', code: 3, closeFirst: true, stderr: 'ERROR: boom\nhandle_crash: Program crashed\n' } } })
    await expect(run.evaluate('x', undefined, signal)).rejects.toThrow(GodotRunStateError)
    await run.whenEnded()
    expect(run.view()).toMatchObject({ phase: 'crashed', exitCode: 3 })
    expect(run.view().message).toBe('The game crashed (exit code 3).\nLast output:\nERROR: boom\nhandle_crash: Program crashed')
    expect(run.logs.last(2)).toMatchObject([{ source: 'process', level: 'error', message: 'boom' }, { source: 'process', level: 'stderr', message: 'handle_crash: Program crashed' }])
  })

  it.each([
    [{ code: 4, closeFirst: true, stdout: 'only stdout\n' }, 'The game crashed (exit code 4).\nLast output:\nonly stdout'],
    [{ code: 5, closeFirst: true }, 'The game crashed (exit code 5).'],
    [{ signal: 'SIGKILL' }, 'The game crashed (signal SIGKILL).'],
  ])('quotes the available output of a crash: %j', async (exit, message) => {
    const { run } = await running({ game: { exitOn: { type: 'eval', ...exit } } })
    await run.evaluate('x', undefined, signal).catch(() => {})
    await run.whenEnded()
    expect(run.view()).toMatchObject({ phase: 'crashed', message })
  })

  it('ends as exited when the game quits by itself, even while another process holds its connection', async () => {
    const closing = await running({ game: { exitOn: { type: 'eval', code: 0, closeFirst: true } } })
    await closing.run.evaluate('x', undefined, signal).catch(() => {})
    await closing.run.whenEnded()
    expect(closing.run.view()).toMatchObject({ phase: 'exited', exitCode: 0 })
    expect(closing.run.view().message).toBeUndefined()
    await closing.run.stop()
    const held = await running({ game: { exitOn: { type: 'eval', code: 0, holdSocket: true } } })
    await held.run.evaluate('x', undefined, signal).catch(() => {})
    await held.run.whenEnded()
    expect(held.run.view()).toMatchObject({ phase: 'exited', exitCode: 0 })
  })

  it('stops a game that closes its connection without exiting', async () => {
    const { run } = await running({ game: { closeOn: 'eval', onHostClose: 'linger' } }, { stopGraceMs: 200 })
    await expect(run.evaluate('x', undefined, signal)).rejects.toThrow('The game closed its connection to the Host.')
    await run.whenEnded()
    expect(run.view()).toMatchObject({ phase: 'crashed', signal: 'SIGTERM', message: 'The game closed its connection without exiting and was stopped after 0.2 s.' })
  })

  it('survives a reset connection', async () => {
    const { run } = await running({ game: { resetOn: 'eval', exitAfterReset: 0 } })
    await expect(run.evaluate('x', undefined, signal)).rejects.toThrow(GodotRunStateError)
    await run.whenEnded()
    expect(run.view().phase).toBe('exited')
  })

  it('logs a protocol violation after the handshake and ends the run', async () => {
    const { run } = await running({ game: { garbageAfterHello: true } })
    await run.whenEnded()
    expect(run.logs.filter(entry => entry.source === 'process')).toMatchObject([{ level: 'error', message: expect.stringContaining('The game harness sent an invalid message') as string }])
  })

  it('accepts no requests once a stop began, also while a frozen game outlives the stop', async () => {
    const hold = new AbortController()
    const aborted = Promise.withResolvers<undefined>()
    const failures: unknown[] = []
    const fail = (error: unknown): void => { failures.push(error) }
    process.on('unhandledRejection', fail)
    process.on('uncaughtException', fail)
    try {
      const { run, warnings } = await start(
        { game: { onQuit: 'ignore', replies: { input: 'none' } } },
        { stopGraceMs: 100 },
        { subprocess: outliving(hold.signal, () => { aborted.resolve(undefined) }) },
      )
      await run.started()
      const frames = new AbortController()
      const reader = frameStream(run, frames.signal).getReader()
      await reader.read()
      run.sendUserInput([{ kind: 'key', key: 'W', pressed: true }])
      run.sendUserInput([{ kind: 'key', key: 'W', pressed: false }])
      const stopping = run.stop()
      expect(run.connected).toBe(false)
      expect(() => { run.sendUserInput([{ wait: 0 }]) }).toThrow(new GodotRunStateError('The game is stopping.'))
      await expect(run.evaluate('x', undefined, signal)).rejects.toThrow(new GodotRunStateError('The game is stopping.'))
      // After the quit grace the run aborts the queued input; the game still holds its connection.
      await aborted.promise
      await tick()
      frames.abort()
      expect(await reader.read()).toEqual({ done: true, value: undefined })
      hold.abort()
      await stopping
      await tick(50)
      expect(failures).toEqual([])
      expect(warnings).toEqual([])
      expect(run.view().phase).toBe('exited')
    } finally {
      hold.abort()
      process.off('unhandledRejection', fail)
      process.off('uncaughtException', fail)
    }
  })

  it('terminates a game that ignores quit, and stops only once', async () => {
    const { run } = await running({ game: { onQuit: 'ignore' } }, { stopGraceMs: 200 })
    const first = run.stop()
    expect(run.stop()).toBe(first)
    await first
    expect(run.view()).toMatchObject({ phase: 'exited', signal: 'SIGTERM' })
    expect(run.terminal).toBe(true)
    expect(run.connected).toBe(false)
    await run.stop()
  })

  it('reports a project without a name', async () => {
    const { run, project } = await start({ game: {} }, path => ({ project: { dir: path } }))
    await run.started()
    expect(run.view()).not.toHaveProperty('projectName')
    expect(run.project.dir).toBe(project)
    expect(run.revision).toBeGreaterThan(0)
  })
})
