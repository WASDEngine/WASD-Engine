/**
 * Client of the ambientCG API: searches by keywords and kind, one asset by id, the categories, preview images, and
 * archive downloads. A page of a search and each asset stay in memory for `catalogMaxAgeMs`, so asking again makes no
 * request; ambientCG is run by one person and asks for no more requests than needed. Every request names the software
 * in `User-Agent`, goes only to ambientCG's hosts, and has its response validated before use.
 * @module @deepseek-ai/dsh-ambientcg/src/api
 */
import { z } from 'zod'
import { AssetLibraryClient, AssetLibraryRequestError } from '@deepseek-ai/dsh-game-mcp/kit'
import type { AmbientCgArchive, AmbientCgAsset, AmbientCgAssetKind, AmbientCgCategory, AmbientCgPage } from './types.ts'

/** Pattern of an asset id. */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

/** The kinds of asset the tools offer, which are also the API's names of them. */
export const KINDS: readonly AmbientCgAssetKind[] = ['material', 'decal', 'atlas', 'hdri']

/** The fields of an asset that the client asks for. */
const INCLUDE = 'type,title,tags,dimensions,downloadStatistics,maps,technique,releaseDate,downloads,thumbnails'

/** The domains whose hosts serve ambientCG's files, besides the configured API's own host. */
const AMBIENTCG_DOMAINS = ['ambientcg.com', 'struffelproductions.com'] as const

/** Most search pages kept in memory. */
const MAX_CACHED_PAGES = 64

/** Most assets kept in memory by id. */
const MAX_CACHED_ASSETS = 2048

/** An archive's name in the API: a resolution and, for surfaces, the picture format. */
const ARCHIVE_ATTRIBUTES = /^(\d{1,2})K(?:-(JPG|PNG))?$/u

/** The thumbnails a preview uses, the first one the asset has: about 512 pixels, on white. */
const PREVIEW_THUMBNAILS = ['512-JPG-FFFFFF', '512-PNG', '256-JPG-FFFFFF', '1024-JPG-FFFFFF'] as const

const AssetJson = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  dimensions: z.object({ width: z.number().nullish(), height: z.number().nullish() }).nullish(),
  downloadStatistics: z.object({ total: z.number().nullish() }).nullish(),
  maps: z.array(z.string()).nullish(),
  technique: z.string().nullish(),
  releaseDate: z.string().nullish(),
  downloads: z.array(z.unknown()).nullish(),
  thumbnails: z.record(z.string(), z.unknown()).nullish(),
})

const ArchiveJson = z.object({ attributes: z.string(), extension: z.string(), url: z.string().min(1), size: z.number().int().min(0) })

const PageJson = z.object({ totalResults: z.number().int().min(0), assets: z.array(z.unknown()) })

const CategoryJson = z.object({ title: z.string().min(1), type: z.string(), numberOfAssets: z.number().int().min(0) })

/** How the client reaches the API. */
export interface AmbientCgApiOptions {
  /** Base URL of the API, such as `https://ambientcg.com/api/v3`. */
  readonly apiUrl: string
  /** Value of the `User-Agent` header of every request. */
  readonly userAgent: string
  /** How long a fetched page, asset, or category list stays fresh, in milliseconds. */
  readonly catalogMaxAgeMs: number
  /** The fetch implementation. */
  readonly fetch: typeof fetch
  /** Milliseconds since the epoch. */
  readonly now: () => number
}

/** A value with the time it was read. */
interface Cached<T> {
  readonly value: T
  readonly fetchedAt: number
}

function kindOf(type: string): AmbientCgAssetKind | undefined {
  return KINDS.find(kind => kind === type)
}

/**
 * The archives of an asset that the tools download: ZIP files named by a resolution, with a picture format for a
 * surface and without one for an HDRI. Other files, such as animated decals and Substance archives, are left out.
 * @param kind - the asset's kind.
 * @param downloads - the asset's `downloads` from the API.
 * @returns the archives, by picture format and then from the smallest resolution up.
 */
