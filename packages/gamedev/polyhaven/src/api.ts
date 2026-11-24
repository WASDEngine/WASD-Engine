/**
 * Client of the Poly Haven API: the asset list, which stays in memory for `catalogMaxAgeMs`, the ranked search, one
 * asset's file tree, preview images, and file downloads. Every request names the software in `User-Agent`, as the
 * API terms require, goes only to Poly Haven's hosts, and has its response validated before use.
 * @module @deepseek-ai/dsh-polyhaven/src/api
 */
import { z } from 'zod'
import { AssetLibraryClient } from '@deepseek-ai/dsh-game-mcp/kit'
import { POLYHAVEN_ERRORS, PolyHavenError, requestStatus } from './errors.ts'
import type { PolyHavenAsset, PolyHavenAssetKind, PolyHavenFile, PolyHavenFileEntry, PolyHavenFileTree } from './types.ts'

/** Pattern of an asset id. */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

/** The API's numeric asset types, by kind. */
const KIND_OF_TYPE: Readonly<Record<number, PolyHavenAssetKind>> = { 0: 'hdri', 1: 'texture', 2: 'model' }

/** The API's type filter of each kind. */
export const TYPE_FILTER: Readonly<Record<PolyHavenAssetKind, string>> = { hdri: 'hdris', texture: 'textures', model: 'models' }

const AssetJson = z.object({
  name: z.string().min(1),
  type: z.number().int(),
  description: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  authors: z.record(z.string(), z.string()).optional(),
  download_count: z.number().optional(),
  date_published: z.number().optional(),
  max_resolution: z.array(z.number()).optional(),
  dimensions: z.array(z.number()).optional(),
  polycount: z.number().optional(),
  thumbnail_url: z.string().optional(),
})

const SearchJson = z.object({ results: z.array(z.object({ slug: z.string() })) })

const FileJson = z.object({ url: z.string().min(1), size: z.number().int().min(0), md5: z.string().regex(/^[0-9a-fA-F]{32}$/u) })

/** How the client reaches the API. */
export interface PolyHavenApiOptions {
  /** Base URL of the API, such as `https://api.polyhaven.com`. */
  readonly apiUrl: string
  /** Value of the `User-Agent` header of every request. */
  readonly userAgent: string
  /** How long a fetched asset list stays fresh, in milliseconds. */
  readonly catalogMaxAgeMs: number
  /** The fetch implementation. */
  readonly fetch: typeof fetch
  /** Milliseconds since the epoch. */
  readonly now: () => number
}

