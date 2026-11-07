/**
 * The Plugins page tab's state: the game tools joined with how the Host lets the tab switch them, the switch writes in
 * flight, and what the last write left to say. Nothing is read before the tab first renders; after that, each mount of
 * the tab, every Host change, and every reconnection reads again, so a change made on the Plugins page, in another
 * client, or in the profile patch by hand shows here too.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ChangeResult, ManagementError, PluginEntryId, PluginInfo, ReadOnlyReason, RemoteResult, RestartReason,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { GameToolsNoticeToastInjected } from './GameToolsNoticeToast.tsx'
import type { PluginsGameToolsTabInjected } from './PluginsGameToolsTab.tsx'
import { gameToolSlots, readFailure, type GameToolSlot, type ReadFailure } from './tools.ts'

/** How the tab may switch one tool: through the profile patch, or not at all, for the Host's reason. */
export type ToolControl =
  | { readonly kind: 'switch' }
  | { readonly kind: 'locked'; readonly reason: ReadOnlyReason }

/** One game tool on the Plugins page. */
export interface ManagedGameTool extends GameToolSlot {
  /** Absent while the Host manages no profile, and for a tool this profile does not mount. */
  readonly control?: ToolControl
}

/** What the latest successful read found. */
export interface GameToolsSnapshot {
  /** Whether the Host manages a profile, so that the tools can be switched. */
  readonly managed: boolean
  readonly tools: readonly ManagedGameTool[]
}

/** What a switch write left to say beyond applying: it waits for a restart, a higher layer overrides it, or it failed. */
export type GameToolOutcome =
  | { readonly kind: 'restart'; readonly reason: RestartReason | undefined }
  | { readonly kind: 'overridden' }
  | {
    readonly kind: 'failed'
    /** The Host's refusal code; absent when the Remote call itself failed. */
    readonly code: ManagementError['code'] | undefined
    /** The Host's diagnostic or the Remote failure's message, shown verbatim; empty when neither says more. */
    readonly message: string
  }

/** One outcome as the toast shows it once: the tool, the direction it was switched, and `seq` telling one showing from the next. */
export type GameToolNotice = GameToolOutcome & {
  readonly tool: ManagedGameTool
  readonly enabled: boolean
  readonly seq: number
}

/** State of the Plugins page tab and its notice toast. */
export interface GameToolsState {
  /** The latest successful read; null before one. */
  readonly snapshot: GameToolsSnapshot | null
  /** Why the latest read failed; null while a read runs and after one succeeds. */
  readonly failure: ReadFailure | null
  /** Entries whose switch write runs. */
  readonly busy: readonly PluginEntryId[]
  /** The outcome the toast shows until it fades or the next write starts. */
  readonly notice: GameToolNotice | null
}

type ReadOutcome =
  | { readonly ok: true; readonly snapshot: GameToolsSnapshot }
  | { readonly ok: false; readonly failure: ReadFailure }

const INITIAL: GameToolsState = { snapshot: null, failure: null, busy: [], notice: null }

function managedTool(slot: GameToolSlot<PluginInfo>): ManagedGameTool {
  const { entry } = slot
  if (entry === undefined) return slot
  return { ...slot, control: entry.readOnlyReason === undefined ? { kind: 'switch' } : { kind: 'locked', reason: entry.readOnlyReason } }
}

function changeOutcome(answer: RemoteResult<ChangeResult>): GameToolOutcome | null {
  if (!answer.ok) return { kind: 'failed', code: undefined, message: answer.error.message }
  const result = answer.value
  switch (result.application) {
    // The Host cancels installations only; a cancelled switch would have changed nothing.
    case 'applied':
    case 'cancelled':
      return null
    case 'restart-required':
      return { kind: 'restart', reason: result.restartReason }
    case 'overridden':
      return { kind: 'overridden' }
    case 'failed':
      return { kind: 'failed', code: result.error?.code, message: result.error?.diagnostic ?? '' }
    /* v8 ignore next -- ChangeResult declares exactly these applications. */
    default: return assertNever(result.application, 'ChangeResult.application')
  }
}

/** What a rejected switch write said, as the plugin manager's own switches report it. */
function faultMessage(fault: unknown): string {
  return fault instanceof Error ? fault.message : String(fault)
}

