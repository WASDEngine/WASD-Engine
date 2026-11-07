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
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'

/** The Godot plugin's default `runtimeManifestUrl`; `wasdengine-libgodot.spec.ts` keeps the two equal. */
export const LIBGODOT_MANIFEST_URL = 'https://github.com/WASDEngine/WASDEngine/releases/download/libgodot-4.7.2-wasd.1/manifest.json'

/** What to do when no runtime can be read; packaging stops until one of these holds. */
const REMEDY = 'Publish the runtime with .github/workflows/wasd-libgodot.yml, set WASD_LIBGODOT_DIR to a '
  + 'wasdengine/libgodot/build.sh --out folder, or set WASD_LIBGODOT_BUNDLE=0 to package without LibGodot.'

const SHA256 = /^[0-9a-f]{64}$/u

/** One platform's archive in a runtime manifest. */
interface Artifact {
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly runner: string
  readonly library: string
}

/** A format 1 runtime manifest, as `wasdengine/libgodot/build.sh` writes it. */
interface Manifest {
  readonly version: string
  readonly godot: string
  readonly artifacts: Readonly<Record<string, Artifact>>
}

/** The packaged platform and architecture, in Node.js names. */
export interface LibGodotTarget {
  readonly platform: string
  readonly arch: string
}

/** The runtime one packaging run ships. */
export interface ShippedLibGodot {
  /** Runtime version, such as `4.7.2-wasd.1`. */
  readonly version: string
  /** Absolute folder holding the runner, the library, and `runtime.json`. */
  readonly directory: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\\]+$/u.test(value) && value !== '.' && value !== '..'
}

function parseArtifact(value: unknown): Artifact | undefined {
  if (!isRecord(value)) return undefined
  const { url, bytes, sha256, runner, library } = value
  if (typeof url !== 'string' || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined
  if (typeof sha256 !== 'string' || !SHA256.test(sha256) || !isFileName(runner) || !isFileName(library)) return undefined
  return { url, bytes, sha256, runner, library }
}

function parseManifest(value: unknown, source: string): Manifest {
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
}

async function fetchManifest(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`desktop runtime: cannot reach the LibGodot manifest ${url}: ${(error as Error).message}. ${REMEDY}`, { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`desktop runtime: the LibGodot manifest ${url} answered HTTP ${String(response.status)}. ${REMEDY}`)
  }
  return response.json()
}

/** Copy `source` to `destination` while checking it against the manifest's size and SHA-256. */
async function copyVerified(source: Readable, destination: string, artifact: Artifact, name: string): Promise<void> {
  const digest = createHash('sha256')
  let bytes = 0
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > artifact.bytes) {
        callback(new Error(`desktop runtime: the LibGodot archive ${name} is larger than the ${String(artifact.bytes)} bytes its manifest lists`))
        return
      }
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(source, counting, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  if (bytes !== artifact.bytes) {
    throw new Error(`desktop runtime: the LibGodot archive ${name} has ${String(bytes)} bytes; its manifest lists ${String(artifact.bytes)}`)
  }
  if (digest.digest('hex') !== artifact.sha256) {
    throw new Error(`desktop runtime: the LibGodot archive ${name} does not match the SHA-256 its manifest lists`)
  }
}

async function download(url: string, destination: string, artifact: Artifact): Promise<void> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`desktop runtime: cannot download the LibGodot archive ${url}: ${(error as Error).message}`, { cause: error })
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error(`desktop runtime: downloading the LibGodot archive ${url} answered HTTP ${String(response.status)}`)
  }
  await copyVerified(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), destination, artifact, url)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function fileSha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

/** Check an extracted archive's `runtime.json` against the manifest, the target, and the files beside it. */
async function verifyRuntime(directory: string, manifest: Manifest, artifact: Artifact, target: LibGodotTarget): Promise<void> {
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
  if (env.WASD_LIBGODOT_BUNDLE === '0') {
    console.log('desktop runtime: WASD_LIBGODOT_BUNDLE=0, so the app ships without LibGodot')
    return undefined
  }
  const local = env.WASD_LIBGODOT_DIR ?? ''
  const source = local !== '' ? join(local, 'manifest.json') : env.WASD_LIBGODOT_MANIFEST_URL ?? LIBGODOT_MANIFEST_URL
  let raw: unknown
  if (local === '') raw = await fetchManifest(source)
  else {
    try {
      raw = JSON.parse(await readFile(source, 'utf8'))
    } catch (error) {
      throw new Error(`desktop runtime: cannot read the LibGodot manifest ${source}. ${REMEDY}`, { cause: error })
    }
  }
  const manifest = parseManifest(raw, source)
  const key = `${target.platform}-${target.arch}`
  const artifact = manifest.artifacts[key]
  if (artifact === undefined) {
    console.log(`desktop runtime: LibGodot ${manifest.version} has no ${key} build, so the app ships without it`)
    return undefined
  }
  const pluginRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-godot')
  if (!await isFile(join(pluginRoot, 'package.json'))) {
    throw new Error('desktop runtime: the dsh tree has no @deepseek-ai/dsh-godot package to ship LibGodot in')
  }
  const root = join(pluginRoot, 'libgodot')
  const work = join(root, `.staging-${randomUUID()}`)
  await mkdir(work, { recursive: true })
  try {
    const archive = join(work, 'runtime.tar.gz')
    if (local === '') await download(new URL(artifact.url, source).href, archive, artifact)
    else {
      // A local folder holds each archive under the name its release URL ends with.
      const file = join(local, posix.basename(new URL(artifact.url, 'file:///').pathname))
      await copyVerified(createReadStream(file), archive, artifact, file)
    }
    const extracted = join(work, key)
    await mkdir(extracted)
    await promisify(execFile)('tar', ['-xzf', archive, '-C', extracted])
    await verifyRuntime(extracted, manifest, artifact, target)
    if (target.platform !== 'win32') await chmod(join(extracted, artifact.runner), 0o755)
    const destination = join(root, key)
    await rm(destination, { recursive: true, force: true })
    await rename(extracted, destination)
    console.log(`desktop runtime: shipping LibGodot ${manifest.version} (Godot ${manifest.godot}) for ${key}`)
    return { version: manifest.version, directory: destination }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
