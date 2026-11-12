/**
 * Audio tab, browser half: the right Sidebar's `audio` page type with its guide entry, its body, and its chip title.
 * The body lists the sound effects, dialogue, and music of the Session's game project, searchable, filtered by kind,
 * and grouped by folder with each sound's length, and plays the selected sound with its waveform, a repeat that loops
 * it sample-accurately, and the details the agent also reads. One player serves the window, so one sound plays at a
 * time. The plugin also answers the agent's audio tools: it decodes and measures a sound for a `game-audio/measure`
 * request of a Session it may read, and opens a sound in the Session's Audio tab for `game-audio/reveal`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the ctx.remote merge with the `workspaceFiles` namespace and the forwarded events, the `file` resource
// protocol, the sessions service, the workspace's Session navigation, and the right Sidebar's registry and navigation.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { probeAudio } from '@deepseek-ai/dsh-game-audio/audio'
import type { AudioReveal } from '@deepseek-ai/dsh-game-audio/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { answerMeasure } from './agent.ts'
import { AudioTab, AudioTabTitle, type AudioTabInjected } from './AudioTab.tsx'
import { AudioGlyph } from './icon.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { AudioPlayback } from './playback.ts'
import { readSound, windowReader, type ReadBytes, type SoundFile } from './read.ts'
import type { ScanLimits, SoundEntry } from './scan.ts'
import { AudioSource } from './source.ts'

export type { AudioTabInjected, AudioTabProps } from './AudioTab.tsx'
export type { GameAudioLocaleKey } from './locales.ts'
export type { PlaybackState } from './playback.ts'
export type { ReadBytes, SoundFile } from './read.ts'
export type { ListRow, SoundItem } from './rows.ts'
export type { ListFolder, ScanLimits, SoundEntry, SoundScan } from './scan.ts'
export type { KindFilter, ProbeEntry, ScanState, ViewState } from './source.ts'

/** Registry id of the Audio tab type, also its slot key. */
export const TAB_ID = '@deepseek-ai/dsh-client-ui-game-audio'

/** Kind of the Audio tab. */
export const TAB_KIND = 'audio'

/** How long a reveal waits for its Session to come on screen, in milliseconds. */
export const REVEAL_WAIT_MS = 10_000

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The sound to select. */
    audio: { readonly path?: string }
  }
}

/** Caps of the project walk, of one read sound, and of what the window decodes and measures. */
export interface Config {
  /** Folders one walk lists, the project folder included, before it stops and says the list is incomplete. */
  maxFolders?: number
  /** Sounds one walk collects before it stops and says the list is incomplete. */
  maxSounds?: number
  /** Largest file the tab reads, in bytes; a larger sound shows a notice instead. */
  maxPreviewBytes?: number
  /** Longest sound the tab decodes, in seconds; a longer sound shows a notice instead. */
  maxDecodedSeconds?: number
  /** Longest stretch from a sound's start that the tab's details measure, in seconds. */
  maxMeasuredSeconds?: number
}

/** Validated caps. */
export const Config: z<Config, Required<Config>> = z.object({
  maxFolders: z.natural().min(1).default(2000),
  maxSounds: z.natural().min(1).default(5000),
  maxPreviewBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxDecodedSeconds: z.natural().min(1).default(1200),
  maxMeasuredSeconds: z.natural().min(1).default(300),
})

/** Browser services the tab needs. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'remote', 'remote.workspaceFiles']

/**
 * Run tasks one after another; this window decodes one sound for agents at a time.
 * @returns the scheduler.
 */
function serial(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => {
      // The caller receives the failure; the chain only orders the tasks.
    })
    return run
  }
}

/**
 * Register the Audio tab type, its body and chip title, its copy, and the answers to the agent's audio tools.
 * @param ctx - the browser plugin context.
 * @param config - the caps.
 */
