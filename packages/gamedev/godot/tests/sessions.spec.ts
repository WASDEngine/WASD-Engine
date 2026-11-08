/**
 * Sessions own one run each, serialize restarts, and enforce the run limit; follow streams of a Session id need no live
 * Agent and coalesce changes.
 */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { FOLLOW_LOG_ENTRIES, followSession, type FollowSources } from '../src/follow.ts'
import { LogSequence } from '../src/logs.ts'
import { GodotRun } from '../src/run.ts'
import { GodotSessionError, GodotSessions, TooManyRunsError, type SessionChange, type SessionWatcher } from '../src/runs.ts'
import type { GodotFollowItem, GodotRuntimeView } from '../src/types.ts'
import { fakeAgent } from './agents.ts'
import { runSpec, scratch, until, writeProject, type Scratch } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe

let dir: Scratch
let ctx: Context
afterEach(async () => {
  await ctx?.fiber.dispose()
  await dir?.cleanup()
})

async function setup(maxRuns = 4) {
  dir = await scratch('sessions')
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  const sessions = new GodotSessions(ctx, maxRuns)
  ctx.effect(() => () => sessions.dispose())
  const sequence = new LogSequence()
  let count = 0
  const launch = async (config: Parameters<typeof writeProject>[1] = { game: {} }, startedBy: 'agent' | 'user' = 'agent', subprocess: SubprocessRuntime = ctx.subprocess) => {
    count += 1
    const project = await writeProject(join(dir.root, `game-${count}`), config)
    return () => GodotRun.launch(runSpec(dir.fakeGodot, project, { runId: `run-${count}`, startedBy }), { subprocess, sequence, warn: () => {} })
  }
  return { sessions, sequence, launch }
}

/** Follow sources of one Session id in a registry, as the plugin builds them. */
function sources(sessions: GodotSessions, id: string, runtime: GodotRuntimeView = { state: 'missing' }) {
  const listeners = new Set<() => void>()
  let latest = runtime
  const value: FollowSources = {
    run: () => sessions.find(SessionId(id))?.run,
    watch: watcher => sessions.watch(SessionId(id), watcher),
    runtimeView: async () => latest,
    latestRuntime: () => latest,
    watchRuntime: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    value,
    listeners,
    publish(next: GodotRuntimeView) {
      latest = next
      for (const listener of listeners) listener()
    },
  }
}

async function next(iterator: AsyncIterator<GodotFollowItem>): Promise<GodotFollowItem> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('follow stream ended')
  return result.value
}

