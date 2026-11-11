/**
 * The model-facing Poly Haven tools: `polyhaven_search` finds HDRIs, textures, and models in Poly Haven's library,
 * `polyhaven_asset` shows one asset's files and preview image, and `polyhaven_download` saves one format and
 * resolution of an asset into a folder. One set of definitions serves one {@link PolyHavenToolSurface}: the Session's
 * own agent, whose preview images become attachments for its model, or agents that reach the tools over WASD Engine's
 * MCP server, whose preview images travel as image bytes.
 * @module @deepseek-ai/dsh-polyhaven/src/tools
 */
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ASSET_ID_PATTERN, PolyHavenRequestError, type PolyHavenApi, type PreviewImage } from './api.ts'
import { writeDownload } from './download.ts'
import { downloadOptions, MAP_FORMATS, planDownload, type DownloadOptions } from './files.ts'
import type { PolyHavenAsset, PolyHavenAssetKind } from './types.ts'

/** License of every Poly Haven asset, as an SPDX identifier. */
export const LICENSE = 'CC0-1.0'

/** Results `polyhaven_search` lists when the call names no limit. */
export const DEFAULT_LIMIT = 10

/** Most results one `polyhaven_search` call lists. */
export const MAX_LIMIT = 50

/** Longest edge in pixels of a preview image: enough to judge an asset, within every model's image limits. */
const PREVIEW_EDGE = 512

/** Most categories a search lists. */
const LISTED_CATEGORIES = 20

/** Most tags `polyhaven_asset` lists. */
const LISTED_TAGS = 20

/** The kind of each search filter, as the model names it. */
const KIND_OF_FILTER: Readonly<Record<'hdris' | 'textures' | 'models', PolyHavenAssetKind>> = { hdris: 'hdri', textures: 'texture', models: 'model' }

/** Each kind as result text names one asset. */
const KIND_NAME: Readonly<Record<PolyHavenAssetKind, string>> = { hdri: 'HDRI', texture: 'texture', model: 'model' }

/** Each kind as result text names several assets. */
const PLURAL: Readonly<Record<PolyHavenAssetKind, string>> = { hdri: 'HDRIs', texture: 'textures', model: 'models' }

/** What the tools need from the plugin. */
export interface PolyHavenToolHost {
  /** The Poly Haven API. */
  readonly api: PolyHavenApi
  /** Largest total size of one download in bytes. */
  readonly maxDownloadBytes: number
  /** Time limit of one search or asset call in milliseconds. */
  readonly requestTimeoutMs: number
  /** Time limit of one download call in milliseconds. */
  readonly downloadTimeoutMs: number
  /**
   * The download folder of one call.
   * @param requested - the folder the call names: absolute, or relative to the calling Session's working directory;
   * undefined for `assets/polyhaven/<id>` in the working directory.
   * @param id - asset id.
   * @param exec - the call's execution.
   * @returns the absolute folder.
   */
  directory(requested: string | undefined, id: string, exec: ToolRunContext): Promise<string>
}

/** How one set of tool definitions shows preview images to its callers. */
export interface PolyHavenToolSurface {
  /**
   * Show one asset's preview image to the caller of a call.
   * @param exec - the call's execution.
   * @param load - downloads the image; called only when the caller can see images.
   * @param name - display name of the image.
   * @returns the stored image that the result carries, or undefined when the caller cannot see images or the image
   * reaches the caller another way.
   */
  preview(exec: ToolRunContext, load: (signal: AbortSignal) => Promise<PreviewImage>, name: string): Promise<ImageAttachmentRef | undefined>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const STRINGS = { type: 'array', required: true, items: { type: 'string' } } as const
const KIND = { type: 'string', enum: ['hdri', 'texture', 'model'], required: true } as const

const SUMMARY_PROPERTIES = {
  id: STRING,
  name: STRING,
  type: KIND,
  category: STRING,
  description: STRING,
  maxWidth: { type: 'integer', description: 'Width in pixels of the largest texture or panorama.' },
  dimensionsMm: { type: 'array', items: { type: 'number' }, description: 'Real-world size in millimeters on each axis.' },
  polycount: { type: 'integer' },
  downloads: INTEGER,
  page: STRING,
} as const

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: STRING,
    type: { type: 'string', enum: ['hdris', 'textures', 'models'] },
    category: { type: 'string' },
    total: INTEGER,
    offset: INTEGER,
    assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: SUMMARY_PROPERTIES } },
    categories: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: STRING, count: INTEGER } } },
  },
} as const

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    width: INTEGER,
    height: INTEGER,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: INTEGER, height: INTEGER } },
  },
} as const

