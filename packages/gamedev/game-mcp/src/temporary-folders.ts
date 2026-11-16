/**
 * The temporary folders where connected agents keep throwaway work, such as Claude Code's scratchpad under /tmp: a
 * connected agent's calls neither register a folder in them as a game project nor create a game project in them, so
 * that work stays out of the user's game projects.
 * @module @deepseek-ai/dsh-game-mcp/src/temporary-folders
 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * The system's temporary folders, the default of the server's `temporaryFolders`: the Host's temporary folder, which
 * `TMPDIR`, `TMP`, or `TEMP` names, and outside Windows /tmp and /var/tmp.
 * @param platform - Host platform.
 * @returns absolute folders, each once.
 */
export function systemTemporaryFolders(platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set(platform === 'win32' ? [tmpdir()] : [tmpdir(), '/tmp', '/var/tmp'])]
}

/**
 * Whether a path is a folder or inside it, compared as spelled.
 * @param folder - absolute folder.
 * @param path - absolute path in the same spelling.
 * @returns true when the path is the folder or below it.
 */
export function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
}

/**
 * The canonical spelling of an absolute path that may not exist yet: the real path of its nearest part that exists,
 * with the rest of the path after it, so a path through a symbolic link, such as /tmp on macOS, which leads to
 * /private/tmp, is spelled as the system spells it.
 * @param path - absolute path.
 * @returns the canonical path, or the normalized path when no part of it can be read.
 */
async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch (_unreadable: unknown) {
      // A part that does not exist or cannot be read: the nearest folder above it decides.
    }
    const parent = dirname(current)
    /* v8 ignore if -- realpath resolves every POSIX root, so only a Windows path on a missing drive ends here */
    if (parent === current) return resolve(path)
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * Whether a path is one of the temporary folders or inside one, compared by canonical spelling.
 * @param folders - absolute temporary folders.
 * @param path - absolute path, which may not exist yet.
 * @returns true when the path is in a temporary folder.
 */
export async function inTemporaryFolder(folders: readonly string[], path: string): Promise<boolean> {
  const [canonical, roots] = await Promise.all([canonicalPath(path), Promise.all(folders.map(canonicalPath))])
  return roots.some(root => within(root, canonical))
}
