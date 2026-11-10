/**
 * The Game tab's Remote follows and drives the game of a Session by its id, resuming the Session only to start a
 * game; the plugin's contributions end with its fiber.
 */
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import GodotController from '../src/index.ts'
import type { GodotFollowItem, GodotRunView } from '../src/types.ts'
import { callTool, compose, type Composition, type CompositionOptions, type ResolveAgent } from './composition.ts'
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
  ])('fails loud for %j', (config, message) => {
    expect(() => new GodotController(new Context(), GodotController.Config(config))).toThrow(message)
  })

  it('applies the documented defaults', () => {
    expect(GodotController.Config({ dataRoot: '/data' })).toEqual({
      dataRoot: '/data', runtimeVersion: '4.7.2-wasd.2',
      runtimeManifestUrl: 'https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.2/manifest.json',
      libgodotPath: '', runnerPath: '', streamFps: 30, streamQuality: 0.9, streamLossless: true, streamMaxWidth: 1280,
      importBeforeRun: true, importTimeoutMs: 180_000, startTimeoutMs: 60_000, requestTimeoutMs: 15_000, stopGraceMs: 3000,
      processOutputBytes: 1024 * 1024, maxLogEntries: 5000, maxRuns: 4, agentRunsMuted: true,
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

posix('frames route', () => {
  it('streams frame records of a live run and refuses others', async () => {
    const c = await setup()
    expect(c.routes.size).toBe(1)
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
  + 'Do not look for one or download one. For a new game, first write project.godot, a main scene, and its scripts.'

posix('system prompt', () => {
  it('tells the agent which Godot is built in, in the text and size that both READMEs document', async () => {
    // No runtime paths: the shipped or installed runtime of the default runtimeVersion runs the games.
    const c = await setup({ config: { runnerPath: '', libgodotPath: '' } })
    const text = await godotSection(c)
    const lead = '# Godot games\n\nGodot 4.7 is built in: the godot_* tools run it, so making, checking, and running a game need '
      + 'no Godot editor or godot command. Do not look for one or download one. Write code for Godot 4.7. For a new game, first '
      + 'write project.godot, whose config/features starts with "4.7", a main scene, and its scripts.\n\n'
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
