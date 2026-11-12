// @vitest-environment jsdom
/**
 * Assets tab browser plugin registration: the tab type and its guide entry, the body and chip title seats, the copy,
 * one state per retained Session released with the Session, the bound Remote calls, and unload.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { AssetsTab, AssetsTabTitle, type AssetsTabInjected } from '../src/client/AssetsTab.tsx'
import { apply, Config, inject, TAB_ID, TAB_KIND } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const S1 = SessionId('s1')
const GONE = SessionId('gone')

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
  })
  const workspaceFiles = {
    list: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'hero.png', type: 'file' as const }], truncated: false },
    })),
    readBytes: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { absolutePath: `/p/${path}`, version: 'v1', bytes: 3, offset: 0, data: new Uint8Array([1, 2, 3]), eof: true },
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
      maxFolders: 2000, maxAssets: 5000, maxPreviewBytes: 256 * 1024 * 1024, maxAgentDraws: 3, maxAgentDrawBytes: 64 * 1024 * 1024,
    })
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
    // The configured preview cap applies to the read.
    expect(!read.ok && read.error.code).toBe('workspace-file/too-large')
    expect(f.workspaceFiles.readBytes).toHaveBeenCalledWith(S1, 'hero.png', {}, expect.any(AbortSignal))
    expect(face.fileAddress('assets/hero.png')).toBe('dsh-resource://file/session/s1/assets/hero.png')
    // A selection may name the animation to play when the asset shows.
    face.select('hero.png', { animation: 'run', grid: { columns: 4, rows: 1 } })
    expect(face.hooks.view.getSnapshot()).toMatchObject({ selected: 'hero.png', asked: { path: 'hero.png', animation: 'run', grid: { columns: 4, rows: 1 }, request: 1 } })
    face.select('other.png')
    expect(face.hooks.view.getSnapshot().asked).toBeUndefined()
    expect(await face.animations.files('', new AbortController().signal)).toEqual(['hero.png'])
    expect(face.relatedUrl('/p/models/a.gltf', 'a.bin')).toBe(new URL(`api/file?path=${encodeURIComponent('/p/models/a.bin')}`, document.baseURI).href)
    expect(() => f.face(GONE)).toThrow('is not retained')
    await f.scopes.get(S1)?.dispose()
    expect(f.face(S1).hooks.scan).not.toBe(face.hooks.scan)
    await f.fiber.dispose()
  })

  it('turns a read that rejects into a failed read and reports it', async () => {
    const f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    f.workspaceFiles.readBytes.mockRejectedValueOnce(new Error('assembly fault'))
    const read = await f.face(S1).read('hero.png', new AbortController().signal)
    expect(!read.ok && read.error.code).toBe('gateway/internal')
    expect(warn).toHaveBeenCalled()
    await f.fiber.dispose()
  })

  it('answers render requests only for a Session it can read, leaving models to a window that draws WebGL', async () => {
    const f = await fixture()
    const render = f.listeners.get('game-assets/render')
    assert(render !== undefined)
    const next = vi.fn(async () => 'delegated')
    const request = { path: 'hero.glb', kind: 'model', draw: { views: ['iso'], shading: 'material', skeleton: false, size: 512 }, images: true, maxBytes: 10, maxPixels: 100 }
    expect(await (render as (this: unknown, ...args: unknown[]) => unknown).call('unscoped', request, next)).toBe('delegated')
    // jsdom offers no WebGL, so a model goes to another window.
    expect(await (render as (this: unknown, ...args: unknown[]) => unknown).call('scoped', request, next)).toBe('delegated')
    expect(next).toHaveBeenCalledTimes(2)
    await f.fiber.dispose()
    expect(f.listeners.size).toBe(0)
  })

  it('draws several agents\' pictures at once, up to its limit, and drops a request whose call ended while it waited', async () => {
    const f = await fixture({ maxAgentDraws: 2 })
    const render = f.listeners.get('game-assets/render') as ((this: unknown, ...args: unknown[]) => Promise<unknown>) | undefined
    assert(render !== undefined)
    const reads: { path: string; release: () => void }[] = []
    f.workspaceFiles.readBytes.mockImplementation(async (_sessionId: string, path: string) => {
      const released = Promise.withResolvers<undefined>()
      reads.push({ path, release: () => { released.resolve(undefined) } })
      await released.promise
      return { ok: true as const, value: { absolutePath: `/p/${path}`, version: 'v1', bytes: 3, offset: 0, data: new Uint8Array([1, 2, 3]), eof: true } }
    })
    const request = (path: string, signal?: AbortSignal) => ({
      path, kind: 'image', draw: { views: ['iso'], shading: 'material', skeleton: false, size: 512 }, images: false, bytes: 3, maxBytes: 10, maxPixels: 100,
      ...signal === undefined ? {} : { signal },
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
    ended.abort(new Error('the call ended'))
    for (const read of reads) read.release()
    await vi.waitFor(() => { expect(reads.map(read => read.path)).toEqual(['a.png', 'b.png', 'd.png']) })
    reads[2]?.release()
    const settled = await Promise.all(answers)
    expect(settled[2]).toBe('the call ended')
    expect(next).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })

  it('walks the project once for the pictures drawn together for a Session without a scan', async () => {
    const f = await fixture()
    const agentSession = SessionId('agent-session')
    const animations = f.face(agentSession).animations
    const signal = new AbortController().signal
    const walks = () => f.workspaceFiles.list.mock.calls.filter(([sessionId, path]) => sessionId === agentSession && path === '.').length
    const [first, second] = await Promise.all([animations.godot(signal), animations.godot(signal)])
    expect(first).toEqual(second)
    expect(walks()).toBe(1)
    // A fresh walk serves the next picture too.
    await animations.godot(signal)
    expect(walks()).toBe(1)
    // A caller whose call has ended does not wait.
    const ended = new AbortController()
    ended.abort(new Error('the call ended'))
    await expect(animations.godot(ended.signal)).rejects.toThrow('the call ended')
    await f.fiber.dispose()
  })

  it('lets a caller stop waiting for a shared walk while the walk goes on for the others', async () => {
    const f = await fixture()
    const agentSession = SessionId('agent-session')
    const listed = Promise.withResolvers<undefined>()
    f.workspaceFiles.list.mockImplementation(async (_sessionId: string, path: string) => {
      await listed.promise
      return { ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'hero.tres', type: 'file' as const }], truncated: false } }
    })
    const animations = f.face(agentSession).animations
    const stopping = new AbortController()
    const stopped = animations.godot(stopping.signal)
    const staying = animations.godot(new AbortController().signal)
    stopping.abort(new Error('the call ended'))
    await expect(stopped).rejects.toThrow('the call ended')
    listed.resolve(undefined)
    expect(await staying).toEqual({ files: ['hero.tres'], projects: [] })
    expect(f.workspaceFiles.list.mock.calls.filter(([sessionId]) => sessionId === agentSession)).toHaveLength(1)
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
