/**
 * What the game project tabs of the right Sidebar share, the Assets tab and the Audio tab
 * (`@deepseek-ai/dsh-client-ui-game-audio`): the walk of a Session's project for the files a tab lists, one Session's
 * walk outside React, the Sessions' states, opening a tab for an agent, and reading the shown file again for each new
 * version. The module keeps no state of its own, so each tab's browser bundle inlines it.
 * @module @deepseek-ai/dsh-client-ui-game-assets/client/project-tab
 */
import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the sessions service, the `file` resource protocol and its value, the right Sidebar's navigation, and the
// workspace's Session navigation.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SidebarRightTabParamsFor } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * List one workspace folder.
 * @param path - workspace path of the folder; `.` names the project folder.
 * @param signal - cancellation.
 * @returns the listing, or the Remote failure.
 */
export type ListFolder = (path: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceDirectoryListing>>

/** Folder listings in flight at once. */
const LISTINGS_AT_ONCE = 6

/** Folder names the walk never enters, besides hidden folders. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules'])

/** Orders folder paths and file names the way people read them: case-insensitively, with numbers by value. */
export const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Whether the walk enters a folder.
 * @param name - the folder's name.
 * @returns false for a hidden folder, whose name starts with `.`, such as `.godot` and `.git`, and for `node_modules`.
 */
export function entersFolder(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_FOLDERS.has(name)
}

/**
 * Join a listed folder's workspace path and a child's name.
 * @param folder - the listed folder; empty for the project folder.
 * @param name - the child's name.
 * @returns the child's workspace path.
 */
export function childPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** Caps of one walk. */
export interface WalkLimits {
  /** Folders listed, the project folder included, before the walk stops. */
  readonly maxFolders: number
  /** Files collected before the walk stops. */
  readonly maxFiles: number
}

/** A file that a walk listed. */
export interface WalkedFile {
  /** Workspace path: relative to the project folder and `/`-separated. */
  readonly path: string
  /** File name. */
  readonly name: string
  /** Workspace path of the folder holding the file; empty for the project folder itself. */
  readonly folder: string
  /** File size in bytes, when the filesystem reports it. */
  readonly bytes?: number
}

/** What one walk collected. */
export interface ProjectWalk<T> {
  /** The collected files, in the order the walk listed them. */
  readonly files: readonly T[]
  /** A cap stopped the walk or cut a folder's listing, so files may be missing. */
  readonly truncated: boolean
  /** Folders below the project folder whose listing failed; their files are missing. */
  readonly unreadable: number
}

/**
 * Walk a Session's project breadth-first through the `workspaceFiles.list` Remote, six listings at a time, into the
 * folders that {@link entersFolder} enters, and offer each listed file to `pick`, which sees every
 * file, also once the file cap is reached. The walk stops listing at the folder and file caps. A folder reached a
 * second time, through a link to a folder already listed, is not listed again, because the Host reports a listed
 * folder by the path it resolves to, and a folder removed while the walk ran costs no files.
 * @param list - the Session's bound folder listing.
 * @param limits - the folder and file caps.
 * @param signal - cancellation; the walk stops listing and rejects with the signal's reason.
 * @param pick - what to collect of a file, or undefined to pass it over.
 * @returns what the walk collected, or the failure of the project folder's own listing.
 * @throws the reason of a listing that rejects, once the listings in flight settled.
 */
export async function walkWorkspace<T>(
  list: ListFolder,
  limits: WalkLimits,
  signal: AbortSignal,
  pick: (file: WalkedFile) => T | undefined,
): Promise<RemoteResult<ProjectWalk<T>>> {
  signal.throwIfAborted()
  const root = await list('.', signal)
  signal.throwIfAborted()
  if (!root.ok) return root
  const files: T[] = []
  const visited = new Set<string>([root.value.path])
  const queue: string[] = []
  let truncated = false
  let unreadable = 0
  let listed = 1
  const take = (listing: WorkspaceDirectoryListing): void => {
    if (listing.truncated) truncated = true
    for (const entry of listing.entries) {
      const path = childPath(listing.path, entry.name)
      if (entry.type === 'directory') {
        if (entersFolder(entry.name)) queue.push(path)
        continue
      }
      if (entry.type !== 'file') continue
      const picked = pick({ path, name: entry.name, folder: listing.path, ...entry.size === undefined ? {} : { bytes: entry.size } })
      if (picked === undefined) continue
      if (files.length >= limits.maxFiles) {
        truncated = true
        continue
      }
      files.push(picked)
    }
  }
  take(root.value)
  const settle = (result: RemoteResult<WorkspaceDirectoryListing>): void => {
    if (!result.ok) {
      // A folder removed while the walk ran has no files left to miss.
      if (result.error.code !== 'workspace-file/not-found') unreadable += 1
      return
    }
    if (visited.has(result.value.path)) return
    visited.add(result.value.path)
    take(result.value)
  }
  // A listing that rejects ends the walk with its reason, once the listings in flight settled.
  const outcome = await new Promise<{ readonly kind: 'done' } | { readonly kind: 'rejected'; readonly reason: unknown }>((resolve) => {
    let active = 0
    let rejection: { readonly reason: unknown } | undefined
    // Starts listings up to the limit while folders wait and no cap is reached; resolves once none is in flight.
    const pump = (): void => {
      while (active < LISTINGS_AT_ONCE && queue.length > 0 && rejection === undefined && !signal.aborted) {
        if (files.length >= limits.maxFiles || listed >= limits.maxFolders) {
          truncated = true
          break
        }
        const path = queue.shift() as string
        listed += 1
        active += 1
        list(path, signal).then((result) => {
          active -= 1
          if (rejection === undefined && !signal.aborted) settle(result)
          pump()
        }, (reason: unknown) => {
          active -= 1
          rejection ??= { reason }
          pump()
        })
      }
      if (active === 0) resolve(rejection === undefined ? { kind: 'done' } : { kind: 'rejected', reason: rejection.reason })
    }
    pump()
  })
  signal.throwIfAborted()
  if (outcome.kind === 'rejected') throw outcome.reason
  return { ok: true, value: { files, truncated, unreadable } }
}

/** Where a tab's walk of its project stands. */
export interface ProjectScanState<Scan> {
  /** `idle` before the first walk; `scanning` while one runs; then whether the latest one succeeded. */
  readonly status: 'idle' | 'scanning' | 'ready' | 'failed'
  /** The latest successful walk, kept while a later one runs or after it fails. */
  readonly scan?: Scan
  /** The latest walk's failure; cleared by the next successful walk. */
  readonly failure?: RemoteFailure
  /** When the latest walk settled, in milliseconds since the epoch. */
  readonly settledAt?: number
}

/**
 * Walk freshness a tab accepts when it shows again, in milliseconds; a project whose walk takes longer is walked again
 * only after ten times its last walk's duration, so a large project is not walked on every open.
 */
export const FRESH_SCAN_MS = 2000

/** How many times its own duration a walk stays fresh. */
const FRESH_SCAN_FACTOR = 10

/**
 * How long a walk stays fresh.
 * @param durationMs - how long the walk took, in milliseconds.
 * @returns {@link FRESH_SCAN_MS}, or ten times the walk's duration when that is longer.
 */
export function freshScanMs(durationMs: number): number {
  return Math.max(FRESH_SCAN_MS, durationMs * FRESH_SCAN_FACTOR)
}

/**
 * One Session's walk of its project for a tab, outside React: the latest walk, kept on screen while a later one runs
 * and after it fails, and the navigation each tab took last. A second request while a walk runs is dropped, because the
 * running walk reads the same folders. A subclass keeps the reader's choices, and `scanned` hears of each successful
 * walk once it is published.
 */
export class ProjectSource<Scan> {
  private running: AbortController | undefined
  private stopped = false
  /** How long the latest settled walk took, in milliseconds. */
  private lastDuration = 0
  /** The navigation revision each tab took last. */
  private readonly navigations = new Map<string, number>()

  /**
   * @param scanState - the walk's store, `idle` until the first walk, which the subclass makes with its tab's store
   * library.
   * @param walkProject - walks the project: it settles with the walk or the project folder's own Remote failure, and
   * rejects with its signal's reason or for a fault.
   * @param now - the clock, in milliseconds since the epoch.
   * @param report - receives a walk that threw instead of returning a Remote failure.
   */
  constructor(
    /** The walk. */
    readonly scanState: SnapshotStore<ProjectScanState<Scan>>,
    private readonly walkProject: (signal: AbortSignal) => Promise<RemoteResult<Scan>>,
    protected readonly now: () => number,
    protected readonly report: (error: unknown) => void,
  ) {}

  /** Walk the project unless a walk runs or the source is closed. */
  rescan(): void {
    if (this.stopped || this.running !== undefined) return
    const walk = new AbortController()
    this.running = walk
    this.scanState.set({ ...this.scanState.getSnapshot(), status: 'scanning' })
    void this.walk(walk.signal).finally(() => {
      if (this.running === walk) this.running = undefined
    })
  }

  /** Walk unless the latest walk is fresh, by {@link FRESH_SCAN_MS} or ten times its duration, or one runs. */
  refresh(): void {
    const settledAt = this.scanState.getSnapshot().settledAt
    if (settledAt !== undefined && this.now() - settledAt < freshScanMs(this.lastDuration)) return
    this.rescan()
  }

  /**
   * Note that a tab acts on one of its navigations.
   * @param tabId - the tab.
   * @param revision - the navigation's revision; 0 names no navigation.
   * @returns true the first time the tab reaches this revision, so each navigation applies once however often its
   * body mounts.
   */
  takeNavigation(tabId: string, revision: number): boolean {
    if (revision === 0 || this.navigations.get(tabId) === revision) return false
    this.navigations.set(tabId, revision)
    return true
  }

  /** Stop the running walk; later requests do nothing. */
  close(): void {
    this.stopped = true
    this.running?.abort()
    this.running = undefined
  }

  /**
   * Hear of a successful walk once the source published it.
   * @param scan - the walk.
   */
  protected scanned?(scan: Scan): void

  /** Run one walk and publish its outcome unless it was stopped. */
  private async walk(signal: AbortSignal): Promise<void> {
    const began = this.now()
    let next: ProjectScanState<Scan>
    try {
      const outcome = await this.walkProject(signal)
      next = outcome.ok
        ? { status: 'ready', scan: outcome.value, settledAt: this.now() }
        : { status: 'failed', ...this.kept(), failure: outcome.error, settledAt: this.now() }
    } catch (error) {
      if (signal.aborted) return
      this.report(error)
      next = { status: 'failed', ...this.kept(), settledAt: this.now() }
    }
    if (signal.aborted) return
    this.lastDuration = this.now() - began
    this.scanState.set(next)
    if (next.status === 'ready' && next.scan !== undefined) this.scanned?.(next.scan)
  }

  private kept(): Pick<ProjectScanState<Scan>, 'scan'> {
    const scan = this.scanState.getSnapshot().scan
    return scan === undefined ? {} : { scan }
  }
}

/**
 * Keep one state per Session for a plugin: made on first use, and closed and forgotten when the Session's scope ends or
 * the plugin is disposed.
 * @param ctx - the browser plugin context.
 * @param label - the plugin's name in effect labels and errors, such as `ui-game-assets`.
 * @param make - makes a Session's state.
 * @returns the state of a Session, which the window must retain.
 * @throws {Error} when the window does not retain the Session.
 */
export function sessionStates<S extends { close(): void }>(
  ctx: Context, label: string, make: (sessionId: SessionId) => S,
): (sessionId: SessionId) => S {
  // Each Session's state with the release of its Session-scope effect; both end with the Session or the plugin.
  const states = new Map<SessionId, { readonly state: S; readonly release: () => void }>()
  ctx.effect(() => () => {
    for (const { release } of [...states.values()]) release()
    states.clear()
  }, `${label}: Session state`)
  return (sessionId) => {
    const known = states.get(sessionId)
    if (known !== undefined) return known.state
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`${label}: Session ${sessionId} is not retained`)
    const state = make(sessionId)
    const dispose = binding.ctx.effect(() => () => {
      state.close()
      if (states.get(sessionId)?.state === state) states.delete(sessionId)
    }, `${label}: release Session state`)
    states.set(sessionId, { state, release: () => { void dispose() } })
    return state
  }
}

