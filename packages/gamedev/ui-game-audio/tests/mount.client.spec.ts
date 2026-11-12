// @vitest-environment jsdom
/**
 * Audio tab browser plugin registration: the tab type and its guide entry, the body and chip title seats, the copy,
 * one state per retained Session released with the Session, the bound Remote calls, the answers to the agent's measure
 * and reveal events, and unload.
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { AudioMeasureEvent, AudioMeasureResult } from '@deepseek-ai/dsh-game-audio/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioTab, AudioTabTitle, type AudioTabInjected } from '../src/client/AudioTab.tsx'
import { apply, Config, inject, TAB_ID, TAB_KIND } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { installWebAudio, wavFile } from './webaudio.client.ts'

const S1 = SessionId('s1')
const GONE = SessionId('gone')

/** A byte read's window option. */
type Range = { readonly range?: { readonly offset?: number; readonly length?: number } }

/** A forwarded event listener as the plugin subscribes it. */
type Listener = (this: unknown, ...args: never[]) => unknown

function isFace(value: unknown): value is AudioTabInjected {
  return typeof value === 'object' && value !== null && 'hooks' in value && 'read' in value
}

beforeEach(() => {
  installWebAudio()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
  const sessionScope = { session: S1 }
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
    scopeOf: (scope: unknown) => scope === sessionScope ? S1 : undefined,
  })
  const samples = Array.from({ length: 800 }, (_, frame) => 0.5 * Math.sin(2 * Math.PI * 100 * frame / 8000))
  const tone = wavFile({ sampleRate: 8000, channels: 1, samples })
  const workspaceFiles = {
    list: vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const, value: { path: path === '.' ? '' : path, entries: [{ name: 'jump.wav', type: 'file' as const, size: tone.length }], truncated: false },
    })),
    readBytes: vi.fn(async (_sessionId: string, _path: string, options: Range) => {
      const offset = options.range?.offset ?? 0
      const data = tone.slice(offset, options.range?.length === undefined ? tone.length : offset + options.range.length)
      return { ok: true as const, value: { absolutePath: '/p/jump.wav', version: 'v1', bytes: tone.length, offset, data, eof: offset + data.length >= tone.length } }
    }),
  }
  const listeners = new Map<string, Listener>()
  const remote = {
    workspaceFiles,
    $on: (event: string, listener: Listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  }
  ctx.provide('remote', remote)
  ctx.provide('remote.workspaceFiles', workspaceFiles)
  const sidebar = { mounted: { getSnapshot: () => S1, subscribe: () => () => {} }, openTab: vi.fn() }
  ctx.provide('sidebarRight', sidebar as never)
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
  const face = (sessionId: SessionId): AudioTabInjected => {
    const factory = entry('sidebar.right.pane.tab')?.inject
    assert(typeof factory === 'function')
    const value: unknown = factory(sessionId as never)
    assert(isFace(value))
    return value
  }
  const measure = (scope: unknown, request: AudioMeasureEvent, next: () => Promise<AudioMeasureResult>): Promise<AudioMeasureResult> => {
    const listener = listeners.get('game-audio/measure')
    assert(listener !== undefined)
    return Reflect.apply(listener, scope, [request, next]) as Promise<AudioMeasureResult>
  }
  return { ctx, fiber, kinds, scopes, workspaceFiles, entry, face, listeners, measure, sessionScope, sidebar }
}

