// @vitest-environment jsdom
/**
 * Godot browser plugin registration: the Remote mount, the Game tab type and
 * seats, the tool cards, per-Session game state, the stop of the game when its
 * tab closes, the Desktop shell's game layers, the Game tab opening for Agent
 * runs, the keyboard capture, and unload.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { RemoteStream, RemoteStreamCarrierError, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightCloseHandler, SidebarRightTabDefinition, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopGameLayerBridge, GodotControlRequest, GodotFollowItem, GodotInputEvent, GodotRunRequest, GodotRunView, GodotRuntimeView,
} from '../src/types.ts'
import { GodotToolCard } from '../src/client/cards.tsx'
import { GameTab, GameTabTitle, type GameTabInjected } from '../src/client/GameTab.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import { inject, mountGame, TAB_ID, TAB_KIND } from '../src/client/mount.ts'
import { feed, READY, run, snapshot, type FedHandle } from './client-fixtures.client.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-godot', descriptors: [] }
const S1 = SessionId('s1')
const S2 = SessionId('s2')
const GONE = SessionId('not-retained')
const OK: RemoteResult<void> = { ok: true, value: undefined }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function isTabFace(value: unknown): value is GameTabInjected {
  return typeof value === 'object' && value !== null && 'openFrames' in value && 'hooks' in value
}

/** A follow handle that fails at once, as the Gateway answers a refused call. */
async function* refused(error: unknown): AsyncGenerator<GodotFollowItem> {
  yield* []
  throw error
}

interface Shortcuts {
  runtime: 'web' | 'desktop'
  platform: 'macos' | 'windows' | 'linux'
  readonly recording: ReturnType<typeof vi.fn<(active: boolean) => Promise<void>>>
}

async function base() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  // A connected carrier: the Gateway's logical streams retry a carrier loss once at once and treat other ends as final.
  const connection = { generation: createSnapshotStore<object | undefined>({}) }
  const logical: RemoteStream<unknown>[] = []
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
    $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
      const stream = new RemoteStream(connection as never, options)
      logical.push(stream)
      return stream
    }
  }
  new Remote()
  const streams: { sessionId: SessionId; stream: FedHandle }[] = []
  const godot = {
    follow: vi.fn((sessionId: SessionId, signal: AbortSignal): AsyncIterable<GodotFollowItem> => {
      const stream = feed(signal)
      streams.push({ sessionId, stream })
      return stream
    }),
    run: vi.fn(async (_sessionId: SessionId, _request: GodotRunRequest): Promise<RemoteResult<GodotRunView>> => ({ ok: true, value: run('r1') })),
    stop: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    control: vi.fn(async (_sessionId: SessionId, _request: GodotControlRequest): Promise<RemoteResult<GodotRunView>> => ({ ok: true, value: run('r1') })),
    input: vi.fn(async (_sessionId: SessionId, _runId: string, _events: GodotInputEvent[]): Promise<RemoteResult<void>> => OK),
    installRuntime: vi.fn(async (): Promise<RemoteResult<GodotRuntimeView>> => ({ ok: true, value: READY })),
  }
  ctx.provide('remote.godot', godot)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const kinds = new Map<string, SidebarRightTabDefinition>()
  ctx.provide('sidebarRightTabs', {
    register: (definition: SidebarRightTabDefinition) => {
      kinds.set(definition.kind, definition)
      return () => { kinds.delete(definition.kind) }
    },
  })
  const mounted = createSnapshotStore<SessionId | undefined>(undefined)
  const closeHandlers = new Map<string, SidebarRightCloseHandler>()
  const sidebarRight = {
    mounted,
    openTabIn: vi.fn(),
    registerCloseHandler: (kind: string, handler: SidebarRightCloseHandler) => {
      closeHandlers.set(kind, handler)
      return () => { closeHandlers.delete(kind) }
    },
  }
  ctx.provide('sidebarRight', sidebarRight)
  // One scope fiber per retained generation, as the Session Controller materializes them.
  const scopes = new Map<SessionId, { fiber: Fiber }>()
  const scopeOf = (id: SessionId) => {
    let scope = scopes.get(id)
    if (scope === undefined || scope.fiber.uid === null) {
      scope = { fiber: ctx.plugin(() => {}) }
      scopes.set(id, scope)
    }
    return scope
  }
  ctx.provide('sessions', {
    binding: (id: SessionId) => {
      if (id === GONE) return undefined
      const scope = scopeOf(id)
      return { sessionId: id, ctx: scope.fiber.ctx }
    },
  })
  const shortcuts: Shortcuts = { runtime: 'web', platform: 'macos', recording: vi.fn(async (_active: boolean) => {}) }
  ctx.provide('shortcuts', shortcuts)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  return { ctx, unmount, streams, logical, godot, kinds, mounted, sidebarRight, closeHandlers, scopes, shortcuts }
}

