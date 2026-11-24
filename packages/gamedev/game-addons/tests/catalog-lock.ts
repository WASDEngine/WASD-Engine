/**
 * The lock of the shipped catalog's Godot entries, `catalog.lock.json` beside this file: the WASD Engine release it
 * records, and each Godot entry's version in that release with a SHA-256 of what an installation of that version puts
 * into a project. The hash covers every part of the entry that reaches the project: its `archive` and `godot` fields,
 * the fields that its section of `THIRD_PARTY_NOTICES.md` shows (`title`, `license`, `copyright`, `homepage`, and
 * `credit`), and the paths and bytes of the files of its overlay folders; the entry's other fields, such as its summary
 * and conflicts, do not reach the project and leave the hash as it is. Installing the version that a project already
 * has only puts back lost `project.godot` entries, so an entry whose installation changes must change its version, or
 * projects that have it never get the change; the lock spec holds each entry to that, and asks for a new lock once the
 * engine's version is another release's. Blender entries are left out: the add-on store replaces an extension whenever
 * its archive or files change.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ENTRY_FILE } from '../src/catalog.ts'
import { overlayFiles } from '../src/manager.ts'

/** The committed lock. */
export const LOCK_FILE = fileURLToPath(new URL('./catalog.lock.json', import.meta.url))

/** The engine's root `package.json`, whose `version` is the WASD Engine release that the tree builds. */
const ENGINE_PACKAGE = fileURLToPath(new URL('../../../../package.json', import.meta.url))

/** The command, run in the engine folder, that writes the lock of the shipped catalog for the engine's version. */
export const LOCK_COMMAND = 'node --import tsx/esm packages/gamedev/game-addons/tests/write-catalog-lock.ts'

/** One Godot entry of the lock. */
export interface LockedAddon {
  /** The entry's version. */
  readonly version: string
  /** SHA-256 of what an installation of that version puts into a project. */
  readonly sha256: string
}

/** A lock: the release it records and its Godot entries by id. */
export interface CatalogLock {
  /** The WASD Engine version whose catalog the lock records. */
  readonly release: string
  /** Each Godot entry of that catalog, by id. */
  readonly addons: Readonly<Record<string, LockedAddon>>
}

const LockFile = z.strictObject({
  format: z.literal(1),
  release: z.string().min(1),
  addons: z.record(z.string(), z.strictObject({ version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })),
})

// The fields of an entry that an installation reads; the lock reads them whole, also from a catalog of an earlier
// release, which the current catalog's validation may refuse.
const InstalledFields = z.looseObject({
  id: z.string().min(1),
  host: z.string(),
  version: z.string().min(1),
  title: z.string(),
  license: z.string(),
  copyright: z.string(),
  homepage: z.string(),
  credit: z.string().optional(),
  archive: z.unknown().optional(),
  godot: z.looseObject({ overlay: z.array(z.string()).optional() }).optional(),
})

/**
 * A JSON value's text with the keys of every object in code unit order, so that the order in which an entry lists its
 * fields does not change the hash.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const fields: [string, unknown][] = Object.entries(value)
    return `{${fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The Godot entries of a catalog folder as a lock records them.
 * @param catalogDir - absolute catalog folder: the shipped one, or one of an earlier release.
 * @returns each Godot entry's version and the SHA-256 of what its installation puts into a project, by id.
 */
export async function catalogLock(catalogDir: string): Promise<Record<string, LockedAddon>> {
  const addons: Record<string, LockedAddon> = {}
  const folders = (await readdir(catalogDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  for (const folder of folders) {
    let text: string
    try {
      text = await readFile(join(catalogDir, folder, ENTRY_FILE), 'utf8')
    } catch (error) {
      // A folder without an entry is an overlay folder that entries name.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const entry = InstalledFields.parse(JSON.parse(text))
    if (entry.host !== 'godot') continue
    const { title, license, copyright, homepage } = entry
    const notice = { title, license, copyright, homepage, credit: entry.credit ?? null }
    const hash = createHash('sha256')
    hash.update(`${canonical({ archive: entry.archive ?? null, godot: entry.godot ?? null, notice })}\0`)
    for (const overlay of entry.godot?.overlay ?? []) {
      const source = join(catalogDir, ...overlay.split('/'))
      for (const file of await overlayFiles(source)) {
        hash.update(`${overlay}/${file}\0`)
        hash.update(await readFile(join(source, ...file.split('/'))))
        hash.update('\0')
      }
    }
    addons[entry.id] = { version: entry.version, sha256: hash.digest('hex') }
  }
  return addons
}

/**
 * The WASD Engine release that the engine's tree builds.
 * @returns the `version` of the engine's root `package.json`.
 */
export async function engineVersion(): Promise<string> {
  return z.object({ version: z.string().min(1) }).parse(JSON.parse(await readFile(ENGINE_PACKAGE, 'utf8'))).version
}

/**
 * What keeps a lock from holding for a catalog: a lock of another release than the engine's version, which must be
 * written again for the catalog that version ships, and entries whose installation changed under a version that the
 * lock records, which must change their version.
 * @param lock - the committed lock.
 * @param current - the catalog's Godot entries as {@link catalogLock} gives them.
 * @param version - the engine's version.
 * @returns one message for each problem, which says what to do; empty when the lock holds.
 */
export function lockProblems(lock: CatalogLock, current: Readonly<Record<string, LockedAddon>>, version: string): string[] {
  const unchanged = Object.entries(current).flatMap(([id, now]) => {
    const locked = lock.addons[id]
    return locked !== undefined && locked.version === now.version && locked.sha256 !== now.sha256 ? [`${id} ${now.version}`] : []
  })
  return [
    ...lock.release === version ? [] : [
      `catalog.lock.json records the Godot entries that WASD Engine ${lock.release} shipped, but the engine's version is ${version}. `
      + `Once the catalog holds what ${version} ships, write the lock for it in the engine folder: ${LOCK_COMMAND}`,
    ],
    ...unchanged.length === 0 ? [] : [
      `These Godot entries install other content than catalog.lock.json records for their versions: ${unchanged.join(', ')}. `
      + 'Installing the version that a project already has only puts back lost project.godot entries, so projects that have one of these versions would never get the change. '
      + 'Change each one\'s version, as Beehave 2.9.3 became 2.9.3+wasd.1 and ProtonScatter 4.2.0-dev+7198cc0 became 4.2.0-dev+7198cc0.wasd.1, and leave the lock as it is. '
      + `Only for a version that WASD Engine never released, write the lock again instead, in the engine folder: ${LOCK_COMMAND}`,
    ],
  ]
}

/**
 * Read a lock file.
 * @param path - the lock file; the committed lock by default.
 * @returns the release it records and its entries by id.
 */
export async function readLock(path = LOCK_FILE): Promise<CatalogLock> {
  const { release, addons } = LockFile.parse(JSON.parse(await readFile(path, 'utf8')))
  return { release, addons }
}

/**
 * The text of a lock file.
 * @param lock - the release and the entries.
 * @returns the JSON text, entries in code unit order of their ids.
 */
export function lockText(lock: CatalogLock): string {
  const addons = Object.fromEntries(Object.entries(lock.addons).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return `${JSON.stringify({ format: 1, release: lock.release, addons }, null, 2)}\n`
}
