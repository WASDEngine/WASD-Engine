// @vitest-environment jsdom
/**
 * The Audio tab in the production right Sidebar, Slot renderer, and resource service: the guide offers it, the list
 * groups the project's sounds by folder with their lengths, filters and searches them, a click plays a sound and a
 * second pauses it, the arrow keys move on while it plays, the details show its figures, an agent's request selects a
 * sound, and the empty project's state.
 */
import type { WorkspaceDirectoryListing, WorkspaceFileBytes, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { contextMenuHook, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { FakeAudioContext, installWebAudio, wavFile } from './webaudio.client.ts'

const SESSION = 'audio-session' as SessionId
const SHORTCUT_CATALOG: readonly never[] = []

type Listing = RemoteResult<WorkspaceDirectoryListing>
type Bytes = RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>

function tone(seconds: number, amplitude = 0.5): Uint8Array<ArrayBuffer> {
  const samples = Array.from({ length: Math.round(seconds * 8000) }, (_, frame) => amplitude * Math.sin(2 * Math.PI * 100 * frame / 8000))
  return wavFile({ sampleRate: 8000, channels: 1, samples })
}

/** The project's sound files by workspace path. */
const FILES: Readonly<Record<string, Uint8Array<ArrayBuffer>>> = {
  'audio/sfx/coin.wav': tone(0.25),
  'audio/sfx/jump.wav': tone(0.5, 1.2),
  'audio/voice/hello.wav': tone(1),
}

/** The project: folders by workspace path; a trailing `/` marks a folder. */
const PROJECT: Readonly<Record<string, readonly string[]>> = {
  '': ['audio/', '.godot/', 'project.godot'],
  audio: ['sfx/', 'voice/'],
  'audio/sfx': ['coin.wav', 'jump.wav', 'jump.wav.import'],
  'audio/voice': ['hello.wav'],
}

function listing(project: Readonly<Record<string, readonly string[]>>, path: string): Listing {
  const key = path === '.' ? '' : path
  const names = project[key]
  if (names === undefined) return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
  const entries = names.map(name => name.endsWith('/')
    ? { name: name.slice(0, -1), type: 'directory' as const }
    : { name, type: 'file' as const, size: FILES[key === '' ? name : `${key}/${name}`]?.length ?? 3 })
  return { ok: true, value: { path: key, entries, truncated: false } }
}

let runtime: SlotTestRuntime | undefined
const restore: (() => void)[] = []

function stubPrototype(target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  restore.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, descriptor)
  })
}

beforeEach(() => {
  stubPrototype(Element.prototype, 'getAnimations', () => [])
  stubPrototype(Element.prototype, 'scrollIntoView', () => {})
  stubPrototype(Element.prototype, 'setPointerCapture', () => {})
  installWebAudio()
  // The playhead follows animation frames, which these specs do not run.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})

afterEach(async () => {
  try {
    await runtime?.dispose()
    runtime = undefined
  } finally {
    for (const undo of restore.splice(0).reverse()) undo()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

async function boot(project: Readonly<Record<string, readonly string[]>> = PROJECT) {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  rt.ctx.provide('contextMenus', { register: () => () => {}, open: vi.fn(), active: createSnapshotStore(null) } as never)
  rt.slots.provideRoot({ props: { useContextMenu: contextMenuHook(() => {}) } })
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: rt.panelInfo } as never)
  rt.ctx.provide('shortcuts', { register: () => () => {}, catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await rt.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const listCalls = vi.fn(async (_sessionId: string, path: string) => listing(project, path))
  type Range = { readonly range?: { readonly offset?: number; readonly length?: number } }
  const readBytes = vi.fn(async (_sessionId: string, path: string, options: Range): Promise<Bytes> => {
    const file = FILES[path]
    if (file === undefined) return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
    const offset = options.range?.offset ?? 0
    const data = file.slice(offset, options.range?.length === undefined ? file.length : offset + options.range.length)
    return { ok: true, value: { absolutePath: `/project/${path}`, version: 'v1', bytes: file.length, offset, data, eof: offset + data.length >= file.length } }
  })
  rt.remote.provideNamespaces({ workspaceFiles: { list: listCalls, readBytes } })
  rt.ctx.effect(() => rt.ctx.resources.register({
    protocol: 'file',
    open: async function* (address, { signal }) {
      const path = address.slice(address.indexOf(SESSION) + SESSION.length + 1)
      const stat: WorkspaceFileStat = { absolutePath: `/project/${path}`, version: 'v1' }
      yield { ok: true as const, value: stat }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    },
  }))
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...inject], apply })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  const openAudio = (params?: { readonly path: string }): void => {
    act(() => { rt.ctx.sidebarRight.openTab('audio', params === undefined ? {} : { params }) })
  }
  return { rt, view, listCalls, readBytes, openAudio }
}

function soundRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-game-audio] button[aria-expanded], [data-game-audio] button[title*=".wav"]')]
    .map(button => button.hasAttribute('aria-expanded') ? `[${button.textContent ?? ''}]` : button.textContent ?? '')
}

