/** The game tools both tabs list, picked out of the Host's Loader entries, and how one reads in the current locale. */
import type { PluginInventorySnapshot, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: declares the `remote-access/denied` failure code a Peer without access receives.
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** One Loader entry of the Host's plugin inventory. */
export type GameToolEntry = PluginInventorySnapshot['entries'][number]

/** Packages the game tool rows mount, in the order both tabs list them. */
export const GAME_TOOL_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-blender', '@deepseek-ai/dsh-gimp', '@deepseek-ai/dsh-godot', '@deepseek-ai/dsh-polyhaven',
  '@deepseek-ai/dsh-supercollider',
]

/** One game tool: the package its row mounts and the Loader entry mounting it in this profile. */
export interface GameToolSlot<Entry extends GameToolEntry = GameToolEntry> {
  readonly moduleName: string
  /** The first Loader entry that mounts the package; undefined when this profile mounts none. */
  readonly entry: Entry | undefined
}

/** Why a read failed: `denied` when the current Peer may not read the plugin list, `failed` otherwise. */
export type ReadFailure = 'denied' | 'failed'

/**
 * Pick the game tools out of the Host's Loader entries.
 * @param entries - Loader entries as the Host lists them.
 * @returns one slot per game tool in display order, whether or not this profile mounts it.
 */
export function gameToolSlots<Entry extends GameToolEntry>(entries: readonly Entry[]): GameToolSlot<Entry>[] {
  return GAME_TOOL_MODULES.map(moduleName => ({ moduleName, entry: entries.find(entry => entry.moduleName === moduleName) }))
}

/**
 * Classify a failed Remote read.
 * @param error - the Remote failure.
 * @returns `denied` for the refusal a Peer without owner access receives, `failed` for any other failure.
 */
export function readFailure(error: RemoteFailure): ReadFailure {
  return error.code === 'remote-access/denied' ? 'denied' : 'failed'
}

/**
 * Resolve a tool's package text in the current locale.
 * @param slot - the tool and its entry.
 * @param resolveText - current-locale package text resolver.
 * @returns the package title, or the package name without one, and the description when the package has one.
 */
export function toolText(
  slot: GameToolSlot,
  resolveText: (text: LocalizedText) => string,
): { readonly title: string; readonly description: string | undefined } {
  const { title, description } = slot.entry?.meta ?? {}
  const shown = description === undefined ? '' : resolveText(description)
  return { title: title === undefined ? slot.moduleName : resolveText(title), description: shown === '' ? undefined : shown }
}
