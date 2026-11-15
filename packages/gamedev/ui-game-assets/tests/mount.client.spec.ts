// @vitest-environment jsdom
/**
 * Assets tab browser plugin registration: the tab type and its guide entry, the body and chip title seats, the copy,
 * one state per retained Session released with the Session, the bound Remote calls, the reads through the Host's
 * project file route inside each Session's folder, and unload.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ANSWER_LIMITS } from '@deepseek-ai/dsh-game-assets/src/result.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetsTab, AssetsTabTitle, type AssetsTabInjected } from '../src/client/AssetsTab.tsx'
import { apply, Config, inject, TAB_ID, TAB_KIND } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const S1 = SessionId('s1')
const GONE = SessionId('gone')

afterEach(() => { vi.unstubAllGlobals() })

/** One request of the project file route, as the fixture's route saw it. */
interface RouteRead {
  readonly root: string | null
  readonly path: string | null
  readonly max: string | null
  readonly length: string | null
}

/**
 * The Host's project file route: three bytes for every file, refused over the request's `max`; a full read can be held
 * until the spec releases it.
 */
function fileRoute(hold: (read: RouteRead) => Promise<void> | undefined = () => undefined) {
  const reads: RouteRead[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const read = { root: url.searchParams.get('root'), path: url.searchParams.get('path'), max: url.searchParams.get('max'), length: url.searchParams.get('length') }
    reads.push(read)
    await hold(read)
    const data = new Uint8Array([1, 2, 3])
    if (read.max !== null && Number(read.max) < data.byteLength) {
      return new Response(JSON.stringify({ code: 'too-large', message: 'too large', limit: Number(read.max) }), { status: 413 })
    }
    return new Response(data, { headers: { 'X-Asset-Version': 'v1' } })
  })
  vi.stubGlobal('fetch', fetch)
  return { reads, fetch }
}

function isFace(value: unknown): value is AssetsTabInjected {
  return typeof value === 'object' && value !== null && 'hooks' in value && 'read' in value
}

async function fixture(config: Config = {}) {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const kinds = new Map<string, SidebarRightTabDefinition>()
  ctx.provide('sidebarRightTabs', {
    register: (definition: SidebarRightTabDefinition) => {
      kinds.set(definition.kind, definition)
      return () => { kinds.delete(definition.kind) }
    },
  })
  const scopes = new Map<SessionId, Fiber>()
  ctx.provide('sessions', {
    binding: (id: SessionId) => {
      if (id === GONE) return undefined
      let fiber = scopes.get(id)
      if (fiber === undefined || fiber.uid === null) {
        fiber = ctx.plugin(() => {})
        scopes.set(id, fiber)
      }
      return { sessionId: id, ctx: fiber.ctx }
    },
    // A render request's owner names its Session; this fixture's owners are the strings the specs pass.
    scopeOf: (owner: unknown) => (owner === 'scoped' ? S1 : undefined),
    // The Host's list of Sessions names each one's project folder.
    list: { getSnapshot: () => ({ byId: { [S1]: { cwd: '/p' }, 'agent-session': { cwd: '/p' } } }) },
  })
  const workspaceFiles = {
    list: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'hero.png', type: 'file' as const }], truncated: false },
    })),
  }
  const listeners = new Map<string, (this: unknown, ...args: never[]) => unknown>()
  const remote = {
    workspaceFiles,
    $on: (event: string, listener: (this: unknown, ...args: never[]) => unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  }
  ctx.provide('remote', remote)
  ctx.provide('remote.workspaceFiles', workspaceFiles)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply: (plugin: Context) => { apply(plugin, Config(config)) } })
  await fiber
  const entry = (slot: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title') =>
    ctx.slots.entries(slot).find(candidate => candidate.options.key === TAB_ID)
  const face = (sessionId: SessionId): AssetsTabInjected => {
    const factory = entry('sidebar.right.pane.tab')?.inject
    assert(typeof factory === 'function')
    const value: unknown = factory(sessionId as never)
    assert(isFace(value))
    return value
  }
  return { ctx, fiber, kinds, scopes, workspaceFiles, entry, face, listeners }
}

