/**
 * Ship a native runtime inside a plugin package of the Desktop app (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes). `wasdengine-libgodot.ts`, `wasdengine-supercollider.ts`, and `wasdengine-gimp.ts` describe their runtimes with a
 * {@link ShippedRuntimeKind}; `stageRuntimeArchive` reads the kind's release manifest, from a URL or from a local
 * `build.sh --out` folder, checks the archive of the packaged platform against the manifest's size and SHA-256,
 * unpacks it with `tar`, lets the kind check the unpacked files, and moves them into
 * `<package>/<folder>/<platform>-<arch>/` of the prepared dsh tree. For a platform where the kind ships the archive
 * itself, that folder holds the checked archive and an `archive.json` instead, and the plugin unpacks the archive on
 * first use. `shippedRuntimeVersion` reads which version of a runtime a prepared tree holds, which
 * `checkWasdengineRuntimes` in `wasdengine-runtime-signing.ts` compares with the version the kind pins.
 *
 * Environment, for a kind whose prefix is `WASD_X`: `WASD_X_DIR` names a local folder holding `manifest.json` and its
 * archives; `WASD_X_MANIFEST_URL` replaces the default manifest; `WASD_X_BUNDLE=0` packages without the runtime.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const SHA256 = /^[0-9a-f]{64}$/u

/** The fields every runtime manifest gives one platform's archive. */
export interface RuntimeArchive {
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

/** A format 1 runtime manifest: one runtime version and its archives by `<platform>-<arch>`. */
export interface RuntimeManifest<A extends RuntimeArchive> {
  readonly version: string
  readonly artifacts: Readonly<Record<string, A>>
}

/** The packaged platform and architecture, in Node.js names. */
export interface RuntimeTarget {
  readonly platform: string
  readonly arch: string
}

/** The runtime one packaging run ships. */
export interface ShippedRuntime {
  /** Runtime version, such as `4.7.2-wasd.1`. */
  readonly version: string
  /** Absolute folder holding the unpacked runtime and its `runtime.json`. */
  readonly directory: string
}

/** A runtime that the Desktop app ships, where the prepared dsh tree holds it, and the version that a release pins. */
export interface PinnedRuntime {
  /** Runtime name in messages, such as `LibGodot`. */
  readonly label: string
  /** Prefix of the environment variables, such as `WASD_LIBGODOT`. */
  readonly environmentPrefix: string
  /** Plugin package that holds the runtime, such as `@deepseek-ai/dsh-godot`. */
  readonly packageName: string
  /** Folder of the package that holds one `<platform>-<arch>` folder per runtime. */
  readonly folder: string
  /** Runtime version that the default manifest URL names and that every signed build ships, such as `4.7.2-wasd.3`. */
  readonly version: string
}

/** What differs between the runtimes that the Desktop app ships. */
export interface ShippedRuntimeKind<A extends RuntimeArchive, M extends RuntimeManifest<A>> extends PinnedRuntime {
  /** Manifest read without a local folder or a manifest URL in the environment. */
  readonly manifestUrl: string
  /** What to do when no manifest can be read; packaging stops until one of these holds. */
  readonly remedy: string
  /**
   * Validate a parsed manifest.
   * @param value - parsed JSON.
   * @param source - manifest URL or path, for messages.
   * @returns the manifest.
   * @throws When the value is not a format 1 manifest of this runtime.
   */
  parseManifest(value: unknown, source: string): M
  /**
   * Check the unpacked archive against its `runtime.json`, the manifest, and the target.
   * @param directory - folder holding the unpacked archive.
   * @param manifest - the validated manifest.
   * @param artifact - the target's archive entry.
   * @param target - packaged platform and architecture.
   * @returns the files, relative to `directory`, that must be executable.
   * @throws When a file or a field does not match.
   */
  verify(directory: string, manifest: M, artifact: A, target: RuntimeTarget): Promise<readonly string[]>
  /**
   * Name the shipped runtime in the packaging log.
   * @param manifest - the validated manifest.
   * @returns text such as `LibGodot 4.7.2-wasd.1 (Godot 4.7.2-stable)`.
   */
  describe(manifest: M): string
  /**
   * Whether the app ships the checked archive itself, with an `archive.json`, for the plugin to unpack on first use,
   * instead of the unpacked files; for a platform whose deepest runtime paths would pass the path length limit below
   * the app's install folder. Omitted, the app ships the unpacked files.
   * @param target - packaged platform and architecture.
   * @returns true to ship the archive.
   */
  shipsArchive?(target: RuntimeTarget): boolean
}

/** The `archive.json` file of a runtime that the app ships as its archive. */
export const ARCHIVE_RECORD_FILE = 'archive.json'

/**
 * Whether a value is a JSON object.
 * @param value - parsed JSON.
 * @returns true for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The fields of an archive entry that every manifest gives, when they are valid.
 * @param value - one entry of `artifacts`.
 * @returns the URL, size, and SHA-256, or undefined when one is missing or invalid.
 */
export function parseRuntimeArchive(value: unknown): RuntimeArchive | undefined {
  if (!isRecord(value)) return undefined
  const { url, bytes, sha256 } = value
  if (typeof url !== 'string' || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined
  return { url, bytes, sha256 }
}

/**
 * The SHA-256 of a file.
 * @param path - file path.
 * @returns lowercase hexadecimal digest.
 */
export async function fileSha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

/** Every file below `directory`, as `/`-separated relative paths; anything but a file or a folder fails. */
async function filesBelow(directory: string, label: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await filesBelow(directory, label, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`desktop runtime: the ${label} archive holds ${path}, which is not a file or a folder`)
  }
  return files
}

/**
 * Check that an unpacked archive holds exactly the files that the `sha256` field of its `runtime.json` lists, each with
 * the listed SHA-256.
 * @param directory - folder holding the unpacked archive.
 * @param digests - `runtime.json`'s map from `/`-separated relative path to SHA-256.
 * @param label - runtime name in messages, such as `SuperCollider`.
 * @returns the files, sorted, without `runtime.json`.
 * @throws When a file is unlisted, missing, not a file or a folder, or does not match its SHA-256.
 */
export async function verifyListedFiles(directory: string, digests: Readonly<Record<string, unknown>>, label: string): Promise<string[]> {
  const files = (await filesBelow(directory, label)).filter(file => file !== 'runtime.json').sort()
  const listed = Object.keys(digests).sort()
  const unlisted = files.filter(file => !Object.hasOwn(digests, file))
  const missing = listed.filter(file => !files.includes(file))
  if (unlisted.length > 0 || missing.length > 0) {
    throw new Error(`desktop runtime: the ${label} archive does not hold exactly the files its runtime.json lists `
      + `(unlisted: ${unlisted.slice(0, 5).join(', ') || 'none'}; missing: ${missing.slice(0, 5).join(', ') || 'none'})`)
  }
  for (const file of files) {
    if (digests[file] !== await fileSha256(join(directory, ...file.split('/')))) {
      throw new Error(`desktop runtime: ${label} ${file} does not match the SHA-256 its runtime.json lists`)
    }
  }
  return files
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

async function fetchManifest(url: string, label: string, remedy: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`desktop runtime: cannot reach the ${label} manifest ${url}: ${(error as Error).message}. ${remedy}`, { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`desktop runtime: the ${label} manifest ${url} answered HTTP ${String(response.status)}. ${remedy}`)
  }
  return response.json()
}

/**
 * A download failure that another attempt would repeat: an HTTP error status other than a transient one
 * ({@link transientStatus}), or bytes that differ from the pin.
 */
class FinalDownloadError extends Error {}

/**
 * Attempts of a download whose transfer fails, breaks off, as HTTP/2 streams of large files sometimes do, stalls, or
 * meets a transient HTTP status.
 */
const DOWNLOAD_ATTEMPTS = 3

/** Longest wait, in milliseconds, for a download's response or its next bytes before the attempt gives up. */
const DOWNLOAD_STALL_MS = 60_000

/** Wait, in milliseconds, before a download's second attempt; the third waits twice as long. */
const DOWNLOAD_RETRY_DELAY_MS = 5_000

/**
 * Whether an HTTP status says the server may answer another attempt: a request timeout, too early, too many requests,
 * or a server error.
 * @param status - The response's status.
 * @returns Whether to try again.
 */
function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Copy `source` to a new file while checking it against a pinned size and SHA-256.
 * @param source - The file's bytes.
 * @param destination - Path of the new file, which must not exist.
 * @param artifact - The size and SHA-256 the bytes must have.
 * @param name - What the bytes came from, for errors.
 * @param label - What the file is, for errors, such as `LibGodot`.
 * @param pinnedBy - What pins the size and SHA-256, for errors.
 * @throws When the bytes differ from the pin; the caller removes the partial file.
 */
export async function copyVerified(
  source: Readable, destination: string, artifact: RuntimeArchive, name: string, label: string, pinnedBy = 'its manifest',
): Promise<void> {
  const digest = createHash('sha256')
  let bytes = 0
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > artifact.bytes) {
        callback(new FinalDownloadError(`desktop runtime: the ${label} archive ${name} is larger than the ${String(artifact.bytes)} bytes ${pinnedBy} lists`))
        return
      }
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(source, counting, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  if (bytes !== artifact.bytes) {
    throw new FinalDownloadError(`desktop runtime: the ${label} archive ${name} has ${String(bytes)} bytes; ${pinnedBy} lists ${String(artifact.bytes)}`)
  }
  if (digest.digest('hex') !== artifact.sha256) {
    throw new FinalDownloadError(`desktop runtime: the ${label} archive ${name} does not match the SHA-256 ${pinnedBy} lists`)
  }
}

/** Options of a download. */
interface DownloadOptions {
  /** Request headers, such as a User-Agent that a host requires. */
  readonly headers?: Record<string, string>
  /** What pins the size and SHA-256, for errors. */
  readonly pinnedBy?: string
  /** Longest wait, in milliseconds, for the response or its next bytes; {@link DOWNLOAD_STALL_MS} by default. */
  readonly stallMs?: number
  /** Wait, in milliseconds, before the second attempt, which the third doubles; {@link DOWNLOAD_RETRY_DELAY_MS} by default. */
  readonly retryDelayMs?: number
}

/**
 * Download a URL into a new file while checking it against a pinned size and SHA-256. A transfer that fails, breaks
 * off, waits longer than `stallMs` for its response or its next bytes, or meets a transient HTTP status
 * ({@link transientStatus}) starts over after a pause, up to three attempts in all; another HTTP error status or bytes
 * that differ from the pin end it at once.
 * @param url - What to download; redirects are followed.
 * @param destination - Path of the new file, which must not exist.
 * @param artifact - The size and SHA-256 the download must have.
 * @param label - What the file is, for errors, such as `LibGodot`.
 * @param options - Request headers, what pins the size and SHA-256, and the stall and retry waits.
 * @throws When the last attempt fails, the server answers with an error status that is not transient, or the bytes
 * differ from the pin; the caller removes the partial file.
 */
export async function downloadVerified(
  url: string, destination: string, artifact: RuntimeArchive, label: string, options: DownloadOptions = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await downloadOnce(url, destination, artifact, label, options)
      return
    } catch (error) {
      if (error instanceof FinalDownloadError || attempt >= DOWNLOAD_ATTEMPTS) throw error
      await rm(destination, { force: true })
      console.warn(`desktop runtime: downloading the ${label} archive ${url} failed (${(error as Error).message}); `
        + `starting over, attempt ${String(attempt + 1)} of ${String(DOWNLOAD_ATTEMPTS)}`)
      await delay((options.retryDelayMs ?? DOWNLOAD_RETRY_DELAY_MS) * attempt)
    }
  }
}