/** The domains whose hosts serve Poly Haven's files, besides the configured API's own host. */
const POLY_HAVEN_DOMAINS = ['polyhaven.com', 'polyhaven.org'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turn one entry of the asset list into an asset.
 * @param id - the entry's key.
 * @param value - the entry.
 * @returns the asset, or undefined for an entry of an unknown type or another format.
 */
function parseAsset(id: string, value: unknown): PolyHavenAsset | undefined {
  const parsed = AssetJson.safeParse(value)
  if (!parsed.success || !ASSET_ID_PATTERN.test(id)) return undefined
  const json = parsed.data
  const kind = KIND_OF_TYPE[json.type]
  if (kind === undefined) return undefined
  const width = json.max_resolution?.[0]
  return {
    id,
    name: json.name,
    kind,
    description: json.description ?? '',
    category: json.category ?? '',
    tags: json.tags ?? [],
    authors: json.authors ?? {},
    downloads: json.download_count ?? 0,
    published: json.date_published ?? 0,
    ...width === undefined || width <= 0 ? {} : { maxWidth: width },
    ...json.dimensions === undefined || kind === 'hdri' ? {} : { dimensionsMm: json.dimensions },
    ...json.polycount === undefined ? {} : { polycount: json.polycount },
    ...json.thumbnail_url === undefined ? {} : { thumbnailUrl: json.thumbnail_url },
  }
}

function parseFile(value: unknown): PolyHavenFile | undefined {
  const parsed = FileJson.safeParse(value)
  return parsed.success ? { url: parsed.data.url, size: parsed.data.size, md5: parsed.data.md5.toLowerCase() } : undefined
}

/**
 * Read an asset's file tree from the `/files/{id}` response. Entries that are not three levels of records ending in
 * files, such as the single tonemapped image of an HDRI, are left out, and so are files whose fields are missing.
 * @param json - the response.
 * @returns the tree.
 */
export function parseFileTree(json: unknown): PolyHavenFileTree {
  const tree = new Map<string, Map<string, Map<string, PolyHavenFileEntry>>>()
  if (!isRecord(json)) return tree
  for (const [group, resolutions] of Object.entries(json)) {
    if (!isRecord(resolutions) || parseFile(resolutions) !== undefined) continue
    for (const [resolution, formats] of Object.entries(resolutions)) {
      if (!isRecord(formats)) continue
      for (const [format, value] of Object.entries(formats)) {
        const file = parseFile(value)
        if (file === undefined) continue
        const include: Record<string, PolyHavenFile> = {}
        const listed = isRecord(value) ? value.include : undefined
        let complete = true
        if (isRecord(listed)) {
          for (const [path, entry] of Object.entries(listed)) {
            const included = parseFile(entry)
            if (included === undefined) complete = false
            else include[path] = included
          }
        }
        // A file whose references cannot all be read would be written without some of them.
        if (!complete) continue
        let byResolution = tree.get(group)
        if (byResolution === undefined) tree.set(group, byResolution = new Map<string, Map<string, PolyHavenFileEntry>>())
        let byFormat = byResolution.get(resolution)
        if (byFormat === undefined) byResolution.set(resolution, byFormat = new Map<string, PolyHavenFileEntry>())
        byFormat.set(format, { ...file, include })
      }
    }
  }
  return tree
}

/** The Poly Haven API, with the asset list cached in memory. Preview images and file downloads are the shared client's. */
export class PolyHavenApi extends AssetLibraryClient {
  private cached: { readonly assets: ReadonlyMap<string, PolyHavenAsset>; readonly fetchedAt: number } | undefined

  /**
   * @param options - the API's URL, the user agent, the cache lifetime, and the fetch implementation.
   */
  constructor(private readonly options: PolyHavenApiOptions) {
    super({
      library: 'Poly Haven',
      apiUrl: options.apiUrl,
      domains: POLY_HAVEN_DOMAINS,
      userAgent: options.userAgent,
      fetch: options.fetch,
      downloads: 'the file',
      errors: POLYHAVEN_ERRORS,
    })
  }

  /**
   * The asset list: the cached one while it is fresh, else a fetched one. When fetching fails, a stale cached list
   * answers instead, so a Poly Haven outage leaves search on the list it last read.
   * @param signal - cancellation.
   * @returns every asset by id.
   * @throws PolyHavenError `POLYHAVEN_REQUEST_FAILED` when the list cannot be read and none is cached.
   */
  async assets(signal: AbortSignal): Promise<ReadonlyMap<string, PolyHavenAsset>> {
    const cached = this.cached
    if (cached !== undefined && this.options.now() - cached.fetchedAt < this.options.catalogMaxAgeMs) return cached.assets
    try {
      const json = await this.http.json(new URL('assets?type=all', this.base), 'the asset list', signal)
      if (!isRecord(json)) throw new PolyHavenError('Poly Haven sent an asset list in an unknown format.', 'POLYHAVEN_REQUEST_FAILED')
      const assets = new Map<string, PolyHavenAsset>()
      for (const [id, value] of Object.entries(json)) {
        const asset = parseAsset(id, value)
        if (asset !== undefined) assets.set(id, asset)
      }
      if (assets.size === 0 && Object.keys(json).length > 0) throw new PolyHavenError('Poly Haven sent an asset list in an unknown format.', 'POLYHAVEN_REQUEST_FAILED')
      this.cached = { assets, fetchedAt: this.options.now() }
      return assets
    } catch (error) {
      if (signal.aborted || cached === undefined) throw error
      return cached.assets
    }
  }

  /**
   * Rank assets for a query with the API's search, which understands synonyms and any language.
   * @param query - the words to look for.
   * @param kind - the only asset kind to rank; undefined for all.
   * @param signal - cancellation.
   * @returns the ids of every matching asset, most relevant first; undefined when the API cannot rank this query now
   * (HTTP 503), in which case the caller ranks by keywords itself.
   * @throws PolyHavenError `POLYHAVEN_REQUEST_FAILED` for every other failure.
   */
  async search(query: string, kind: PolyHavenAssetKind | undefined, signal: AbortSignal): Promise<readonly string[] | undefined> {
    const url = new URL('search', this.base)
    url.searchParams.set('q', query.trim().toLowerCase())
    url.searchParams.set('t', kind === undefined ? 'all' : TYPE_FILTER[kind])
    try {
      const parsed = SearchJson.safeParse(await this.http.json(url, 'search results', signal))
      if (!parsed.success) throw new PolyHavenError('Poly Haven sent search results in an unknown format.', 'POLYHAVEN_REQUEST_FAILED')
      return parsed.data.results.map(result => result.slug)
    } catch (error) {
      if (requestStatus(error) === 503) return undefined
      throw error
    }
  }

  /**
   * Read the file tree of one asset.
   * @param id - asset id.
   * @param signal - cancellation.
   * @returns the asset's files.
   * @throws PolyHavenError `POLYHAVEN_REQUEST_FAILED` when the request fails, whose {@link requestStatus} is 404 when
   * Poly Haven has no such asset.
   */
  async files(id: string, signal: AbortSignal): Promise<PolyHavenFileTree> {
    return parseFileTree(await this.http.json(new URL(`files/${encodeURIComponent(id)}`, this.base), `the files of ${id}`, signal))
  }
}