const ASSET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SUMMARY_PROPERTIES,
    license: STRING,
    authors: STRINGS,
    tags: STRINGS,
    published: { type: 'string', description: 'Publication date, YYYY-MM-DD.' },
    formats: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: STRING,
          resolutions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { resolution: STRING, bytes: INTEGER, files: INTEGER } } },
        },
      },
    },
    maps: STRINGS,
    defaultMaps: STRINGS,
    preview: IMAGE_SCHEMA,
    previewError: { type: 'string' },
  },
} as const

const DOWNLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: STRING,
    name: STRING,
    type: KIND,
    format: STRING,
    resolution: STRING,
    directory: STRING,
    entry: { type: 'string', description: 'The file that opens the asset, relative to directory.' },
    maps: STRINGS,
    files: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: STRING, bytes: INTEGER, status: { type: 'string', enum: ['downloaded', 'replaced', 'unchanged'], required: true } },
      },
    },
    totalBytes: INTEGER,
    downloadedBytes: INTEGER,
    page: STRING,
    license: STRING,
    authors: STRINGS,
  },
} as const

/** One asset as a search lists it. */
type AssetSummary = InferValue<typeof SEARCH_SCHEMA>['assets'][number]

/** The value of `polyhaven_asset`. */
type AssetValue = InferValue<typeof ASSET_SCHEMA>

/** The value of `polyhaven_download`. */
type DownloadValue = InferValue<typeof DOWNLOAD_SCHEMA>

/** Notes on using each downloaded format, which a download result ends with. */
const FORMAT_NOTES: Readonly<Record<string, string>> = {
  hdr: 'In Godot, load it as the panorama of a PanoramaSkyMaterial in the Sky of a WorldEnvironment; in Blender, use it as the World\'s Environment Texture.',
  maps: 'Diffuse is the base color, nor_gl the OpenGL normal map that Godot and Blender read, Rough the roughness, AO the ambient occlusion, and Displacement the height; arm packs ambient occlusion, roughness, and metalness into its red, green, and blue channels, as Godot\'s ORMMaterial3D reads them.',
  gltf: 'Godot imports the .gltf file as a scene to instance; in Blender, import it with bpy.ops.import_scene.gltf.',
  fbx: 'Godot imports the .fbx file as a scene; in Blender, import it with bpy.ops.import_scene.fbx.',
  blend: 'Open or append it in Blender; for Godot, download gltf instead.',
  usd: 'In Blender, import it with bpy.ops.wm.usd_import; Godot does not import USD, so download gltf for Godot.',
  mtlx: 'A MaterialX material for tools that read MaterialX, such as Blender; Godot does not read MaterialX, so download the jpg maps for Godot.',
}

/**
 * The page of an asset on polyhaven.com.
 * @param id - asset id.
 * @returns the page URL.
 */
export function assetPage(id: string): string {
  return `https://polyhaven.com/a/${id}`
}

