/**
 * Client of the Poly Haven API: the asset list, which stays in memory for `catalogMaxAgeMs`, the ranked search, one
 * asset's file tree, preview images, and file downloads. Every request names the software in `User-Agent`, as the
 * API terms require, and every response is validated before use.
 * @module @deepseek-ai/dsh-polyhaven/src/api
 */
import { z } from 'zod'
import type { PolyHavenAsset, PolyHavenAssetKind, PolyHavenFile, PolyHavenFileEntry, PolyHavenFileTree } from './types.ts'

/** Most bytes of one JSON response; the full asset list is about 2.5 MB. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

/** Most bytes of one preview image. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Media types a preview image may have. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** Media type of a preview image. */
export type PreviewMediaType = typeof IMAGE_TYPES[number]

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

/** A failed request: the HTTP status, or 0 when Poly Haven could not be reached. */
export class PolyHavenRequestError extends Error {
  /**
   * @param status - HTTP status of the response, or 0 without one.
   * @param message - model-facing explanation.
   * @param options - the underlying failure.
   */
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PolyHavenRequestError'
  }
}

/** A preview image's bytes. */
export interface PreviewImage {
  /** Encoded image. */
  readonly data: Buffer
  /** Media type from the response. */
  readonly mediaType: PreviewMediaType
}

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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

/**
 * Read a response body, at most `limit` bytes.
 * @param response - the response.
 * @param limit - most bytes.
 * @param what - what the body is, for the error.
 * @returns the bytes.
 * @throws PolyHavenRequestError when the body is longer than the limit.
 */
async function readBounded(response: Response, limit: number, what: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new PolyHavenRequestError(response.status, `Poly Haven sent ${what} larger than ${limit} bytes.`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength
    // Leaving the loop cancels the body.
    if (total > limit) throw new PolyHavenRequestError(response.status, `Poly Haven sent ${what} larger than ${limit} bytes.`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** The Poly Haven API, with the asset list cached in memory. */
export class PolyHavenApi {
  private readonly base: URL
  private cached: { readonly assets: ReadonlyMap<string, PolyHavenAsset>; readonly fetchedAt: number } | undefined

  /**
   * @param options - the API's URL, the user agent, the cache lifetime, and the fetch implementation.
   */
  constructor(private readonly options: PolyHavenApiOptions) {
    this.base = new URL(options.apiUrl.endsWith('/') ? options.apiUrl : `${options.apiUrl}/`)
  }

  /**
   * The asset list: the cached one while it is fresh, else a fetched one. When fetching fails, a stale cached list
   * answers instead, so a Poly Haven outage leaves search on the list it last read.
   * @param signal - cancellation.
   * @returns every asset by id.
   * @throws PolyHavenRequestError when the list cannot be read and none is cached.
   */
  async assets(signal: AbortSignal): Promise<ReadonlyMap<string, PolyHavenAsset>> {
    const cached = this.cached
    if (cached !== undefined && this.options.now() - cached.fetchedAt < this.options.catalogMaxAgeMs) return cached.assets
    try {
      const json = await this.json(new URL('assets?type=all', this.base), 'the asset list', signal)
      if (!isRecord(json)) throw new PolyHavenRequestError(200, 'Poly Haven sent an asset list in an unknown format.')
      const assets = new Map<string, PolyHavenAsset>()
      for (const [id, value] of Object.entries(json)) {
        const asset = parseAsset(id, value)
        if (asset !== undefined) assets.set(id, asset)
      }
      if (assets.size === 0 && Object.keys(json).length > 0) throw new PolyHavenRequestError(200, 'Poly Haven sent an asset list in an unknown format.')
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
   * @throws PolyHavenRequestError for every other failure.
   */
  async search(query: string, kind: PolyHavenAssetKind | undefined, signal: AbortSignal): Promise<readonly string[] | undefined> {
    const url = new URL('search', this.base)
    url.searchParams.set('q', query.trim().toLowerCase())
    url.searchParams.set('t', kind === undefined ? 'all' : TYPE_FILTER[kind])
    try {
      const parsed = SearchJson.safeParse(await this.json(url, 'search results', signal))
      if (!parsed.success) throw new PolyHavenRequestError(200, 'Poly Haven sent search results in an unknown format.')
      return parsed.data.results.map(result => result.slug)
    } catch (error) {
      if (error instanceof PolyHavenRequestError && error.status === 503) return undefined
      throw error
    }
  }

  /**
   * Read the file tree of one asset.
   * @param id - asset id.
   * @param signal - cancellation.
   * @returns the asset's files.
   * @throws PolyHavenRequestError when the request fails; status 404 when Poly Haven has no such asset.
   */
  async files(id: string, signal: AbortSignal): Promise<PolyHavenFileTree> {
    return parseFileTree(await this.json(new URL(`files/${encodeURIComponent(id)}`, this.base), `the files of ${id}`, signal))
  }

  /**
   * Download a preview image.
   * @param url - image URL.
   * @param signal - cancellation.
   * @returns the image.
   * @throws PolyHavenRequestError when the request fails or the response is not an image of a supported type.
   */
  async image(url: string, signal: AbortSignal): Promise<PreviewImage> {
    const response = await this.request(new URL(url), 'image/*', 'the preview image', signal)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const mediaType = IMAGE_TYPES.find(candidate => candidate === type)
    if (mediaType === undefined) {
      await response.body?.cancel()
      throw new PolyHavenRequestError(response.status, `Poly Haven sent the preview image as ${type === '' ? 'an unknown type' : type}.`)
    }
    return { data: await readBounded(response, MAX_IMAGE_BYTES, 'a preview image'), mediaType }
  }

  /**
   * Start downloading one file.
   * @param url - file URL from a file tree.
   * @param signal - cancellation of the request and of reading its body.
   * @returns the successful response, whose body the caller reads.
   * @throws PolyHavenRequestError when the request fails.
   */
  async download(url: string, signal: AbortSignal): Promise<Response> {
    return await this.request(new URL(url), '*/*', `the file ${url}`, signal)
  }

  private async json(url: URL, what: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(url, 'application/json', what, signal)
    const text = (await readBounded(response, MAX_JSON_BYTES, what)).toString('utf8')
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      throw new PolyHavenRequestError(response.status, `Poly Haven sent ${what} that is not JSON.`, { cause: error })
    }
  }

  private async request(url: URL, accept: string, what: string, signal: AbortSignal): Promise<Response> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new PolyHavenRequestError(0, `Poly Haven named ${what} at a URL that is not HTTP: ${url.href}`)
    let response: Response
    try {
      response = await this.options.fetch(url, { headers: { 'user-agent': this.options.userAgent, accept }, signal })
    } catch (error) {
      signal.throwIfAborted()
      throw new PolyHavenRequestError(0, `Could not reach Poly Haven at ${url.host} for ${what}: ${message(error)}`, { cause: error })
    }
    if (response.ok) return response
    await response.body?.cancel()
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? Number.NaN)
      const after = Number.isFinite(wait) && wait > 0 ? `in ${Math.ceil(wait)} seconds` : 'later'
      throw new PolyHavenRequestError(429, `Poly Haven is limiting requests from this computer; try again ${after}.`)
    }
    throw new PolyHavenRequestError(response.status, `Poly Haven answered HTTP ${response.status} for ${what}.`)
  }
}