/** How long a reveal waits for its Session to come on screen, in milliseconds. */
export const REVEAL_WAIT_MS = 10_000

/** How often a reveal tries again while the Session's sidebar surface is not mounted yet, in milliseconds. */
const REVEAL_RETRY_MS = 50

/**
 * Open a page of the right Sidebar in a Session for an agent: at once when the Session is on screen, or after the
 * window shows it. The sidebar reports a Session on screen in the render before its surface takes commands, so an open
 * that finds no surface tries again until {@link REVEAL_WAIT_MS} has passed.
 * @param ctx - the browser plugin context.
 * @param sessionId - the Session.
 * @param kind - the page type.
 * @param params - the page's navigation parameters.
 * @param failure - the warning logged when the page could not be opened in time.
 * @returns a function that stops the reveal if it has not opened the page yet.
 */
export function revealTab<K extends string>(
  ctx: Context,
  sessionId: SessionId,
  kind: K,
  params: SidebarRightTabParamsFor<K>,
  failure: string,
): () => void {
  const sidebar = ctx.get('sidebarRight')
  if (sidebar === undefined) return () => {}
  const deadline = Date.now() + REVEAL_WAIT_MS
  let retry: ReturnType<typeof setTimeout> | undefined
  const open = (): void => {
    retry = undefined
    if (sidebar.mounted.getSnapshot() !== sessionId) return
    try {
      sidebar.openTab(kind, { params })
    } catch (error) {
      // Error: the Session's surface mounts in the render after it came on screen; another try follows shortly.
      if (Date.now() < deadline) retry = setTimeout(open, REVEAL_RETRY_MS)
      else ctx.logger.warn(failure, error)
    }
  }
  if (sidebar.mounted.getSnapshot() === sessionId) {
    open()
    return () => { clearTimeout(retry) }
  }
  const workspace = ctx.get('uiWorkspace')
  if (workspace === undefined) return () => {}
  const stop = sidebar.mounted.subscribe(() => {
    if (sidebar.mounted.getSnapshot() !== sessionId) return
    stop()
    clearTimeout(timer)
    open()
  })
  const timer = setTimeout(stop, REVEAL_WAIT_MS)
  workspace.openSession(sessionId)
  return () => {
    stop()
    clearTimeout(timer)
    clearTimeout(retry)
  }
}