describe('Audio tab', () => {
  it('is offered on the guide with its description, and opens from it', async () => {
    const h = await boot()
    act(() => { h.rt.ctx.sidebarRight.openTab('guide') })
    const entry = h.view.container.querySelector<HTMLElement>('[data-sidebar-right-guide-entry="audio"]')
    expect(entry?.textContent).toContain('Audio')
    act(() => { entry?.click() })
    await waitFor(() => { expect(h.view.container.querySelector('[data-game-audio]')).not.toBeNull() })
  })

  it('lists the sounds by folder with their lengths, filters and searches them, and plays, pauses, and moves on', async () => {
    const h = await boot()
    h.openAudio()
    expect(await screen.findByText('Choose a sound to listen to it.')).toBeTruthy()
    await waitFor(() => { expect(soundRows(h.view.container)).toContain('jump.wav0.50 s') })
    expect(soundRows(h.view.container)).toEqual(['[audio/sfx2]', 'coin.wav0.25 s', 'jump.wav0.50 s', '[audio/voice1]', 'hello.wav1.00 s'])
    expect(h.listCalls.mock.calls.map(call => call[1]).sort()).toEqual(['.', 'audio', 'audio/sfx', 'audio/voice'])
    // The kind filter and the search.
    fireEvent.click(screen.getByRole('tab', { name: 'Dialogue' }))
    expect(soundRows(h.view.container)).toEqual(['[audio/voice1]', 'hello.wav1.00 s'])
    fireEvent.click(screen.getByRole('tab', { name: 'All' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search sounds' }), { target: { value: 'jum' } })
    expect(soundRows(h.view.container)).toEqual(['jump.wavaudio/sfx0.50 s'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    // A folder heading folds its sounds away.
    fireEvent.click(screen.getByRole('button', { name: /audio\/voice/u }))
    expect(soundRows(h.view.container)).toEqual(['[audio/sfx2]', 'coin.wav0.25 s', 'jump.wav0.50 s', '[audio/voice1]'])
    // A click selects the sound and plays it once it decodes.
    fireEvent.click(screen.getByTitle('audio/sfx/jump.wav'))
    await waitFor(() => { expect(FakeAudioContext.made[0]?.sources[0]?.started).toEqual([[0, 0]]) })
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Position in jump.wav' }).getAttribute('aria-valuetext')).toBe('0:00.0 / 0:00.5')
    const details = within(screen.getByLabelText('Details'))
    expect(details.getByText('Sound effect')).toBeTruthy()
    expect(details.getByText('WAV · 16-bit PCM · 8 kHz · Mono')).toBeTruthy()
    expect(details.getByText('0.5 s')).toBeTruthy()
    await waitFor(() => { expect(details.getByText('0.0 dBFS')).toBeTruthy() })
    expect(screen.getByText(/samples reach full scale and clip/u)).toBeTruthy()
    // A second click pauses it; the arrow keys move on, playing while a sound plays.
    fireEvent.click(screen.getByTitle('audio/sfx/jump.wav'))
    expect(FakeAudioContext.made[0]?.sources[0]?.stopped).toBe(true)
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.keyDown(screen.getByTitle('audio/sfx/jump.wav'), { key: 'ArrowUp' })
    await waitFor(() => { expect(screen.getByRole('slider', { name: 'Position in coin.wav' })).toBeTruthy() })
    await waitFor(() => { expect(FakeAudioContext.made[0]?.sources.at(-1)?.buffer?.duration).toBe(0.25) })
    // Repeat loops the sound.
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    expect(screen.getByRole('button', { name: 'Repeat' }).getAttribute('aria-pressed')).toBe('true')
    expect(FakeAudioContext.made[0]?.sources.at(-1)?.loop).toBe(true)
  })

  it('selects the sound an agent asked to show, without playing it', async () => {
    const h = await boot()
    h.openAudio({ path: 'audio/voice/hello.wav' })
    await waitFor(() => { expect(screen.getByRole('slider', { name: 'Position in hello.wav' })).toBeTruthy() })
    expect(screen.getByTitle('audio/voice/hello.wav').getAttribute('aria-current')).toBe('true')
    expect(FakeAudioContext.made).toEqual([])
  })

  it('says when the project has no sounds yet', async () => {
    const h = await boot({ '': ['project.godot'] })
    h.openAudio()
    expect(await screen.findByText('No sounds yet')).toBeTruthy()
    expect(screen.getByText('Sound effects, dialogue, and music in this game project appear here.')).toBeTruthy()
  })
})
