/**
 * The state WASD Engine keeps for a game project, in a hidden folder inside it, and the two rules its changes follow:
 * every file is replaced whole, and one project's exports, recordings, and releases run one at a time.
 * @module @deepseek-ai/dsh-wasd-plugins/src/state
 */
import { randomUUID } from 'node:crypto'
import { realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Folder, inside a project, of the state WASD Engine keeps for it; hidden, so Godot ignores it. */
export const STATE_DIR = '.wasdengine'

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
 * The operations of each game project, one at a time and in the order they asked: the exports, preview recordings,
 * and releases that rewrite a project's state folder and its link to its game, whether a Session's agent or an agent
 * connected through WASD Engine's MCP server started them. A project is known by its real path, so two paths of one
 * folder, such as one through a symbolic link, share its queue.
 */
export class ProjectQueue {
  /** Per project, the promise that settles once its latest operation, and every earlier one, ended. */
  private readonly tails = new Map<string, Promise<void>>()
  /** Settles once the latest call found its project's real path; it never rejects. */
  private resolving: Promise<string> = Promise.resolve('')

  /**
   * Run an operation once the project's earlier operations ended.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation; it ends the wait, and an operation cancelled while it waits never runs.
   * @param operation - the operation.
   * @returns the operation's result.
   * @throws the signal's reason when it aborts during the wait, and the operation's failure.
   */
  async run<T>(projectDir: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    // Calls find their real paths one after another, so each takes its place in the queue in the order it was asked;
    // otherwise a later call whose path resolved first would find no earlier operation and run beside it.
    const resolved = this.resolving.then(() => realFolder(projectDir))
    this.resolving = resolved
    const key = await resolved
    const earlier = this.tails.get(key) ?? Promise.resolve()
    let end = (): void => {}
    const ended = new Promise<void>((resolveEnd) => { end = resolveEnd })
    // Later operations wait for every earlier one as well, also when this one is cancelled while it waits.
    const tail = earlier.then(() => ended)
    this.tails.set(key, tail)
    try {
      await after(earlier, signal)
      return await operation()
    } finally {
      end()
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    }
  }
}

/**
 * The key of a project folder in a {@link ProjectQueue}.
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