/** What the shown file's reads show: `loading` until a read settles, then what the latest read settled with. */
export type VersionedLoad<Settled> = { readonly kind: 'loading' } | Settled

/** The shown file's reads. */
export interface VersionedRead<Settled> {
  /** The latest read; a `ready` one stays while a newer version is read. */
  readonly load: VersionedLoad<Settled>
  /** Whether the file is gone from the project; no read looks for it then. */
  readonly gone: boolean
  /** Read the file again. */
  readonly retry: () => void
}

/**
 * Read the shown file once its `file` resource reported its first frame, so opening a file reads it once, not before
 * and after its version arrives; read it again for each new version and after `retry`, and not while the file is gone.
 * A newer version replaces a `ready` read once its own read settled; until then the shown one stays.
 * @param useResource - the tab's resource hook.
 * @param address - the file's resource address.
 * @param read - reads the file and settles with what to show; it does not reject.
 * @param versionOf - the version of a settled read, which is not read again while the resource reports it; undefined
 * for a read to try again on the next frame, such as a failure.
 * @param inputs - the values besides the file's version that `read` depends on, such as its path; a change reads again.
 * @returns the latest read, whether the file is gone, and the retry.
 */
export function useVersionedRead<Settled extends { readonly kind: string }>(
  useResource: UseResource,
  address: string,
  read: (signal: AbortSignal) => Promise<Settled>,
  versionOf: (settled: Settled) => string | undefined,
  inputs: readonly unknown[],
): VersionedRead<Settled> {
  const resource = useResource<'file'>(address)
  const version = resource.status === 'live' ? resource.value?.version : undefined
  const waiting = resource.status === 'loading'
  const gone = resource.status === 'failed' && resource.failure?.code === 'workspace-file/not-found'
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<VersionedLoad<Settled>>({ kind: 'loading' })
  const shown = useRef<{ readonly version: string; readonly attempt: number }>()
  useEffect(() => {
    if (waiting || gone) return
    const known = shown.current
    if (known !== undefined && known.attempt === attempt && (version === undefined || known.version === version)) return
    const controller = new AbortController()
    setLoad(current => current.kind === 'ready' ? current : { kind: 'loading' })
    void read(controller.signal).then((settled) => {
      if (controller.signal.aborted) return
      const settledVersion = versionOf(settled)
      shown.current = settledVersion === undefined ? undefined : { version: settledVersion, attempt }
      setLoad(settled)
    })
    return () => { controller.abort() }
  }, [version, waiting, gone, attempt, ...inputs])
  return { load, gone, retry: () => { setAttempt(count => count + 1) } }
}
