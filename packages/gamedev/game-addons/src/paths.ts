/**
 * The project paths that the add-on manager reads from a record and changes in a game project. A record path is
 * project-relative with `/` separators and nothing another platform reads as a separator or a drive. Every change
 * resolves the folders on its way with their symbolic links, so that a link inside the project, such as an `addons`
 * folder that points elsewhere, never leads a move, a deletion, or a new file outside the project; the entry a change
 * moves or deletes is never followed, so a linked add-on folder loses only its link.
 * @module @deepseek-ai/dsh-game-addons/src/paths
 */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'

/** A change that the manager refuses because a path of the project leads outside it. */
export class GameAddonPathError extends Error {
  override name = 'GameAddonPathError'
}

/** The path functions of one platform, `node:path` or one of its `posix` and `win32` forms. */
export type PathFunctions = Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>

/** Characters a record path never holds: another platform's separator, a drive or stream colon, and control characters. */
const FORBIDDEN = /[\\:\p{Cc}]/u

/**
 * Whether a record path names a place inside the project on every platform.
 * @param value - the path as the record holds it.
 * @returns true for a relative path of `/`-separated segments, none empty, `.`, or `..`, without a backslash, a colon,
 *   or a control character.
 */
export function isProjectPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || FORBIDDEN.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Whether an absolute path is a folder or the entry of one.
 * @param root - absolute folder.
 * @param target - absolute path to test.
 * @param functions - the platform's path functions.
 * @returns true when `target` is `root` or lies below it.
 */
export function within(root: string, target: string, functions: PathFunctions = path): boolean {
  const rest = functions.relative(root, target)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${functions.sep}`) && !functions.isAbsolute(rest))
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function outside(projectDir: string, relativePath: string, real: string): GameAddonPathError {
  return new GameAddonPathError(`${relativePath} in ${projectDir} leads outside the project, to ${real}; the add-on manager changes nothing there.`)
}

/**
 * The real path of a folder of the project, created one level at a time when missing, so that no folder is created
 * outside the project.
 * @param projectDir - absolute project folder.
 * @param relativePath - project-relative folder with `/` separators.
 * @returns the folder's real path.
 * @throws {GameAddonPathError} when the folder or a folder on its way leads outside the project.
 */
export async function projectFolder(projectDir: string, relativePath: string): Promise<string> {
  const root = await realpath(projectDir)
  let current = root
  for (const segment of relativePath.split('/')) {
    const next = path.join(current, segment)
    try {
      await mkdir(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    current = await realpath(next)
    if (!within(root, current)) throw outside(projectDir, relativePath, current)
  }
  return current
}

/**
 * Where an existing entry of the project is: the real path of its folder joined with its own name, which stays a
 * link when it is one, so that moving or deleting the entry never follows it.
 * @param projectDir - absolute project folder.
 * @param relativePath - project-relative path with `/` separators.
 * @returns the entry's location, or undefined when it does not exist.
 * @throws {GameAddonPathError} when a folder on its way leads outside the project.
 */
export async function projectEntry(projectDir: string, relativePath: string): Promise<string | undefined> {
  const root = await realpath(projectDir)
  const absolute = path.join(root, ...relativePath.split('/'))
  let folder: string
  try {
    folder = await realpath(path.dirname(absolute))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!within(root, folder)) throw outside(projectDir, relativePath, folder)
  const entry = path.join(folder, path.basename(absolute))
  try {
    await lstat(entry)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return entry
}
