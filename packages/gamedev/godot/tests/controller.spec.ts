/**
 * The Game tab's Remote follows and drives the game of a Session by its id, resuming the Session only to start a
 * game; the plugin's contributions end with its fiber.
 */
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import GodotController from '../src/index.ts'
import type { GodotFollowItem, GodotRunView } from '../src/types.ts'
import { callTool, compose, text, type Composition, type CompositionOptions, type ResolveAgent } from './composition.ts'
import { fakeLog, fakeRequests, until } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal
/** The composition's live Session. */
const OWNER = SessionId('owner')
const READY = { state: 'ready', kind: 'libgodot', windowless: process.platform === 'darwin' } as const

let composition: Composition | undefined
afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function setup(options: CompositionOptions = {}): Promise<Composition> {
  composition = await compose(options)
  return composition
}

async function expectRemote(call: Promise<unknown> | (() => unknown), code: string, message?: string): Promise<void> {
  const settled = typeof call === 'function' ? Promise.resolve().then(call) : call
  const expected = { isDSHRemoteError: true, code, ...message === undefined ? {} : { message: expect.stringContaining(message) as string } }
  await expect(settled).rejects.toMatchObject(expected)
}

/** Read follow items until one satisfies `match`. */
async function until$(stream: AsyncIterator<GodotFollowItem>, match: (item: GodotFollowItem) => boolean): Promise<GodotFollowItem> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('the follow stream ended')
    if (match(next.value)) return next.value
  }
}

/** Whether a follow item reports `run` in `phase`. */
function reports(run: GodotRunView, phase: GodotRunView['phase']): (item: GodotFollowItem) => boolean {
  return item => (item.type === 'run' || item.type === 'snapshot') && item.run?.runId === run.runId && item.run.phase === phase
}

describe('configuration', () => {
  it.each([
    [{ dataRoot: 'relative' }, 'dataRoot must be an absolute path'],
    [{ dataRoot: '/data', libgodotPath: '/lib.so' }, 'set libgodotPath and runnerPath together'],
    [{ dataRoot: '/data', runnerPath: 'godot_runner', libgodotPath: '/lib.so' }, 'runnerPath must be an absolute path'],
    [{ dataRoot: '/data', runtimeManifestUrl: 'not a url' }, 'runtimeManifestUrl must be an http or https URL'],
    [{ dataRoot: '/data', runtimeManifestUrl: 'file:///manifest.json' }, 'runtimeManifestUrl must be an http or https URL'],
    [{ dataRoot: '/data', webTemplateArchiveUrl: 'file:///t.tpz' }, 'webTemplateArchiveUrl must be an http or https URL'],
    [{ dataRoot: '/data', windowsTemplateArchiveUrl: 'nope' }, 'windowsTemplateArchiveUrl must be an http or https URL'],
    [{ dataRoot: '/data', macosTemplatePath: 'macos.zip' }, 'macosTemplatePath must be an absolute path'],
  ])('fails loud for %j', (config, message) => {
    expect(() => new GodotController(new Context(), GodotController.Config(config))).toThrow(message)
  })

  it('applies the documented defaults', () => {
    expect(GodotController.Config({ dataRoot: '/data' })).toEqual({
      dataRoot: '/data', runtimeVersion: '4.7.2-wasd.2',
      runtimeManifestUrl: 'https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.2/manifest.json',
      libgodotPath: '', runnerPath: '', streamFps: 30, streamQuality: 0.9, streamLossless: true, streamMaxWidth: 1280,
      importBeforeRun: true, importTimeoutMs: 180_000, startTimeoutMs: 60_000, requestTimeoutMs: 15_000, stopGraceMs: 3000,
      processOutputBytes: 1024 * 1024, maxLogEntries: 5000, maxRuns: 4, runMemoryBytes: 8 * 1024 ** 3, runCores: 4,
      idleRunStopMs: 300_000, maxScripts: 4, scriptMemoryBytes: 2 * 1024 ** 3, scriptCores: 2, keptScriptResults: 20,
      maxHeadlessProcesses: 2, minAvailableMemoryBytes: 1024 ** 3, hiddenFps: 10, hiddenDelayMs: 30_000, agentRunsMuted: true,
      minWindowHeight: 720, recordQuality: 0.92, recordBufferBytes: 1024 ** 3, maxVideoBytes: 4 * 1024 ** 3,
      webTemplateArchiveUrl: 'https://github.com/WASDEngine/WASD-Engine/releases/download/web-template-4.7.2-wasd.1/web-template-4.7.2-wasd.1.tpz',
      webTemplateEntry: 'templates/web_nothreads_release.zip',
      webTemplateSha256: '477a8c0bff8a89acf58cdd68d913b160e71cfb038cf3648eebc2ab853148a65d',
      webTemplatePath: '',
      windowsTemplateArchiveUrl: 'https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz',
      windowsTemplateEntry: 'templates/windows_release_x86_64.exe',
      windowsTemplateSha256: 'd34d36f3be1a6c49c56525ae86469b92e4f417ddf0b43cf00dd80c385c4b0562',
      windowsTemplatePath: '',
      macosTemplateArchiveUrl: 'https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz',
      macosTemplateEntry: 'templates/macos.zip',
      macosTemplateSha256: '88df5e2e6fee99088699be66e6d42e4da4fb0c5619d054297d755a49558a4792',
      macosTemplatePath: '',
      serverTemplateArchiveUrl: 'https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz',
      serverTemplateEntry: 'templates/linux_release.x86_64',
      serverTemplateSha256: 'd9f79ab89b5ae369aeed11c6052d402e8218cd503bf85b4a235f9c30c46a7c63',
      serverTemplatePath: '',
      exportTimeoutMs: 600_000,
      maxInstances: 4, instanceMemoryBytes: 2 * 1024 ** 3, instanceCores: 1,
      webCheckCommand: [], webCheckSeconds: 20, webCheckStartTimeoutMs: 180_000, webCheckTimeoutMs: 300_000,
    })
  })
})

