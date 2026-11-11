/**
 * The Godot Web export template: `web_nothreads_release.zip`, the single-threaded release build of the engine for the
 * browser, which Web exports pack with the project. Godot ships it only inside its export templates archive (about
 * 1.3 GB for every platform), so the manager reads that archive's ZIP directory with HTTP range requests and
 * downloads only the template entry (about 10 MB), then checks its size, CRC-32, and the SHA-256 the configuration
 * pins before it publishes `<dataRoot>/templates/<sha256>.zip` under a file lock. A configured `webTemplatePath`
 * replaces the download.
 * @module @deepseek-ai/dsh-godot/src/web-template
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { untilAborted } from './abort.ts'

/** Template fields of the plugin configuration. */
export interface WebTemplateSettings {
  /** Absolute plugin data folder; downloaded templates live in its `templates/` folder. */
  readonly dataRoot: string
  /** Godot export templates archive (`.tpz`, a ZIP file) that holds the template. */
  readonly webTemplateArchiveUrl: string
  /** Path of the template inside that archive. */
  readonly webTemplateEntry: string
  /** Lowercase hex SHA-256 the extracted template must have. */
  readonly webTemplateSha256: string
  /** Absolute template ZIP to use instead of downloading one; empty when unset. */
  readonly webTemplatePath: string
}

/**
 * Fetch one URL with request headers.
 * @param url - absolute URL.
 * @param init - request headers and cancellation.
 * @returns the response.
 */
export type TemplateFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>

/** A template download or configuration failure with an actionable message. */
export class GodotTemplateError extends Error {
  override name = 'GodotTemplateError'
}

/** The tail read first: the end-of-directory record plus the largest archive comment. */
const TAIL_BYTES = 65_536 + 22
const END_OF_DIRECTORY = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_END_OF_DIRECTORY = 0x06064b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

/** A ZIP directory entry's location and checks. */
interface ArchiveEntry {
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly localHeaderOffset: number
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is not a usable template.
    return false
  }
}

/** Resolves, and on first use downloads, the Web export template. */
export class WebTemplateManager {
  private pending: Promise<string> | undefined

  /**
   * @param settings - template configuration.
   * @param fetchUrl - HTTP client; range requests go through it.
   */
  constructor(private readonly settings: WebTemplateSettings, private readonly fetchUrl: TemplateFetch) {}

  /**
   * The path of the downloaded Web template.
   * @returns where a downloaded template lives, named after its pinned SHA-256.
   */
  installedPath(): string {
    return join(this.settings.dataRoot, 'templates', `${this.settings.webTemplateSha256}.zip`)
  }

  /**
   * The template ZIP, downloading it once when neither a configured nor a downloaded one exists. Concurrent calls
   * share one download.
   * @param signal - stops this caller's wait; a download another caller shares continues.
   * @returns the absolute template path.
   * @throws {GodotTemplateError} when the configured file is missing, or the download fails or does not match.
   */
  async resolve(signal: AbortSignal): Promise<string> {
    if (this.settings.webTemplatePath !== '') {
      if (!await isFile(this.settings.webTemplatePath)) {
        throw new GodotTemplateError(`The configured Web export template ${this.settings.webTemplatePath} is not a file.`)
      }
      return this.settings.webTemplatePath
    }
    const installed = this.installedPath()
    if (await isFile(installed)) return installed
    this.pending ??= this.install().finally(() => { this.pending = undefined })
    return await untilAborted(this.pending, signal)
  }

  private async install(): Promise<string> {
    const destination = this.installedPath()
    const folder = join(this.settings.dataRoot, 'templates')
    await mkdir(folder, { recursive: true })
    // The download outlives any one caller; a dead connection fails it instead of hanging it.
    const signal = AbortSignal.timeout(15 * 60_000)
    const staging = join(folder, `.download-${randomUUID()}.zip`)
    try {
      await this.download(staging, signal)
      await withFileLock(destination, async () => {
        if (await isFile(destination)) return
        await rename(staging, destination)
      }, { signal })
      return destination
    } finally {
      await rm(staging, { force: true })
    }
  }

