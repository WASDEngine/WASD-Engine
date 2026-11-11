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

async function fixture(config?: Parameters<typeof apply>[1]) {
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
  })
  const workspaceFiles = {
    list: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'hero.png', type: 'file' as const }], truncated: false },
    })),
    readBytes: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { absolutePath: `/p/${path}`, version: 'v1', bytes: 3, offset: 0, data: new Uint8Array([1, 2, 3]), eof: true },
    })),
  }
  ctx.provide('remote', { workspaceFiles })
  ctx.provide('remote.workspaceFiles', workspaceFiles)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply: (plugin: Context) => { apply(plugin, config) } })
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
  return { ctx, fiber, kinds, scopes, workspaceFiles, entry, face }
}

describe('Assets tab registration', () => {
  it('declares the browser services it needs and validates its caps', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles'])
    expect(Config({})).toEqual({ maxFolders: 2000, maxAssets: 5000, maxPreviewBytes: 256 * 1024 * 1024 })
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
