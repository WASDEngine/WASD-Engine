/**
 * Reference searches. A search reads the pages a web search finds for each query, takes the image each page names for
 * link previews, or its first image without one, and the video it plays; a page the call names directly gives every
 * image it shows. Each image is downloaded within the size and time limits, decoded once to check it is a picture
 * large enough to study, and only then kept in the plugin's cache folder, where a later save finds it without
 * downloading it again; a cached file that no longer decodes is dropped from the cache. The same picture found twice,
 * at another size or on another site, is kept once, and the rest are numbered on a contact sheet. A page or image that
 * fails in any way counts as unusable and never fails the search.
 * @module @deepseek-ai/dsh-art-references/src/finder
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { decodeHtml, readPageMedia } from './html.ts'
import { drawContactSheet, fingerprint, fingerprintDistance, probeImage, sheetPicture, UnreadableImage, type SheetEntry } from './images.ts'
import { getPublic, WebRequestError, type ReferenceWeb } from './net.ts'
import type { ReferenceCandidate, ReferenceImageFormat, ReferenceImageInfo } from './types.ts'

/** A file name that is a content hash, as the attachment store names its files: no title to keep. */
export const HASH_NAME = /^[0-9a-f]{32,}$/iu

/** Limits of a reference search. */
export interface FinderLimits {
  /** Pages one query's web search returns. */
  readonly resultsPerQuery: number
  /** Most images on one contact sheet. */
  readonly maxCandidates: number
  /** Time limit of reading one page. */
  readonly pageTimeoutMs: number
  /** Time limit of downloading one image. */
  readonly imageTimeoutMs: number
  /** Most bytes of a page read; a longer page is read up to this many. */
  readonly maxPageBytes: number
  /** Largest image downloaded. */
  readonly maxImageBytes: number
  /** Smallest longest side, in pixels, of an image worth studying. */
  readonly minImageEdge: number
  /** Side of each image's square on the contact sheet. */
  readonly sheetCell: number
  /** Most images in one row of the contact sheet. */
  readonly sheetColumns: number
  /** Pages read and images downloaded at once. */
  readonly concurrency: number
}

/** One page a web search found. */
export interface WebSearchHit {
  readonly url: string
  readonly title?: string
}

/**
 * Run one web search.
 * @param query - the search words.
 * @param maxResults - most pages to return.
 * @param signal - cancellation.
 * @returns the pages found, best first.
 */
export type SearchWeb = (query: string, maxResults: number, signal: AbortSignal) => Promise<readonly WebSearchHit[]>

/** Where an image came from. */
export interface ImageOrigin {
  /** The page it came from, or the image itself. */
  readonly page: string
  /** Title of the page or the image; empty without one. */
  readonly title: string
  /** Host name of the page. */
  readonly site: string
  /** Address of the video the page plays, when the image is its poster. */
  readonly video?: string
  /** Set for an image file on this computer, such as one the user attached; `image` and `page` hold its path. */
  readonly local?: true
}

/** One downloaded image in the cache folder. */
export interface CachedImage extends ReferenceImageInfo, ImageOrigin {
  /** Address of the image. */
  readonly image: string
  /** Absolute path of the downloaded file. */
  readonly path: string
}

/** A drawn contact sheet, saved in the cache folder. */
export interface FoundSheet {
  /** Absolute path of the sheet's JPEG file. */
  readonly path: string
  /** The search's id, eight hexadecimal digits, by which the tools name its images as `<id>#<number>`. */
  readonly id: string
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/** One image of a kept search, as the record beside its contact sheet holds it. */
export interface SheetImage {
  /** Number on the contact sheet, from 1. */
  readonly number: number
  /** Address of the image file. */
  readonly image: string
  /** Address of the page the image came from, or of the image itself. */
  readonly page: string
  /** Title of the page or the image; empty without one. */
  readonly title: string
  /** Host name of the page. */
  readonly site: string
  /** Address of the video the page plays, when the image is its poster. */
  readonly video?: string
}

/** The outcome of one reference search. */
export interface FindResult {
  /** The images found, in number order. */
  readonly candidates: readonly ReferenceCandidate[]
  /** The contact sheet; absent when no image was found. */
  readonly sheet?: FoundSheet
  /** Pages read. */
  readonly pages: number
  /** Pages and images that gave no usable image: unreachable, refused, not an image, or too small. */
  readonly unusable: number
  /** Images dropped because an earlier one shows the same picture. */
  readonly duplicates: number
}

/** The pages a call names directly, and the queries it searches for. */
export interface FindRequest {
  readonly queries: readonly string[]
  readonly pages: readonly string[]
}

/** File extension of each image file type. */
export const IMAGE_EXTENSIONS: Readonly<Record<ReferenceImageFormat, string>> = {
  png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif', avif: '.avif',
}

/** Paths that are image files, by extension. */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif)$/iu

