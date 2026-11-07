/**
 * Copies files that packages ship (worker scripts, Godot harness scripts) to
 * real paths that external applications can open. A packaged Desktop app
 * keeps package files inside `app.asar`, which only Electron's `fs` can read;
 * Blender, GIMP, and Godot need an ordinary file.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hex digits of the content hash that name a payload directory. */
const DIGEST_PREFIX = 16

/**
 * Copy a packaged file to `<dataRoot>/payload/<sha256 prefix>/<basename>` and
 * return the real path of the copy. The directory is named by the first 16 hex
 * digits of the content's SHA-256, so each content version gets its own copy.
 * A copy with identical bytes is reused; otherwise the bytes are written to a
 * temporary file and renamed into place, so readers never see a partial file.
 * The copy is created with mode 0o644 (before the umask).
 * @param source - `file:` URL of the shipped file, possibly inside `app.asar`.
 * @param dataRoot - absolute directory the plugin owns.
 * @returns the real path of the copy.
 * @throws TypeError when `source` is not a `file:` URL; filesystem errors when the
 *   source cannot be read or the copy cannot be written.
 */
export async function materializePayload(source: URL, dataRoot: string): Promise<string> {
  // Read through a path string, which Electron's app.asar support resolves.
  const path = fileURLToPath(source)
  const name = basename(path)
  const bytes = await readFile(path)
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, DIGEST_PREFIX)
  const directory = join(dataRoot, 'payload', digest)
  const target = join(directory, name)
  if (!await holds(target, bytes)) {
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
  return await realpath(target)
}

/** Whether `path` is a readable file holding exactly `bytes`. */
async function holds(path: string, bytes: Buffer): Promise<boolean> {
  let existing: Buffer
  try {
    existing = await readFile(path)
  } catch {
    // ENOENT, EISDIR, EACCES: the path holds no usable copy, and the rename replaces it or reports why it cannot.
    return false
  }
  return existing.equals(bytes)
}