async function fixture() {
  const b = await base()
  const fiber = b.ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountGame(plugin, REMOTE) })
  await fiber
  const entry = (slot: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title' | 'tool.call.toolview', key: string) =>
    b.ctx.slots.entries(slot).find(candidate => candidate.options.key === key)
  const face = (sessionId: SessionId): GameTabInjected => {
    const factory = entry('sidebar.right.pane.tab', TAB_ID)?.inject
    assert(typeof factory === 'function')
    const value: unknown = factory(sessionId as never)
    assert(isTabFace(value))
    return value
  }
  const streamsOf = (sessionId: SessionId) => b.streams.filter(item => item.sessionId === sessionId).map(item => item.stream)
  return { ...b, fiber, entry, face, streamsOf }
}

describe('mountGame registration', () => {
  it('declares the browser services it needs', () => {
    expect(inject).toEqual(['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'shortcuts'])
  })

  it('registers the Game tab type with its guide entry, its body and title, the tool cards, and the copy', async () => {
    const f = await fixture()
    const type = f.kinds.get(TAB_KIND)
    expect(type).toMatchObject({ id: TAB_ID, kind: 'godot', priority: 'builtin', keepMounted: true })
    expect([en['tab.title'], zh['tab.title']]).toContain(type?.title('sidebar://godot'))
    expect(type?.guide).toHaveLength(1)
    const guide = type?.guide?.[0]
    expect(guide).toMatchObject({ id: 'play', order: 40 })
    expect([en['guide.title'], zh['guide.title']]).toContain(guide?.title())
    expect([en['guide.description'], zh['guide.description']]).toContain(guide?.description?.())
    const Icon = guide?.icon
    assert(Icon !== undefined)
    expect(renderToStaticMarkup(createElement(Icon, { size: 22 }))).toContain('width="22"')
    expect(renderToStaticMarkup(createElement(Icon))).toContain('width="16"')
    expect(f.entry('sidebar.right.pane.tab', TAB_ID)).toMatchObject({ component: GameTab, locale: NS })
    expect(f.entry('sidebar.right.pane.tab.title', TAB_ID)).toMatchObject({ component: GameTabTitle, locale: NS })
    expect(f.ctx.slots.entries('tool.call.toolview').map(item => [item.options.key, item.component, item.locale])).toEqual([
      ['godot_screenshot', GodotToolCard, NS],
      ['godot_input', GodotToolCard, NS],
      ['godot_wait', GodotToolCard, NS],
    ])
    expect([en['card.screenshot'], zh['card.screenshot']]).toContain(f.ctx.locale.bind(NS)('card.screenshot'))
    await f.fiber.dispose()
  })

  it('withdraws every contribution, closes the follow streams, and unmounts the Remote on unload', async () => {
    const f = await fixture()
    f.face(S1).hooks.game.subscribe(() => {})
    f.mounted.set(S2)
    expect(f.streams.map(item => item.sessionId)).toEqual([S1, S2])
    await f.fiber.dispose()
    expect(f.kinds.has(TAB_KIND)).toBe(false)
    expect(f.ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    expect(f.ctx.slots.entries('sidebar.right.pane.tab.title')).toEqual([])
    expect(f.ctx.slots.entries('tool.call.toolview')).toEqual([])
    expect(f.ctx.locale.bind(NS)('tab.title')).toBe('tab.title')
    for (const { stream } of f.streams) expect(stream.signal.aborted).toBe(true)
    expect(f.logical.every(stream => stream.signal.aborted)).toBe(true)
    expect(f.unmount).toHaveBeenCalledOnce()
    f.mounted.set(S1)
    expect(f.streams).toHaveLength(2)
    expect(f.sidebarRight.openTabIn).not.toHaveBeenCalled()
  })

  it('rolls back the Remote when the UI cannot register', async () => {
    const b = await base()
    vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('registration failed') })
    try {
      await expect(mountGame(b.ctx, REMOTE)).rejects.toThrow('registration failed')
      expect(b.unmount).toHaveBeenCalledOnce()
      expect(b.kinds.size).toBe(0)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('returns a disposer that withdraws the UI before the Remote', async () => {
    const b = await base()
    try {
      const dispose = await mountGame(b.ctx, REMOTE)
      expect(b.kinds.has(TAB_KIND)).toBe(true)
      await dispose()
      expect(b.kinds.has(TAB_KIND)).toBe(false)
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })
})

describe('Game tab face', () => {
  it('routes actions to the bound Session and reports refusals', async () => {
    const f = await fixture()
    const face = f.face(S1)
    expect(f.face(S1).hooks.game).toBe(face.hooks.game)
    await expect(face.play({ project: '/work/game' })).resolves.toBeUndefined()
    expect(f.godot.run).toHaveBeenCalledWith(S1, { project: '/work/game' })
    f.godot.run.mockResolvedValueOnce({ ok: false, error: new RemoteError('godot/no-project', 'no project.godot', { directory: '/work' }) })
    await expect(face.play({})).resolves.toEqual({ issue: 'noProject', message: 'no project.godot' })
    f.godot.run.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/writer-held', 'held', { sessionId: S1 }) })
    await expect(face.play({})).resolves.toEqual({ issue: 'sessionInUse', message: 'held' })
    await expect(face.stop()).resolves.toBeUndefined()
    expect(f.godot.stop).toHaveBeenCalledWith(S1)
    await expect(face.control({ action: 'step', frames: 1 })).resolves.toBeUndefined()
    expect(f.godot.control).toHaveBeenCalledWith(S1, { action: 'step', frames: 1 })
    f.godot.installRuntime.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'download failed', {}) })
    await expect(face.install()).resolves.toEqual({ issue: 'failed', message: 'download failed' })
    await f.fiber.dispose()
  })

  it('drops input that reached an ended run and rejects when the game may not have received it', async () => {
    const f = await fixture()
    const face = f.face(S1)
    const events: GodotInputEvent[] = [{ kind: 'key', key: 'W', pressed: true }]
    await face.input('r1', events)
    expect(f.godot.input).toHaveBeenCalledWith(S1, 'r1', events)
    f.godot.input.mockResolvedValueOnce({ ok: false, error: new RemoteError('godot/stale-run', 'stale', { runId: 'r1' }) })
    await expect(face.input('r1', events)).resolves.toBeUndefined()
    f.godot.input.mockResolvedValueOnce({ ok: false, error: new RemoteError('godot/not-running', 'stopped', {}) })
    await expect(face.input('r1', events)).resolves.toBeUndefined()
    const lost = new RemoteError('gateway/internal', 'carrier lost', {})
    f.godot.input.mockResolvedValueOnce({ ok: false, error: lost })
    await expect(face.input('r1', events)).rejects.toBe(lost)
    await f.fiber.dispose()
  })

  it('requests a run’s frames at the Session’s frame address without caching', async () => {
    const f = await fixture()
    const response = new Response(null, { status: 204 })
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => response)
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(f.face(S1).openFrames('run 1&x', signal)).resolves.toBe(response)
    const [url, init] = fetch.mock.calls[0]!
    expect(url.href).toBe(new URL('api/godot.frames?session=s1&run=run+1%26x', document.baseURI).href)
    expect(init).toEqual({ signal, cache: 'no-store' })
    await f.fiber.dispose()
  })

  it('follows each Session separately, reconnects on demand, and releases the state when the Session scope ends', async () => {
    const f = await fixture()
    const first = f.face(S1)
    const unsubscribe = first.hooks.game.subscribe(() => {})
    f.face(S2).hooks.game.subscribe(() => {})
    expect(f.streams.map(item => item.sessionId)).toEqual([S1, S2])
    f.streamsOf(S1)[0]!.end()
    await vi.waitFor(() => { expect(first.hooks.game.getSnapshot().disconnected).toBe(true) })
    first.reconnect()
    expect(f.streamsOf(S1)).toHaveLength(2)
    await f.scopes.get(S1)!.fiber.dispose()
    expect(f.streamsOf(S1)[1]!.signal.aborted).toBe(true)
    unsubscribe()
    const fresh = f.face(S1)
    expect(fresh.hooks.game).not.toBe(first.hooks.game)
    expect(() => f.face(GONE)).toThrow('godot: Session not-retained is not retained')
    await f.fiber.dispose()
  })
})

describe('Desktop game layers', () => {
  it('offers the layer display only where the Desktop shell provides it', async () => {
    const f = await fixture()
    expect(f.face(S1).showLayer).toBeUndefined()
    await f.fiber.dispose()
  })

  it('shows layers through the shell behind holes in the application root, and closes the holes on unload', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    const bridge = { show: vi.fn<DesktopGameLayerBridge['show']>(async () => true), hide: vi.fn<DesktopGameLayerBridge['hide']>() }
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, gameLayer: bridge })
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const f = await fixture()
    const view = document.createElement('div')
    vi.spyOn(view, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 360))
    const showLayer = f.face(S1).showLayer
    assert(showLayer !== undefined)
    const end = showLayer({ id: 'game', view, layer: { context: 5, scale: 2 }, window: { width: 1280, height: 720 }, onBox: () => {}, onFailed: () => {} })
    expect(bridge.show).toHaveBeenCalledWith('game', expect.objectContaining({ context: 5, layerWidth: 640, layerHeight: 360 }))
    await vi.waitFor(() => { expect(root.style.mask).toContain('0px 0px / 640px 360px') })
    await f.fiber.dispose()
    expect(root.style.mask).toBe('')
    end()
    expect(bridge.hide).toHaveBeenCalledWith('game')
    root.remove()
  })
})