/** Fingerprints this many bits apart, or closer, show the same picture. */
const SAME_PICTURE_BITS = 6

/** `Accept` header of page requests. */
const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'

/** `Accept` header of image requests. */
const IMAGE_ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5'

/**
 * Run `work` over `items` with at most `limit` running at once.
 * @param items - the items.
 * @param limit - most at once.
 * @param work - the work for one item.
 * @returns each item's result or failure, in item order.
 */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length })
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index] as T, index) }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/**
 * The host name of an address, without `www.`.
 * @param address - an absolute address.
 * @returns the host name.
 */
export function siteOf(address: string): string {
  return new URL(address).hostname.replace(/^www\./u, '')
}

/**
 * A file name's stem for an image address: its last path segment without extension.
 * @param address - the image's address.
 * @returns the stem, decoded; empty when the path has none.
 */
export function fileStem(address: string): string {
  const last = new URL(address).pathname.split('/').at(-1) ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    // URIError: a malformed escape; keep the segment as written.
  }
  return decoded.replace(/\.[^.]*$/u, '')
}

/** The images one page or image offers, before download. */
interface Offer extends ImageOrigin {
  readonly image: string
}

/** One source of images: a page a search found, a page the call named, or an image a search found. */
interface Source {
  readonly kind: 'result' | 'named' | 'image'
  readonly url: string
  readonly title: string
}

/** The downloaded images, the contact sheets, and how old a file may get, in the plugin's cache folder. */
export class ReferenceCache {
  /** Downloaded images by address, for this process. */
  private readonly known = new Map<string, CachedImage>()

  /**
   * @param folder - the cache folder, created when first written.
   * @param maxAgeMs - how long a cached file is kept and reused.
   */
  constructor(readonly folder: string, private readonly maxAgeMs: number) {}

  /** The folder of downloaded images. */
  private get images(): string {
    return join(this.folder, 'images')
  }

  /** The folder of contact sheets. */
  private get sheets(): string {
    return join(this.folder, 'sheets')
  }

  /** The cache key of an image address. */
  private key(image: string): string {
    return createHash('sha256').update(image).digest('hex').slice(0, 32)
  }

