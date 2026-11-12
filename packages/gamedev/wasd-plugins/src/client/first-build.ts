/**
 * Data of the first build tip: the effort a Session's model runs at and whether it offers Max, whether a game
 * project's folder holds anything yet, and the project folders where the user dismissed the tip.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryListing, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The reasoning effort the tip suggests for a game's first build. */
export const FIRST_BUILD_EFFORT = 'max'

/** localStorage entry of the project folders where the user dismissed the tip. */
export const DISMISSED_STORAGE_KEY = 'wasd.firstBuildTip.dismissed'

/** Most dismissed project folders kept; older ones are forgotten first. */
export const DISMISSED_LIMIT = 200

/** Files that Windows leaves in folders, which a game project holds without anyone adding them. */
const SYSTEM_FILES: ReadonlySet<string> = new Set(['Thumbs.db', 'desktop.ini'])

/**
 * Whether a listed folder holds nothing yet: only hidden entries, such as the `.git` folder a new game project gets,
 * and system files.
 * @param listing - the folder's direct entries.
 * @returns false for a listing the entry cap cut.
 */
export function holdsNothing(listing: Pick<WorkspaceDirectoryListing, 'entries' | 'truncated'>): boolean {
  return !listing.truncated && listing.entries.every(entry => entry.name.startsWith('.') || SYSTEM_FILES.has(entry.name))
}

/** Effort facts of a Session's selected model. */
export interface FirstBuildEffort {
  /** Whether the model offers the Max effort. */
  readonly offersMax: boolean
  /** Whether the Session runs the model at Max, chosen or as the model's default. */
  readonly atMax: boolean
}

/**
 * Read the selected model's effort facts from a Session's model directory.
 * @param state - the Session's model directory snapshot.
 * @returns undefined while no model is selected, its catalog entry is not loaded, or the model has no efforts.
 */
export function firstBuildEffort(state: Pick<ModelDirectoryState, 'current' | 'groups'>): FirstBuildEffort | undefined {
  const current = state.current
  if (current === null) return undefined
  const reasoning = state.groups.find(group => group.id === current.provider)
    ?.models.find(model => model.id === current.model)?.reasoning
  if (reasoning === undefined) return undefined
  return {
    offersMax: reasoning.efforts.some(level => level.id === FIRST_BUILD_EFFORT),
    atMax: (current.reasoningEffort ?? reasoning.defaultEffort) === FIRST_BUILD_EFFORT,
  }
}

/** A reconnecting watch stream as the Client Remote's `$stream` supervises it. */
export interface FolderWatchStream<Item> extends AsyncIterable<{ readonly value: Item; accept(): void }> {
  /** End the stream and wait for its generation to close. */
  dispose(): Promise<void>
}

/** The slice of the Client Remote that {@link watchHoldsNothing} calls; `ClientRemote` satisfies it. */
export interface FolderWatchRemote {
  /**
   * Open a reconnecting stream.
   * @param options - diagnostic name, generation opener, and end classification.
   * @returns the single-consumer stream.
   */
  $stream<Item>(options: {
    readonly name: string
    readonly open: (signal: AbortSignal) => AsyncIterable<Item>
    readonly ended: (accepted: boolean) => Error
  }): FolderWatchStream<Item>
  readonly workspaceFiles: {
    /** List a folder's direct entries; the generated `workspaceFiles.list`. */
    readonly list: ClientRemote['workspaceFiles']['list']
    /**
     * Follow a folder's direct entries; the generated `workspaceFiles.changes`.
     * @param sessionId - the Session whose workspace holds the folder.
     * @param path - absolute folder path.
     * @param signal - ends the generation.
     * @returns readiness, then a frame per change.
     */
    readonly changes: (sessionId: SessionId, path: string, signal?: AbortSignal) => AsyncIterable<WorkspaceFileWatchFrame>
  }
}

/**
 * Follow whether a folder of a Session holds nothing yet. The folder is listed once its watch is ready and again
 * after each change of its direct entries. The watch ends at the first listing that finds something, since a game
 * project that holds files no longer needs the tip, and a listing that fails counts as finding something.
 * @param remote - the Client Remote.
 * @param sessionId - the Session whose workspace holds the folder.
 * @param directory - absolute folder path inside that workspace.
 * @param signal - ends the watch.
 * @returns true for each listing that finds nothing, then false once one finds something.
 */
export async function* watchHoldsNothing(
  remote: FolderWatchRemote,
  sessionId: SessionId,
  directory: string,
  signal: AbortSignal,
): AsyncGenerator<boolean, void, undefined> {
  // A function, so each read sees the signal's current state across the awaits below.
  const aborted = (): boolean => signal.aborted
  if (aborted()) return
  const stream = remote.$stream<WorkspaceFileWatchFrame>({
    name: `first build tip ${directory}`,
    open: lifetime => remote.workspaceFiles.changes(sessionId, directory, lifetime),
    ended: () => new Error(`Directory watch ended: ${directory}`),
  })
  const stop = (): void => { void stream.dispose() }
  signal.addEventListener('abort', stop, { once: true })
  try {
    for await (const item of stream) {
      if (aborted()) return
      if (item.value.kind === 'ready') item.accept()
      const listing = await remote.workspaceFiles.list(sessionId, directory, signal)
      if (aborted()) return
      const empty = listing.ok && holdsNothing(listing.value)
      yield empty
      if (!empty) return
    }
  } finally {
    signal.removeEventListener('abort', stop)
    await stream.dispose()
  }
}

/**
 * The project folders where the user dismissed the tip, kept in this browser's localStorage. A stored value that is
 * not a list of paths starts the list over.
 * @returns the store, most recent dismissal last.
 */
export function createDismissedProjects(): SnapshotStore<readonly string[]> {
  const store = createSnapshotStore<readonly string[]>([], { persist: { name: DISMISSED_STORAGE_KEY } })
  const stored: unknown = store.getSnapshot()
  if (!Array.isArray(stored) || !stored.every(path => typeof path === 'string')) store.set([])
  return store
}

/**
 * Remember that the user dismissed the tip in a project folder.
 * @param store - the dismissed project folders.
 * @param project - absolute path of the game project folder.
 */
export function dismissProject(store: SnapshotStore<readonly string[]>, project: string): void {
  const kept = store.getSnapshot().filter(path => path !== project)
  store.set([...kept, project].slice(-DISMISSED_LIMIT))
}
