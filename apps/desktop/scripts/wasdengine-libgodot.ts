/**
 * Ship the WASD Engine LibGodot runtime with the Desktop app (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes). Before `prepare-dsh.ts` signs the prepared dsh tree and writes its runtime descriptor,
 * `stageLibGodotRuntime` puts the runtime of the packaged platform into `@deepseek-ai/dsh-godot`'s
 * `libgodot/<platform>-<arch>/` folder, where the Godot plugin looks before its managed download, and
 * `applyWasdengineLibGodot` in `wasdengine-builder-config.mjs` keeps that folder outside `app.asar`.
 *
 * The runtime comes from a release manifest that `.github/workflows/wasd-libgodot.yml` publishes, by default the one
 * the Godot plugin's `runtimeManifestUrl` names, or from a `wasdengine/libgodot/build.sh --out` folder. The archive
 * must match the manifest's size and SHA-256, and its `runtime.json` must name the manifest's version and Godot
 * release, the packaged platform and architecture, and the SHA-256 of the runner and the library.
 *
 * Environment: `WASD_LIBGODOT_DIR` names a local folder holding `manifest.json` and its archives;
 * `WASD_LIBGODOT_MANIFEST_URL` replaces the default manifest; `WASD_LIBGODOT_BUNDLE=0` packages without LibGodot.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fileSha256, isRecord, parseRuntimeArchive, stageRuntimeArchive, type RuntimeArchive, type RuntimeTarget, type ShippedRuntime,
  type ShippedRuntimeKind,
} from './wasdengine-runtime-archive.ts'

/** The Godot plugin's default `runtimeManifestUrl`; `wasdengine-libgodot.spec.ts` keeps the two equal. */
export const LIBGODOT_MANIFEST_URL = 'https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.2/manifest.json'

/** One platform's archive in a LibGodot runtime manifest. */
interface Artifact extends RuntimeArchive {
  readonly runner: string
  readonly library: string
}

/** A format 1 LibGodot runtime manifest, as `wasdengine/libgodot/build.sh` writes it. */
interface Manifest {
  readonly version: string
  readonly godot: string
  readonly artifacts: Readonly<Record<string, Artifact>>
}

/** The packaged platform and architecture, in Node.js names. */
export type LibGodotTarget = RuntimeTarget

/** The LibGodot runtime one packaging run ships. */
export type ShippedLibGodot = ShippedRuntime

function isFileName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\\]+$/u.test(value) && value !== '.' && value !== '..'
}

function parseArtifact(value: unknown): Artifact | undefined {
  const archive = parseRuntimeArchive(value)
  if (archive === undefined || !isRecord(value)) return undefined
  const { runner, library } = value
  return isFileName(runner) && isFileName(library) ? { ...archive, runner, library } : undefined
}

const LIBGODOT: ShippedRuntimeKind<Artifact, Manifest> = {
  label: 'LibGodot',
  environmentPrefix: 'WASD_LIBGODOT',
  manifestUrl: LIBGODOT_MANIFEST_URL,
  remedy: 'Publish the runtime with .github/workflows/wasd-libgodot.yml, set WASD_LIBGODOT_DIR to a '
    + 'wasdengine/libgodot/build.sh --out folder, or set WASD_LIBGODOT_BUNDLE=0 to package without LibGodot.',
  packageName: '@deepseek-ai/dsh-godot',
  folder: 'libgodot',
  parseManifest(value, source) {
    if (!isRecord(value) || value.format !== 1 || typeof value.version !== 'string' || typeof value.godot !== 'string'
      || !isRecord(value.artifacts)) {
      throw new Error(`desktop runtime: the LibGodot manifest ${source} is not a format 1 runtime manifest`)
    }
    const artifacts: Record<string, Artifact> = {}
    for (const [key, entry] of Object.entries(value.artifacts)) {
      const artifact = parseArtifact(entry)
      if (artifact === undefined) throw new Error(`desktop runtime: the LibGodot manifest ${source} lists an invalid ${key} archive`)
      artifacts[key] = artifact
    }
    return { version: value.version, godot: value.godot, artifacts }
  },
  async verify(directory, manifest, artifact, target) {
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    } catch (error) {
      throw new Error('desktop runtime: the LibGodot archive has no readable runtime.json', { cause: error })
    }
    if (!isRecord(record) || record.format !== 1 || record.version !== manifest.version || record.godot !== manifest.godot
      || record.platform !== target.platform || record.arch !== target.arch
      || record.runner !== artifact.runner || record.library !== artifact.library || !isRecord(record.sha256)) {
      throw new Error(`desktop runtime: the LibGodot archive's runtime.json does not describe ${manifest.version} for ${target.platform}-${target.arch}`)
    }
    for (const name of [artifact.runner, artifact.library]) {
      if (record.sha256[name] !== await fileSha256(join(directory, name))) {
        throw new Error(`desktop runtime: LibGodot ${name} does not match the SHA-256 its runtime.json lists`)
      }
    }
    return [artifact.runner]
  },
  describe: manifest => `LibGodot ${manifest.version} (Godot ${manifest.godot})`,
}

/**
 * Put the LibGodot runtime of the packaged platform into the prepared dsh tree's Godot plugin package.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param target - Packaged platform and architecture.
 * @param env - Environment that selects the runtime source.
 * @returns The shipped runtime, or undefined when `WASD_LIBGODOT_BUNDLE=0` or the manifest has no build for the target,
 * in which case the Godot plugin falls back to its managed download.
 * @throws When the manifest cannot be read, the tree has no Godot plugin package, or the archive or its files fail
 * verification.
 */
export async function stageLibGodotRuntime(
  dshRoot: string, target: LibGodotTarget, env: NodeJS.ProcessEnv = process.env,
): Promise<ShippedLibGodot | undefined> {
  return await stageRuntimeArchive(LIBGODOT, dshRoot, target, env)
}
