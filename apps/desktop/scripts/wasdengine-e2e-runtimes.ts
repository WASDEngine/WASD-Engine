/**
 * Put the runtimes that the Desktop app ships into this checkout's plugin packages, for the end-to-end suites of the
 * game tools (fork-owned; `wasdengine/FORK.md`, merge checklist step 7, and `.github/workflows/wasd-checks.yml`).
 *
 * Each runtime comes from the release that its packaging script pins, `stageRuntimeArchive` checks the manifest
 * against the pin beside its version and the archive against the manifest's SHA-256, as packaging does, and the
 * runtime lands where a source checkout keeps it: LibGodot in `packages/gamedev/godot/libgodot/<platform>-<arch>`,
 * which `WASD_LIBGODOT_DIR` then names, and Blender, GIMP, and SuperCollider in the git-ignored
 * `packages/gamedev/<tool>/runtime/<platform>-<arch>`, where their suites look. A runtime that the release has no build
 * of for this machine fails the script, since its suite would otherwise skip every test.
 *
 * `pnpm --filter @deepseek-ai/dsh-desktop exec tsx scripts/wasdengine-e2e-runtimes.ts [--env-out <path>]` appends
 * `WASD_LIBGODOT_DIR=<folder>` to the given file, such as `$GITHUB_ENV`, and prints it.
 */

import { appendFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { stageBlenderRuntime } from './wasdengine-blender.ts'
import { stageGimpRuntime } from './wasdengine-gimp.ts'
import { stageLibGodotRuntime } from './wasdengine-libgodot.ts'
import type { RuntimeTarget } from './wasdengine-runtime-archive.ts'
import { stageSuperColliderRuntime } from './wasdengine-supercollider.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** The plugin packages whose runtimes the end-to-end suites use, by package name, with their folder in this checkout. */
const PACKAGES: Readonly<Record<string, string>> = {
  'dsh-godot': 'godot',
  'dsh-blender': 'blender',
  'dsh-gimp': 'gimp',
  'dsh-supercollider': 'supercollider',
}

/**
 * Stage every shipped runtime of this machine's platform into the checkout's plugin packages.
 * @param target - Platform and architecture to stage.
 * @returns The LibGodot runtime's folder, for `WASD_LIBGODOT_DIR`.
 * @throws When a release has no build for the target, or a manifest or an archive fails verification.
 */
export async function stageE2eRuntimes(target: RuntimeTarget): Promise<string> {
  // A dsh tree whose plugin packages are this checkout's, so each runtime lands in the package's own folder.
  const tree = await mkdtemp(join(tmpdir(), 'wasdengine-e2e-runtimes-'))
  try {
    await mkdir(join(tree, 'node_modules', '@deepseek-ai'), { recursive: true })
    for (const [name, folder] of Object.entries(PACKAGES)) {
      await symlink(join(REPOSITORY_ROOT, 'packages', 'gamedev', folder), join(tree, 'node_modules', '@deepseek-ai', name), 'dir')
    }
    const env = { ...process.env, WASD_LIBGODOT_BUNDLE: '1', WASD_BLENDER_BUNDLE: '1', WASD_GIMP_BUNDLE: '1', WASD_SUPERCOLLIDER_BUNDLE: '1' }
    const godot = await stageLibGodotRuntime(tree, target, env)
    const others = [
      ['Blender', await stageBlenderRuntime(tree, target, env)],
      ['GIMP', await stageGimpRuntime(tree, target, env)],
      ['SuperCollider', await stageSuperColliderRuntime(tree, target, env)],
    ] as const
    const missing = [...godot === undefined ? ['LibGodot'] : [], ...others.filter(([, staged]) => staged === undefined).map(([label]) => label)]
    if (godot === undefined || missing.length > 0) {
      throw new Error(`e2e runtimes: the pinned releases have no ${target.platform}-${target.arch} build of ${missing.join(', ')}`)
    }
    // The folder in this checkout, not its path through the temporary tree, which goes below.
    return await realpath(godot.directory)
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'env-out': { type: 'string' } } })
  const directory = await stageE2eRuntimes({ platform: process.platform, arch: process.arch })
  const line = `WASD_LIBGODOT_DIR=${directory}`
  if (values['env-out'] !== undefined) await appendFile(values['env-out'], `${line}\n`)
  console.log(line)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
