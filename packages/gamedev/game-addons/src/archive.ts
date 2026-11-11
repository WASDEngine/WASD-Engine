/**
 * Add-on archives: each pinned zip is downloaded once into `<dataRoot>/archives/<sha256>.zip`, streaming into a
 * temporary file while its size and SHA-256 are checked against the catalog, and only a matching file takes its
 * cache name. Unpacking reads the archive's central directory and streams one folder's files into a new folder, so
 * memory stays bounded however large the archive is; entry names with absolute paths, `..` segments, or backslashes
 * stop it, and macOS metadata entries are skipped.
 * @module @deepseek-ai/dsh-game-addons/src/archive
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import type { GameAddonArchive } from './types.ts'

/** Archive entries that are never installed: macOS resource forks and Finder metadata. */
function isMetadata(name: string): boolean {
  return name.split('/').some(segment => segment === '__MACOSX' || segment === '.DS_Store')
}

/** An archive that could not be downloaded, did not match its pin, or could not be unpacked. */
export class GameAddonArchiveError extends Error {
  override name = 'GameAddonArchiveError'
}

/** How archives are downloaded. */
export interface ArchiveDownloads {
  /** Absolute folder of the archive cache. */
  readonly cacheDir: string
  /**
   * Start one download.
   * @param url - archive URL.
   * @param signal - cancellation of the request and its body.
   * @returns the response.
   */
  readonly fetch: (url: string, signal: AbortSignal) => Promise<Response>
}

/**
 * The cached archive of a pin, downloading it when it is not cached yet.
 * @param archive - the catalog's pin.
 * @param downloads - cache folder and fetch.
 * @param signal - cancellation.
 * @returns the absolute path of the checked archive.
 * @throws {GameAddonArchiveError} when the request fails or the archive's size or SHA-256 differs from the pin.
 */
export async function cachedArchive(archive: GameAddonArchive, downloads: ArchiveDownloads, signal: AbortSignal): Promise<string> {
  const target = join(downloads.cacheDir, `${archive.sha256}.zip`)
  try {
    const existing = await stat(target)
    if (existing.isFile() && existing.size === archive.bytes) return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(downloads.cacheDir, { recursive: true })
  const temporary = `${target}.${randomUUID()}.part`
  try {
    let response: Response
    try {
      response = await downloads.fetch(archive.url, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new GameAddonArchiveError(`Downloading ${archive.url} failed: ${(error as Error).message}`)
    }
    if (!response.ok || response.body === null) {
      throw new GameAddonArchiveError(`Downloading ${archive.url} failed with HTTP ${response.status}.`)
    }
    const hash = createHash('sha256')
    let bytes = 0
    // An explicit handle is closed before the temporary file is removed, so a failed download leaves no file behind.
    const file = await open(temporary, 'wx')
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > archive.bytes) throw new GameAddonArchiveError(`${archive.url} is larger than the ${archive.bytes} bytes the catalog pins; the download stopped.`)
        hash.update(chunk)
        await file.write(chunk)
      }
    } finally {
      await file.close()
    }
    if (bytes !== archive.bytes) throw new GameAddonArchiveError(`${archive.url} arrived with ${bytes} bytes, but the catalog pins ${archive.bytes}.`)
    const digest = hash.digest('hex')
    if (digest !== archive.sha256) {
      throw new GameAddonArchiveError(`${archive.url} does not match the SHA-256 the catalog pins (got ${digest}); it was not installed.`)
    }
    await rename(temporary, target)
    return target
  } finally {
    await rm(temporary, { force: true })
  }
}

/** A path inside an archive as a safe relative path, or undefined for one that would leave its folder. */
function safeRelative(name: string): string | undefined {
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/u.test(name)) return undefined
  const segments = name.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

// yauzl's own checks of entry names, which stop the whole archive.
const UNSAFE_NAME = /^(?:invalid relative path|absolute path|invalid characters in fileName): (.*)$/su

