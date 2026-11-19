/**
 * The state WASD Engine keeps for a game project, in a hidden folder inside it, and the rules its changes follow:
 * every file is replaced whole, one project's exports, recordings, and releases run one at a time, and a project is
 * known by its real path.
 * @module @deepseek-ai/dsh-wasd-plugins/src/state
 */
import { randomUUID } from 'node:crypto'
import { realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Folder, inside a project, of the state WASD Engine keeps for it; hidden, so Godot ignores it. */
export const STATE_DIR = '.wasdengine'

/**
 * The `.gitignore` of a project's state folder: the builds, the recorded preview, and the Web check's picture, which
 * take up to hundreds of megabytes and which WASD Engine makes again when it needs them. The state folder's other
 * files, such as the record of the installed add-ons and the link to the released game, stay in git.
 */
export const STATE_GITIGNORE = [
  '# WASD Engine\'s builds of this game and their previews, which it makes again when it needs them.',
  '/web/', '/web-zip/', '/desktop/', '/mobile/', '/server/', '/preview/', '/web-check.jpg', '',
].join('\n')

/**
 * Give a project's state folder its `.gitignore` ({@link STATE_GITIGNORE}) when the folder exists and has none; a
 * `.gitignore` the folder holds already, such as one the user wrote, stays as it is.
 * @param projectDir - absolute project folder.
 */
export async function ignoreBuilds(projectDir: string): Promise<void> {
  const folder = join(projectDir, STATE_DIR)
  const found = await stat(folder).catch(() => undefined)
  if (found?.isDirectory() !== true) return
  try {
    await writeFile(join(folder, '.gitignore'), STATE_GITIGNORE, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Replace a file whole: write a temporary file beside it, then rename it over the file, so a reader, or a write that
 * stops part way, never leaves part of the new content in place of the old.
 * @param path - absolute file path in an existing folder.
 * @param data - the file's new content.
 */
export async function writeWhole(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Wait for an earlier operation, or for cancellation.
 * @param earlier - settles once the earlier operation ended; it never rejects.
 * @param signal - cancellation.
 * @returns once the earlier operation ended.
 * @throws the signal's reason once it aborts first.
 */
function after(earlier: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolveWait, rejectWait) => {
    const abort = (): void => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
      rejectWait(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void earlier.then(() => {
      signal.removeEventListener('abort', abort)
      resolveWait()
    })
  })
}

/**
 * The real paths of project folders, found one after another: callers that queue work by a project's real path, so two
 * paths of one folder, such as one through a symbolic link, share a queue, take their places in the order they asked;
 * otherwise a later call whose path resolved first would find no earlier work and run beside it.
 */
export class RealFolders {
  /** Settles once the latest call found its project's real path; it never rejects. */
  private resolving: Promise<string> = Promise.resolve('')

  /**
   * Find a project folder's real path, after the folders of every earlier call.
   * @param projectDir - absolute project folder.
   * @returns its real path, or the path itself when it cannot be resolved.
   */
  find(projectDir: string): Promise<string> {
    const resolved = this.resolving.then(() => realFolder(projectDir))
    this.resolving = resolved
    return resolved
  }
}

/**
 * The operations of each game project, one at a time and in the order they asked: the exports, preview recordings,
 * and releases that rewrite a project's state folder and its link to its game, whether a Session's agent or an agent
 * connected through WASD Engine's MCP server started them. A project is known by its real path, so two paths of one
 * folder, such as one through a symbolic link, share its queue. After each operation the state folder gets its
 * `.gitignore` ({@link ignoreBuilds}).
 */
export class ProjectQueue {
  /** Per project, the promise that settles once its latest operation, and every earlier one, ended. */
  private readonly tails = new Map<string, Promise<void>>()
  private readonly folders = new RealFolders()

  /**
   * Run an operation once the project's earlier operations ended.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation; it ends the wait, and an operation cancelled while it waits never runs.
   * @param operation - the operation.
   * @returns the operation's result.
   * @throws the signal's reason when it aborts during the wait, and the operation's failure.
   */
  async run<T>(projectDir: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const key = await this.folders.find(projectDir)
    const earlier = this.tails.get(key) ?? Promise.resolve()
    let end = (): void => {}
    const ended = new Promise<void>((resolveEnd) => { end = resolveEnd })
    // Later operations wait for every earlier one as well, also when this one is cancelled while it waits.
    const tail = earlier.then(() => ended)
    this.tails.set(key, tail)
    try {
      await after(earlier, signal)
      try {
        return await operation()
      } finally {
        // A build the operation left in the state folder stays out of git; a folder that cannot take the file keeps
        // the operation's own outcome.
        await ignoreBuilds(projectDir).catch((_unwritable: unknown) => undefined)
      }
    } finally {
      end()
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    }
  }
}

/**
 * The path that names a project folder whichever way a caller reached it.
 * @param projectDir - absolute project folder.
 * @returns its real path, or the path itself when it cannot be resolved.
 */
async function realFolder(projectDir: string): Promise<string> {
  try {
    return await realpath(projectDir)
  } catch {
    // A folder that is gone or unreadable keeps its own path; the operation reports why it cannot use the folder.
    return resolve(projectDir)
  }
}
