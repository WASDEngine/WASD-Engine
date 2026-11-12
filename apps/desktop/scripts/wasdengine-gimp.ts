/**
 * Ship the WASD Engine GIMP runtime with the Desktop app (fork-owned; `wasdengine/FORK.md` lists the fork changes).
 * Before `prepare-dsh.ts` signs the prepared dsh tree and writes its runtime descriptor, `stageGimpRuntime` puts the
 * runtime of the packaged platform into `@deepseek-ai/dsh-gimp`'s `runtime/<platform>-<arch>/` folder, where the GIMP
 * plugin looks for it, and `applyWasdengineGimp` in `wasdengine-builder-config.mjs` keeps that folder outside
 * `app.asar`. On macOS, the `sign:dsh-native` step then signs gimp-console, GIMP's libraries and plug-ins, and its
 * Python with the other Mach-O files of the tree. On Windows, whose path length limit the deepest runtime files would
 * pass below the app's install folder, the folder holds the checked archive and its `archive.json`, and the plugin
 * unpacks the archive under its data folder on first use.
 *
 * The runtime comes from the release manifest that `.github/workflows/wasd-gimp.yml` publishes, or from a
 * `wasdengine/gimp/build.sh --out` folder. The archive must match the manifest's size and SHA-256, and its
 * `runtime.json` must name the manifest's runtime and GIMP versions and the packaged platform and architecture, name a
 * console and folders that the archive holds, and list every unpacked file, and only those, with its SHA-256.
 *
 * Environment: `WASD_GIMP_DIR` names a local folder holding `manifest.json` and its archives; `WASD_GIMP_MANIFEST_URL`
 * replaces the default manifest; `WASD_GIMP_BUNDLE=0` packages without GIMP.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isRecord, parseRuntimeArchive, stageRuntimeArchive, verifyListedFiles, type RuntimeArchive, type RuntimeTarget, type ShippedRuntime,
  type ShippedRuntimeKind,
} from './wasdengine-runtime-archive.ts'

/** Manifest of the GIMP runtime release that `wasdengine/gimp/build.sh` builds by default. */
export const GIMP_MANIFEST_URL = 'https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-3.2.8-wasd.2/manifest.json'

/** A format 1 GIMP runtime manifest, as `wasdengine/gimp/runtime.py` writes it. */
interface Manifest {
  readonly version: string
  readonly gimp: string
  readonly artifacts: Readonly<Record<string, RuntimeArchive>>
}

/** Folders of `runtime.json` that GIMP reads through `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR`. */
const FOLDERS = ['dataDir', 'localeDir', 'sysconfDir'] as const

const GIMP: ShippedRuntimeKind<RuntimeArchive, Manifest> = {
  label: 'GIMP',
  environmentPrefix: 'WASD_GIMP',
  manifestUrl: GIMP_MANIFEST_URL,
  remedy: 'Publish the runtime with .github/workflows/wasd-gimp.yml, set WASD_GIMP_DIR to a wasdengine/gimp/build.sh --out folder, '
    + 'or set WASD_GIMP_BUNDLE=0 to package without GIMP.',
  packageName: '@deepseek-ai/dsh-gimp',
  folder: 'runtime',
  parseManifest(value, source) {
    if (!isRecord(value) || value.format !== 1 || typeof value.version !== 'string' || typeof value.gimp !== 'string' || !isRecord(value.artifacts)) {
      throw new Error(`desktop runtime: the GIMP manifest ${source} is not a format 1 runtime manifest`)
    }
    const artifacts: Record<string, RuntimeArchive> = {}
    for (const [key, entry] of Object.entries(value.artifacts)) {
      const artifact = parseRuntimeArchive(entry)
      if (artifact === undefined) throw new Error(`desktop runtime: the GIMP manifest ${source} lists an invalid ${key} archive`)
      artifacts[key] = artifact
    }
    return { version: value.version, gimp: value.gimp, artifacts }
  },
  async verify(directory, manifest, _artifact, target) {
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    } catch (error) {
      throw new Error('desktop runtime: the GIMP archive has no readable runtime.json', { cause: error })
    }
    const key = `${target.platform}-${target.arch}`
    if (!isRecord(record) || record.format !== 1 || record.version !== manifest.version || record.gimp !== manifest.gimp
      || record.platform !== target.platform || record.arch !== target.arch || !isRecord(record.sha256)
      || typeof record.console !== 'string' || FOLDERS.some(field => typeof record[field] !== 'string')) {
      throw new Error(`desktop runtime: the GIMP archive's runtime.json does not describe ${manifest.version} for ${key}`)
    }
    const files = await verifyListedFiles(directory, record.sha256, 'GIMP')
    if (!files.includes(record.console)) {
      throw new Error(`desktop runtime: the GIMP archive's runtime.json names ${record.console}, which it does not hold`)
    }
    for (const field of FOLDERS) {
      const folder = String(record[field])
      if (!files.some(file => file.startsWith(`${folder}/`))) {
        throw new Error(`desktop runtime: the GIMP archive's runtime.json names the folder ${folder}, which holds no file`)
      }
    }
    return [record.console]
  },
  describe: manifest => `GIMP runtime ${manifest.version} (GIMP ${manifest.gimp})`,
  shipsArchive: target => target.platform === 'win32',
}

/**
 * Put the GIMP runtime of the packaged platform into the prepared dsh tree's GIMP plugin package.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param target - Packaged platform and architecture.
 * @param env - Environment that selects the runtime source.
 * @returns The shipped runtime, or undefined when `WASD_GIMP_BUNDLE=0` or the manifest has no build for the target, in
 * which case the plugin uses a GIMP 3 installed on the user's machine. For Windows, its folder holds the archive and
 * `archive.json`.
 * @throws When the manifest cannot be read, the tree has no GIMP plugin package, or the archive or its files fail
 * verification.
 */
export async function stageGimpRuntime(
  dshRoot: string, target: RuntimeTarget, env: NodeJS.ProcessEnv = process.env,
): Promise<ShippedRuntime | undefined> {
  return await stageRuntimeArchive(GIMP, dshRoot, target, env)
}
