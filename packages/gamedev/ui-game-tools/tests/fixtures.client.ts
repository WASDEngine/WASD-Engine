/** Host answers the Game tools specs share: the three tool entries as the inventory and the plugin manager list them. */
import type {
  ChangeResult, PluginEntryId, PluginInfo, PluginInventorySnapshot, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

/** A Loader entry id. */
export function entryId(value: string): PluginEntryId {
  return brandString<PluginEntryId>(value)
}

/** The icon data URL the Host would send for Blender. */
export const BLENDER_ICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzYiIGhlaWdodD0iMzYiLz4='

/** The icon data URL the Host would send for GIMP. */
export const GIMP_ICON = 'data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMzYgMzYiLz4='

/** Blender as the plugin manager lists it: running, switchable through its patch row. */
export const BLENDER: PluginInfo = {
  entryId: entryId('blender'),
  moduleName: '@deepseek-ai/dsh-blender',
  enabled: true,
  fiberPhase: 'active',
  patchId: 'blender',
  meta: {
    title: { en: 'Blender', zh: 'Blender 建模' },
    description: { en: 'Build 3D models.', zh: '构建 3D 模型。' },
    icon: BLENDER_ICON,
  },
}

/** GIMP switched off in the profile patch. */
export const GIMP: PluginInfo = {
  entryId: entryId('gimp'),
  moduleName: '@deepseek-ai/dsh-gimp',
  enabled: false,
  fiberPhase: null,
  patchId: 'gimp',
  meta: { title: 'GIMP', description: 'Paint 2D art.', icon: GIMP_ICON },
}

/** Godot running, with a package that declares no icon. */
export const GODOT: PluginInfo = {
  entryId: entryId('godot'),
  moduleName: '@deepseek-ai/dsh-godot',
  enabled: true,
  fiberPhase: 'active',
  patchId: 'godot',
  meta: { title: 'Godot', description: 'Run Godot games.' },
}

/** An unrelated Loader entry both tabs leave out. */
export const OTHER: PluginInfo = {
  entryId: entryId('tool-web'),
  moduleName: '@deepseek-ai/dsh-tool-web',
  enabled: true,
  fiberPhase: 'active',
  patchId: 'tool-web',
}

/**
 * The inventory answer for these entries.
 * @param entries - the Loader entries.
 * @param managementAvailable - whether the Host manages a profile.
 * @returns the successful answer.
 */
export function inventory(
  entries: readonly PluginInfo[] = [OTHER, BLENDER, GIMP, GODOT],
  managementAvailable = true,
): RemoteResult<PluginInventorySnapshot> {
  return { ok: true, value: { managementAvailable, entries } }
}

/**
 * The plugin manager's answer for these entries.
 * @param entries - the Loader entries.
 * @returns the successful answer.
 */
export function plugins(entries: readonly PluginInfo[] = [OTHER, BLENDER, GIMP, GODOT]): RemoteResult<PluginInfo[]> {
  return { ok: true, value: [...entries] }
}

/**
 * A failed Remote answer.
 * @param denied - whether it is the owner-only refusal a Peer without access receives.
 * @returns the failed answer.
 */
export function failed<T>(denied = false): RemoteResult<T> {
  return {
    ok: false,
    error: denied
      ? new RemoteError('remote-access/denied', 'access denied', { action: 'pluginInventory/list', reason: 'no-allow' })
      : new RemoteError('gateway/internal', 'the Host is gone', {}),
  }
}

/**
 * A switch write's answer.
 * @param result - the fields that differ from an applied change.
 * @returns the successful answer.
 */
export function change(result: Partial<ChangeResult> = {}): RemoteResult<ChangeResult> {
  return { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'blender', ...result } }
}