posix('Remote', () => {
  it('follows the Session: snapshot, the user run, and its logs', async () => {
    const c = await setup({ game: { game: { logs: [{ level: 'stdout', message: 'hi', time_ms: 1 }] } } })
    const controller = new AbortController()
    const stream = c.godot.follow(OWNER, controller.signal)[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.value).toEqual({ type: 'snapshot', run: null, runtime: READY, logs: [], cursor: 0 })
    const view = await c.godot.run(OWNER, {}, signal)
    expect(view).toMatchObject({ startedBy: 'user', muted: false, runtime: 'libgodot', launch: {} })
    expect(c.sessionController.resumed).toEqual([])
    const items: GodotFollowItem[] = []
    while (!items.some(item => item.type === 'logs')) items.push((await stream.next()).value as GodotFollowItem)
    expect(items.some(item => item.type === 'run' && item.run?.phase === 'running')).toBe(true)
    controller.abort()
    expect(await stream.next()).toMatchObject({ done: true })
  })

  it('follows and plays a Session whose Agent is not live, resuming it only to play', async () => {
    const c = await setup({ game: { game: { replies: {} } } })
    const cold = SessionId('cold')
    const controller = new AbortController()
    const stream = c.godot.follow(cold, controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual({ type: 'snapshot', run: null, runtime: READY, logs: [], cursor: 0 })
    await expectRemote(c.godot.stop(cold, signal), 'godot/not-running')
    await expectRemote(c.godot.control(cold, { action: 'pause' }, signal), 'godot/not-running')
    await expectRemote(() => { c.godot.input(cold, 'run', [{ wait: 0 }], signal) }, 'godot/not-running')
    expect(c.ctx.agents.get(cold)).toBeUndefined()
    expect(c.sessionController.resumed).toEqual([])

    const view = await c.godot.run(cold, { width: 320, height: 200 }, signal)
    expect(c.sessionController.resumed).toEqual([cold])
    expect(c.ctx.agents.get(cold)).toBeDefined()
    expect(view).toMatchObject({ startedBy: 'user', launch: { width: 320, height: 200 } })
    // The stream that opened while the Session had no Agent reports the run.
    await until$(stream, reports(view, 'running'))
    expect(await c.godot.control(cold, { action: 'pause' }, signal)).toMatchObject({ phase: 'paused' })
    c.godot.input(cold, view.runId, [{ kind: 'key', key: 'W', pressed: true }], signal)
    await until(async () => (await fakeRequests(c.project)).some(request => request.type === 'input'))
    await c.godot.stop(cold, signal)
    await until$(stream, reports(view, 'exited'))
    controller.abort()
  })

  it('reports no run once the Session’s Agent ends, and follows the run of its next Agent', async () => {
    const c = await setup()
    const controller = new AbortController()
    const stream = c.godot.follow(OWNER, controller.signal)[Symbol.asyncIterator]()
    await stream.next()
    const first = await c.godot.run(OWNER, {}, signal)
    await until$(stream, reports(first, 'running'))
    await c.owner.dispose()
    await until$(stream, item => item.type === 'run' && item.run === null)
    await expectRemote(c.godot.stop(OWNER, signal), 'godot/not-running')
    await expectRemote(() => { c.godot.input(OWNER, first.runId, [{ wait: 0 }], signal) }, 'godot/not-running')
    const second = await c.godot.run(OWNER, {}, signal)
    expect(c.sessionController.resumed).toEqual([OWNER])
    await until$(stream, reports(second, 'running'))
    controller.abort()
  })

  it('refuses to play a Session that cannot be resumed, and a cancelled call stops only its wait for the resume', async () => {
    const c = await setup()
    const calls: SessionId[] = []
    const refuse: ResolveAgent = async (sessionId) => {
      calls.push(sessionId)
      return { error: new RemoteError('session/writer-held', `session "${sessionId}" is already owned by an active write handle`, { sessionId }) }
    }
    c.sessionController.resolveAgent = refuse
    await expectRemote(c.godot.run(SessionId('held'), {}, signal), 'session/writer-held', 'active write handle')
    // A malformed request fails before the Session is resumed.
    await expectRemote(c.godot.run(SessionId('held'), { width: 320 }, signal), 'gateway/bad-request', 'Give width and height together.')
    expect(calls).toEqual([SessionId('held')])
    const resume = Promise.withResolvers<Awaited<ReturnType<ResolveAgent>>>()
    const resumes: SessionId[] = []
    c.sessionController.resolveAgent = (sessionId) => {
      resumes.push(sessionId)
      return resume.promise
    }
    const leaving = new AbortController()
    const starting = c.godot.run(SessionId('slow'), {}, leaving.signal)
    expect(resumes).toEqual([SessionId('slow')])
    leaving.abort(new Error('closed tab'))
    await expect(starting).rejects.toThrow('closed tab')
    await expect(c.godot.run(SessionId('slow'), {}, leaving.signal)).rejects.toThrow('closed tab')
    expect(resumes).toEqual([SessionId('slow')])
    // The resume that the cancelled call began finishes for the Session; no game starts.
    resume.resolve({ agent: c.owner.agent })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await fakeLog(c.project)).toEqual([])
  })

  it('needs the Session controller only to play from the Game tab', async () => {
    const c = await setup({ sessionController: false })
    await expect(c.godot.run(OWNER, {}, signal)).rejects.toThrow('needs the sessionController service')
    expect((await callTool(c, 'godot_run')).isError).toBe(false)
  })

  it('starts muted runs at a size and scene, and refuses bad requests with Remote failures', async () => {
    const c = await setup()
    await mkdir(join(c.project, 'levels'), { recursive: true })
    await writeFile(join(c.project, 'levels', 'one.tscn'), '[gd_scene format=3]\n')
    expect(await c.godot.run(OWNER, { muted: true, width: 320, height: 200, scene: 'res://levels/one.tscn' }, signal)).toMatchObject({
      muted: true, launch: { scene: 'res://levels/one.tscn', width: 320, height: 200 },
    })
    await until(async () => (await fakeLog(c.project)).some(entry => (entry.argv as string[] | undefined)?.includes('320x200') === true))
    await expectRemote(c.godot.run(OWNER, { width: 320 }, signal), 'gateway/bad-request', 'Give width and height together.')
    await expectRemote(c.godot.run(OWNER, { width: 320.5, height: 200 }, signal), 'gateway/bad-request', 'integers from 1 to 16384')
    await expectRemote(c.godot.run(OWNER, { project: 'missing' }, signal), 'godot/no-project')
    await expectRemote(c.godot.run(OWNER, { scene: 'level.tscn' }, signal), 'godot/no-project', 'res:// or uid://')
  })

  it('reports an unusable runtime configuration and limits concurrent runs', async () => {
    const broken = await setup({ config: { runnerPath: '/missing/godot_runner', libgodotPath: '/missing/libgodot.so' } })
    await expectRemote(broken.godot.run(OWNER, {}, signal), 'godot/runtime-unavailable', 'runnerPath')
    await broken.cleanup()
    composition = undefined
    const limited = await setup({ config: { maxRuns: 1 } })
    await limited.godot.run(OWNER, {}, signal)
    await expectRemote(limited.godot.run(SessionId('other'), {}, signal), 'godot/too-many-runs')
  })

  it('runs no more games than the computer\'s memory allows', async () => {
    // A game that needs all of the computer's memory leaves room for one, whatever maxRuns allows.
    const c = await setup({ config: { maxRuns: 16, runMemoryBytes: totalmem() } })
    await c.godot.run(OWNER, {}, signal)
    await expectRemote(c.godot.run(SessionId('other'), {}, signal), 'godot/too-many-runs', '1 Godot game already runs, as many as this computer runs at once')
  })

  it('starts no game while the computer has less memory available than a start needs', async () => {
    const c = await setup({ config: { minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER } })
    const refused = await c.godot.run(OWNER, {}, signal).then(() => undefined, (error: unknown) => error)
    expect(refused).toMatchObject({ isDSHRemoteError: true, code: 'godot/low-memory', details: { requiredBytes: Number.MAX_SAFE_INTEGER } })
    expect((refused as RemoteError<'godot/low-memory'>).details.availableBytes).toBeGreaterThan(0)
    expect(text(await callTool(c, 'godot_run'))).toMatch(/The computer has \S+ \S+ of memory available, less than the \S+ GiB that starting the game needs, so it did not start\./u)
    expect(await fakeLog(c.project)).toEqual([])
  })

  it('counts a view of the run while a view stream stays open, and refuses one for another run', async () => {
    const c = await setup({ game: { game: { displayServer: 'embedded' } }, config: { hiddenFps: 10, hiddenDelayMs: 100 } })
    const run = await c.godot.run(OWNER, {}, signal)
    const paces = async (): Promise<number[]> => (await fakeRequests(c.project)).flatMap(request => request.type === 'pace' ? [request.maxFps as number] : [])
    await until(async () => (await paces()).length === 1)
    const viewing = new AbortController()
    const stream = c.godot.view(OWNER, run.runId, viewing.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { type: 'shown' } })
    await until(async () => (await paces()).length === 2)
    const ended = stream.next()
    viewing.abort()
    expect(await ended).toEqual({ done: true, value: undefined })
    await until(async () => (await paces()).length === 3)
    expect(await paces()).toEqual([10, 0, 10])
    await expectRemote(() => c.godot.view(OWNER, 'another-run', signal)[Symbol.asyncIterator]().next(), 'godot/stale-run')
    await expectRemote(() => c.godot.view(SessionId('other'), run.runId, signal)[Symbol.asyncIterator]().next(), 'godot/not-running')
  })

  it('ends a view stream when its run ends', async () => {
    const c = await setup()
    const run = await c.godot.run(OWNER, {}, signal)
    const stream = c.godot.view(OWNER, run.runId, signal)[Symbol.asyncIterator]()
    await stream.next()
    const ended = stream.next()
    await c.godot.stop(OWNER, signal)
    expect(await ended).toEqual({ done: true, value: undefined })
  })

  it('pauses, resumes, steps, and stops the game', async () => {
    const c = await setup({ game: { game: { replies: {} } } })
    await expectRemote(c.godot.control(OWNER, { action: 'pause' }, signal), 'godot/not-running')
    await callTool(c, 'godot_run')
    expect(await c.godot.control(OWNER, { action: 'pause' }, signal)).toMatchObject({ phase: 'paused' })
    expect(await c.godot.control(OWNER, { action: 'resume' }, signal)).toMatchObject({ phase: 'running' })
    expect(await c.godot.control(OWNER, { action: 'step' }, signal)).toMatchObject({ phase: 'paused' })
    expect(await c.godot.control(OWNER, { action: 'step', frames: 5 }, signal)).toMatchObject({ phase: 'paused' })
    await expectRemote(c.godot.control(OWNER, { action: 'step', frames: 0.5 }, signal), 'gateway/bad-request')
    await expectRemote(c.godot.control(OWNER, { action: 'step', frames: 200_000 }, signal), 'gateway/bad-request')
    // Each step carries its frames at 10 frames per second plus requestTimeoutMs as its real-time limit.
    expect((await fakeRequests(c.project)).filter(request => request.type === 'step')).toMatchObject([
      { frames: 1, timeoutMs: 5100 }, { frames: 5, timeoutMs: 5500 },
    ])
    await c.godot.stop(OWNER, signal)
    await expectRemote(c.godot.control(OWNER, { action: 'resume' }, signal), 'godot/not-running')
    await c.godot.stop(OWNER, signal)
  })

  it('reports a refused control request', async () => {
    const c = await setup({ game: { game: { replies: { pause: 'error' } } } })
    await callTool(c, 'godot_run')
    await expectRemote(c.godot.control(OWNER, { action: 'pause' }, signal), 'godot/request-failed', 'fake pause failure')
  })

  it('forwards user input to the current run only', async () => {
    const c = await setup()
    await expectRemote(() => { c.godot.input(OWNER, 'run', [{ wait: 0 }], signal) }, 'godot/not-running')
    const { runId } = await c.godot.run(OWNER, {}, signal)
    await expectRemote(() => { c.godot.input(OWNER, 'other', [{ wait: 0 }], signal) }, 'godot/stale-run')
    await expectRemote(() => { c.godot.input(OWNER, runId, [{ kind: 'key', key: 'W', pressed: true }], signal) }, 'godot/not-running')
    const stream = c.godot.follow(OWNER, new AbortController().signal)[Symbol.asyncIterator]()
    for (;;) {
      const item = (await stream.next()).value as GodotFollowItem
      if ((item.type === 'run' || item.type === 'snapshot') && item.run?.phase === 'running') break
    }
    await stream.return?.(undefined)
    const warnings = () => c.ctx.logger.buffer.filter(message => message.type === 'warn').map(message => String(message.args[0])).filter(message => message.startsWith('Godot'))
    c.godot.input(OWNER, runId, [{ kind: 'key', key: 'W', pressed: true }], signal)
    c.godot.input(OWNER, runId, [{ kind: 'key', key: 'BadKey', pressed: true }], signal)
    await until(() => warnings().length > 0)
    expect(warnings()).toEqual(['Godot rejected user input: unknown key BadKey'])
    await expectRemote(() => { c.godot.input(OWNER, runId, [], signal) }, 'gateway/bad-request', 'at least one event')
    await until(async () => (await fakeRequests(c.project)).some(request => request.type === 'input'))
    const aborted = new AbortController()
    aborted.abort(new Error('gone'))
    expect(() => { c.godot.input(OWNER, runId, [{ wait: 0 }], aborted.signal) }).toThrow('gone')
  })

  it('waits for an install and lets the caller stop waiting for a stop', async () => {
    const c = await setup({ config: { runtimeManifestUrl: 'http://127.0.0.1:1/manifest.json' } })
    expect(await c.godot.installRuntime(signal)).toMatchObject({ state: 'ready', kind: 'libgodot' })
    await callTool(c, 'godot_run')
    const leaving = new AbortController()
    leaving.abort(new Error('closed tab'))
    await expect(c.godot.stop(OWNER, leaving.signal)).rejects.toThrow('closed tab')
  })
})