function parseArchives(kind: AmbientCgAssetKind, downloads: readonly unknown[]): AmbientCgArchive[] {
  const archives: Array<AmbientCgArchive & { readonly pixels: number }> = []
  for (const value of downloads) {
    const parsed = ArchiveJson.safeParse(value)
    if (!parsed.success || parsed.data.extension !== 'zip' || !URL.canParse(parsed.data.url)) continue
    const named = ARCHIVE_ATTRIBUTES.exec(parsed.data.attributes)
    if (named === null || (named[2] === undefined) !== (kind === 'hdri')) continue
    archives.push({
      resolution: `${named[1] as string}k`,
      format: named[2]?.toLowerCase() ?? 'exr',
      attributes: parsed.data.attributes,
      url: parsed.data.url,
      size: parsed.data.size,
      pixels: Number(named[1]),
    })
  }
  return archives
    .sort((a, b) => a.format.localeCompare(b.format) || a.pixels - b.pixels)
    .map(({ pixels: _pixels, ...archive }) => archive)
}

/**
 * Turn one entry of an asset list into an asset.
 * @param value - the entry.
 * @returns the asset, or undefined for an entry of another kind or another format.
 */
function parseAsset(value: unknown): AmbientCgAsset | undefined {
  const parsed = AssetJson.safeParse(value)
  if (!parsed.success || !ASSET_ID_PATTERN.test(parsed.data.id)) return undefined
  const json = parsed.data
  const kind = kindOf(json.type)
  if (kind === undefined) return undefined
  const width = json.dimensions?.width ?? 0
  const height = json.dimensions?.height ?? 0
  const thumbnails = json.thumbnails ?? {}
  const thumbnail = PREVIEW_THUMBNAILS.map(size => thumbnails[size]).find(url => typeof url === 'string' && url !== '')
  return {
    id: json.id,
    title: json.title ?? json.id,
    kind,
    tags: json.tags ?? [],
    maps: json.maps ?? [],
    technique: json.technique ?? '',
    downloads: json.downloadStatistics?.total ?? 0,
    released: json.releaseDate ?? '',
    ...width > 0 && height > 0 ? { sizeCm: [width, height] } : {},
    archives: parseArchives(kind, json.downloads ?? []),
    ...typeof thumbnail === 'string' ? { thumbnailUrl: thumbnail } : {},
  }
}

/**
 * The ambientCG API, with search pages, assets, and the category list cached in memory. Preview images and archive
 * downloads are the shared client's.
 */
export class AmbientCgApi extends AssetLibraryClient {
  private readonly pages = new Map<string, Cached<AmbientCgPage>>()
  private readonly byId = new Map<string, Cached<AmbientCgAsset>>()
  private categoryList: Cached<readonly AmbientCgCategory[]> | undefined

  /**
   * @param options - the API's URL, the user agent, the cache lifetime, and the fetch implementation.
   */
  constructor(private readonly options: AmbientCgApiOptions) {
    super({
      library: 'ambientCG',
      apiUrl: options.apiUrl,
      domains: AMBIENTCG_DOMAINS,
      userAgent: options.userAgent,
      fetch: options.fetch,
      downloads: 'the archive',
    })
  }

  private fresh(cached: Cached<unknown>): boolean {
    return this.options.now() - cached.fetchedAt < this.options.catalogMaxAgeMs
  }

  /**
   * One page of the assets that have every word, most popular first.
   * @param words - the keywords; none lists every asset of the kinds.
   * @param kinds - the kinds to list.
   * @param limit - most assets of the page, 1 to 500.
   * @param offset - assets to skip.
   * @param signal - cancellation.
   * @returns the page; the one read last when ambientCG cannot be reached now.
   * @throws AssetLibraryRequestError when the page cannot be read and none is kept.
   */
  async search(
    words: readonly string[], kinds: readonly AmbientCgAssetKind[], limit: number, offset: number, signal: AbortSignal,
  ): Promise<AmbientCgPage> {
    const url = new URL('assets', this.base)
    if (words.length > 0) url.searchParams.set('q', words.join(' '))
    url.searchParams.set('type', kinds.join(','))
    url.searchParams.set('limit', String(limit))
    if (offset > 0) url.searchParams.set('offset', String(offset))
    url.searchParams.set('include', INCLUDE)
    const kept = this.pages.get(url.href)
    if (kept !== undefined && this.fresh(kept)) return kept.value
    let page: AmbientCgPage
    try {
      page = await this.page(url, 'the asset list', signal)
    } catch (error) {
      if (signal.aborted || kept === undefined) throw error
      return kept.value
    }
    this.pages.delete(url.href)
    this.pages.set(url.href, { value: page, fetchedAt: this.options.now() })
    // The page read longest ago leaves when the memory is full.
    for (const key of this.pages.keys()) {
      if (this.pages.size <= MAX_CACHED_PAGES) break
      this.pages.delete(key)
    }
    return page
  }