function megabytes(bytes: number): string {
  if (bytes < 100 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function resolutionOf(width: number | undefined): string | undefined {
  return width === undefined ? undefined : `${Math.round(width / 1024)}k`
}

function sizeOf(dimensionsMm: readonly number[] | undefined): string | undefined {
  if (dimensionsMm === undefined || dimensionsMm.length === 0 || dimensionsMm.some(value => !(value > 0))) return undefined
  return `${dimensionsMm.map(value => Number((value / 1000).toPrecision(3)).toString()).join(' × ')} m`
}

function authorsOf(asset: PolyHavenAsset): string[] {
  return Object.entries(asset.authors).map(([author, credit]) => credit === '' || credit === 'All' ? author : `${author} (${credit})`)
}

function summaryOf(asset: PolyHavenAsset): AssetSummary {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.kind,
    category: asset.category,
    description: asset.description,
    ...asset.maxWidth === undefined ? {} : { maxWidth: asset.maxWidth },
    ...asset.dimensionsMm === undefined ? {} : { dimensionsMm: [...asset.dimensionsMm] },
    ...asset.polycount === undefined ? {} : { polycount: Math.round(asset.polycount) },
    downloads: Math.round(asset.downloads),
    page: assetPage(asset.id),
  }
}

/** One asset's facts in a parenthesis: kind, category, resolution, size, and polygons. */
function factsOf(asset: AssetSummary): string {
  const resolution = resolutionOf(asset.maxWidth)
  const size = sizeOf(asset.dimensionsMm)
  return [
    KIND_NAME[asset.type],
    ...asset.category === '' ? [] : [asset.category],
    ...resolution === undefined ? [] : [`up to ${resolution}`],
    ...size === undefined ? [] : [size],
    ...asset.polycount === undefined ? [] : [`${asset.polycount.toLocaleString('en-US')} polygons`],
  ].join('; ')
}

/** Split a category path into lowercase segments. */
function segmentsOf(category: string): string[] {
  return category.split('/').map(segment => segment.trim().toLowerCase()).filter(segment => segment !== '')
}

function inCategory(asset: PolyHavenAsset, category: readonly string[]): boolean {
  const own = segmentsOf(asset.category)
  return category.every((segment, index) => own[index] === segment)
}

/** The categories one level below `category` that hold the assets, most assets first. */
function childCategories(assets: readonly PolyHavenAsset[], category: readonly string[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, { path: string; count: number }>()
  for (const asset of assets) {
    const parts = asset.category.split('/').map(segment => segment.trim()).filter(segment => segment !== '')
    if (parts.length <= category.length) continue
    const path = parts.slice(0, category.length + 1).join('/')
    const key = path.toLowerCase()
    const entry = counts.get(key)
    if (entry === undefined) counts.set(key, { path, count: 1 })
    else entry.count += 1
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, LISTED_CATEGORIES)
}

/** Rank assets by the query's words in their names, tags, categories, and descriptions. */
function keywordRanking(assets: readonly PolyHavenAsset[], query: string): PolyHavenAsset[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
  const scored = assets.map((asset) => {
    const name = asset.name.toLowerCase()
    const tags = asset.tags.join(' ').toLowerCase()
    const category = asset.category.toLowerCase()
    const description = asset.description.toLowerCase()
    let score = 0
    for (const word of words) {
      if (name.includes(word)) score += 3
      if (tags.includes(word) || category.includes(word)) score += 2
      if (description.includes(word)) score += 1
    }
    return { asset, score }
  })
  return scored.filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.asset.downloads - a.asset.downloads)
    .map(entry => entry.asset)
}

/**
 * Find one asset by id.
 * @throws Error when the id is malformed or names no asset.
 */
async function findAsset(host: PolyHavenToolHost, id: string, signal: AbortSignal): Promise<PolyHavenAsset> {
  if (!ASSET_ID_PATTERN.test(id)) throw new Error(`${JSON.stringify(id)} is not a Poly Haven asset id; ids are like "mossy_rock", as polyhaven_search lists them.`)
  const assets = await host.api.assets(signal)
  const asset = assets.get(id) ?? [...assets.values()].find(candidate => candidate.id.toLowerCase() === id.toLowerCase())
  if (asset === undefined) throw new Error(`Poly Haven has no asset with the id ${JSON.stringify(id)}; find one with polyhaven_search.`)
  return asset
}

/** Read an asset's file tree, wording a missing asset for the model. */
async function filesOf(host: PolyHavenToolHost, asset: PolyHavenAsset, signal: AbortSignal): ReturnType<PolyHavenApi['files']> {
  try {
    return await host.api.files(asset.id, signal)
  } catch (error) {
    if (error instanceof PolyHavenRequestError && error.status === 404) throw new Error(`Poly Haven lists ${asset.id} but has no files for it.`, { cause: error })
    throw error
  }
}

/**
 * The preview image URL of an asset: its thumbnail as a JPEG of {@link PREVIEW_EDGE} pixels.
 * @param thumbnailUrl - the asset list's thumbnail URL.
 * @returns the preview URL, or the thumbnail URL itself when it does not parse.
 */
export function previewUrl(thumbnailUrl: string): string {
  // A thumbnail URL that does not parse is passed on as it is, and its request fails with its own message.
  if (!URL.canParse(thumbnailUrl)) return thumbnailUrl
  const url = new URL(thumbnailUrl)
  url.searchParams.set('width', String(PREVIEW_EDGE))
  url.searchParams.set('height', String(PREVIEW_EDGE))
  url.searchParams.set('format', 'jpeg')
  return url.href
}

function formatLines(options: DownloadOptions): string[] {
  return options.formats.map((option) => {
    const sizes = option.resolutions.map(resolution => `${resolution.resolution} ${megabytes(resolution.bytes)}`).join(', ')
    return `- ${option.format}${MAP_FORMATS.includes(option.format) && options.maps.length > 0 ? ' maps' : ''}: ${sizes}`
  })
}

function renderSearch(value: InferValue<typeof SEARCH_SCHEMA>): string {
  const what = value.type === undefined ? 'assets' : PLURAL[KIND_OF_FILTER[value.type]]
  const where = value.category === undefined ? '' : ` in ${value.category}`
  const lines: string[] = []
  if (value.query === '') lines.push(`Most downloaded Poly Haven ${what}${where}: ${value.total} in all.`)
  else lines.push(`Poly Haven ${what} for ${JSON.stringify(value.query)}${where}, most relevant first: ${value.total} found.`)
  if (value.assets.length === 0) {
    lines.push(value.total > 0
      ? `No results at offset ${value.offset}; pass a smaller offset.`
      : 'Nothing matches; try other words, another type, or no category.')
  } else {
    lines.push(`Showing ${value.offset + 1}–${value.offset + value.assets.length}. Every Poly Haven asset is CC0: free for any use, also commercial, without attribution.`)
    for (const asset of value.assets) lines.push(`- ${asset.id}: ${asset.name} (${factsOf(asset)}). ${asset.description}`.trimEnd())
  }
  if (value.categories.length > 0) {
    lines.push(`Categories${where === '' ? '' : ` under ${value.category ?? ''}`}: ${value.categories.map(category => `${category.path} (${category.count})`).join(', ')}.`)
  }
  const next = value.offset + value.assets.length
  if (next < value.total && value.assets.length > 0) lines.push(`More: pass offset ${next}.`)
  lines.push('polyhaven_asset shows an asset\'s files and preview; polyhaven_download saves it into the project.')
  return lines.join('\n')
}

function renderAsset(value: AssetValue): string {
  const size = sizeOf(value.dimensionsMm)
  const facts = [
    ...size === undefined ? [] : [`Size: ${size}.`],
    ...value.polycount === undefined ? [] : [`${value.polycount.toLocaleString('en-US')} polygons.`],
    ...value.tags.length === 0 ? [] : [`Tags: ${value.tags.slice(0, LISTED_TAGS).join(', ')}.`],
  ]
  const lines = [
    `${value.name} (${value.id}): Poly Haven ${KIND_NAME[value.type]}${value.category === '' ? '' : `, ${value.category}`}, license ${value.license}${value.authors.length === 0 ? '' : `, by ${value.authors.join(', ')}`}. ${value.page}`,
    ...value.description === '' ? [] : [value.description],
    ...facts.length === 0 ? [] : [facts.join(' ')],
  ]
  if (value.formats.length === 0) lines.push('It has no files that polyhaven_download can fetch.')
  else lines.push('Files for polyhaven_download, by format and resolution:', ...formatLines({ formats: value.formats, maps: value.maps, defaultMaps: value.defaultMaps }))
  if (value.maps.length > 0) {
    const left = value.maps.filter(map => !value.defaultMaps.includes(map))
    lines.push(`Maps of the jpg, png, and exr formats: ${value.maps.join(', ')}. Without maps, a download takes ${left.length === 0 ? 'all of them' : `all but ${left.join(', ')}`}; the sizes above count those.`)
  }
  if (value.previewError !== undefined) lines.push(`The preview image could not be shown: ${value.previewError}`)
  return lines.join('\n')
}

function renderDownload(value: DownloadValue): string {
  const counts = (['downloaded', 'replaced', 'unchanged'] as const)
    .map(status => [status, value.files.filter(file => file.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status === 'unchanged' ? 'already in place' : status}`)
  const listed = value.files.map(file => file.path)
  const note = FORMAT_NOTES[value.maps.length > 0 ? 'maps' : value.format === 'exr' ? 'hdr' : value.format]
  return [
    `Saved ${value.name} (Poly Haven ${KIND_NAME[value.type]} ${value.id}, ${value.format} at ${value.resolution}) in ${value.directory}: ${value.files.length} ${value.files.length === 1 ? 'file' : 'files'}, ${megabytes(value.totalBytes)} (${counts.join(', ')}).`,
    ...value.entry === undefined ? [] : [`Open ${value.entry}.`],
    `Files: ${listed.join(', ')}.`,
    `Source: ${value.page}${value.authors.length === 0 ? '' : `, by ${value.authors.join(', ')}`}; license ${value.license}, no attribution required. Record the source with the asset.`,
    ...note === undefined ? [] : [note],
  ].join('\n')
}

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function checkedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const chosen = value ?? fallback
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`)
  return chosen
}

/**
 * Build the Poly Haven tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how the definitions show preview images.
 * @returns the definitions, not registered.
 */
export function polyHavenToolDefinitions(host: PolyHavenToolHost, surface: PolyHavenToolSurface): ToolDefinition[] {
  return [defineTool({
    name: 'polyhaven_search',
    description: 'Search Poly Haven, a free library of CC0 HDRI skies, tileable PBR textures, and 3D models that any game may use without attribution. Understands descriptions in any language, such as "mossy rock", "overcast sky", or "wooden chair", and lists the matching assets, most relevant first, with their ids, categories, sizes, and descriptions. Without a query, lists the most downloaded assets and their categories. Pass an id to polyhaven_asset to see its files and preview, or to polyhaven_download to save it into the project.',
    parameters: {
      query: { type: 'string', description: 'What to find. Default: the most downloaded assets.' },
      type: { type: 'string', enum: ['hdris', 'textures', 'models'], description: 'Only this kind: hdris for skies and lighting, textures for tileable materials, models for props. Default: all three.' },
      category: { type: 'string', description: 'Only assets in this category or below it, as a path from earlier results, such as "Furniture/Seating".' },
      limit: { type: 'integer', description: `Most results, from 1 to ${MAX_LIMIT}. Default: ${DEFAULT_LIMIT}.` },
      offset: { type: 'integer', description: 'Results to skip, to list more. Default: 0.' },
    },
    output: {
      schema: SEARCH_SCHEMA,
      render: (_args, value) => textBlocks(renderSearch(value)),
    },
    timeoutMs: host.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = checkedInteger(args.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT)
      const offset = checkedInteger(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const kind = args.type === undefined ? undefined : KIND_OF_FILTER[args.type]
      const category = args.category === undefined ? [] : segmentsOf(args.category)
      const query = args.query?.trim() ?? ''
      const assets = await host.api.assets(exec.signal)
      const ofKind = [...assets.values()].filter(asset => kind === undefined || asset.kind === kind)
      let ranked: PolyHavenAsset[]
      if (query === '') {
        ranked = ofKind.sort((a, b) => b.downloads - a.downloads || a.id.localeCompare(b.id))
      } else {
        const ids = await host.api.search(query, kind, exec.signal)
        ranked = ids === undefined
          ? keywordRanking(ofKind, query)
          : ids.flatMap(id => assets.get(id) ?? []).filter(asset => kind === undefined || asset.kind === kind)
      }
      const matching = ranked.filter(asset => inCategory(asset, category))
      return {
        query,
        ...args.type === undefined ? {} : { type: args.type },
        ...category.length === 0 || args.category === undefined ? {} : { category: args.category.trim() },
        total: matching.length,
        offset,
        assets: matching.slice(offset, offset + limit).map(summaryOf),
        categories: query === '' ? childCategories(matching, category) : [],
      }
    },
  }), defineTool({
    name: 'polyhaven_asset',
    description: 'Show one Poly Haven asset: its description, authors, tags, and real-world size, the formats and resolutions polyhaven_download can save with their sizes, the texture maps of a texture, and its preview image.',
    parameters: {
      id: { type: 'string', required: true, description: 'Asset id, as polyhaven_search lists it, such as "mossy_rock".' },
      preview: { type: 'boolean', description: 'Show the preview image. Default: true.' },
    },
    output: {
      schema: ASSET_SCHEMA,
      render: (_args, value) => [
        ...textBlocks(renderAsset(value)),
        // The value holds the reference that the attachment store returned, so its id is a stored attachment id.
        ...value.preview === undefined ? [] : [{ type: 'image' as const, attachment: { ...value.preview, attachmentId: brandString<AttachmentId>(value.preview.attachmentId) } }],
      ],
    },
    timeoutMs: host.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const asset = await findAsset(host, args.id, exec.signal)
      const options = downloadOptions(asset.kind, await filesOf(host, asset, exec.signal))
      let preview: ImageAttachmentRef | undefined
      let previewError: string | undefined
      const thumbnail = asset.thumbnailUrl
      if (args.preview !== false && thumbnail !== undefined) {
        try {
          preview = await surface.preview(exec, signal => host.api.image(previewUrl(thumbnail), signal), `polyhaven-${asset.id}.jpg`)
        } catch (error) {
          exec.signal.throwIfAborted()
          previewError = error instanceof Error ? error.message : String(error)
        }
      }
      return {
        ...summaryOf(asset),
        license: LICENSE,
        authors: authorsOf(asset),
        tags: [...asset.tags],
        ...asset.published > 0 ? { published: new Date(asset.published * 1000).toISOString().slice(0, 10) } : {},
        formats: options.formats.map(option => ({
          format: option.format,
          resolutions: option.resolutions.map(resolution => ({ ...resolution })),
        })),
        maps: [...options.maps],
        defaultMaps: [...options.defaultMaps],
        ...preview === undefined ? {} : { preview },
        ...previewError === undefined ? {} : { previewError },
      }
    },
  }), defineTool({
    name: 'polyhaven_download',
    description: 'Save one Poly Haven asset into the project: an HDRI\'s panorama, a texture\'s maps or ready-made material, or a model with its textures, in one format and resolution. It writes every file the format references, checks each file\'s digest, never overwrites a changed file unless replace is true, and skips files already in place. Prefer 1k or 2k for games, gltf for models, and jpg maps for textures in Godot.',
    parameters: {
      id: { type: 'string', required: true, description: 'Asset id, as polyhaven_search lists it.' },
      format: { type: 'string', description: 'File format, from polyhaven_asset. HDRIs: hdr (default) or exr. Textures: jpg (default), png, or exr maps, or a gltf, blend, or mtlx material. Models: gltf (default), fbx, blend, or usd.' },
      resolution: { type: 'string', description: 'Resolution, such as 1k, 2k, or 4k, from polyhaven_asset. Default: 1k.' },
      maps: { type: 'array', items: { type: 'string' }, description: 'For jpg, png, and exr textures: the maps to save, such as ["Diffuse", "nor_gl", "Rough"]. Default: every map but the DirectX normal map nor_dx.' },
      directory: { type: 'string', description: 'Folder to save into, relative to the working directory. Default: assets/polyhaven/<id>.' },
      replace: { type: 'boolean', description: 'Overwrite files that exist with other contents. Default: false.' },
    },
    output: {
      schema: DOWNLOAD_SCHEMA,
      render: (_args, value) => textBlocks(renderDownload(value)),
    },
    timeoutMs: host.downloadTimeoutMs,
    async execute(args, exec) {
      const asset = await findAsset(host, args.id, exec.signal)
      const plan = planDownload(asset.name, asset.kind, await filesOf(host, asset, exec.signal), {
        format: args.format?.trim().toLowerCase(),
        resolution: args.resolution?.trim().toLowerCase(),
        maps: args.maps,
      })
      const totalBytes = plan.files.reduce((total, planned) => total + planned.file.size, 0)
      if (totalBytes > host.maxDownloadBytes) {
        throw new Error(`This download of ${asset.name} is ${megabytes(totalBytes)}, more than the ${megabytes(host.maxDownloadBytes)} that one download may be; choose a lower resolution${plan.maps.length > 0 ? ', fewer maps,' : ''} or another format.`)
      }
      const directory = await host.directory(args.directory, asset.id, exec)
      const files = await writeDownload(plan, directory, {
        replace: args.replace === true,
        open: (url, signal) => host.api.download(url, signal),
        signal: exec.signal,
      })
      return {
        id: asset.id,
        name: asset.name,
        type: asset.kind,
        format: plan.format,
        resolution: plan.resolution,
        directory,
        ...plan.entry === undefined ? {} : { entry: plan.entry },
        maps: [...plan.maps],
        files: files.map(file => ({ ...file })),
        totalBytes,
        downloadedBytes: files.filter(file => file.status !== 'unchanged').reduce((total, file) => total + file.bytes, 0),
        page: assetPage(asset.id),
        license: LICENSE,
        authors: authorsOf(asset),
      }
    },
  })]
}