posix('recordings for other plugins', () => {
  const request = { seconds: 0.5, frameMs: 100, maxWidth: 320, stillWidth: 640, stillAt: 0.2, startSeconds: 0, stopStarted: false }

  it('records the running game with its input, without starting another', async () => {
    const c = await setup()
    await callTool(c, 'godot_run')
    const recording = await c.godot.record(c.owner.agent, { ...request, events: [{ kind: 'key', key: 'Right', pressed: true, hold: 0.1 }] }, signal)
    expect(recording).toMatchObject({
      started: false, windowWidth: 640, windowHeight: 360, paused: false, still: { width: 640, height: 360 },
    })
    expect(recording.frames.length).toBeGreaterThanOrEqual(3)
    expect(recording.frames[0]).toMatchObject({ width: 320, height: 180 })
    expect(Buffer.from(recording.frames[0]?.image as Uint8Array).toString('latin1')).toBe('PNG-BYTES')
    expect(recording.frames[0]?.type).toBe('image/png')
    const requests = await fakeRequests(c.project)
    expect(requests.filter(entry => entry.type === 'input')).toMatchObject([{ events: [{ kind: 'key', key: 'Right', pressed: true, hold: 0.1 }] }])
    expect(requests.filter(entry => entry.type === 'screenshot').map(entry => entry.maxWidth)).toContain(640)
    const launches = (await fakeLog(c.project)).filter(entry => entry.argv !== undefined && !(entry.argv as string[]).includes('--import'))
    expect(launches).toHaveLength(1)
  })

  it('captures JPEG frames at a frame quality, and the wider still on its own as a PNG', async () => {
    const c = await setup()
    await callTool(c, 'godot_run')
    const recording = await c.godot.record(c.owner.agent, { ...request, frameQuality: 0.85 }, signal)
    expect(recording.frames[0]).toMatchObject({ type: 'image/jpeg', width: 320, height: 180 })
    expect(Buffer.from(recording.frames[0]?.image as Uint8Array).toString('latin1')).toBe('JPEG-BYTES')
    expect(recording.still).toMatchObject({ type: 'image/png', width: 640 })
    const shots = (await fakeRequests(c.project)).filter(entry => entry.type === 'screenshot')
    expect(shots.filter(entry => entry.format === 'jpeg').map(entry => [entry.maxWidth, entry.quality])).toContainEqual([320, 0.85])
    expect(shots.filter(entry => entry.format === 'png').map(entry => entry.maxWidth)).toContain(640)
  })

  it('starts the game when none runs, and stops it afterwards when asked', async () => {
    const c = await setup()
    const recording = await c.godot.record(c.owner.agent, { ...request, stopStarted: true }, signal)
    expect(recording.started).toBe(true)
    await expectRemote(c.godot.control(OWNER, { action: 'pause' }, signal), 'godot/not-running')
  })

  it('refuses invalid numbers, invalid events, and screenshot coordinates without a screenshot', async () => {
    const c = await setup()
    await expect(c.godot.record(c.owner.agent, { ...request, seconds: 100 }, signal)).rejects.toThrow('seconds must be from 0.5 to 30.')
    await expect(c.godot.record(c.owner.agent, { ...request, events: [{ kind: 'key', pressed: true }] }, signal)).rejects.toThrow('a key event needs key or keycode')
    const click = { kind: 'mouse_button', button: 'left', pressed: true, x: 10, y: 10 }
    await expect(c.godot.record(c.owner.agent, { ...request, events: [click] }, signal)).rejects.toThrow('this game has no screenshot yet')
    await expectRemote(c.godot.control(OWNER, { action: 'pause' }, signal), 'godot/not-running')
    const windowClick = await c.godot.record(c.owner.agent, { ...request, events: [click], coordinateSpace: 'window' }, signal)
    expect(windowClick.started).toBe(true)
    await callTool(c, 'godot_screenshot')
    const screenshotClick = await c.godot.record(c.owner.agent, { ...request, events: [click] }, signal)
    expect(screenshotClick.started).toBe(false)
    const inputs = (await fakeRequests(c.project)).filter(entry => entry.type === 'input')
    expect(inputs.map(entry => entry.events)).toEqual([[click], [{ ...click, x: 20, y: 20 }]])
  })
})