  /**
   * One asset by id, in any letter case.
   * @param id - asset id.
   * @param signal - cancellation.
   * @returns the asset, or undefined when ambientCG has no material, decal, atlas, or HDRI of that id.
   * @throws AssetLibraryRequestError when the request fails and the asset is not kept.
   */
  async asset(id: string, signal: AbortSignal): Promise<AmbientCgAsset | undefined> {
    const kept = this.byId.get(id.toLowerCase())
    if (kept !== undefined && this.fresh(kept)) return kept.value
    const url = new URL('assets', this.base)
    url.searchParams.set('id', id)
    url.searchParams.set('type', KINDS.join(','))
    url.searchParams.set('include', INCLUDE)
    try {
      const page = await this.page(url, `the asset ${id}`, signal)
      return page.assets.find(asset => asset.id.toLowerCase() === id.toLowerCase())
    } catch (error) {
      if (signal.aborted || kept === undefined) throw error
      return kept.value
    }
  }

  /**
   * Drop what is kept of one asset, so the next call reads it again; a download whose archive no longer matches its
   * listing calls this.
   * @param id - asset id.
   */
  forget(id: string): void {
    this.byId.delete(id.toLowerCase())
  }

  /**
   * The categories of the kinds the tools offer.
   * @param signal - cancellation.
   * @returns the categories with assets, most assets first; the list read last when ambientCG cannot be reached now.
   * @throws AssetLibraryRequestError when the list cannot be read and none is kept.
   */
  async categories(signal: AbortSignal): Promise<readonly AmbientCgCategory[]> {
    const kept = this.categoryList
    if (kept !== undefined && this.fresh(kept)) return kept.value
    try {
      const json = await this.http.json(new URL('categories', this.base), 'the categories', signal)
      if (!Array.isArray(json)) throw new AssetLibraryRequestError(200, 'ambientCG sent the categories in an unknown format.')
      const categories = json.flatMap((value): AmbientCgCategory[] => {
        const parsed = CategoryJson.safeParse(value)
        const kind = parsed.success ? kindOf(parsed.data.type) : undefined
        if (!parsed.success || kind === undefined || parsed.data.numberOfAssets === 0) return []
        return [{ title: parsed.data.title, kind, count: parsed.data.numberOfAssets }]
      }).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
      this.categoryList = { value: categories, fetchedAt: this.options.now() }
      return categories
    } catch (error) {
      if (signal.aborted || kept === undefined) throw error
      return kept.value
    }
  }

  /** Read one page of assets and keep each asset by id. */
  private async page(url: URL, what: string, signal: AbortSignal): Promise<AmbientCgPage> {
    const parsed = PageJson.safeParse(await this.http.json(url, what, signal))
    if (!parsed.success) throw new AssetLibraryRequestError(200, `ambientCG sent ${what} in an unknown format.`)
    const assets = parsed.data.assets.flatMap(value => parseAsset(value) ?? [])
    if (assets.length === 0 && parsed.data.assets.length > 0) throw new AssetLibraryRequestError(200, `ambientCG sent ${what} in an unknown format.`)
    const fetchedAt = this.options.now()
    for (const asset of assets) {
      this.byId.delete(asset.id.toLowerCase())
      this.byId.set(asset.id.toLowerCase(), { value: asset, fetchedAt })
    }
    for (const key of this.byId.keys()) {
      if (this.byId.size <= MAX_CACHED_ASSETS) break
      this.byId.delete(key)
    }
    return { total: parsed.data.totalResults, assets }
  }
}
