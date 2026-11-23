/**
 * Save the map pictures of one ambientCG archive into a folder. ambientCG offers each resolution of an asset as one
 * ZIP file, so a download fetches the archive into a temporary folder while its size and, where the server names one,
 * its SHA-1 digest are checked, reads the archive's directory, and unpacks only the pictures the call takes, each
 * checked against the directory's CRC-32. The pictures are written whole or not at all, as the kit's
 * `writeAssetFiles` does it. The plugin remembers the directory of each archive it read, so a later download of the
 * same archive whose pictures are all in place fetches nothing.
 * @module @deepseek-ai/dsh-ambientcg/src/download
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { kilobytes, saveBody, writeAssetFiles, type WrittenAssetFile } from '@deepseek-ai/dsh-game-mcp/kit'
import { archivePictures, selectPictures } from './files.ts'
import type { AmbientCgArchive, AmbientCgArchiveListing, AmbientCgAsset, AmbientCgPicture } from './types.ts'

/** Most files an archive may list; ambientCG's hold about a dozen. */
const MAX_ARCHIVE_FILES = 2000

/** The headers in which ambientCG's file host names a file's SHA-1 digest. */
const SHA1_HEADERS = ['x-bz-content-sha1', 'x-bz-info-large_file_sha1'] as const

/** An archive that differs from what the asset's listing or the remembered directory says, as after an update of the asset. */
export class AmbientCgArchiveChanged extends Error {
  override name = 'AmbientCgArchiveChanged'
}

/** How one download reaches its archive. */
export interface DownloadOptions {
  /** Whether pictures whose contents differ are replaced; otherwise they stop the download before anything is written. */
  readonly replace: boolean
  /** The maps the call names; undefined for the default of {@link selectPictures}. */
  readonly maps: readonly string[] | undefined
  /** Largest total size in bytes of the pictures one download unpacks. */
  readonly maxUnpackedBytes: number
  /**
   * Start downloading the archive.
   * @param url - archive URL.
   * @param signal - cancellation of the request and its body.
   * @returns the successful response.
   */
  readonly open: (url: string, signal: AbortSignal) => Promise<Response>
  /** The directories of the archives read so far, by asset id and archive name; the download adds its own. */
  readonly known: Map<string, AmbientCgArchiveListing>
  /** Cancellation of the whole download. */
  readonly signal: AbortSignal
}

/** What one download saved. */
export interface DownloadedPictures {
  /** What happened to each picture, in the archive's order. */
  readonly files: WrittenAssetFile[]
  /** The map of each picture, in the same order. */
  readonly maps: string[]
  /** Size in bytes of the archive this call fetched; 0 when every picture was already in place. */
  readonly fetchedBytes: number
}

/** An archive on disk, open for reading its files. */
interface OpenedArchive {
  readonly zipfile: ZipFile
  readonly entries: ReadonlyMap<string, Entry>
  readonly listing: AmbientCgArchiveListing
}

function changed(asset: AmbientCgAsset): AmbientCgArchiveChanged {
  return new AmbientCgArchiveChanged(`ambientCG's files of ${asset.title} differ from its listing, as after an update of the asset; nothing was saved. Call again to read the new listing.`)
}

/** The SHA-1 digest the file host names for a response's body, in lowercase; undefined when it names none. */
function expectedSha1(headers: Headers): string | undefined {
  for (const name of SHA1_HEADERS) {
    const digest = /^(?:unverified:)?([0-9a-f]{40})$/iu.exec(headers.get(name) ?? '')
    if (digest !== null) return (digest[1] as string).toLowerCase()
  }
  return undefined
}

/**
 * Download the archive into a new file and check it.
 * @throws AmbientCgArchiveChanged when its size differs from the listing's.
 * @throws Error when the request fails or the digest differs from the file host's.
 */
async function fetchArchive(path: string, asset: AmbientCgAsset, archive: AmbientCgArchive, options: DownloadOptions): Promise<void> {
  const response = await options.open(archive.url, options.signal)
  const { bytes, digest } = await saveBody(response, path, 'sha1', archive.size, () => changed(asset), options.signal)
  if (bytes !== archive.size) throw changed(asset)
  const expected = expectedSha1(response.headers)
  if (expected !== undefined && digest !== expected) throw new Error(`The archive of ${asset.title} arrived damaged: its SHA-1 digest differs from ambientCG's; nothing was saved.`)
}

/** Read every entry of an archive's directory. */
function readDirectory(zipfile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const found: Entry[] = []
    zipfile.once('error', reject)
    zipfile.once('end', () => { resolve(found) })
    zipfile.on('entry', (entry: Entry) => {
      if (found.length >= MAX_ARCHIVE_FILES) {
        reject(new Error(`the archive lists more than ${String(MAX_ARCHIVE_FILES)} files`))
        return
      }
      found.push(entry)
      zipfile.readEntry()
    })
    zipfile.readEntry()
  })
}

/**
 * Open a downloaded archive and read its directory.
 * @throws Error when the file is not a readable ZIP archive.
 */