describe('Audio tab registration', () => {
  it('declares the browser services it needs and validates its caps', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles'])
    expect(Config({})).toEqual({
      maxFolders: 2000, maxSounds: 5000, maxPreviewBytes: 256 * 1024 * 1024, maxDecodedSeconds: 1200, maxMeasuredSeconds: 300,
    })
    expect(() => Config({ maxSounds: 0 })).toThrow()
  })

  it('registers the Audio page type with its guide entry, its body and chip title, and its copy', async () => {
    const f = await fixture()
    const type = f.kinds.get(TAB_KIND)
    expect(type).toMatchObject({ id: TAB_ID, kind: 'audio', priority: 'builtin' })
    expect([en['tab.title'], zh['tab.title']]).toContain(type?.title('sidebar://audio'))
    const guide = type?.guide?.[0]
    expect(guide).toMatchObject({ id: 'listen', order: 46 })
    expect([en['guide.description'], zh['guide.description']]).toContain(guide?.description?.())
    const Icon = guide?.icon
    assert(Icon !== undefined)
    expect(renderToStaticMarkup(createElement(Icon, { size: 26 }))).toContain('width="26"')
    expect(f.entry('sidebar.right.pane.tab')).toMatchObject({ component: AudioTab, locale: NS })
    expect(f.entry('sidebar.right.pane.tab.title')).toMatchObject({ component: AudioTabTitle, locale: NS })
    await f.fiber.dispose()
  })

  it('binds one state per Session to that Session\'s listing, header reads, and file reads, and releases it with the Session', async () => {
    const f = await fixture({ maxFolders: 5, maxSounds: 5, maxPreviewBytes: 10, maxDecodedSeconds: 60, maxMeasuredSeconds: 30 })
    const face = f.face(S1)
    expect(f.face(S1).hooks.scan).toBe(face.hooks.scan)
    expect(face).toMatchObject({ keyPrefix: S1, maxDecodedSeconds: 60, maxMeasuredSeconds: 30 })
    face.rescan()
    await vi.waitFor(() => { expect(face.hooks.probes.getSnapshot().get('jump.wav')?.probe).toMatchObject({ format: 'WAV', seconds: 0.1 }) })
    expect(f.workspaceFiles.list).toHaveBeenCalledWith(S1, '.', expect.any(AbortSignal))
    expect(f.workspaceFiles.readBytes).toHaveBeenCalledWith(S1, 'jump.wav', { range: { offset: 0, length: 4096 } }, expect.any(AbortSignal))
    const read = await face.read('jump.wav', new AbortController().signal)
    // The configured preview cap applies to the read.
    expect(!read.ok && read.error.code).toBe('workspace-file/too-large')
    expect(face.fileAddress('audio/jump.wav')).toBe('dsh-resource://file/session/s1/audio/jump.wav')
    expect(() => f.face(GONE)).toThrow('is not retained')
    await f.scopes.get(S1)?.dispose()
    expect(f.face(S1).hooks.scan).not.toBe(face.hooks.scan)
    await f.fiber.dispose()
  })

  it('measures a sound for an agent of a Session it may read, and leaves other requests to the next window', async () => {
    const f = await fixture()
    const next = vi.fn(async (): Promise<AudioMeasureResult> => { throw new Error('no window') })
    const request: AudioMeasureEvent = { path: 'jump.wav', start: 0, maxSeconds: 300, picture: false, maxBytes: 1_000_000, signal: new AbortController().signal }
    const answer = await f.measure(f.sessionScope, request, next)
    expect(answer.measurements).toMatchObject({ sampleRate: 8000, channels: 1, seconds: 0.1 })
    expect(next).not.toHaveBeenCalled()
    await expect(f.measure({}, request, next)).rejects.toThrow('no window')
    expect(next).toHaveBeenCalledTimes(1)
    await f.fiber.dispose()
  })

  it('opens a revealed sound in the Session\'s Audio tab', async () => {
    const f = await fixture()
    const reveal = f.listeners.get('game-audio/reveal')
    assert(reveal !== undefined)
    Reflect.apply(reveal, undefined, [{ sessionId: S1, path: 'audio/jump.wav' }])
    expect(f.sidebar.openTab).toHaveBeenCalledWith('audio', { params: { path: 'audio/jump.wav' } })
    await f.fiber.dispose()
  })

  it('withdraws the type, both seats, the copy, the event answers, and every Session\'s state on unload', async () => {
    const f = await fixture()
    const face = f.face(S1)
    face.rescan()
    await f.fiber.dispose()
    expect(f.kinds.has(TAB_KIND)).toBe(false)
    expect(f.ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    expect(f.ctx.slots.entries('sidebar.right.pane.tab.title')).toEqual([])
    expect(f.ctx.locale.bind(NS)('tab.title')).toBe('tab.title')
    expect([...f.listeners.keys()]).toEqual([])
    const calls = f.workspaceFiles.list.mock.calls.length
    face.rescan()
    expect(f.workspaceFiles.list.mock.calls.length).toBe(calls)
  })
})