/** Owns the Plugins page tab's reads and switch writes for one Client. */
export class GameToolsController {
  /** The tab state, bound by the tab and the notice toast as `useGameTools`. */
  readonly store: SnapshotStore<GameToolsState> = createSnapshotStore<GameToolsState>(INITIAL)
  private started = false
  private disposed = false
  /** Numbers the reads; an answer to an older read than the latest is dropped. */
  private reads = 0
  private notices = 0

  /** @param ctx - the plugin scope whose `remote.pluginInventory` and `remote.pluginManager` namespaces answer. */
  constructor(private readonly ctx: ClientContext) {}

  /** Stop publishing answers that arrive later. */
  dispose(): void {
    this.disposed = true
  }

  /** Read again after a Host change or a reconnection; a tab that never rendered stays unread. */
  changed(): void {
    if (this.started) void this.load()
  }

  /**
   * Build the tab's injected face.
   * @param resolveText - current-locale package text resolver.
   * @returns the tab's state source and actions.
   */
  face(resolveText: (text: LocalizedText) => string): PluginsGameToolsTabInjected {
    return {
      hooks: { gameTools: this.store },
      resolveText,
      load: () => {
        this.started = true
        void this.load()
      },
      setEnabled: (entryId, enabled) => { void this.toggle(entryId, enabled) },
    }
  }

  /**
   * Build the notice toast's injected face.
   * @param resolveText - current-locale package text resolver.
   * @returns the state source whose notice the toast shows, and its dismissal.
   */
  noticeFace(resolveText: (text: LocalizedText) => string): GameToolsNoticeToastInjected {
    return {
      hooks: { gameTools: this.store },
      resolveText,
      dismissNotice: () => { this.patch({ notice: null }) },
    }
  }

  private async load(): Promise<void> {
    const read = ++this.reads
    if (this.state().failure !== null) this.patch({ failure: null })
    // A Remote call rejects only on an assembly fault, which the tab reports as a failed read.
    const outcome = await this.read().catch((_assemblyFault: unknown): ReadOutcome => ({ ok: false, failure: 'failed' }))
    if (read !== this.reads) return
    this.patch(outcome.ok ? { snapshot: outcome.snapshot, failure: null } : { failure: outcome.failure })
  }

  private async read(): Promise<ReadOutcome> {
    // The manager Remote is mounted whether or not the Host manages a profile; the inventory says whether it does.
    const inventory = await this.ctx.remote.pluginInventory.list()
    if (!inventory.ok) return { ok: false, failure: readFailure(inventory.error) }
    if (inventory.value.managementAvailable !== true) {
      return { ok: true, snapshot: { managed: false, tools: gameToolSlots(inventory.value.entries) } }
    }
    const plugins = await this.ctx.remote.pluginManager.listPlugins()
    if (!plugins.ok) return { ok: false, failure: readFailure(plugins.error) }
    return { ok: true, snapshot: { managed: true, tools: gameToolSlots(plugins.value).map(managedTool) } }
  }

  private async toggle(entryId: PluginEntryId, enabled: boolean): Promise<void> {
    const { snapshot, busy } = this.state()
    const tool = snapshot?.tools.find(item => item.entry?.entryId === entryId)
    if (tool === undefined || busy.includes(entryId)) return
    this.patch({ busy: [...busy, entryId], notice: null })
    const outcome = await this.ctx.remote.pluginManager.setPluginEnabled(entryId, enabled).then(
      changeOutcome,
      // An assembly fault leaves the write's effect unknown, so the tab reports the switch as failed and reads again.
      (fault: unknown): GameToolOutcome => ({ kind: 'failed', code: undefined, message: faultMessage(fault) }),
    )
    this.patch({
      busy: this.state().busy.filter(id => id !== entryId),
      // A write that applied leaves in place the notice that another tool's write published meanwhile.
      ...outcome === null ? {} : { notice: { ...outcome, tool, enabled, seq: ++this.notices } },
    })
    await this.load()
  }

  private state(): GameToolsState {
    return this.store.getSnapshot()
  }

  private patch(next: Partial<GameToolsState>): void {
    if (this.disposed) return
    this.store.set({ ...this.state(), ...next })
  }
}