posix('frames route', () => {
  it('streams frame records of a live run and refuses others', async () => {
    const c = await setup()
    expect([...c.routes].map(candidate => [candidate.path, candidate.methods, candidate.requestBody])).toEqual([
      ['/api/godot.frames', ['GET'], 'buffered'], ['/api/godot.recording', ['GET'], 'buffered'], ['/api/godot.video', ['POST'], 'streaming'],
    ])
    const route = [...c.routes][0]
    if (route === undefined) throw new Error('expected the frames route')
    expect(route).toMatchObject({ path: '/api/godot.frames', methods: ['GET'], requestBody: 'buffered' })
    const missing = await route.fetch(new Request('http://127.0.0.1/api/godot.frames?session=owner&run=nope'))
    expect(missing.status).toBe(404)
    await callTool(c, 'godot_run')
    const runId = (await c.godot.run(OWNER, {}, signal)).runId
    await until(async () => {
      const response = await route.fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`))
      if (response.status !== 200) return false
      await response.body?.cancel()
      return true
    })
    const controller = new AbortController()
    const response = await route.fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`, { signal: controller.signal }))
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const record = Buffer.from((await reader.read()).value as Uint8Array)
    expect(record.readUInt32LE(0)).toBe(record.length - 12)
    controller.abort()
    expect(await reader.read()).toMatchObject({ done: true })
    expect((await route.fetch(new Request(`http://127.0.0.1/api/godot.frames?session=stranger&run=${runId}`))).status).toBe(404)
  })

  it('is not registered without a connection service', async () => {
    const c = await setup({ connection: false })
    expect(c.routes.size).toBe(0)
  })
})

