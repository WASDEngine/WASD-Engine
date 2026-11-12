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
 * Whether a package's own `.gitignore` ignores a missing path or one of its directories, such as the runtime folder
 * that a game tool's build script installs into a source checkout. The repository root's `.gitignore` does not count:
 * its patterns (`lib/`, `node_modules/`) name build output, whose stale paths upstream's gates must still report.
 * @param root - repository root, the working directory of `git check-ignore`.
 * @param target - absolute path of the missing target.
 * @returns true when a `.gitignore` below the root ignores the path as a directory; false when none does, or when
 *   `root` is not a git checkout.
 */
export function isGitIgnoredPath(root: string, target: string): boolean {
  // Relative, because git compares an absolute path with the checkout's real path, which a symlinked root does not match.
  // The trailing slash: a pattern such as `/runtime/` matches only directories, and git cannot tell that a missing path is one.
  const path = `${relative(root, target).replaceAll(sep, '/')}/`
  const matched = spawnSync('git', ['check-ignore', '-v', '--', path], { cwd: root, encoding: 'utf8' })
  if (matched.status !== 0) return false
  // `<source>:<line>:<pattern>\t<path>`; the source is a path relative to the checkout for its own .gitignore files.
  const source = matched.stdout.slice(0, matched.stdout.indexOf(':'))
  return source !== '.gitignore' && source.endsWith('/.gitignore')
}