describe('Game tab follow stream', () => {
  it('reopens the Host stream after a carrier loss and keeps the last state meanwhile', async () => {
    const f = await fixture()
    const game = f.face(S1).hooks.game
    const unsubscribe = game.subscribe(() => {})
    f.streamsOf(S1)[0]!.push(snapshot(run('r1')))
    await vi.waitFor(() => { expect(game.getSnapshot().state?.run?.runId).toBe('r1') })
    f.streamsOf(S1)[0]!.fail(new RemoteStreamCarrierError('carrier lost'))
    await vi.waitFor(() => { expect(f.streamsOf(S1)).toHaveLength(2) })
    expect(game.getSnapshot()).toMatchObject({ disconnected: false, state: { run: { runId: 'r1' } } })
    f.streamsOf(S1)[1]!.push(snapshot(run('r2')))
    await vi.waitFor(() => { expect(game.getSnapshot().state?.run?.runId).toBe('r2') })
    unsubscribe()
    await f.fiber.dispose()
  })

  it('follows again at once after the Host ends a stream that delivered its snapshot', async () => {
    const f = await fixture()
    const game = f.face(S1).hooks.game
    const unsubscribe = game.subscribe(() => {})
    f.streamsOf(S1)[0]!.push(snapshot(run('r1')))
    await vi.waitFor(() => { expect(game.getSnapshot().state?.run?.runId).toBe('r1') })
    f.streamsOf(S1)[0]!.end()
    await vi.waitFor(() => { expect(f.streamsOf(S1)).toHaveLength(2) })
    expect(game.getSnapshot().disconnected).toBe(false)
    unsubscribe()
    await f.fiber.dispose()
  })

  it('reports a refused follow call as a lost connection and follows again after its delay', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.godot.follow.mockImplementationOnce(() => refused(new RemoteError('gateway/internal', 'boom', {})))
    f.mounted.set(S1)
    const game = f.face(S1).hooks.game
    await vi.advanceTimersByTimeAsync(0)
    expect(game.getSnapshot()).toEqual({ state: null, disconnected: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.godot.follow).toHaveBeenCalledTimes(2)
    f.streamsOf(S1)[0]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'starting' })))
    await vi.advanceTimersByTimeAsync(0)
    expect(game.getSnapshot()).toMatchObject({ disconnected: false, state: { run: { runId: 'r1' } } })
    expect(f.sidebarRight.openTabIn).toHaveBeenCalledExactlyOnceWith(S1, TAB_KIND)
    await f.fiber.dispose()
  })
})