describe('Assets tab registration', () => {
  it('declares the browser services it needs and validates its caps', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles'])
    expect(Config({})).toEqual({
      maxFolders: 2000, maxAssets: 5000, maxPreviewBytes: 256 * 1024 * 1024, maxDecodedPixels: 8192 * 8192,
      maxAgentDraws: 3, maxAgentDrawBytes: 64 * 1024 * 1024,
    })
    expect(() => Config({ maxDecodedPixels: 0 })).toThrow()
    expect(() => Config({ maxAgentDraws: 0 })).toThrow()
    expect(() => Config({ maxAssets: 0 })).toThrow()
  })

  it('registers the Assets page type with its guide entry, its body and chip title, and its copy', async () => {
    const f = await fixture()
    const type = f.kinds.get(TAB_KIND)
    expect(type).toMatchObject({ id: TAB_ID, kind: 'assets', priority: 'builtin' })
    expect(type?.patterns).toBeUndefined()
    expect([en['tab.title'], zh['tab.title']]).toContain(type?.title('sidebar://assets'))
    const guide = type?.guide?.[0]
    expect(guide).toMatchObject({ id: 'browse', order: 45 })
    expect([en['guide.description'], zh['guide.description']]).toContain(guide?.description?.())
    const Icon = guide?.icon
    assert(Icon !== undefined)
    expect(renderToStaticMarkup(createElement(Icon, { size: 26 }))).toContain('width="26"')
    expect(f.entry('sidebar.right.pane.tab')).toMatchObject({ component: AssetsTab, locale: NS })
    expect(f.entry('sidebar.right.pane.tab.title')).toMatchObject({ component: AssetsTabTitle, locale: NS })
    await f.fiber.dispose()
  })

  it('binds one state per Session to that Session\'s listing and reads, and releases it with the Session', async () => {
    const route = fileRoute()
    const f = await fixture({ maxFolders: 5, maxAssets: 5, maxPreviewBytes: 2 })
    const face = f.face(S1)
    expect(f.face(S1).hooks.scan).toBe(face.hooks.scan)
    face.rescan()
    await vi.waitFor(() => { expect(face.hooks.scan.getSnapshot().status).toBe('ready') })
    expect(f.workspaceFiles.list).toHaveBeenCalledWith(S1, '.', expect.any(AbortSignal))
    expect(face.hooks.scan.getSnapshot().scan?.assets.map(asset => asset.path)).toEqual(['hero.png'])
    face.select('hero.png')
    expect(face.hooks.view.getSnapshot().selected).toBe('hero.png')
    const read = await face.read('hero.png', new AbortController().signal)
    // The read stays inside the Session's project folder, and the configured preview cap applies to it.
    expect(!read.ok && read.error.code).toBe('workspace-file/too-large')
    expect(route.reads).toEqual([{ root: '/p', path: 'hero.png', max: '2', length: null }])
    expect(face.fileAddress('assets/hero.png')).toBe('dsh-resource://file/session/s1/assets/hero.png')
    // A selection may name the animation to play when the asset shows.
    face.select('hero.png', { animation: 'run', grid: { columns: 4, rows: 1 } })
    expect(face.hooks.view.getSnapshot()).toMatchObject({ selected: 'hero.png', asked: { path: 'hero.png', animation: 'run', grid: { columns: 4, rows: 1 }, request: 1 } })
    face.select('other.png')
    expect(face.hooks.view.getSnapshot().asked).toBeUndefined()
    expect(await face.animations.files('', new AbortController().signal)).toEqual(['hero.png'])
    expect(face.relatedUrl('models/a.gltf', 'a.bin')).toBe(new URL(`api/game-assets.file?${new URLSearchParams({ root: '/p', path: 'models/a.bin', max: '2' }).toString()}`, document.baseURI).href)
    // A Session the Host's list names no folder for reads nothing.
    const unknown = await f.face(SessionId('unlisted')).read('hero.png', new AbortController().signal)
    expect(!unknown.ok && unknown.error.code).toBe('game-assets/unreadable')
    expect(f.face(SessionId('unlisted')).relatedUrl('models/a.gltf', 'a.bin')).toBeUndefined()
    expect(route.reads).toHaveLength(1)
    expect(() => f.face(GONE)).toThrow('is not retained')
    await f.scopes.get(S1)?.dispose()
    expect(f.face(S1).hooks.scan).not.toBe(face.hooks.scan)
    await f.fiber.dispose()
  })

  it('reads a path through a folder named ~ inside the workspace, which the Host would read in the home folder', async () => {
    const route = fileRoute()
    const f = await fixture()
    await f.face(S1).read('~/Pictures/hero.png', new AbortController().signal)
    expect(route.reads.at(-1)?.path).toBe('./~/Pictures/hero.png')
    await f.face(S1).read('art/~/hero.png', new AbortController().signal)
    expect(route.reads.at(-1)?.path).toBe('art/~/hero.png')
    // An agent's draw reads the image's first bytes the same way.
    const render = f.listeners.get('game-assets/render') as ((this: unknown, ...args: unknown[]) => Promise<unknown>) | undefined
    assert(render !== undefined)
    // The draw reads inside the folder its request names: the first bytes, then the whole file.
    const request = {
      path: '~/Pictures/hero.png', root: '/games/knight', kind: 'image', draw: { views: ['iso'], shading: 'material', skeleton: false, size: 512 },
      images: false, bytes: 3, maxBytes: 10, maxPixels: 100, limits: ANSWER_LIMITS,
    }
    await render.call('scoped', request, vi.fn()).catch(() => {
      // AssetDrawError: the fixture's bytes are no image; only the paths read matter here.
    })
    expect(route.reads.slice(2).map(read => [read.root, read.path, read.length])).toEqual([
      ['/games/knight', './~/Pictures/hero.png', String(256 * 1024)],
      ['/games/knight', './~/Pictures/hero.png', null],
    ])
    await f.fiber.dispose()
  })

  it('turns a read that rejects into a failed read and reports it, and a cancelled one without a report', async () => {
    fileRoute()
    const f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    // A base URI that names no URL fails the read before any request: an assembly fault.
    const base = vi.spyOn(document, 'baseURI', 'get').mockReturnValue('http://[broken')
    const read = await f.face(S1).read('hero.png', new AbortController().signal)
    expect(!read.ok && read.error.code).toBe('game-assets/unreadable')
    expect(warn).toHaveBeenCalledOnce()
    base.mockRestore()
    const cancelled = new AbortController()
    cancelled.abort(new Error('closed'))
    const dropped = await f.face(S1).read('hero.png', cancelled.signal)
    expect(!dropped.ok && dropped.error.code).toBe('game-assets/unreadable')
    expect(warn).toHaveBeenCalledOnce()
    await f.fiber.dispose()
  })

  it('answers render requests only for a Session it can read, leaving models to a window that draws WebGL', async () => {
    const f = await fixture()
    const render = f.listeners.get('game-assets/render')
    assert(render !== undefined)
    const next = vi.fn(async () => 'delegated')
    const request = { path: 'hero.glb', root: '/p', kind: 'model', draw: { views: ['iso'], shading: 'material', skeleton: false, size: 512 }, images: true, maxBytes: 10, maxPixels: 100, limits: ANSWER_LIMITS }
    expect(await (render as (this: unknown, ...args: unknown[]) => unknown).call('unscoped', request, next)).toBe('delegated')
    // jsdom offers no WebGL, so a model goes to another window.
    expect(await (render as (this: unknown, ...args: unknown[]) => unknown).call('scoped', request, next)).toBe('delegated')
    expect(next).toHaveBeenCalledTimes(2)
    await f.fiber.dispose()
    expect(f.listeners.size).toBe(0)
  })

  it('draws several agents\' pictures at once, up to its limit, and drops a request whose call ended while it waited', async () => {
    const reads: { path: string; release: () => void }[] = []
    const heads: string[] = []
    fileRoute(async (read) => {
      // An image's first bytes, which size it before its draw waits for its turn, are not held.
      if (read.length !== null) {
        heads.push(read.path ?? '')
        return
      }
      const released = Promise.withResolvers<undefined>()
      reads.push({ path: read.path ?? '', release: () => { released.resolve(undefined) } })
      await released.promise
    })
    const f = await fixture({ maxAgentDraws: 2 })
    const render = f.listeners.get('game-assets/render') as ((this: unknown, ...args: unknown[]) => Promise<unknown>) | undefined
    assert(render !== undefined)
    const request = (path: string, signal?: AbortSignal) => ({
      path, root: '/p', kind: 'image', draw: { views: ['iso'], shading: 'material', skeleton: false, size: 512 }, images: false, bytes: 3, maxBytes: 10, maxPixels: 100,
      limits: ANSWER_LIMITS, ...signal === undefined ? {} : { signal },
    })
    const next = vi.fn(async () => 'delegated')
    const ended = new AbortController()
    const answers = [
      render.call('scoped', request('a.png'), next),
      render.call('scoped', request('b.png'), next),
      render.call('scoped', request('c.png', ended.signal), next),
      render.call('scoped', request('d.png'), next),
    ].map(answer => answer.then(() => 'drawn', (error: unknown) => (error instanceof Error ? error.message : String(error))))
    await vi.waitFor(() => { expect(reads.map(read => read.path)).toEqual(['a.png', 'b.png']) })
    expect(heads).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    ended.abort(new Error('the call ended'))
    for (const read of reads) read.release()
    await vi.waitFor(() => { expect(reads.map(read => read.path)).toEqual(['a.png', 'b.png', 'd.png']) })
    reads[2]?.release()
    const settled = await Promise.all(answers)
    expect(settled[2]).toBe('the call ended')
    expect(next).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })

  it('walks a Session\'s project for its images\' animations when it has no scan, again for each later image', async () => {
    const f = await fixture()
    const agentSession = SessionId('agent-session')
    const animations = f.face(agentSession).animations
    const signal = new AbortController().signal
    const walks = () => f.workspaceFiles.list.mock.calls.filter(([sessionId, path]) => sessionId === agentSession && path === '.').length
    expect(await animations.godot(signal)).toEqual({ files: [], projects: [] })
    expect(walks()).toBe(1)
    // The project may have changed since: a later image's animations come from a new walk.
    f.workspaceFiles.list.mockImplementation(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'hero.tres', type: 'file' as const }], truncated: false },
    }))
    expect(await animations.godot(signal)).toEqual({ files: ['hero.tres'], projects: [] })
    expect(walks()).toBe(2)
    // A caller whose call has ended does not wait.
    const ended = new AbortController()
    ended.abort(new Error('the call ended'))
    await expect(animations.godot(ended.signal)).rejects.toThrow('the call ended')
    await f.fiber.dispose()
  })

  it('follows only the latest reveal while an earlier one waits for its Session to come on screen', async () => {
    const f = await fixture()
    const reveal = f.listeners.get('game-assets/reveal') as ((reveal: unknown) => void) | undefined
    assert(reveal !== undefined)
    let mounted: SessionId | undefined
    const subscribers = new Set<() => void>()
    const show = (sessionId: SessionId) => {
      mounted = sessionId
      for (const notify of [...subscribers]) notify()
    }
    const openTab = vi.fn()
    const openSession = vi.fn()
    f.ctx.provide('sidebarRight', {
      openTab,
      mounted: {
        getSnapshot: () => mounted,
        subscribe: (listener: () => void) => {
          subscribers.add(listener)
          return () => { subscribers.delete(listener) }
        },
      },
    } as never)
    f.ctx.provide('uiWorkspace', { openSession } as never)
    const first = SessionId('first')
    const second = SessionId('second')
    reveal({ sessionId: first, path: 'a.png' })
    reveal({ sessionId: second, path: 'b.png' })
    expect(openSession.mock.calls).toEqual([[first], [second]])
    // The first Session comes on screen late; its reveal was superseded and opens nothing.
    show(first)
    expect(openTab).not.toHaveBeenCalled()
    show(second)
    expect(openTab).toHaveBeenCalledWith('assets', { params: { path: 'b.png' } })
    expect(subscribers.size).toBe(0)
    await f.fiber.dispose()
  })

  it('opens a revealed asset in the Assets tab of the Session on screen, or shows the Session first', async () => {
    const f = await fixture()
    const reveal = f.listeners.get('game-assets/reveal') as ((reveal: unknown) => void) | undefined
    assert(reveal !== undefined)
    // Without the right Sidebar nothing opens.
    reveal({ sessionId: S1, path: 'a.png' })
    let mounted: SessionId | undefined = S1
    const subscribers = new Set<() => void>()
    const openTab = vi.fn()
    const openSession = vi.fn((sessionId: SessionId) => {
      mounted = sessionId
      for (const notify of [...subscribers]) notify()
    })
    f.ctx.provide('sidebarRight', {
      openTab,
      mounted: {
        getSnapshot: () => mounted,
        subscribe: (listener: () => void) => {
          subscribers.add(listener)
          return () => { subscribers.delete(listener) }
        },
      },
    } as never)
    f.ctx.provide('uiWorkspace', { openSession } as never)
    reveal({ sessionId: S1, path: 'art/hero.png', animation: 'grid', grid: { columns: 4, rows: 1 } })
    expect(openTab).toHaveBeenLastCalledWith('assets', { params: { path: 'art/hero.png', animation: 'grid', grid: { columns: 4, rows: 1 } } })
    expect(openSession).not.toHaveBeenCalled()
    const other = SessionId('agent-session')
    reveal({ sessionId: other, path: 'models/knight.glb' })
    expect(openSession).toHaveBeenCalledWith(other)
    expect(openTab).toHaveBeenLastCalledWith('assets', { params: { path: 'models/knight.glb' } })
    expect(subscribers.size).toBe(0)
    await f.fiber.dispose()
  })

  it('withdraws the type, both seats, the copy, and every Session\'s state on unload', async () => {
    const f = await fixture()
    const face = f.face(S1)
    face.rescan()
    await f.fiber.dispose()
    expect(f.kinds.has(TAB_KIND)).toBe(false)
    expect(f.ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    expect(f.ctx.slots.entries('sidebar.right.pane.tab.title')).toEqual([])
    expect(f.ctx.locale.bind(NS)('tab.title')).toBe('tab.title')
    // A closed state scans no more.
    const calls = f.workspaceFiles.list.mock.calls.length
    face.rescan()
    expect(f.workspaceFiles.list.mock.calls.length).toBe(calls)
  })
})
