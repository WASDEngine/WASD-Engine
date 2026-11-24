/**
 * A game project's record of the add-ons installed through WASD Engine: `.wasdengine/addons.json` in the folder that
 * holds `project.godot`, beside the `game.json` of WASD Engine Plugins. The record names what an installation created,
 * and a removal takes out those paths when they lie in the add-on's own folder. The project can carry a record that
 * someone else wrote, so a path counts only when it is relative, with `/` separators, and names nothing another
 * platform reads as a separator or a drive. Writers hold the record's file lock and replace the file atomically; an
 * installation or removal holds the lock while it changes the project's files, so the changes of one project never
 * interleave, in this process or another. Beside the record, `.wasdengine/addon-settings.json` keeps the value each
 * project setting held before an add-on's installation changed it, so that its removal can give the value back; it is a
 * file of its own because the record's format admits no new fields, which the readers of earlier versions would refuse.
 * @module @deepseek-ai/dsh-game-addons/src/record
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { ADDON_ID_PATTERN } from './catalog.ts'
import { GameAddonError } from './errors.ts'
import { isProjectPath, projectFolder } from './paths.ts'
import type { InstalledGameAddon } from './types.ts'

/** Folder of WASD Engine's per-project state, relative to the project folder. */
export const STATE_DIR = '.wasdengine'

/** File name of the record inside {@link STATE_DIR}. */
export const RECORD_FILE = 'addons.json'

/** Version of the record's format. */
export const RECORD_FORMAT = 1

/** File name, inside {@link STATE_DIR}, of the project settings that installations changed and their values before. */
export const SETTINGS_FILE = 'addon-settings.json'

/** One project setting an add-on's installation changed, and the value it held before. */
export interface SettingBefore {
  /** Section of `project.godot`. */
  readonly section: string
  /** Key within the section. */
  readonly key: string
  /** The value's text before the add-on's first installation; absent when the project had no such key. */
  readonly before?: string
}

/** How long a writer waits for another writer of the same record, whose change moves folders and rewrites small files. */
const LOCK_WAIT_MS = 10_000

const ProjectPath = z.string().min(1).refine(isProjectPath, 'must be a relative path inside the project, with / separators')

const Installed = z.strictObject({
  id: z.string().regex(ADDON_ID_PATTERN),
  title: z.string().min(1),
  host: z.enum(['godot', 'blender']),
  version: z.string().min(1),
  license: z.string().min(1),
  source: z.string().min(1).exactOptional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u).exactOptional(),
  paths: z.array(ProjectPath),
  installedAt: z.string().min(1),
})

const RecordFile = z.strictObject({
  format: z.literal(RECORD_FORMAT),
  addons: z.array(Installed),
})

// Fields a later version adds are passed over, so that this file never makes an earlier reader refuse the project.
const SettingsFile = z.object({
  format: z.literal(1),
  addons: z.record(
    z.string().regex(ADDON_ID_PATTERN),
    z.array(z.object({ section: z.string(), key: z.string(), before: z.string().exactOptional() })),
  ),
})

/** A record or settings file that cannot be read (`GAME_ADDON_RECORD_UNREADABLE`) or is not valid (`GAME_ADDON_RECORD_CORRUPT`). */
export class GameAddonRecordError extends GameAddonError {
  /**
   * @param message - the file and what to do about it.
   * @param code - the failure's code.
   * @param options - the failure's cause.
   */
  constructor(message: string, code: 'GAME_ADDON_RECORD_UNREADABLE' | 'GAME_ADDON_RECORD_CORRUPT', options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'GameAddonRecordError'
  }
}

/**
 * The record's path in a project.
 * @param projectDir - absolute project folder.
 * @returns the absolute path of `.wasdengine/addons.json`.
 */
export function recordPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, RECORD_FILE)
}

/**
 * The JSON value of a file of the project's state folder, such as the record.
 * @param path - absolute path of the file.
 * @returns the value, or undefined when the file does not exist.
 * @throws {GameAddonRecordError} `GAME_ADDON_RECORD_UNREADABLE` when the file cannot be read, and
 *   `GAME_ADDON_RECORD_CORRUPT` when it is not JSON.
 */