posix('GodotSessions', () => {
  it('keeps one state per live Agent and refuses Agents that are not live', async () => {
    const { sessions } = await setup()
    const one = await fakeAgent(ctx, 'one')
    const two = await fakeAgent(ctx, 'two')
    await fakeAgent(ctx, 'idle')
    const session = sessions.session(one.agent)
    expect(sessions.session(one.agent)).toBe(session)
    sessions.session(two.agent)
    expect(sessions.find(SessionId('two'))?.agent).toBe(two.agent)
    expect(sessions.find(SessionId('one'))).toBe(session)
    expect(sessions.find(SessionId('idle'))).toBeUndefined()
    expect(sessions.find(SessionId('three'))).toBeUndefined()
    const stranger = { ...one.agent, id: SessionId('stranger') }
    expect(() => sessions.session(stranger)).toThrow(GodotSessionError)
  })

  it('tells the watchers of a Session id about runs, logs, and the end of its Agent, whether or not it is live', async () => {
    const { sessions, launch } = await setup()
    const seen: SessionChange[] = []
    const other: SessionChange[] = []
    const watcher: SessionWatcher = { notify: (change) => { seen.push(change) } }
    const unwatch = sessions.watch(SessionId('watched'), watcher)
    const unwatchOther = sessions.watch(SessionId('watched'), { notify: (change) => { other.push(change) } })
    const owner = await fakeAgent(ctx, 'watched')
    const session = sessions.session(owner.agent)
    const run = await sessions.replace(session, await launch({ game: { logs: [{ level: 'stdout', message: 'hi', time_ms: 1 }] } }))
    await run.started()
    await until(() => seen.includes('logs'))
    expect(seen[0]).toBe('run')
    unwatchOther()
    const ended = other.length
    seen.length = 0
    await owner.dispose()
    // The end of the Agent is one run change; the stopping run's own changes no longer reach the watchers.
    expect(seen).toEqual(['run'])
    expect(other).toHaveLength(ended)
    unwatch()
    unwatch()
    const late: SessionChange[] = []
    sessions.watch(SessionId('watched'), { notify: (change) => { late.push(change) } })
    await sessions.dispose()
    expect(late).toEqual(['end'])
    const unwatchLate = sessions.watch(SessionId('watched'), { notify: (change) => { late.push(change) } })
    expect(late).toEqual(['end', 'end'])
    unwatchLate()
  })

  it('replaces a run, stopping the previous one first', async () => {
    const { sessions, launch } = await setup()
    const { agent } = await fakeAgent(ctx, 'replace')
    const session = sessions.session(agent)
    const first = await sessions.replace(session, await launch())
    await first.started()
    session.screenshot = { runId: first.id, width: 1, height: 1, windowWidth: 1, windowHeight: 1 }
    const second = await sessions.replace(session, await launch())
    expect(first.terminal).toBe(true)
    expect(first.view().phase).toBe('exited')
    expect(session.run).toBe(second)
    expect(session.screenshot).toBeUndefined()
    await sessions.stop(session)
    expect(second.terminal).toBe(true)
    await sessions.stop(session)
  })

  it('limits concurrent runs across Sessions and frees ended runs', async () => {
    const { sessions, launch } = await setup(1)
    const one = sessions.session((await fakeAgent(ctx, 'limit-1')).agent)
    const two = sessions.session((await fakeAgent(ctx, 'limit-2')).agent)
    sessions.session((await fakeAgent(ctx, 'limit-3')).agent)
    const run = await sessions.replace(one, await launch())
    const refused = await sessions.replace(two, await launch()).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TooManyRunsError)
    expect(refused).toMatchObject({ limit: 1 })
    await run.started()
    await sessions.stop(one)
    const accepted = await sessions.replace(two, await launch())
    await accepted.stop()
  })

  it('counts the game of a closed Session against the limit until that game ended', async () => {
    const { sessions, launch } = await setup(1)
    const release = Promise.withResolvers<undefined>()
    // The first game's process exits on quit, but its run ends only after `release`.
    const held = Object.create(ctx.subprocess, {
      spawn: {
        value: (spec: SubprocessSpawnSpec) => {
          const handle = ctx.subprocess.spawn(spec)
          return { ...handle, done: handle.done.then(async (outcome) => { await release.promise; return outcome }) }
        },
      },
    }) as SubprocessRuntime
    try {
      const one = await fakeAgent(ctx, 'closing-1')
      const two = sessions.session((await fakeAgent(ctx, 'closing-2')).agent)
      const first = await sessions.replace(sessions.session(one.agent), await launch({ game: {} }, 'agent', held))
      await first.started()
      const closing = one.dispose()
      await until(() => sessions.find(SessionId('closing-1')) === undefined)
      const refused = await sessions.replace(two, await launch()).then(() => 'started', (error: unknown) => error)
      expect(refused).toBeInstanceOf(TooManyRunsError)
      expect(first.terminal).toBe(false)
      release.resolve(undefined)
      await closing
      expect(first.terminal).toBe(true)
      const accepted = await sessions.replace(two, await launch())
      await accepted.started()
      await accepted.stop()
    } finally {
      release.resolve(undefined)
    }
  })

  it('stops the run when its Agent is disposed and refuses a restart racing the disposal', async () => {
    const { sessions, launch } = await setup()
    const owner = await fakeAgent(ctx, 'disposed')
    const session = sessions.session(owner.agent)
    const run = await sessions.replace(session, await launch())
    await run.started()
    const restart = sessions.replace(session, await launch())
    await owner.dispose()
    await expect(restart).rejects.toThrow(GodotSessionError)
    expect(run.terminal).toBe(true)
    expect(session.closed).toBe(true)
    expect(sessions.find(SessionId('disposed'))).toBeUndefined()
  })

  it('stops every run and refuses new Sessions after disposal', async () => {
    const { sessions, launch } = await setup()
    const { agent } = await fakeAgent(ctx, 'registry')
    const idle = await fakeAgent(ctx, 'idle')
    sessions.session(idle.agent)
    const run = await sessions.replace(sessions.session(agent), await launch())
    await sessions.dispose()
    expect(run.terminal).toBe(true)
    expect(() => sessions.session(agent)).toThrow(GodotSessionError)
  })
})