export function apply(ctx: Context, config: Required<Config> = Config({})): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-audio: dictionaries')
  const t = ctx.locale.bind(NS)
  const limits: ScanLimits = { maxFolders: config.maxFolders, maxSounds: config.maxSounds }
  const player = new AudioPlayback()
  ctx.effect(() => () => { player.close() }, 'ui-game-audio: player')
  const bytesOf = (sessionId: SessionId): ReadBytes => (path, options, signal) =>
    ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal)
  const readOf = (sessionId: SessionId) => (path: string, maxBytes: number, signal: AbortSignal): Promise<RemoteResult<SoundFile>> =>
    readSound(bytesOf(sessionId), path, maxBytes, signal).catch((error: unknown) => {
      // A Remote call rejects only for an assembly fault; the player shows it as a failed read.
      ctx.logger.warn('ui-game-audio: reading a sound failed', error)
      return { ok: false, error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } as const
    })
  const probeOf = (sessionId: SessionId) => async (sound: SoundEntry, signal: AbortSignal) => {
    let size = sound.bytes
    if (size === undefined) {
      const first = await bytesOf(sessionId)(sound.path, { range: { offset: 0, length: 1 } }, signal)
      if (!first.ok || first.value.bytes === undefined) return undefined
      size = first.value.bytes
    }
    return await probeAudio(windowReader(bytesOf(sessionId), sound.path, signal), size)
  }
  // Each Session's state with the release of its Session-scope effect; both end with the Session or this plugin.
  const sources = new Map<SessionId, { readonly source: AudioSource; readonly release: () => void }>()
  ctx.effect(() => () => {
    for (const { release } of [...sources.values()]) release()
    sources.clear()
  }, 'ui-game-audio: Session state')
  const sourceOf = (sessionId: SessionId): AudioSource => {
    const known = sources.get(sessionId)
    if (known !== undefined) return known.source
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-game-audio: Session ${sessionId} is not retained`)
    const source = new AudioSource(
      (path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal),
      probeOf(sessionId),
      limits,
      () => Date.now(),
      (error) => { ctx.logger.warn('ui-game-audio: the project walk failed', error) },
    )
    const dispose = binding.ctx.effect(() => () => {
      source.close()
      if (sources.get(sessionId)?.source === source) sources.delete(sessionId)
    }, 'ui-game-audio: release Session state')
    sources.set(sessionId, { source, release: () => { void dispose() } })
    return source
  }
  const tabFace = (scopeKey: string): AudioTabInjected => {
    const sessionId = brandString<SessionId>(scopeKey)
    const source = sourceOf(sessionId)
    const read = readOf(sessionId)
    return {
      hooks: { scan: source.scanState, view: source.view, probes: source.probes, playback: player.state },
      rescan: () => { source.rescan() },
      refresh: () => { source.refresh() },
      select: (path) => { source.select(path) },
      setQuery: (query) => { source.setQuery(query) },
      setFilter: (filter) => { source.setFilter(filter) },
      toggleFolder: (folder) => { source.toggleFolder(folder) },
      takeNavigation: (tabId, revision) => source.takeNavigation(tabId, revision),
      read: (path, signal) => read(path, config.maxPreviewBytes, signal),
      fileAddress: path => fileAddressFor(sessionId, undefined, path),
      playback: {
        load: (key, buffer) => { player.load(key, buffer) },
        play: (key) => { player.play(key) },
        pause: (key) => { player.pause(key) },
        seek: (key, seconds) => { player.seek(key, seconds) },
        position: key => player.position(key),
        setLoop: (loop) => { player.setLoop(loop) },
        setVolume: (volume) => { player.setVolume(volume) },
        release: (key) => { player.release(key) },
      },
      keyPrefix: sessionId,
      maxMeasuredSeconds: config.maxMeasuredSeconds,
      maxDecodedSeconds: config.maxDecodedSeconds,
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    title: () => t('tab.title'),
    guide: [{ id: 'listen', order: 46, title: () => t('guide.title'), description: () => t('guide.description'), icon: AudioGlyph }],
  }), 'ui-game-audio: Audio tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: tabFace,
  }, AudioTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
  }, AudioTabTitle))

  // The agent's audio tools: this window decodes and measures for the Sessions it may read, one sound at a time.
  const queue = serial()
  ctx.effect(() => ctx.remote.$on('game-audio/measure', function (request, next) {
    const sessionId = ctx.sessions.scopeOf(this)
    if (sessionId === undefined) return next()
    const { agent: _agent, signal, ...fields } = request
    const read = readOf(sessionId)
    return queue(() => answerMeasure(fields, read, signal ?? new AbortController().signal))
  }), 'ui-game-audio: measure sounds for agents')
  ctx.effect(() => ctx.remote.$on('game-audio/reveal', (reveal) => { revealSound(ctx, reveal) }), 'ui-game-audio: reveal sounds')
}

/** How often a reveal tries again while the Session's sidebar surface is not mounted yet, in milliseconds. */
const REVEAL_RETRY_MS = 50

/**
 * Open a sound in its Session's Audio tab: at once when the Session is on screen, or after the window shows it. The
 * sidebar reports a Session on screen in the render before its surface takes commands, so an open that finds no
 * surface tries again until {@link REVEAL_WAIT_MS} has passed.
 * @param ctx - the browser plugin context.
 * @param reveal - the Session and the sound.
 */
function revealSound(ctx: Context, reveal: AudioReveal): void {
  const sidebar = ctx.get('sidebarRight')
  if (sidebar === undefined) return
  const deadline = Date.now() + REVEAL_WAIT_MS
  const open = (): void => {
    if (sidebar.mounted.getSnapshot() !== reveal.sessionId) return
    try {
      sidebar.openTab(TAB_KIND, { params: { path: reveal.path } })
    } catch (error) {
      // Error: the Session's surface mounts in the render after it came on screen; another try follows shortly.
      if (Date.now() < deadline) setTimeout(open, REVEAL_RETRY_MS)
      else ctx.logger.warn('ui-game-audio: the Audio tab could not be opened for an agent', error)
    }
  }
  if (sidebar.mounted.getSnapshot() === reveal.sessionId) {
    open()
    return
  }
  const workspace = ctx.get('uiWorkspace')
  if (workspace === undefined) return
  const stop = sidebar.mounted.subscribe(() => {
    if (sidebar.mounted.getSnapshot() !== reveal.sessionId) return
    stop()
    clearTimeout(timer)
    open()
  })
  const timer = setTimeout(stop, REVEAL_WAIT_MS)
  workspace.openSession(reveal.sessionId)
}