async function readStateJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new GameAddonRecordError(`Cannot read ${path}: ${(error as Error).message}`, 'GAME_ADDON_RECORD_UNREADABLE', { cause: error })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new GameAddonRecordError(`${path} is not valid JSON (${(error as Error).message}); fix or delete it.`, 'GAME_ADDON_RECORD_CORRUPT', { cause: error })
  }
  return json
}

/**
 * Read a project's record.
 * @param projectDir - absolute project folder.
 * @returns the installed add-ons in record order; empty when the project has no record.
 * @throws {GameAddonRecordError} when the file exists but is not a valid record.
 */
export async function readRecord(projectDir: string): Promise<InstalledGameAddon[]> {
  const path = recordPath(projectDir)
  const json = await readStateJson(path)
  if (json === undefined) return []
  const parsed = RecordFile.safeParse(json)
  if (!parsed.success) throw new GameAddonRecordError(`${path} is not a valid add-on record; fix or delete it. ${z.prettifyError(parsed.error)}`, 'GAME_ADDON_RECORD_CORRUPT')
  return parsed.data.addons
}

/**
 * Read the settings that a project's installations changed.
 * @param projectDir - absolute project folder.
 * @returns each add-on's changed settings by id; empty when the project has no such file.
 * @throws {GameAddonRecordError} when the file exists but is not valid.
 */
async function readSettings(projectDir: string): Promise<Map<string, readonly SettingBefore[]>> {
  const path = join(projectDir, STATE_DIR, SETTINGS_FILE)
  const json = await readStateJson(path)
  if (json === undefined) return new Map()
  const parsed = SettingsFile.safeParse(json)
  if (!parsed.success) throw new GameAddonRecordError(`${path} is not a valid list of add-on settings; fix or delete it. ${z.prettifyError(parsed.error)}`, 'GAME_ADDON_RECORD_CORRUPT')
  return new Map(Object.entries(parsed.data.addons))
}

/** A project's record while its writer lock is held. */
export interface HeldRecord {
  /** The installed add-ons as the record held them when the lock was taken. */
  readonly entries: readonly InstalledGameAddon[]
  /** The project settings each installed add-on changed, by add-on id, with the values they held before. */
  readonly settings: ReadonlyMap<string, readonly SettingBefore[]>
  /**
   * Replace the record's entries atomically.
   * @param next - the installed add-ons, in any order; the file lists them by id.
   */
  write(next: readonly InstalledGameAddon[]): Promise<void>
  /**
   * Replace the changed settings atomically; without any, the file goes.
   * @param next - each add-on's changed settings by id.
   */
  writeSettings(next: ReadonlyMap<string, readonly SettingBefore[]>): Promise<void>
}

/**
 * Hold a project's record lock around one change of the project: the change reads the entries, changes the project's
 * files, and writes the record as its last step.
 * @param projectDir - absolute project folder.
 * @param change - the change; it runs to its end once the lock is held, and undoes its own steps when one fails.
 * @param signal - cancellation of the lock wait, before the change starts.
 * @returns the change's result.
 * @throws {GameAddonRecordError} when the current file is not a valid record; the change does not run then.
 * @throws {GameAddonPathError} when the project's `.wasdengine` folder leads outside the project.
 */
export async function lockRecord<T>(projectDir: string, change: (record: HeldRecord) => Promise<T>, signal: AbortSignal): Promise<T> {
  const folder = await projectFolder(projectDir, STATE_DIR)
  const path = join(folder, RECORD_FILE)
  return await withFileLock(path, async () => await change({
    entries: await readRecord(projectDir),
    settings: await readSettings(projectDir),
    write: async (next) => {
      const sorted = [...next].sort((a, b) => a.id.localeCompare(b.id, 'en'))
      await writeFileAtomic(path, `${JSON.stringify({ format: RECORD_FORMAT, addons: sorted }, null, 2)}\n`, { mode: 0o644 })
    },
    writeSettings: async (next) => {
      const settingsPath = join(folder, SETTINGS_FILE)
      if (next.size === 0) {
        await rm(settingsPath, { force: true })
        return
      }
      const addons = Object.fromEntries([...next].sort(([a], [b]) => a.localeCompare(b, 'en')))
      await writeFileAtomic(settingsPath, `${JSON.stringify({ format: 1, addons }, null, 2)}\n`, { mode: 0o644 })
    },
  }), { signal, waitMs: LOCK_WAIT_MS })
}
