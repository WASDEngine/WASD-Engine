/**
 * Check that a signed build of the Desktop app carries WASDEngine's bundled runtimes in their pinned versions, and
 * finish their Developer ID signing after upstream's per-file pass in `prepare-dsh.ts`.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { signMacOSRuntimeCode, verifyMacOSRuntimeCode } from './verify-macos-signature.mjs'
import { BLENDER_RUNTIME } from './wasdengine-blender.ts'
import { GIMP_RUNTIME } from './wasdengine-gimp.ts'
import { LIBGODOT_RUNTIME } from './wasdengine-libgodot.ts'
import { shippedRuntimeVersion, type PinnedRuntime, type RuntimeTarget } from './wasdengine-runtime-archive.ts'
import { SUPERCOLLIDER_RUNTIME } from './wasdengine-supercollider.ts'

const execute = promisify(execFile)

/** The runtimes that every signed build ships, in the order of their staging steps in `prepare-dsh.ts`. */
export const WASDENGINE_PINNED_RUNTIMES: readonly PinnedRuntime[] = [LIBGODOT_RUNTIME, SUPERCOLLIDER_RUNTIME, GIMP_RUNTIME, BLENDER_RUNTIME]

/** A pinned runtime that a prepared tree lacks or holds in another version. */
export interface WasdengineRuntimeMismatch {
  readonly runtime: PinnedRuntime
  /** Version that the tree holds; undefined when it holds none. */
  readonly shipped: string | undefined
}

/**
 * Compare the runtimes in a prepared tree with their pins.
 * @param root - Prepared `dsh` output root, after the runtime staging steps.
 * @param target - Packaged platform and architecture.
 * @param runtimes - The pinned runtimes.
 * @returns Each runtime that the tree lacks or holds in another version than its pin; empty when it holds every
 *   runtime in its pinned version.
 * @throws When a runtime's record in the tree is not JSON or names no version.
 */
export async function wasdengineRuntimeMismatches(
  root: string, target: RuntimeTarget, runtimes: readonly PinnedRuntime[] = WASDENGINE_PINNED_RUNTIMES,
): Promise<WasdengineRuntimeMismatch[]> {
  const mismatches: WasdengineRuntimeMismatch[] = []
  for (const runtime of runtimes) {
    const shipped = await shippedRuntimeVersion(root, runtime, target)
    if (shipped !== runtime.version) mismatches.push({ runtime, shipped })
  }
  return mismatches
}

function mismatchText({ runtime, shipped }: WasdengineRuntimeMismatch): string {
  return shipped === undefined
    ? `it ships no ${runtime.label} runtime, whose pinned version is ${runtime.version}`
    : `it ships ${runtime.label} ${shipped}, not the pinned ${runtime.version}`
}

/**
 * The `runtime:wasdengine-pins` step of `prepare-dsh.ts`, after the runtime staging steps and before signing. A signed
 * build stops unless the tree holds every pinned runtime in its pinned version, so a stale `WASD_<RUNTIME>_DIR`,
 * `WASD_<RUNTIME>_MANIFEST_URL`, or `WASD_<RUNTIME>_BUNDLE=0` in the shell cannot put another runtime, or none, into a
 * release; an unsigned build warns and continues.
 * @param root - Prepared `dsh` output root.
 * @param target - Packaged platform and architecture.
 * @param env - Packaging environment; `DSH_DESKTOP_UNSIGNED=1` marks an unsigned build.
 * @throws When a signed build lacks a pinned runtime or holds another version of one, or a runtime's record names no
 *   version.
 */
export async function checkWasdengineRuntimes(root: string, target: RuntimeTarget, env: NodeJS.ProcessEnv): Promise<void> {
  const mismatches = await wasdengineRuntimeMismatches(root, target)
  if (mismatches.length === 0) return
  if (env.DSH_DESKTOP_UNSIGNED !== '1') {
    const variables = mismatches.flatMap(({ runtime: { environmentPrefix: prefix } }) => [`${prefix}_DIR`, `${prefix}_MANIFEST_URL`, `${prefix}_BUNDLE`])
    throw new Error(`desktop runtime: a signed build ships every runtime in its pinned version, but ${mismatches.map(mismatchText).join('; ')}. `
      + `Unset ${variables.join(', ')} to package the pinned releases.`)
  }
  for (const mismatch of mismatches) {
    console.warn(`desktop runtime: this unsigned build continues, but ${mismatchText(mismatch)}; a signed build stops here`)
  }
}

