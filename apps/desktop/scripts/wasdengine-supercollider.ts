/**
 * Ship the WASD Engine SuperCollider runtime with the Desktop app (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes). Before `prepare-dsh.ts` signs the prepared dsh tree and writes its runtime descriptor,
 * `stageSuperColliderRuntime` puts the runtime of the packaged platform into `@deepseek-ai/dsh-supercollider`'s
 * `runtime/<platform>-<arch>/` folder, where the SuperCollider plugin looks for it, and
 * `applyWasdengineSuperCollider` in `wasdengine-builder-config.mjs` keeps that folder outside `app.asar`. The
 * `sign:dsh-native` step then signs sclang, scsynth, and the UGen plugins with the other Mach-O files of the tree.
 *
 * The runtime comes from the release manifest that `.github/workflows/wasd-supercollider.yml` publishes, or from a
 * `wasdengine/supercollider/build.sh --out` folder. The archive must match the manifest's size and SHA-256, and its
 * `runtime.json` must name the manifest's runtime and SuperCollider versions and the packaged platform and
 * architecture, and list every unpacked file, and only those, with its SHA-256.
 *
 * Environment: `WASD_SUPERCOLLIDER_DIR` names a local folder holding `manifest.json` and its archives;
 * `WASD_SUPERCOLLIDER_MANIFEST_URL` replaces the default manifest; `WASD_SUPERCOLLIDER_BUNDLE=0` packages without
 * SuperCollider.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isRecord, parseRuntimeArchive, stageRuntimeArchive, verifyListedFiles, type RuntimeArchive, type RuntimeTarget, type ShippedRuntime,
  type ShippedRuntimeKind,
} from './wasdengine-runtime-archive.ts'

/** Manifest of the SuperCollider runtime release that `wasdengine/supercollider/build.sh` builds by default. */
export const SUPERCOLLIDER_MANIFEST_URL = 'https://github.com/WASDEngine/WASD-Engine/releases/download/supercollider-3.14.1-wasd.1/manifest.json'

/** A format 1 SuperCollider runtime manifest, as `wasdengine/supercollider/runtime.py` writes it. */
interface Manifest {
  readonly version: string
  readonly supercollider: string
  readonly artifacts: Readonly<Record<string, RuntimeArchive>>
}

/** Fields of `runtime.json` that name the runtime's programs and folders. */
const NAMED_ENTRIES = ['sclang', 'scsynth', 'plugins', 'classLibrary', 'helpSource'] as const

const SUPERCOLLIDER: ShippedRuntimeKind<RuntimeArchive, Manifest> = {
  label: 'SuperCollider',
  environmentPrefix: 'WASD_SUPERCOLLIDER',
  manifestUrl: SUPERCOLLIDER_MANIFEST_URL,
  remedy: 'Publish the runtime with .github/workflows/wasd-supercollider.yml, set WASD_SUPERCOLLIDER_DIR to a '
    + 'wasdengine/supercollider/build.sh --out folder, or set WASD_SUPERCOLLIDER_BUNDLE=0 to package without SuperCollider.',
  packageName: '@deepseek-ai/dsh-supercollider',
  folder: 'runtime',
  parseManifest(value, source) {
    if (!isRecord(value) || value.format !== 1 || typeof value.version !== 'string' || typeof value.supercollider !== 'string'
      || !isRecord(value.artifacts)) {
      throw new Error(`desktop runtime: the SuperCollider manifest ${source} is not a format 1 runtime manifest`)
    }
    const artifacts: Record<string, RuntimeArchive> = {}
    for (const [key, entry] of Object.entries(value.artifacts)) {
      const artifact = parseRuntimeArchive(entry)
      if (artifact === undefined) throw new Error(`desktop runtime: the SuperCollider manifest ${source} lists an invalid ${key} archive`)
      artifacts[key] = artifact
    }
    return { version: value.version, supercollider: value.supercollider, artifacts }
  },
  async verify(directory, manifest, _artifact, target) {
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    } catch (error) {
      throw new Error('desktop runtime: the SuperCollider archive has no readable runtime.json', { cause: error })
    }
    const key = `${target.platform}-${target.arch}`
    if (!isRecord(record) || record.format !== 1 || record.version !== manifest.version || record.supercollider !== manifest.supercollider
      || record.platform !== target.platform || record.arch !== target.arch || !isRecord(record.sha256)
      || NAMED_ENTRIES.some(field => typeof record[field] !== 'string')) {
      throw new Error(`desktop runtime: the SuperCollider archive's runtime.json does not describe ${manifest.version} for ${key}`)
    }
    const files = await verifyListedFiles(directory, record.sha256, 'SuperCollider')
    const programs = [record.sclang, record.scsynth]
    for (const program of programs) {
      if (typeof program !== 'string' || !files.includes(program)) {
        throw new Error(`desktop runtime: the SuperCollider archive's runtime.json names ${String(program)}, which it does not hold`)
      }
    }
    return programs.filter(program => typeof program === 'string')
  },
  describe: manifest => `SuperCollider runtime ${manifest.version} (SuperCollider ${manifest.supercollider})`,
}

/**
 * Put the SuperCollider runtime of the packaged platform into the prepared dsh tree's SuperCollider plugin package.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param target - Packaged platform and architecture.
 * @param env - Environment that selects the runtime source.
 * @returns The shipped runtime, or undefined when `WASD_SUPERCOLLIDER_BUNDLE=0` or the manifest has no build for the
 * target, in which case the plugin uses a SuperCollider installed on the user's machine.
 * @throws When the manifest cannot be read, the tree has no SuperCollider plugin package, or the archive or its files
 * fail verification.
 */
export async function stageSuperColliderRuntime(
  dshRoot: string, target: RuntimeTarget, env: NodeJS.ProcessEnv = process.env,
): Promise<ShippedRuntime | undefined> {
  return await stageRuntimeArchive(SUPERCOLLIDER, dshRoot, target, env)
}