/** The fenced `# Godot games` block that a README quotes as the section text. */
function quotedSection(readme: string): string | undefined {
  const fence = '```markdown\n'
  const start = readme.indexOf(`${fence}# Godot games\n`)
  if (start < 0) return undefined
  const body = readme.slice(start + fence.length)
  return body.slice(0, body.indexOf('\n```'))
}

/** The `godot` system prompt section of a composition. */
async function godotSection(c: Composition): Promise<string | undefined> {
  return (await c.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'godot')?.text
}

/** The section's first paragraph when it names no Godot release. */
const UNVERSIONED = 'Godot is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. '
  + 'Do not look for one or download one. For a new game, first write project.godot, whose [physics] section sets '
  + '3d/physics_engine="Jolt Physics", a main scene, and its scripts.'

posix('system prompt', () => {
  it('tells the agent which Godot is built in, and to give a new project Jolt, in the text and size that both READMEs document', async () => {
    // No runtime paths: the shipped or installed runtime of the default runtimeVersion runs the games.
    const c = await setup({ config: { runnerPath: '', libgodotPath: '' } })
    const text = await godotSection(c)
    const lead = '# Godot games\n\nGodot 4.7 is built in: the godot_* tools run it, so making, checking, and running a game need '
      + 'no Godot editor or godot command. Do not look for one or download one. Write code for Godot 4.7. For a new game, first '
      + 'write project.godot, whose config/features starts with "4.7" and whose [physics] section sets '
      + '3d/physics_engine="Jolt Physics", a main scene, and its scripts.\n\n'
    expect(text?.slice(0, lead.length)).toBe(lead)
    const english = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    const chinese = await readFile(new URL('../README.zh.md', import.meta.url), 'utf8')
    expect(quotedSection(english)).toBe(text)
    expect(quotedSection(chinese)).toBe(text)
    expect(english).toContain(`The section adds ${String(text?.length)} characters`)
    expect(chinese).toContain(`该部分为每个系统提示词增加 ${String(text?.length)} 个字符`)
  })

  it('names no Godot release for configured runtime paths', async () => {
    const c = await setup()
    expect(await godotSection(c)).toContain(`# Godot games\n\n${UNVERSIONED}\n\nTest a Godot project`)
  })

  it('names no Godot release for a runtime version that does not start with one', async () => {
    const c = await setup({ config: { runnerPath: '', libgodotPath: '', runtimeVersion: 'nightly-2026-11-08' } })
    expect(await godotSection(c)).toContain(`# Godot games\n\n${UNVERSIONED}\n\nTest a Godot project`)
  })
})

posix('disposal', () => {
  it('stops runs, ends follow streams, and withdraws the tools, prompt section, and route with the plugin fiber', async () => {
    const c = await setup()
    await callTool(c, 'godot_run')
    const stream = c.godot.follow(SessionId('watching'), signal)[Symbol.asyncIterator]()
    await stream.next()
    expect(c.ctx.tools.get('godot_run')).toBeDefined()
    expect((await c.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'godot')).toBe(true)
    await c.unload()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(c.ctx.tools.get('godot_run')).toBeUndefined()
    expect(c.ctx.tools.get('godot_check')).toBeUndefined()
    expect((await c.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'godot')).toBe(false)
    expect(c.routes.size).toBe(0)
    expect((await fakeRequests(c.project)).some(request => request.type === 'quit')).toBe(true)
  })

  it('retries copying the harness scripts after a failure', async () => {
    const c = await setup()
    await mkdir(join(c.dir.root, 'data'), { recursive: true })
    await writeFile(join(c.dir.root, 'data', 'payload'), 'not a folder')
    const first = await callTool(c, 'godot_run')
    expect(first.isError).toBe(true)
    expect((await callTool(c, 'godot_run')).isError).toBe(true)
    await expect(c.godot.run(OWNER, {}, signal)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