/** Entitlements of the LibGodot runner, which loads the GDExtension libraries of the games it runs. */
export const GODOT_RUNNER_ENTITLEMENTS = fileURLToPath(new URL('./wasdengine-godot-entitlements.plist', import.meta.url))

/** One signing step, named relative to the prepared `dsh` root: a Mach-O file with its entitlements, or a bundle. */
export type WasdengineRuntimeSigningStep =
  | { readonly kind: 'file'; readonly path: string; readonly entitlements: string }
  | { readonly kind: 'bundle'; readonly path: string }

/**
 * List what upstream's per-file pass leaves unfinished in a prepared runtime tree. The LibGodot runner needs
 * `disable-library-validation` to load a game's GDExtensions, which other developers sign. GIMP's `Python.app` is an
 * application bundle, and signing its executable alone breaks the seal that notarization checks. The runtime's
 * `Python.framework` keeps no symbolic links, so `codesign` does not recognize it as a bundle, and the per-file pass
 * already signs each of its Mach-O files.
 * @param root - Prepared `dsh` output root.
 * @param arch - Target architecture.
 * @returns Steps in signing order; a runtime the tree lacks contributes none.
 */
export function wasdengineRuntimeSigningPlan(root: string, arch: 'arm64' | 'x64'): WasdengineRuntimeSigningStep[] {
  const steps: WasdengineRuntimeSigningStep[] = []
  const runner = `node_modules/@deepseek-ai/dsh-godot/libgodot/darwin-${arch}/godot_runner`
  if (existsSync(join(root, runner))) steps.push({ kind: 'file', path: runner, entitlements: GODOT_RUNNER_ENTITLEMENTS })
  const versions = `node_modules/@deepseek-ai/dsh-gimp/runtime/darwin-${arch}/Contents/lib/Python.framework/Versions`
  if (!existsSync(join(root, versions))) return steps
  for (const version of readdirSync(join(root, versions)).sort()) {
    const app = `${versions}/${version}/Resources/Python.app`
    if (existsSync(join(root, app))) steps.push({ kind: 'bundle', path: app })
  }
  return steps
}

/**
 * Sign the steps of {@link wasdengineRuntimeSigningPlan} with the release identity in the packaging keychain, after
 * upstream's per-file pass and before the runtime manifests record the tree. The runner keeps the identifier that the
 * per-file pass gave it; a bundle takes the identifier that `codesign` derives for it.
 * @param root - Prepared `dsh` output root.
 * @param appId - Release application identifier.
 * @param expected - Public release identity.
 * @param arch - Target architecture.
 * @returns The number of signed steps.
 * @throws When the packaging command did not prepare `CSC_KEYCHAIN`, or when `codesign` fails or rejects a result.
 */
export async function signWasdengineRuntimes(root: string, appId: string, expected: MacOSSigningEnvironment, arch: 'arm64' | 'x64'): Promise<number> {
  const keychain = process.env.CSC_KEYCHAIN
  if (!keychain) throw new Error('WASDEngine runtime signing: run through the package command to prepare the signing keychain')
  const steps = wasdengineRuntimeSigningPlan(root, arch)
  for (const step of steps) {
    const path = join(root, step.path)
    if (step.kind === 'file') {
      await signMacOSRuntimeCode(path, `${appId}.runtime.${createHash('sha256').update(step.path).digest('hex')}`, expected, step.entitlements)
      verifyMacOSRuntimeCode(path, expected)
      continue
    }
    await execute('/usr/bin/codesign', ['--force', '--sign', expected.signingIdentity, '--keychain', keychain, '--timestamp', '--options', 'runtime', path])
    await execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path])
  }
  return steps.length
}