describe('Game tab close', () => {
  const TAB: TabRecord = { id: brandString<TabId>('tab1'), kind: TAB_KIND, contentId: 'sidebar://godot', title: 'Game' }

  it('stops the Session’s game when its tab closes, until the plugin unloads', async () => {
    const f = await fixture()
    const close = f.closeHandlers.get(TAB_KIND)
    assert(close !== undefined)
    close(S1, TAB)
    expect(f.godot.stop).toHaveBeenCalledExactlyOnceWith(S1)
    await f.fiber.dispose()
    expect(f.closeHandlers.has(TAB_KIND)).toBe(false)
  })

  it('stays quiet when the Session has no game and reports a stop that failed', async () => {
    const f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const close = f.closeHandlers.get(TAB_KIND)
    assert(close !== undefined)
    f.godot.stop.mockResolvedValueOnce({ ok: false, error: new RemoteError('godot/not-running', 'The game is not running.', {}) })
    close(S1, TAB)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warn).not.toHaveBeenCalled()
    const lost = new RemoteError('gateway/internal', 'carrier lost', {})
    f.godot.stop.mockResolvedValueOnce({ ok: false, error: lost })
    close(S2, TAB)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledExactlyOnceWith('godot: the game did not stop when its tab closed', lost) })
    expect(f.godot.stop.mock.calls).toEqual([[S1], [S2]])
    await f.fiber.dispose()
  })
})

