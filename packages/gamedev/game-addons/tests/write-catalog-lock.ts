/**
 * Write `catalog.lock.json` for a release: from the shipped catalog for the engine's version, or from the catalog folder
 * and release that the two arguments name, such as a folder that `git archive` extracted from a release tag. Run it in
 * the engine folder when preparing a release, once `bump.ts` set the release's version and the catalog holds what the
 * release ships: `node --import tsx/esm packages/gamedev/game-addons/tests/write-catalog-lock.ts`.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { catalogLock, engineVersion, LOCK_FILE, lockText } from './catalog-lock.ts'
import { CATALOG_DIR } from './shipped-catalog.ts'

const [folder, named] = process.argv.slice(2)
if ((folder === undefined) !== (named === undefined)) throw new Error('Name both a catalog folder and its release, or neither.')
const catalogDir = folder === undefined ? CATALOG_DIR : resolve(folder)
const release = named ?? await engineVersion()
const addons = await catalogLock(catalogDir)
await writeFile(LOCK_FILE, lockText({ release, addons }))
process.stdout.write(`Wrote the versions and install hashes of ${String(Object.keys(addons).length)} Godot entries of ${catalogDir}, as WASD Engine ${release} ships them, to ${LOCK_FILE}.\n`)