/** One attempt of {@link downloadVerified}, which gives up once the response or its next bytes take longer than `stallMs`. */
async function downloadOnce(
  url: string, destination: string, artifact: RuntimeArchive, label: string, options: DownloadOptions,
): Promise<void> {
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS
  const controller = new AbortController()
  const stall = (): void => { controller.abort() }
  let timer = setTimeout(stall, stallMs)
  const arrived = (): void => {
    clearTimeout(timer)
    timer = setTimeout(stall, stallMs)
  }
  try {
    let response: Response
    try {
      response = await fetch(url, { headers: options.headers ?? {}, signal: controller.signal })
    } catch (error) {
      throw new Error(`desktop runtime: cannot download the ${label} archive ${url}: ${(error as Error).message}`, { cause: error })
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      const message = `desktop runtime: downloading the ${label} archive ${url} answered HTTP ${String(response.status)}`
      throw transientStatus(response.status) ? new Error(message) : new FinalDownloadError(message)
    }
    arrived()
    const body = watchedChunks(response.body as ReadableStream<Uint8Array>, arrived, controller.signal)
    await copyVerified(Readable.from(body), destination, artifact, url, label, options.pinnedBy)
  } catch (error) {
    if (!controller.signal.aborted || error instanceof FinalDownloadError) throw error
    throw new Error(`desktop runtime: downloading the ${label} archive ${url} stalled: nothing arrived for ${String(stallMs)} ms`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pass a download's chunks on, reporting each one's arrival, until `signal` aborts, which cancels the body and fails
 * the read that waits.
 * @param body - The response body.
 * @param arrived - Called as each chunk arrives.
 * @param signal - The attempt's stall signal.
 * @yields The chunks, in order.
 * @throws The signal's reason once it aborts.
 */
async function* watchedChunks(body: ReadableStream<Uint8Array>, arrived: () => void, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const cancel = (): void => {
    reader.cancel().catch(() => {
      // A body that already failed: the waiting read fails with it, and the attempt reports the stall either way.
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const next = await reader.read()
      // A cancelled body ends its waiting read as if the body were complete.
      signal.throwIfAborted()
      if (next.done) return
      arrived()
      yield next.value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/**
 * Put a runtime of the packaged platform into its plugin package in the prepared dsh tree.
 * @param kind - the runtime's manifest format, checks, package, and environment variables.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param target - Packaged platform and architecture.
 * @param env - Environment that selects the runtime source.
 * @returns The shipped runtime, or undefined when `<prefix>_BUNDLE=0` or the manifest has no build for the target.
 * @throws When the manifest cannot be read, the tree has no plugin package, or the archive or its files fail verification.
 */
export async function stageRuntimeArchive<A extends RuntimeArchive, M extends RuntimeManifest<A>>(
  kind: ShippedRuntimeKind<A, M>, dshRoot: string, target: RuntimeTarget, env: NodeJS.ProcessEnv,
): Promise<ShippedRuntime | undefined> {
  if (env[`${kind.environmentPrefix}_BUNDLE`] === '0') {
    console.log(`desktop runtime: ${kind.environmentPrefix}_BUNDLE=0, so the app ships without ${kind.label}`)
    return undefined
  }
  const local = env[`${kind.environmentPrefix}_DIR`] ?? ''
  const source = local !== '' ? join(local, 'manifest.json') : env[`${kind.environmentPrefix}_MANIFEST_URL`] ?? kind.manifestUrl
  let raw: unknown
  if (local === '') raw = await fetchManifest(source, kind.label, kind.remedy)
  else {
    try {
      raw = JSON.parse(await readFile(source, 'utf8'))
    } catch (error) {
      throw new Error(`desktop runtime: cannot read the ${kind.label} manifest ${source}. ${kind.remedy}`, { cause: error })
    }
  }
  const manifest = kind.parseManifest(raw, source)
  const key = `${target.platform}-${target.arch}`
  const artifact = manifest.artifacts[key]
  if (artifact === undefined) {
    console.log(`desktop runtime: ${kind.label} ${manifest.version} has no ${key} build, so the app ships without it`)
    return undefined
  }
  const pluginRoot = join(dshRoot, 'node_modules', ...kind.packageName.split('/'))
  if (!await isFile(join(pluginRoot, 'package.json'))) {
    throw new Error(`desktop runtime: the dsh tree has no ${kind.packageName} package to ship ${kind.label} in`)
  }
  const root = join(pluginRoot, kind.folder)
  const work = join(root, `.staging-${randomUUID()}`)
  await mkdir(work, { recursive: true })
  try {
    const archive = join(work, 'runtime.tar.gz')
    if (local === '') await downloadVerified(new URL(artifact.url, source).href, archive, artifact, kind.label)
    else {
      // A local folder holds each archive under the name its release URL ends with.
      const file = join(local, posix.basename(new URL(artifact.url, 'file:///').pathname))
      await copyVerified(createReadStream(file), archive, artifact, file, kind.label)
    }
    const extracted = join(work, key)
    await mkdir(extracted)
    await promisify(execFile)('tar', ['-xzf', archive, '-C', extracted])
    const executables = await kind.verify(extracted, manifest, artifact, target)
    const destination = join(root, key)
    if (kind.shipsArchive?.(target) === true) {
      const packed = join(work, `${key}.archive`)
      const name = posix.basename(new URL(artifact.url, 'file:///').pathname)
      await mkdir(packed)
      await rename(archive, join(packed, name))
      // archive.json carries the archive's runtime.json without its file digests, so the plugin reads the runtime's
      // fields before it unpacks the archive.
      const { sha256: _digests, ...runtime } = JSON.parse(await readFile(join(extracted, 'runtime.json'), 'utf8')) as Record<string, unknown>
      const record = { format: 1, archive: name, bytes: artifact.bytes, sha256: artifact.sha256, runtime }
      await writeFile(join(packed, ARCHIVE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
      await rm(destination, { recursive: true, force: true })
      await rename(packed, destination)
      console.log(`desktop runtime: shipping ${kind.describe(manifest)} for ${key} as its archive, which the plugin unpacks on first use`)
      return { version: manifest.version, directory: destination }
    }
    if (target.platform !== 'win32') for (const file of executables) await chmod(join(extracted, file), 0o755)
    await rm(destination, { recursive: true, force: true })
    await rename(extracted, destination)
    console.log(`desktop runtime: shipping ${kind.describe(manifest)} for ${key}`)
    return { version: manifest.version, directory: destination }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** A JSON file's value, or undefined when the file does not exist. */
async function readJsonIfPresent(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  return JSON.parse(text)
}

/**
 * Read the version of a runtime that a prepared dsh tree ships for a target.
 * @param dshRoot - Prepared dsh tree.
 * @param runtime - The runtime's package and folder.
 * @param target - Packaged platform and architecture.
 * @returns The version that the shipped `runtime.json` names or, for a runtime shipped as its archive, the one that the
 *   runtime of its `archive.json` names; undefined when the tree holds neither file.
 * @throws When the file is not JSON or names no version.
 */
export async function shippedRuntimeVersion(dshRoot: string, runtime: PinnedRuntime, target: RuntimeTarget): Promise<string | undefined> {
  const directory = join(dshRoot, 'node_modules', ...runtime.packageName.split('/'), runtime.folder, `${target.platform}-${target.arch}`)
  const unpacked = await readJsonIfPresent(join(directory, 'runtime.json'))
  const record = unpacked ?? await readJsonIfPresent(join(directory, ARCHIVE_RECORD_FILE))
  if (record === undefined) return undefined
  const described = unpacked === undefined && isRecord(record) ? record.runtime : record
  if (!isRecord(described) || typeof described.version !== 'string') {
    throw new Error(`desktop runtime: the ${runtime.label} runtime in ${directory} names no version`)
  }
  return described.version
}
