/**
 * WASDEngine fork: paths that a clean checkout of the fork lacks on purpose. `verify-md-links` and
 * `verify-package-paths` do not report references to them as missing.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * Whether a missing path is an upstream path the fork deletes, so upstream documents may keep naming it.
 * @param root - repository root holding `wasdengine/upstream-prune.txt`.
 * @param target - absolute path of the missing target.
 * @returns true when a listed literal path names the target or one of its directories.
 */
export function isPrunedUpstreamPath(root: string, target: string): boolean {
  const manifest = resolve(root, 'wasdengine/upstream-prune.txt')
  if (!existsSync(manifest)) return false
  return readFileSync(manifest, 'utf8').split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry !== '' && !entry.startsWith('#'))
    .some((entry) => {
      const pruned = resolve(root, entry)
      return target === pruned || target.startsWith(pruned + sep)
    })
}

/**
 * Whether git ignores a missing path or one of its directories, such as the runtime folder that a game tool's
 * build script installs into a source checkout.
 * @param root - repository root, the working directory of `git check-ignore`.
 * @param target - absolute path of the missing target.
 * @returns true when git ignores the path as a directory; false when it does not, or when `root` is not a git checkout.
 */
export function isGitIgnoredPath(root: string, target: string): boolean {
  // Relative, because git compares an absolute path with the checkout's real path, which a symlinked root does not match.
  // The trailing slash: a pattern such as `/runtime/` matches only directories, and git cannot tell that a missing path is one.
  const path = `${relative(root, target).replaceAll(sep, '/')}/`
  return spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' }).status === 0
}
