/**
 * The files that the Godot tools save their captures to: the path that a call names, or a new file that the plugin
 * names after the project and the time in a folder that Godot does not import: the recordings folder of the project, or
 * the screenshots folder in WASD Engine's own `.wasdengine` folder of the project. A call that may not replace a file
 * holds its file from before the capture until it saved the capture, so of two calls that save to one path at once,
 * the second fails instead of replacing the first one's file.
 * @module @deepseek-ai/dsh-godot/src/captures
 */
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { GodotProject } from './project.ts'

/** Folder of a project where WASD Engine keeps its own files, such as the backups of removed add-ons. */
export const WASD_ENGINE_FOLDER = '.wasdengine'

/**
 * Folder in a project's {@link WASD_ENGINE_FOLDER} that holds the images that `godot_screenshot` and `godot_view` save
 * with `save`. Godot skips hidden folders, and a `.gdignore` file in this one keeps it from importing the images too,
 * so exports of the game leave them out; a `.gitignore` file keeps them out of git.
 */
export const SCREENSHOTS_FOLDER = 'screenshots'

/** What the `.gitignore` file of a project's screenshots folder holds: the images and the writes still in progress. */
export const SCREENSHOTS_GITIGNORE = '# Images that WASD Engine saved with godot_screenshot and godot_view.\n*.png\n*.png.*.tmp\n'

/**
 * Most characters of the project's name in the name of a capture file, which keeps the name, with its time, number,
 * and extension, within the 255 bytes that file systems take for a name.
 */
const MAX_STEM_NAME = 80

/** A project as the names of its capture files take it. */
export type CaptureProject = Pick<GodotProject, 'dir' | 'name'>

/** The file that a call saves its capture to, held from before the capture until the call saved it or failed. */
export interface CaptureFile {
  /** Absolute path of the file. */
  readonly path: string
  /**
   * Save the capture into the file through a temporary file beside it, so that readers find the whole capture or the
   * file's earlier content.
   * @param data - the file's bytes.
   */
  readonly write: (data: Uint8Array) => Promise<void>
  /**
   * Give the file up after the call failed, as {@link PathHold.release} does; a capture that the call saved stays. It
   * never fails, so the call reports its own failure.
   */
  readonly release: () => Promise<void>
}

/** A path that a call holds for a file that it saves later. */
export interface PathHold {
  /**
   * Give the path up after the call saved nothing there: remove the empty file that the hold made, unless another
   * writer replaced it, then the folders that the hold made, while they are empty. It never fails: a file or folder
   * that it cannot remove stays, and a later save that may not replace the file finds it and names its path.
   */
  release(): Promise<void>
}

/**
 * The stem of a capture file's name: the project's name, or its folder's, in characters that every file system takes
 * and cut to {@link MAX_STEM_NAME} characters, and the time in the computer's time zone.
 * @param project - the project.
 * @param now - the time.
 * @returns `<name>_<YYYY>-<MM>-<DD>_<hh>-<mm>-<ss>`.
 */
export function captureStem(project: CaptureProject, now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  const clean = (project.name ?? basename(project.dir)).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+/u, '')
  const name = clean.slice(0, MAX_STEM_NAME).replace(/-+$/u, '') || 'game'
  return `${name}_${stamp}`
}

/**
 * Keep Godot from importing the files of a capture folder, so its editor and the game's exports skip them, and keep
 * them out of git: write the folder's `.gdignore` and `.gitignore` files, unless it holds them already.
 * @param folder - absolute folder, which exists.
 * @param gitignore - content of the `.gitignore` file.
 */
