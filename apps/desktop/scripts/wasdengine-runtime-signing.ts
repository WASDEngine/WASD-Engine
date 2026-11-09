/** Finish the Developer ID signing of WASDEngine's bundled runtimes after upstream's per-file pass in `prepare-dsh.ts`. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { signMacOSRuntimeCode, verifyMacOSRuntimeCode } from './verify-macos-signature.mjs'

const execute = promisify(execFile)

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