  /**
   * Request bytes `start` to `end` of the archive. Ranges are always explicit: GitHub's release storage answers a
   * suffix range (`bytes=-N`) with 501, so the archive's size comes from a first one-byte range.
   */
  private async range(start: number, end: number, signal: AbortSignal): Promise<{ readonly response: Response; readonly total: number }> {
    const url = this.settings.webTemplateArchiveUrl
    let response: Response
    try {
      response = await this.fetchUrl(url, { headers: { range: `bytes=${start}-${end}` }, signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new GodotTemplateError(`Cannot reach the Godot export templates at ${url}: ${(error as Error).message}`, { cause: error })
    }
    if (response.status !== 206) {
      await response.body?.cancel()
      throw new GodotTemplateError(response.ok
        ? `The server of ${url} does not answer range requests, so only the Web template cannot be downloaded. Extract ${this.settings.webTemplateEntry} from the archive and set webTemplatePath in the Godot plugin configuration.`
        : `Downloading the Godot export templates from ${url} failed with HTTP ${response.status}.`)
    }
    const total = Number(/\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')?.[1])
    if (!Number.isSafeInteger(total)) {
      await response.body?.cancel()
      throw new GodotTemplateError(`The server of ${url} answered a range request without the archive's size.`)
    }
    return { response, total }
  }

  private async bytes(start: number, end: number, signal: AbortSignal): Promise<Buffer> {
    const { response } = await this.range(start, end, signal)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length !== end - start + 1) throw new GodotTemplateError('The Godot export templates archive answered a range request with the wrong length.')
    return data
  }

  private async findEntry(signal: AbortSignal): Promise<ArchiveEntry> {
    const probe = await this.range(0, 0, signal)
    await probe.response.body?.cancel()
    const tailStart = Math.max(0, probe.total - TAIL_BYTES)
    const tailBytes = await this.bytes(tailStart, probe.total - 1, signal)
    const end = tailBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0 || tailBytes.readUInt32LE(end) !== END_OF_DIRECTORY) throw new GodotTemplateError('The Godot export templates archive is not a ZIP file.')
    let entries = tailBytes.readUInt16LE(end + 10)
    let directorySize = tailBytes.readUInt32LE(end + 12)
    let directoryOffset = tailBytes.readUInt32LE(end + 16)
    if (directoryOffset === 0xffffffff || entries === 0xffff) {
      const locator = end - 20
      if (locator < 0 || tailBytes.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new GodotTemplateError('The Godot export templates archive has a damaged ZIP64 directory.')
      const recordStart = Number(tailBytes.readBigUInt64LE(locator + 8))
      const record = await this.bytes(recordStart, recordStart + 55, signal)
      if (record.readUInt32LE(0) !== ZIP64_END_OF_DIRECTORY) throw new GodotTemplateError('The Godot export templates archive has a damaged ZIP64 directory.')
      entries = Number(record.readBigUInt64LE(32))
      directorySize = Number(record.readBigUInt64LE(40))
      directoryOffset = Number(record.readBigUInt64LE(48))
    }
    const directory = directoryOffset >= tailStart
      ? tailBytes.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
      : await this.bytes(directoryOffset, directoryOffset + directorySize - 1, signal)
    let position = 0
    for (let index = 0; index < entries && position + 46 <= directory.length; index++) {
      if (directory.readUInt32LE(position) !== DIRECTORY_ENTRY) break
      const nameLength = directory.readUInt16LE(position + 28)
      const extraLength = directory.readUInt16LE(position + 30)
      const commentLength = directory.readUInt16LE(position + 32)
      const name = directory.toString('utf8', position + 46, position + 46 + nameLength)
      if (name === this.settings.webTemplateEntry) {
        if (directory.readUInt32LE(position + 42) === 0xffffffff) throw new GodotTemplateError('The Godot export templates archive stores the Web template past 4 GB, which needs ZIP64 entry support.')
        return {
          method: directory.readUInt16LE(position + 10),
          crc: directory.readUInt32LE(position + 16),
          compressedSize: directory.readUInt32LE(position + 20),
          size: directory.readUInt32LE(position + 24),
          localHeaderOffset: directory.readUInt32LE(position + 42),
        }
      }
      position += 46 + nameLength + extraLength + commentLength
    }
    throw new GodotTemplateError(`The Godot export templates archive has no ${this.settings.webTemplateEntry}.`)
  }

  private async download(destination: string, signal: AbortSignal): Promise<void> {
    const entry = await this.findEntry(signal)
    if (entry.method !== 0 && entry.method !== 8) throw new GodotTemplateError(`${this.settings.webTemplateEntry} uses a ZIP compression method other than store or deflate.`)
    const header = await this.bytes(entry.localHeaderOffset, entry.localHeaderOffset + 29, signal)
    if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new GodotTemplateError('The Godot export templates archive has a damaged entry header.')
    const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const { response } = await this.range(dataStart, dataStart + entry.compressedSize - 1, signal)
    if (response.body === null) throw new GodotTemplateError('The Godot export templates archive sent no data.')
    const digest = createHash('sha256')
    let checksum = 0
    let size = 0
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > entry.size) {
          callback(new GodotTemplateError(`${entry.size} bytes were expected of the Web export template, and more arrived.`))
          return
        }
        digest.update(chunk)
        checksum = crc32(chunk, checksum)
        callback(null, chunk)
      },
    })
    const sink = createWriteStream(destination, { flags: 'wx', mode: 0o644 })
    if (entry.method === 8) await pipeline(response.body, createInflateRaw(), check, sink, { signal })
    else await pipeline(response.body, check, sink, { signal })
    if (size !== entry.size || checksum >>> 0 !== entry.crc) throw new GodotTemplateError('The downloaded Web export template is damaged.')
    if (digest.digest('hex') !== this.settings.webTemplateSha256) {
      throw new GodotTemplateError('The downloaded Web export template does not match the SHA-256 the Godot plugin configuration pins; set webTemplateSha256 for the configured runtime version.')
    }
  }
}
