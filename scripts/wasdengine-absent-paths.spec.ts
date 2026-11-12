/** WASDEngine fork: the reference gates skip the paths a clean checkout of the fork lacks on purpose, and only those. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findPackagePathViolations } from './verify-package-paths.ts'
import { isGitIgnoredPath, isPrunedUpstreamPath } from './wasdengine-absent-paths.ts'

let root: string

function write(file: string, content: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function initGit(): void {
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasd-absent-paths-'))
  write('wasdengine/upstream-prune.txt', '# Presets the fork does not ship\n  packages/bundle/web-app/presets/standard.patch.yml  \n\n.github/workflows\n')
  write('packages/bundle/web-app/package.json', '{}\n')
  write('packages/gamedev/blender/.gitignore', '/runtime/\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isPrunedUpstreamPath', () => {
  it('matches a listed path and the paths inside a listed directory', () => {
    expect(isPrunedUpstreamPath(root, join(root, 'packages/bundle/web-app/presets/standard.patch.yml'))).toBe(true)
    expect(isPrunedUpstreamPath(root, join(root, '.github/workflows/ci.yml'))).toBe(true)
  })

  it('does not match a sibling of a listed file or a path that only shares a listed prefix', () => {
    expect(isPrunedUpstreamPath(root, join(root, 'packages/bundle/web-app/presets/ptc.patch.yml'))).toBe(false)
    expect(isPrunedUpstreamPath(root, join(root, '.github/workflows-extra/ci.yml'))).toBe(false)
  })
})

describe('isGitIgnoredPath', () => {
  it('matches a missing folder that a directory pattern ignores, and the paths inside it', () => {
    initGit()
    expect(isGitIgnoredPath(root, join(root, 'packages/gamedev/blender/runtime'))).toBe(true)
    expect(isGitIgnoredPath(root, join(root, 'packages/gamedev/blender/runtime/darwin-arm64/runtime.json'))).toBe(true)
    expect(isGitIgnoredPath(root, join(root, 'packages/gamedev/blender/src/missing.ts'))).toBe(false)
  })

  it('matches nothing outside a git checkout', () => {
    expect(isGitIgnoredPath(root, join(root, 'packages/gamedev/blender/runtime'))).toBe(false)
  })
})

describe('verify-package-paths in the fork', () => {
  it('skips deleted upstream paths and ignored folders, and still reports other missing paths', () => {
    initGit()
    write('docs/guide.md', [
      'Upstream preset: `packages/bundle/web-app/presets/standard.patch.yml`.',
      'Installed runtime: `--install packages/gamedev/blender/runtime`.',
      'Moved preset: `packages/bundle/web-app/presets/ptc.patch.yml`.',
      'Moved source: `packages/gamedev/blender/src/missing.ts`.',
    ].join('\n'))
    expect(findPackagePathViolations(root, join(root, 'docs/guide.md'), new Set(['web-app', 'blender']))).toEqual([
      { file: 'docs/guide.md', line: 3, ref: 'packages/bundle/web-app/presets/ptc.patch.yml' },
      { file: 'docs/guide.md', line: 4, ref: 'packages/gamedev/blender/src/missing.ts' },
    ])
  })
})