async function readArchive(path: string, asset: AmbientCgAsset, archive: AmbientCgArchive): Promise<OpenedArchive> {
  let zipfile: ZipFile | undefined
  try {
    zipfile = await new Promise<ZipFile>((resolve, reject) => {
      openZip(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, opened) => {
        if (error === null) resolve(opened)
        else reject(error)
      })
    })
    const directory = await readDirectory(zipfile)
    const entries = new Map(directory.filter(entry => !entry.fileName.endsWith('/')).map(entry => [entry.fileName, entry]))
    const files = [...entries.values()].map(entry => ({ name: entry.fileName, bytes: entry.uncompressedSize, crc32: entry.crc32 }))
    return { zipfile, entries, listing: { size: archive.size, pictures: archivePictures(asset, files) } }
  } catch (error) {
    zipfile?.close()
    throw new Error(`The archive of ${asset.title} is not a readable ZIP file: ${error instanceof Error ? error.message : String(error)}; nothing was saved.`, { cause: error })
  }
}

async function crcOf(path: string, signal: AbortSignal): Promise<number> {
  let checksum = 0
  for await (const chunk of createReadStream(path, { signal })) checksum = crc32(chunk as Buffer, checksum)
  return checksum
}

/**
 * Unpack one picture into a new file and check it.
 * @throws Error when its contents differ from the archive's directory.
 */
async function unpack(zipfile: ZipFile, entry: Entry, picture: AmbientCgPicture, temporary: string, signal: AbortSignal): Promise<void> {
  const stream = await new Promise<Readable>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, opened) => {
      if (error === null) resolve(opened)
      else reject(error)
    })
  })
  let checksum = 0
  async function* checked(): AsyncGenerator<Buffer> {
    for await (const chunk of stream) {
      checksum = crc32(chunk as Buffer, checksum)
      yield chunk as Buffer
    }
  }
  await pipeline(checked(), createWriteStream(temporary, { flags: 'wx' }), { signal })
  if (checksum !== picture.crc32) throw new Error(`${picture.name} arrived damaged: its checksum differs from the archive's; nothing was saved.`)
}

/**
 * Save the pictures of one archive of an asset into a folder, creating the folder.
 * @param asset - the asset.
 * @param archive - the archive of the resolution and picture format to save.
 * @param directory - absolute download folder.
 * @param options - the maps to take, whether to replace changed pictures, how to fetch the archive, and cancellation.
 * @returns the pictures and what happened to each.
 * @throws AmbientCgArchiveChanged when the archive differs from the asset's listing.
 * @throws Error when a picture conflicts, the request fails, the archive or a picture arrives damaged, or writing
 * fails; no picture is written then, except when moving the checked pictures into place fails partway.
 */
export async function writeDownload(
  asset: AmbientCgAsset, archive: AmbientCgArchive, directory: string, options: DownloadOptions,
): Promise<DownloadedPictures> {
  const key = `${asset.id}/${archive.attributes}`
  let folder: string | undefined
  let opened: Promise<OpenedArchive> | undefined
  // The archive is fetched once, by whichever step first needs it, and not at all when no step does.
  const fetched = (): Promise<OpenedArchive> => opened ??= (async () => {
    folder = await mkdtemp(join(tmpdir(), 'dsh-ambientcg-'))
    const path = join(folder, 'archive.zip')
    await fetchArchive(path, asset, archive, options)
    const read = await readArchive(path, asset, archive)
    options.known.set(key, read.listing)
    return read
  })()
  try {
    const remembered = options.known.get(key)
    const listing = remembered?.size === archive.size ? remembered : (await fetched()).listing
    const pictures = selectPictures(asset, listing.pictures, options.maps)
    const unpacked = pictures.reduce((total, picture) => total + picture.bytes, 0)
    if (unpacked > options.maxUnpackedBytes) {
      throw new Error(`The maps of this download are ${kilobytes(unpacked)} unpacked, more than the ${kilobytes(options.maxUnpackedBytes)} that one download may be; choose a lower resolution or fewer maps.`)
    }
    const files = await writeAssetFiles(pictures.map(picture => ({
      path: picture.name,
      bytes: picture.bytes,
      same: async (target, signal) => await crcOf(target, signal) === picture.crc32,
      async write(temporary, signal) {
        const { zipfile, entries } = await fetched()
        const entry = entries.get(picture.name)
        if (entry === undefined || entry.crc32 !== picture.crc32 || entry.uncompressedSize !== picture.bytes) throw changed(asset)
        await unpack(zipfile, entry, picture, temporary, signal)
      },
    })), directory, options)
    return { files, maps: pictures.map(picture => picture.map), fetchedBytes: opened === undefined ? 0 : archive.size }
  } catch (error) {
    // The next call reads the archive's directory again instead of trusting one that no longer fits.
    if (error instanceof AmbientCgArchiveChanged) options.known.delete(key)
    throw error
  } finally {
    await opened?.then((read) => { read.zipfile.close() }, () => undefined)
    // On Windows the archive's handle may close a moment after the call that closes it.
    if (folder !== undefined) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
