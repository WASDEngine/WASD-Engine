/**
 * A game project's record of the add-ons installed through WASD Engine: `.wasdengine/addons.json` in the folder that
 * holds `project.godot`, beside the `game.json` of WASD Engine Plugins. The record names what an installation created,
 * and a removal takes out those paths when they lie in the add-on's own folder. The project can carry a record that
 * someone else wrote, so a path counts only when it is relative, with `/` separators, and names nothing another
 * platform reads as a separator or a drive. Writers hold the record's file lock and replace the file atomically.
 * @module @deepseek-ai/dsh-game-addons/src/record
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { ADDON_ID_PATTERN } from './catalog.ts'
import { isProjectPath, projectFolder } from './paths.ts'
import type { InstalledGameAddon } from './types.ts'

/** Folder of WASD Engine's per-project state, relative to the project folder. */
export const STATE_DIR = '.wasdengine'

/** File name of the record inside {@link STATE_DIR}. */
export const RECORD_FILE = 'addons.json'

/** Version of the record's format. */
export const RECORD_FORMAT = 1

/** How long a writer waits for another writer of the same record. */
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

/** A record file that cannot be read as this format. */
export class GameAddonRecordError extends Error {
  override name = 'GameAddonRecordError'
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
 * Read a project's record.
 * @param projectDir - absolute project folder.
 * @returns the installed add-ons in record order; empty when the project has no record.
 * @throws {GameAddonRecordError} when the file exists but is not a valid record.
 */
export async function readRecord(projectDir: string): Promise<InstalledGameAddon[]> {
  const path = recordPath(projectDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new GameAddonRecordError(`Cannot read ${path}: ${(error as Error).message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new GameAddonRecordError(`${path} is not valid JSON (${(error as Error).message}); fix or delete it.`)
  }
  const parsed = RecordFile.safeParse(json)
  if (!parsed.success) throw new GameAddonRecordError(`${path} is not a valid add-on record; fix or delete it. ${z.prettifyError(parsed.error)}`)
  return parsed.data.addons
}

/**
 * Change a project's record under its file lock.
 * @param projectDir - absolute project folder.
 * @param change - receives the current entries and returns the next ones, or undefined to leave the file unchanged.
 * @param signal - cancellation of the lock wait.
 * @returns the entries after the change.
 * @throws {GameAddonRecordError} when the current file is not a valid record.
 * @throws {GameAddonPathError} when the project's `.wasdengine` folder leads outside the project.
 */
export async function updateRecord(
  projectDir: string,
  change: (current: readonly InstalledGameAddon[]) => readonly InstalledGameAddon[] | undefined,
  signal: AbortSignal,
): Promise<readonly InstalledGameAddon[]> {
  const path = join(await projectFolder(projectDir, STATE_DIR), RECORD_FILE)
  return await withFileLock(path, async () => {
    const current = await readRecord(projectDir)
    const next = change(current)
    if (next === undefined) return current
    const sorted = [...next].sort((a, b) => a.id.localeCompare(b.id, 'en'))
    await writeFileAtomic(path, `${JSON.stringify({ format: RECORD_FORMAT, addons: sorted }, null, 2)}\n`, { mode: 0o644 })
    return sorted
  }, { signal, waitMs: LOCK_WAIT_MS })
}