posix('followSession', () => {
  it('sends a snapshot, then coalesced run, log, and runtime changes, and no run once the Agent ends', async () => {
    const { sessions, launch } = await setup()
    const owner = await fakeAgent(ctx, 'follow')
    const session = sessions.session(owner.agent)
    const runtime = sources(sessions, 'follow')
    const controller = new AbortController()
    const stream = followSession(runtime.value, controller.signal)[Symbol.asyncIterator]()
    expect(await next(stream)).toEqual({ type: 'snapshot', run: null, runtime: { state: 'missing' }, logs: [], cursor: 0 })

    const run = await sessions.replace(session, await launch({ game: { logs: [{ level: 'stdout', message: 'hello', time_ms: 1 }] } }))
    expect(await next(stream)).toMatchObject({ type: 'run', run: { runId: run.id } })
    await run.started()
    await until(() => run.logs.lastSeq > 0)
    runtime.publish({ state: 'ready', kind: 'libgodot', windowless: false })
    const items: GodotFollowItem[] = []
    while (!items.some(item => item.type === 'logs') || !items.some(item => item.type === 'runtime')) items.push(await next(stream))
    expect(items.find(item => item.type === 'runtime')).toEqual({ type: 'runtime', runtime: { state: 'ready', kind: 'libgodot', windowless: false } })
    expect(items.find(item => item.type === 'logs')).toMatchObject({ type: 'logs', entries: [{ message: 'hello' }] })

    const late = followSession(runtime.value, controller.signal)[Symbol.asyncIterator]()
    const snapshot = await next(late)
    expect(snapshot).toMatchObject({ type: 'snapshot', run: { runId: run.id }, logs: [{ message: 'hello' }] })
    expect(snapshot.type === 'snapshot' && snapshot.cursor).toBe(run.logs.lastSeq)
    await late.return?.()

    await owner.dispose()
    let item = await next(stream)
    while (item.type === 'run' && item.run !== null) item = await next(stream)
    expect(item).toEqual({ type: 'run', run: null })
    expect(run.terminal).toBe(true)
    controller.abort()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(runtime.listeners.size).toBe(0)
  })

  it('follows a Session id before it has an Agent and ends when the registry is disposed', async () => {
    const { sessions, launch } = await setup()
    const stream = followSession(sources(sessions, 'later').value, new AbortController().signal)[Symbol.asyncIterator]()
    expect(await next(stream)).toEqual({ type: 'snapshot', run: null, runtime: { state: 'missing' }, logs: [], cursor: 0 })
    const owner = await fakeAgent(ctx, 'later')
    const run = await sessions.replace(sessions.session(owner.agent), await launch())
    expect(await next(stream)).toMatchObject({ type: 'run', run: { runId: run.id } })
    const ending = sessions.dispose()
    let done = await stream.next()
    while (done.done !== true) done = await stream.next()
    await ending
    expect(run.terminal).toBe(true)
  })

  it('skips log items of a replaced run and ends when cancelled', async () => {
    const { sessions, launch } = await setup()
    const session = sessions.session((await fakeAgent(ctx, 'replaced')).agent)
    const first = await sessions.replace(session, await launch({ game: { logsOn: { eval: [{ level: 'stdout', message: 'late', time_ms: 2 }] } } }))
    await first.started()
    const controller = new AbortController()
    const stream = followSession(sources(sessions, 'replaced').value, controller.signal)[Symbol.asyncIterator]()
    await next(stream)
    // The stream is not read while the old run logs and the Session switches to a run that has no entries yet.
    await first.evaluate('x', undefined, new AbortController().signal)
    const second = await sessions.replace(session, await launch({ game: { connect: 'never' } }))
    expect(await next(stream)).toMatchObject({ type: 'run', run: { runId: second.id } })
    const pending = stream.next()
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    await second.stop()
  })

  it('reads no entries for a log change while the Session has no run', async () => {
    let watcher: SessionWatcher | undefined
    const stream = followSession({
      run: () => undefined,
      watch: (value) => {
        watcher = value
        return () => {}
      },
      runtimeView: async () => ({ state: 'missing' }),
      latestRuntime: () => ({ state: 'installing' }),
      watchRuntime: () => () => {},
    }, new AbortController().signal)[Symbol.asyncIterator]()
    await next(stream)
    const pending = next(stream)
    watcher?.notify('logs')
    await new Promise(resolve => setTimeout(resolve, 10))
    watcher?.notify('run')
    expect(await pending).toEqual({ type: 'run', run: null })
    await stream.return?.()
  })

  it('ends at once when its signal is already aborted after the snapshot', async () => {
    const { sessions } = await setup()
    sessions.session((await fakeAgent(ctx, 'aborted')).agent)
    const controller = new AbortController()
    const runtime = sources(sessions, 'aborted')
    const stream = followSession(runtime.value, controller.signal)[Symbol.asyncIterator]()
    await next(stream)
    const waiting = stream.next()
    await new Promise(resolve => setTimeout(resolve, 10))
    runtime.publish({ state: 'installing' })
    expect(await waiting).toEqual({ done: false, value: { type: 'runtime', runtime: { state: 'installing' } } })
    controller.abort()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(FOLLOW_LOG_ENTRIES).toBe(200)
  })
})