/** The archive error for a failure of the zip reader. */
function readerError(archivePath: string, error: unknown): Error {
  if (error instanceof GameAddonArchiveError || (error instanceof Error && error.name === 'AbortError')) return error
  const message = error instanceof Error ? error.message : String(error)
  const unsafe = UNSAFE_NAME.exec(message)
  if (unsafe !== null) return new GameAddonArchiveError(`The archive entry ${unsafe[1] as string} would leave the add-on folder; nothing was installed.`)
  return new GameAddonArchiveError(`${archivePath} is not a readable zip archive: ${message}`)
}

/** Open an archive for reading its entries one at a time. */
function openArchive(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(archivePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zipfile) => {
      if (error === null) resolve(zipfile)
      else reject(readerError(archivePath, error))
    })
  })
}

/** The archive's entries in central directory order. */
async function* entries(zipfile: ZipFile): AsyncGenerator<Entry> {
  for (;;) {
    const entry = await new Promise<Entry | undefined>((resolve, reject) => {
      const settle = (): void => {
        zipfile.off('entry', onEntry)
        zipfile.off('end', onEnd)
        zipfile.off('error', onError)
      }
      const onEntry = (next: Entry): void => { settle(); resolve(next) }
      const onEnd = (): void => { settle(); resolve(undefined) }
      const onError = (error: Error): void => { settle(); reject(error) }
      zipfile.on('entry', onEntry)
      zipfile.on('end', onEnd)
      zipfile.on('error', onError)
      zipfile.readEntry()
    })
    if (entry === undefined) return
    yield entry
  }
}

/** A stream of one entry's uncompressed bytes. */
function entryStream(zipfile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error === null) resolve(stream)
      else reject(error)
    })
  })
}

/**
 * Unpack the files below one folder of an archive into a new folder, one file at a time.
 * @param archivePath - absolute path of a checked archive.
 * @param root - folder inside the archive, with `/` separators; empty for the whole archive.
 * @param destination - absolute folder that must not exist yet; created with the files.
 * @param signal - cancellation between and during files.
 * @returns the written paths relative to `destination`, with `/` separators, sorted.
 * @throws {GameAddonArchiveError} for a damaged archive, an entry that would leave the folder, or a root without files.
 */
export async function unpackFolder(archivePath: string, root: string, destination: string, signal: AbortSignal): Promise<string[]> {
  const zipfile = await openArchive(archivePath)
  try {
    const prefix = root === '' ? '' : `${root}/`
    const selected: { readonly entry: Entry; readonly relative: string }[] = []
    for await (const entry of entries(zipfile)) {
      const name = entry.fileName
      if (name.endsWith('/') || isMetadata(name) || !name.startsWith(prefix)) continue
      const relative = safeRelative(name.slice(prefix.length))
      if (relative === undefined || relative === '') throw new GameAddonArchiveError(`The archive entry ${name} would leave the add-on folder; nothing was installed.`)
      selected.push({ entry, relative })
    }
    if (selected.length === 0) throw new GameAddonArchiveError(`The archive has no files under ${root === '' ? 'its root' : root}.`)
    await mkdir(destination, { recursive: false })
    for (const { entry, relative } of selected) {
      signal.throwIfAborted()
      const target = join(destination, ...relative.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await pipeline(await entryStream(zipfile, entry), createWriteStream(target, { flags: 'wx' }), { signal })
    }
    return selected.map(item => item.relative).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error
    throw readerError(archivePath, error)
  } finally {
    zipfile.close()
  }
}

/**
 * Read one file of an archive.
 * @param archivePath - absolute path of a checked archive.
 * @param name - entry path inside the archive, with `/` separators.
 * @returns the file's bytes.
 * @throws {GameAddonArchiveError} when the archive has no such file or cannot be read.
 */
export async function readArchiveFile(archivePath: string, name: string): Promise<Uint8Array> {
  const zipfile = await openArchive(archivePath)
  try {
    for await (const entry of entries(zipfile)) {
      if (entry.fileName !== name) continue
      const chunks: Buffer[] = []
      for await (const chunk of await entryStream(zipfile, entry)) chunks.push(chunk as Buffer)
      return new Uint8Array(Buffer.concat(chunks))
    }
  } catch (error) {
    throw readerError(archivePath, error)
  } finally {
    zipfile.close()
  }
  throw new GameAddonArchiveError(`The archive has no file ${name}.`)
}