describe('Game tab opening for Agent runs', () => {
  it('opens the tab once per Agent run while the run is in progress on the Session on screen', async () => {
    const f = await fixture()
    f.mounted.set(S1)
    const [s1] = f.streamsOf(S1)
    s1!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'starting' })))
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenCalledExactlyOnceWith(S1, TAB_KIND) })
    s1!.push({ type: 'run', run: run('r1', { startedBy: 'agent', phase: 'running' }) })
    s1!.push({ type: 'run', run: run('r2', { startedBy: 'user', phase: 'running' }) })
    s1!.push({ type: 'run', run: run('r3', { startedBy: 'agent', phase: 'exited', exitCode: 0 }) })
    s1!.push({ type: 'run', run: null })
    s1!.push({ type: 'run', run: run('r4', { startedBy: 'agent', phase: 'preparing' }) })
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenCalledTimes(2) })
    s1!.push({ type: 'runtime', runtime: READY })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.sidebarRight.openTabIn).toHaveBeenCalledTimes(2)
    await f.fiber.dispose()
  })

  it('follows only the Session on screen and remembers opened runs per Session', async () => {
    const f = await fixture()
    f.mounted.set(S1)
    f.streamsOf(S1)[0]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'running' })))
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenCalledOnce() })
    f.mounted.set(S2)
    expect(f.streamsOf(S1)[0]!.signal.aborted).toBe(true)
    f.streamsOf(S2)[0]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'paused' })))
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenLastCalledWith(S2, TAB_KIND) })
    f.mounted.set(S1)
    f.streamsOf(S1)[1]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'running' })))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.sidebarRight.openTabIn).toHaveBeenCalledTimes(2)
    f.mounted.set(undefined)
    expect(f.streamsOf(S1)[1]!.signal.aborted).toBe(true)
    f.mounted.set(GONE)
    expect(f.streamsOf(GONE)).toEqual([])
    f.mounted.set(S2)
    expect(f.streamsOf(S2)).toHaveLength(2)
    await f.fiber.dispose()
    expect(f.streamsOf(S2)[1]!.signal.aborted).toBe(true)
  })

  it('remembers an opened run after the Session scope retires and returns', async () => {
    const f = await fixture()
    f.mounted.set(S1)
    f.streamsOf(S1)[0]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'running' })))
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenCalledOnce() })
    // The user switches away; nothing retains the first Session, so its scope retires.
    f.mounted.set(S2)
    await f.scopes.get(S1)!.fiber.dispose()
    f.mounted.set(S1)
    f.streamsOf(S1)[1]!.push(snapshot(run('r1', { startedBy: 'agent', phase: 'running' })))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.sidebarRight.openTabIn).toHaveBeenCalledOnce()
    f.streamsOf(S1)[1]!.push({ type: 'run', run: run('r2', { startedBy: 'agent', phase: 'starting' }) })
    await vi.waitFor(() => { expect(f.sidebarRight.openTabIn).toHaveBeenCalledTimes(2) })
    await f.fiber.dispose()
  })
})

describe('Game view keyboard capture', () => {
  it.each([
    ['web', 'windows'], ['desktop', 'macos'], ['desktop', 'linux'],
  ] as const)('leaves %s on %s to dispatch shortcuts after the view', async (runtime, platform) => {
    const f = await fixture()
    Object.assign(f.shortcuts, { runtime, platform })
    f.face(S1).captureKeyboard()()
    expect(f.shortcuts.recording).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })

  it('suspends the native shortcut interception of Windows Desktop until released', async () => {
    const f = await fixture()
    Object.assign(f.shortcuts, { runtime: 'desktop', platform: 'windows' })
    const release = f.face(S1).captureKeyboard()
    expect(f.shortcuts.recording.mock.calls).toEqual([[true]])
    release()
    expect(f.shortcuts.recording.mock.calls).toEqual([[true], [false]])
    await f.fiber.dispose()
  })

  it('reports a capture that Desktop cannot acknowledge', async () => {
    const f = await fixture()
    Object.assign(f.shortcuts, { runtime: 'desktop', platform: 'windows' })
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const refusal = new Error('desktop shortcuts: rejected sender')
    f.shortcuts.recording.mockRejectedValue(refusal)
    f.face(S1).captureKeyboard()()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    expect(warn).toHaveBeenCalledWith('godot: application shortcuts may take keys from the focused game view', refusal)
    await f.fiber.dispose()
  })
})