  /**
   * The cached download of an image address, from this process or an earlier one, while it is younger than the
   * cache's age limit.
   * @param image - the image's address.
   * @returns the cached image, or undefined.
   */
  async find(image: string): Promise<CachedImage | undefined> {
    const remembered = this.known.get(image)
    if (remembered !== undefined) return remembered
    const record = join(this.images, `${this.key(image)}.json`)
    try {
      const found = await stat(record)
      if (Date.now() - found.mtimeMs > this.maxAgeMs) return undefined
      const entry = parseCachedImage(JSON.parse(await readFile(record, 'utf8')), image)
      if (entry === undefined || !(await stat(entry.path).then(file => file.isFile(), () => false))) return undefined
      this.known.set(image, entry)
      return entry
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  /**
   * Keep a downloaded image.
   * @param image - its address.
   * @param data - its bytes, which the caller decoded.
   * @param info - what it is.
   * @param origin - where it came from.
   * @returns the cached image.
   */
  async keep(image: string, data: Buffer, info: ReferenceImageInfo, origin: ImageOrigin): Promise<CachedImage> {
    await mkdir(this.images, { recursive: true })
    const key = this.key(image)
    const path = join(this.images, `${key}${IMAGE_EXTENSIONS[info.format]}`)
    await writeAtomically(path, data)
    const entry: CachedImage = { ...info, ...origin, image, path }
    await writeAtomically(join(this.images, `${key}.json`), Buffer.from(JSON.stringify(entry)))
    this.known.set(image, entry)
    return entry
  }

  /**
   * Drop a cached download, such as one whose file no longer decodes, so the next request downloads it again.
   * @param image - its address.
   * @returns when its record and file are gone.
   */
  async forget(image: string): Promise<void> {
    this.known.delete(image)
    const key = this.key(image)
    // The record goes first, so no reader finds a record whose file is gone.
    await rm(join(this.images, `${key}.json`), { force: true })
    await Promise.all(Object.values(IMAGE_EXTENSIONS).map(extension => rm(join(this.images, `${key}${extension}`), { force: true })))
  }

  /**
   * Save a contact sheet, with a record of its images beside it under the same name, so later calls can name an image
   * by the search's id and its number.
   * @param data - the sheet's JPEG bytes.
   * @param images - the images it shows, numbered as drawn.
   * @returns the sheet's absolute path and the search's id.
   */
  async keepSheet(data: Buffer, images: readonly SheetImage[]): Promise<{ path: string; id: string }> {
    await mkdir(this.sheets, { recursive: true })
    const id = randomUUID().slice(0, 8)
    const stem = join(this.sheets, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${id}`)
    await writeAtomically(`${stem}.json`, Buffer.from(JSON.stringify({ images: images.map(sheetImage) })))
    await writeAtomically(`${stem}.jpg`, data)
    return { path: `${stem}.jpg`, id }
  }

  /**
   * An image of a search this cache keeps, by the search's id and the image's number on its contact sheet, while the
   * search is younger than the cache's age limit.
   * @param id - the search's id.
   * @param number - the image's number.
   * @returns the image, or undefined when no kept search has the id or it shows no image of that number.
   */
  async findSheetImage(id: string, number: number): Promise<SheetImage | undefined> {
    let names: string[]
    try {
      names = await readdir(this.sheets)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    // Each search has a random id, so two records end alike only by an eight-digit coincidence, which names no image.
    const [name, ...more] = names.filter(entry => entry.endsWith(`-${id}.json`))
    if (name === undefined || more.length > 0) return undefined
    const record = join(this.sheets, name)
    try {
      if (Date.now() - (await stat(record)).mtimeMs > this.maxAgeMs) return undefined
      return parseSheetImages(JSON.parse(await readFile(record, 'utf8'))).find(image => image.number === number)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  /**
   * Delete cached files older than the age limit.
   * @returns when the folders are pruned; a folder that does not exist is skipped.
   */
  async prune(): Promise<void> {
    const cutoff = Date.now() - this.maxAgeMs
    for (const folder of [this.images, this.sheets]) {
      let names: string[]
      try {
        names = await readdir(folder)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const name of names) {
        const path = join(folder, name)
        const found = await stat(path).catch(() => undefined)
        if (found !== undefined && found.isFile() && found.mtimeMs < cutoff) await rm(path, { force: true })
      }
    }
    for (const [image, entry] of this.known) {
      if (!(await stat(entry.path).then(file => file.isFile(), () => false))) this.known.delete(image)
    }
  }
}

/** The fields of an image that the record beside a contact sheet keeps. */
function sheetImage(image: SheetImage): SheetImage {
  return {
    number: image.number, image: image.image, page: image.page, title: image.title, site: image.site,
    ...image.video === undefined ? {} : { video: image.video },
  }
}

/**
 * Validate the record beside a contact sheet read from disk.
 * @param value - the parsed JSON.
 * @returns its complete image entries; none when it is no such record.
 */
function parseSheetImages(value: unknown): SheetImage[] {
  const images = typeof value === 'object' && value !== null ? (value as { images?: unknown }).images : undefined
  if (!Array.isArray(images)) return []
  return images.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return []
    const image = entry as Partial<Record<keyof SheetImage, unknown>>
    if (!(['image', 'page', 'title', 'site'] as const).every(key => typeof image[key] === 'string')) return []
    if (typeof image.number !== 'number' || !Number.isInteger(image.number) || image.number < 1) return []
    if (image.video !== undefined && typeof image.video !== 'string') return []
    return [entry as SheetImage]
  })
}

/**
 * Validate a cache record read from disk.
 * @param value - the parsed JSON.
 * @param image - the address the record must be for.
 * @returns the record, or undefined when it is not a complete record for that address.
 */
function parseCachedImage(value: unknown, image: string): CachedImage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Record<keyof CachedImage, unknown>>
  const strings = ['image', 'path', 'page', 'title', 'site'] as const
  if (!strings.every(key => typeof record[key] === 'string') || record.image !== image) return undefined
  if (!(['png', 'jpeg', 'webp', 'gif', 'avif'] as const).some(format => format === record.format)) return undefined
  if (![record.width, record.height, record.frames].every(number => typeof number === 'number' && Number.isInteger(number) && number > 0)) return undefined
  if (!Array.isArray(record.delays) || !record.delays.every(delay => typeof delay === 'number')) return undefined
  if (record.video !== undefined && typeof record.video !== 'string') return undefined
  return value as CachedImage
}

/**
 * Write a file through a temporary file beside it, so it appears complete or not at all.
 * @param path - the file.
 * @param data - its bytes.
 */
export async function writeAtomically(path: string, data: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.part`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Reports a page or image that failed for a reason other than the web or the file, such as a cache folder it cannot write. */
export type ReportFailure = (error: unknown) => void

/** A downloaded image that decodes, with the fingerprint of its first frame. */
interface Decoded {
  readonly cached: CachedImage
  readonly print: bigint
}

/** Finds reference images on the web and draws their contact sheet. */
export class ReferenceFinder {
  /**
   * @param web - how the tools reach the web.
   * @param search - the web search.
   * @param cache - the cache folder.
   * @param limits - the search's limits.
   * @param report - told of each page or image that failed for a reason other than the web or the file, which the
   *   search still counts as unusable.
   */
  constructor(
    private readonly web: ReferenceWeb,
    private readonly search: SearchWeb,
    readonly cache: ReferenceCache,
    private readonly limits: FinderLimits,
    private readonly report: ReportFailure,
  ) {}

  /**
   * Download an image, or find its earlier download in the cache. An address that turns out to be a web page, such as
   * a wiki's page of one image file, gives the page's main image: the one it names for link previews, or else its
   * first image. The image decodes: a new download is decoded before it is cached, and a cached file that no longer
   * decodes is dropped from the cache and downloaded again.
   * @param image - the image's address, or a page's.
   * @param origin - where it came from, recorded with a new download; a page fills in its title when the origin has
   *   none.
   * @param signal - cancellation.
   * @returns the cached image, whose `image` is the address of the image file downloaded.
   * @throws WebRequestError when the download fails, or UnreadableImage when the file is not a reference image that
   *   decodes or the page shows none.
   */
  async download(image: string, origin: ImageOrigin, signal: AbortSignal): Promise<CachedImage> {
    return (await this.obtain(image, origin, signal, true)).cached
  }

  /**
   * Read an image file on this computer, such as an image the user attached, to save as a reference. Saving copies
   * the file, which stays where it is.
   * @param path - absolute path of the file.
   * @returns the image, which decodes, titled by its file name unless the name is a content hash, as attachment files
   *   are.
   * @throws UnreadableImage when the path names no file, the file is larger than an image download may be, or it is
   *   not a reference image that decodes.
   */
  async readLocal(path: string): Promise<CachedImage> {
    const file = await stat(path).catch((error: unknown) => {
      throw new UnreadableImage('is not a file on this computer.', { cause: error })
    })
    if (!file.isFile()) throw new UnreadableImage('is not a file.')
    if (file.size > this.limits.maxImageBytes) throw new UnreadableImage(`is larger than ${Math.round(this.limits.maxImageBytes / (1024 * 1024))} MB.`)
    const data = await readFile(path).catch((error: unknown) => {
      throw new UnreadableImage(`could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`, { cause: error })
    })
    const info = await probeImage(data)
    await fingerprint(data)
    const stem = basename(path).replace(/\.[^.]*$/u, '')
    return { ...info, image: path, path, page: path, title: HASH_NAME.test(stem) ? '' : stem, site: '', local: true }
  }

  /**
   * Download one address and fingerprint it, following a web page to its main image when `followPage` is true. A new
   * download is cached only once it decodes; a cached file that no longer decodes is dropped from the cache and
   * downloaded again.
   * @throws as {@link ReferenceFinder.download}.
   */
  private async obtain(image: string, origin: ImageOrigin, signal: AbortSignal, followPage: boolean): Promise<Decoded> {
    const cached = await this.cache.find(image)
    if (cached !== undefined) {
      try {
        return { cached, print: await fingerprint(await readFile(cached.path)) }
      } catch (error) {
        // A file an earlier version cached without decoding it, or one changed on disk: download it again.
        if (!(error instanceof UnreadableImage)) throw error
        await this.cache.forget(image)
      }
    }
    const response = await getPublic(this.web, image, {
      accept: IMAGE_ACCEPT, maxBytes: this.limits.maxImageBytes, truncate: false, timeoutMs: this.limits.imageTimeoutMs, signal,
    })
    if (response.mediaType === 'text/html' || response.mediaType === 'application/xhtml+xml') {
      const media = followPage ? readPageMedia(decodeHtml(response.body, response.contentType), response.url, 1) : undefined
      const main = media?.preview[0] ?? media?.shown[0]
      if (media === undefined || main === undefined) throw new UnreadableImage('is a web page, not an image file.')
      return await this.obtain(main, { ...origin, title: origin.title || media.title }, signal, false)
    }
    if (response.mediaType.startsWith('text/')) throw new UnreadableImage('is a text file, not an image file.')
    const info = await probeImage(response.body)
    const print = await fingerprint(response.body)
    signal.throwIfAborted()
    return { cached: await this.cache.keep(image, response.body, info, origin), print }
  }

  /**
   * Count one failed page or image: a failure of the web or the file is expected, any other is reported.
   * @param error - the failure.
   * @param signal - the search's cancellation, whose reason is no failure of a page or image.
   */
  private failed(error: unknown, signal: AbortSignal): void {
    if (signal.aborted || error instanceof WebRequestError || error instanceof UnreadableImage) return
    this.report(error)
  }

  /**
   * Search for reference images.
   * @param request - the queries to search for and the pages to read.
   * @param signal - cancellation.
   * @returns the numbered images and their contact sheet.
   * @throws Error from the web search, such as a signed-out account; failures of single pages and images are counted.
   */
  async find(request: FindRequest, signal: AbortSignal): Promise<FindResult> {
    const sources = await this.sources(request, signal)
    const pages = sources.filter(source => source.kind !== 'image')
    const read = await eachLimited(sources, this.limits.concurrency, async (source): Promise<Offer[]> => {
      if (source.kind === 'image') return [{ image: source.url, page: source.url, title: source.title, site: siteOf(source.url) }]
      return await this.offers(source, signal)
    })
    signal.throwIfAborted()
    let unusable = 0
    const offers: Offer[] = []
    const seen = new Set<string>()
    for (const result of read) {
      if (result.status === 'rejected') {
        this.failed(result.reason, signal)
        unusable++
        continue
      }
      if (result.value.length === 0) unusable++
      for (const offer of result.value) {
        if (seen.has(offer.image)) continue
        seen.add(offer.image)
        offers.push(offer)
      }
    }
    // Twice the sheet's images, so the sheet still fills when some downloads fail or repeat a picture.
    const tried = offers.slice(0, this.limits.maxCandidates * 2)
    const downloads = await eachLimited(tried, this.limits.concurrency, async (offer) => {
      const { cached, print } = await this.obtain(offer.image, offer, signal, true)
      if (Math.max(cached.width, cached.height) < this.limits.minImageEdge) throw new UnreadableImage('is too small to study.')
      return { cached, offer, print }
    })
    signal.throwIfAborted()
    const kept: { cached: CachedImage; offer: Offer; print: bigint }[] = []
    let duplicates = 0
    for (const download of downloads) {
      if (download.status === 'rejected') {
        this.failed(download.reason, signal)
        unusable++
        continue
      }
      if (kept.some(entry => fingerprintDistance(entry.print, download.value.print) <= SAME_PICTURE_BITS)) {
        duplicates++
        continue
      }
      if (kept.length < this.limits.maxCandidates) kept.push(download.value)
    }
    // Each kept image is drawn for its cell; one that fails to draw is unusable like a failed download.
    const pictures = await eachLimited(kept, this.limits.concurrency, async ({ cached }) => {
      try {
        return await sheetPicture(await readFile(cached.path), this.limits.sheetCell)
      } catch (error) {
        if (error instanceof UnreadableImage) await this.cache.forget(cached.image)
        throw error
      }
    })
    signal.throwIfAborted()
    const shown: { cached: CachedImage; offer: Offer; picture: SheetEntry['picture'] }[] = []
    for (const [index, entry] of kept.entries()) {
      const result = pictures[index]
      if (result?.status !== 'fulfilled') {
        if (result !== undefined) this.failed(result.reason, signal)
        unusable++
        continue
      }
      shown.push({ cached: entry.cached, offer: entry.offer, picture: result.value })
    }
    const candidates = shown.map(({ cached, offer }, index): ReferenceCandidate => ({
      number: index + 1,
      image: cached.image,
      page: offer.page,
      // A direct image without a search title takes the title of the page it led to, or its file name.
      title: offer.title || cached.title || fileStem(cached.image),
      site: offer.site,
      ...offer.video === undefined ? {} : { video: offer.video },
      format: cached.format, width: cached.width, height: cached.height, frames: cached.frames, delays: cached.delays,
    }))
    if (candidates.length === 0) return { candidates, pages: pages.length, unusable, duplicates }
    const drawn = await drawContactSheet(shown.map(({ cached, picture }, index) => ({
      picture,
      number: index + 1,
      tag: cached.frames > 1 ? `${cached.format === 'gif' ? 'GIF' : 'ANIM'} ${String(cached.frames)}` : candidates[index]?.video === undefined ? '' : 'VIDEO',
    })), { cell: this.limits.sheetCell, columns: this.limits.sheetColumns })
    signal.throwIfAborted()
    const { path, id } = await this.cache.keepSheet(drawn.data, candidates)
    return { candidates, sheet: { path, id, ...drawn }, pages: pages.length, unusable, duplicates }
  }

  /**
   * The pages to read and the images found directly: the named pages first, then each query's results, taken in turn
   * from every query so each query's best results come first. A query whose search fails adds nothing while another
   * query or a named page gives sources.
   * @throws Error from the web search when every query's search fails and the call names no page.
   */
  private async sources(request: FindRequest, signal: AbortSignal): Promise<Source[]> {
    const sources: Source[] = request.pages.map(url => ({ kind: 'named', url, title: '' }))
    const settled = await Promise.allSettled(request.queries.map(query => this.search(query, this.limits.resultsPerQuery, signal)))
    signal.throwIfAborted()
    const searched = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed !== undefined && searched.length === 0 && request.pages.length === 0) throw failed.reason
    const seen = new Set(request.pages)
    for (let rank = 0; rank < this.limits.resultsPerQuery; rank++) {
      for (const hits of searched) {
        const hit = hits[rank]
        if (hit === undefined || seen.has(hit.url) || !URL.canParse(hit.url)) continue
        seen.add(hit.url)
        const path = new URL(hit.url).pathname
        sources.push({ kind: IMAGE_PATH.test(path) ? 'image' : 'result', url: hit.url, title: hit.title ?? '' })
      }
    }
    return sources
  }

  /**
   * The images a page offers: for a search result, the image it names for link previews or else its first image; for
   * a page the call named, every image it shows, up to the sheet's size.
   * @throws WebRequestError when the page cannot be read.
   */
  private async offers(source: Source, signal: AbortSignal): Promise<Offer[]> {
    const response = await getPublic(this.web, source.url, {
      accept: PAGE_ACCEPT, maxBytes: this.limits.maxPageBytes, truncate: true, timeoutMs: this.limits.pageTimeoutMs, signal,
    })
    if (response.mediaType.startsWith('image/')) {
      return [{ image: response.url.href, page: source.url, title: source.title || fileStem(source.url), site: siteOf(source.url) }]
    }
    if (response.mediaType !== '' && response.mediaType !== 'text/html' && response.mediaType !== 'application/xhtml+xml') {
      throw new WebRequestError(`is a ${response.mediaType} file, not a web page.`)
    }
    const media = readPageMedia(decodeHtml(response.body, response.contentType), response.url, this.limits.maxCandidates)
    const origin: ImageOrigin = { page: source.url, title: media.title || source.title, site: siteOf(source.url) }
    // The page's video is the video of its first preview image, the poster link previews show.
    const offer = (image: string, poster: boolean): Offer => ({
      ...origin, image, ...poster && media.video !== undefined ? { video: media.video } : {},
    })
    if (source.kind === 'named') {
      return [...media.preview.map((image, index) => offer(image, index === 0)), ...media.shown.map(image => offer(image, false))]
    }
    const [first] = media.preview
    if (first !== undefined) return [offer(first, true)]
    const [shown] = media.shown
    return shown === undefined ? [] : [offer(shown, false)]
  }
}
