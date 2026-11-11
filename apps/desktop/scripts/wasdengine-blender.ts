/**
 * Ship the WASD Engine Blender runtime with the Desktop app (fork-owned; `wasdengine/FORK.md` lists the fork changes).
 * Before `prepare-dsh.ts` signs the prepared dsh tree and writes its runtime descriptor, `stageBlenderRuntime` puts the
 * runtime of the packaged platform, a Python with Blender's bpy module, into `@deepseek-ai/dsh-blender`'s
 * `runtime/<platform>-<arch>/` folder, where the Blender plugin looks for it, and `applyWasdengineBlender` in
 * `wasdengine-builder-config.mjs` keeps that folder outside `app.asar`. On macOS, the `sign:dsh-native` step then signs
 * the Python program, its extension modules, and bpy's libraries with the other Mach-O files of the tree. On Windows,
 * whose path length limit the deepest runtime files would pass below the app's install folder, the folder holds the
 * checked archive and its `archive.json`, and the plugin unpacks the archive under its data folder on first use.
 *
 * The runtime comes from the release manifest that `.github/workflows/wasd-blender.yml` publishes, or from a
 * `wasdengine/blender/build.sh --out` folder. The archive must match the manifest's size and SHA-256, and its
 * `runtime.json` must name the manifest's runtime and bpy versions and the packaged platform and architecture, name a
 * Python program that the archive holds, and list every unpacked file, and only those, with its SHA-256.
 *
 * Environment: `WASD_BLENDER_DIR` names a local folder holding `manifest.json` and its archives;
 * `WASD_BLENDER_MANIFEST_URL` replaces the default manifest; `WASD_BLENDER_BUNDLE=0` packages without the runtime.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isRecord, parseRuntimeArchive, stageRuntimeArchive, verifyListedFiles, type RuntimeArchive, type RuntimeTarget, type ShippedRuntime,
  type ShippedRuntimeKind,
} from './wasdengine-runtime-archive.ts'

/** Manifest of the Blender runtime release that `wasdengine/blender/build.sh` builds by default. */
export const BLENDER_MANIFEST_URL = 'https://github.com/WASDEngine/WASD-Engine/releases/download/blender-5.2.3-wasd.1/manifest.json'

/** A format 1 Blender runtime manifest, as `wasdengine/blender/runtime.py` writes it. */
interface Manifest {
  readonly version: string
  readonly bpy: string
  readonly artifacts: Readonly<Record<string, RuntimeArchive>>
}

const BLENDER: ShippedRuntimeKind<RuntimeArchive, Manifest> = {
  label: 'Blender',
  environmentPrefix: 'WASD_BLENDER',
  manifestUrl: BLENDER_MANIFEST_URL,
  remedy: 'Publish the runtime with .github/workflows/wasd-blender.yml, set WASD_BLENDER_DIR to a wasdengine/blender/build.sh --out folder, '
    + 'or set WASD_BLENDER_BUNDLE=0 to package without Blender.',
  packageName: '@deepseek-ai/dsh-blender',
  folder: 'runtime',
  parseManifest(value, source) {
    if (!isRecord(value) || value.format !== 1 || typeof value.version !== 'string' || typeof value.bpy !== 'string' || !isRecord(value.artifacts)) {
      throw new Error(`desktop runtime: the Blender manifest ${source} is not a format 1 runtime manifest`)
    }
    const artifacts: Record<string, RuntimeArchive> = {}
    for (const [key, entry] of Object.entries(value.artifacts)) {
      const artifact = parseRuntimeArchive(entry)
      if (artifact === undefined) throw new Error(`desktop runtime: the Blender manifest ${source} lists an invalid ${key} archive`)
      artifacts[key] = artifact
    }
    return { version: value.version, bpy: value.bpy, artifacts }
  },
  async verify(directory, manifest, _artifact, target) {
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    } catch (error) {
      throw new Error('desktop runtime: the Blender archive has no readable runtime.json', { cause: error })
    }
    const key = `${target.platform}-${target.arch}`
    if (!isRecord(record) || record.format !== 1 || record.version !== manifest.version || record.bpy !== manifest.bpy
      || record.platform !== target.platform || record.arch !== target.arch || !isRecord(record.sha256)
      || typeof record.python !== 'string' || typeof record.executable !== 'string') {
      throw new Error(`desktop runtime: the Blender archive's runtime.json does not describe ${manifest.version} for ${key}`)
    }
    const files = await verifyListedFiles(directory, record.sha256, 'Blender')
    if (!files.includes(record.executable)) {
      throw new Error(`desktop runtime: the Blender archive's runtime.json names ${record.executable}, which it does not hold`)
    }
    return [record.executable]
  },
  describe: manifest => `Blender runtime ${manifest.version} (bpy ${manifest.bpy})`,
  shipsArchive: target => target.platform === 'win32',
}

/**
 * Put the Blender runtime of the packaged platform into the prepared dsh tree's Blender plugin package.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param target - Packaged platform and architecture.
 * @param env - Environment that selects the runtime source.
 * @returns The shipped runtime, or undefined when `WASD_BLENDER_BUNDLE=0` or the manifest has no build for the target, in
 * which case the plugin installs the bpy module with uv or uses a Blender installed on the user's machine.
 * @throws When the manifest cannot be read, the tree has no Blender plugin package, or the archive or its files fail
 * verification.
 */
export async function stageBlenderRuntime(
  dshRoot: string, target: RuntimeTarget, env: NodeJS.ProcessEnv = process.env,
): Promise<ShippedRuntime | undefined> {
  return await stageRuntimeArchive(BLENDER, dshRoot, target, env)
}