export async function markCaptureFolder(folder: string, gitignore: string): Promise<void> {
  for (const [name, content] of [['.gdignore', ''], ['.gitignore', gitignore]] as const) {
    try {
      await writeFile(join(folder, name), content, { flag: 'wx' })
    } catch (error) {
      // A marker file that the folder holds already stays as it is.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/**
 * Hold a path for a file that a call saves later: create the file, empty, and the folders above it, only while no file
 * or folder has the path, so two calls that save to one path at once never both save there. The saved file then
 * replaces the empty one.
 * @param path - absolute path.
 * @returns the hold, or undefined when a file or folder has the path.
 */
export async function holdPath(path: string): Promise<PathHold | undefined> {
  const folder = dirname(path)
  const created = await mkdir(folder, { recursive: true })
  const removeFolders = async (): Promise<void> => {
    if (created === undefined) return
    // The folders that the hold made, deepest first, while each is empty; a folder in use stays.
    for (let current = folder; !relative(created, current).startsWith('..'); current = dirname(current)) {
      const removed = await rmdir(current).then(() => true, () => false)
      if (!removed || current === created) return
    }
  }
  let made: Stats
  try {
    made = await createEmpty(path)
  } catch (error) {
    await removeFolders()
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  return {
    async release() {
      // A path that is gone or that cannot be read holds nothing of this hold's.
      const now = await stat(path).catch(() => undefined)
      if (now !== undefined && now.ino === made.ino && now.dev === made.dev && now.size === 0) {
        await rm(path, { force: true }).catch((error: unknown) => {
          // An empty file that cannot be removed stays; a later save that may not replace it names its path.
          void error
        })
      }
      await removeFolders()
    },
  }
}

/**
 * Create an empty file where no file or folder exists.
 * @param path - absolute path in an existing folder.
 * @returns the new file's status.
 * @throws the `EEXIST` failure when the path is taken.
 */
async function createEmpty(path: string): Promise<Stats> {
  const handle = await open(path, 'wx')
  try {
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

/**
 * The refusal of a path that a file has, for a call that may not replace it.
 * @param path - absolute path.
 * @returns the message.
 */
function existsMessage(path: string): string {
  return `${path} already exists; pass replace: true to overwrite it, or choose another path.`
}

/**
 * Hold the file at the path that a call names for its capture, before the capture. Without `replace`, the hold
 * creates the file only while no file has the path, so of two calls that save to one path at once, the second fails.
 * @param path - absolute path.
 * @param replace - whether the call may replace a file at the path.
 * @param extension - the file's extension, such as `.png`.
 * @returns the held file.
 * @throws Error when the path is a folder, or a file that the call may not replace.
 */
export async function holdCaptureFile(path: string, replace: boolean, extension: string): Promise<CaptureFile> {
  let found
  try {
    found = await stat(path)
  } catch (error) {
    // Only a path that does not exist yet is free; any other failure stops the call.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (found?.isDirectory() === true) throw new Error(`${path} is a folder; pass the path of a ${extension} file.`)
  const write = (data: Uint8Array): Promise<void> => writeFileAtomic(path, data, { mode: 0o644 })
  if (replace) return { path, write, release: () => Promise.resolve() }
  if (found !== undefined) throw new Error(existsMessage(path))
  const hold = await holdPath(path)
  // Another call or program created the file since the check.
  if (hold === undefined) throw new Error(existsMessage(path))
  return { path, write, release: () => hold.release() }
}

/**
 * Hold a new file whose name the plugin chose for a capture, `<stem><extension>`: that path, or, when a file has it,
 * the first of `<stem>_2<extension>`, `<stem>_3<extension>`, and so on that no file has.
 * @param path - absolute path of the name that the plugin chose.
 * @returns the path that the call holds, and the hold.
 */
export async function holdNewPath(path: string): Promise<{ readonly path: string; readonly hold: PathHold }> {
  const extension = extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let copy = 1; ; copy += 1) {
    const numbered = copy === 1 ? path : `${stem}_${String(copy)}${extension}`
    const hold = await holdPath(numbered)
    if (hold !== undefined) return { path: numbered, hold }
  }
}

/**
 * Hold a new file in the screenshots folder of a project's {@link WASD_ENGINE_FOLDER} for a capture, named after the
 * project and the time as {@link holdNewPath} numbers it. The call makes each of the two folders that is missing and
 * writes into no other folder; the screenshots folder gets its marker files before the image, so Godot never imports
 * what the folder holds.
 * @param project - the running game's project.
 * @param now - the time that names the file.
 * @returns the held file.
 * @throws Error when the project's `.wasdengine` or `.wasdengine/screenshots` is something other than a folder, such
 *   as a file or a link.
 */
export async function newScreenshotFile(project: CaptureProject, now: Date): Promise<CaptureFile> {
  const state = join(project.dir, WASD_ENGINE_FOLDER)
  const folder = join(state, SCREENSHOTS_FOLDER)
  for (const owned of [state, folder]) await ownFolder(owned, folder)
  await markCaptureFolder(folder, SCREENSHOTS_GITIGNORE)
  const { path, hold } = await holdNewPath(join(folder, `${captureStem(project, now)}.png`))
  return { path, write: data => writeFileAtomic(path, data, { mode: 0o644 }), release: () => hold.release() }
}

/**
 * Make a folder of WASD Engine's in a project, unless it exists.
 * @param path - absolute path of the folder, whose parent folder exists.
 * @param screenshots - the screenshots folder, which the refusal names.
 * @throws Error when something other than a folder, such as a file or a link, has the path.
 */
async function ownFolder(path: string, screenshots: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // A folder that has the name is WASD Engine's; anything else, also a link to a folder, is not.
    if (!(await lstat(path)).isDirectory()) {
      throw new Error(`${path} is not a folder, so save cannot keep the image in ${screenshots}; move ${path} away, or pass path instead.`, { cause: error })
    }
  }
}
