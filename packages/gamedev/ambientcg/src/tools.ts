/**
 * The model-facing ambientCG tools: `ambientcg_search` finds materials, decals, atlases, and HDRIs in ambientCG's
 * library by keywords, `ambientcg_asset` shows one asset's sizes and preview image, and `ambientcg_download` saves
 * the map pictures of one resolution into a folder. One set of definitions serves one {@link AmbientCgToolSurface}:
 * the Session's own agent, whose preview images become attachments for its model, or agents that reach the tools over
 * WASD Engine's MCP server, whose preview images travel as image bytes.
 * @module @deepseek-ai/dsh-ambientcg/src/tools
 */
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ATTACHED_IMAGE_SCHEMA, checkedInteger, kilobytes, savedCounts, shownPreview, textBlocks, WRITTEN_FILES_SCHEMA, type PreviewSurface,
} from '@deepseek-ai/dsh-game-mcp/kit'
import { defineTool, ToolArgsError, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ASSET_ID_PATTERN, KINDS, type AmbientCgApi } from './api.ts'
import { writeDownload } from './download.ts'
import { AmbientCgError, isStaleListing } from './errors.ts'
import { checkMaps, chooseArchive, formatOptions, mapKey } from './files.ts'
import type { AmbientCgArchiveListing, AmbientCgAsset, AmbientCgAssetKind, AmbientCgCategory, AmbientCgPage } from './types.ts'

/** License of every ambientCG asset, as an SPDX identifier. */
export const LICENSE = 'CC0-1.0'

/** Results `ambientcg_search` lists when the call names no limit. */
export const DEFAULT_LIMIT = 10

/** Most results one `ambientcg_search` call lists. */
export const MAX_LIMIT = 50

/** Most results a search may skip; the library holds a few thousand assets. */
const MAX_OFFSET = 100_000

/** Most keywords of one search. */
const MAX_WORDS = 8

/** Most keywords that a search with no asset for all of them looks up one by one. */
const RELAXED_WORDS = 4

/** Assets read for each keyword of such a search. */
const RELAXED_LIMIT = 50

/** Most categories a search lists. */
const LISTED_CATEGORIES = 30

/** Most tags one asset lists. */
const LISTED_TAGS = 12

/** The kind of each search filter, as the model names it. */
const KIND_OF_FILTER: Readonly<Record<'materials' | 'decals' | 'atlases' | 'hdris', AmbientCgAssetKind>> = {
  materials: 'material', decals: 'decal', atlases: 'atlas', hdris: 'hdri',
}

/** Each kind as result text names one asset. */
const KIND_NAME: Readonly<Record<AmbientCgAssetKind, string>> = { material: 'material', decal: 'decal', atlas: 'atlas', hdri: 'HDRI' }

/** Each kind as result text names several assets. */
const PLURAL: Readonly<Record<AmbientCgAssetKind, string>> = { material: 'materials', decal: 'decals', atlas: 'atlases', hdri: 'HDRIs' }

/** How a surface was made, by the API's name of the technique. */
const MADE: Readonly<Record<string, string>> = {
  'surface-photogrammetry': 'scanned',
  'surface-photometric-stereo': 'scanned',
  'surface-fully-procedural': 'procedural',
  'surface-procedural-bitmap-elements': 'procedural',
  'surface-approximated': 'from a photo',
}

/** What each map of a surface holds, by its key, as a download's result says it. */
const MAP_MEANINGS: Readonly<Record<string, string>> = {
  color: 'the base color',
  normalgl: 'the OpenGL normal map that Godot and Blender read',
  normaldx: 'the DirectX normal map, which Godot and Blender do not read',
  roughness: 'the roughness',
  metalness: 'the metal',
  ambientocclusion: 'the ambient occlusion',
  displacement: 'the height',
  opacity: 'the transparency, which belongs in the material\'s alpha',
  scattering: 'the light that shines through',
  emission: 'the glow',
}

/** What the tools need from the plugin. */
export interface AmbientCgToolHost {
  /** The ambientCG API. */
  readonly api: AmbientCgApi
  /** Largest size of the archive of one download, and of the pictures it unpacks, in bytes. */
  readonly maxDownloadBytes: number
  /** Time limit of one search or asset call in milliseconds. */
  readonly requestTimeoutMs: number
  /** Time limit of one download call in milliseconds. */
  readonly downloadTimeoutMs: number
  /** The directories of the archives the plugin read, which later downloads of the same archive start from. */
  readonly archives: Map<string, AmbientCgArchiveListing>
  /** The folders that the plugin's running downloads created, each with how many of them hold it. */
  readonly folders: Map<string, number>
  /**
   * The download folder of one call.
   * @param requested - the folder the call names: absolute, or relative to the calling Session's working directory;
   * undefined for `assets/ambientcg/<id>` in the working directory.
   * @param id - asset id.
   * @param exec - the call's execution.
   * @returns the absolute folder.
   */
  directory(requested: string | undefined, id: string, exec: ToolRunContext): Promise<string>
}

/** How one set of tool definitions shows preview images to its callers. */
export type AmbientCgToolSurface = PreviewSurface<ImageAttachmentRef>

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const STRINGS = { type: 'array', required: true, items: { type: 'string' } } as const
const KIND = { type: 'string', enum: ['material', 'decal', 'atlas', 'hdri'], required: true } as const
const SIZE = { type: 'array', items: { type: 'number' }, description: 'Real-world width and height of one repeat in meters.' } as const

const SUMMARY_PROPERTIES = {
  id: STRING,
  name: STRING,
  type: KIND,
  tags: STRINGS,
  maps: STRINGS,
  sizeM: SIZE,
  made: { type: 'string', description: 'How a surface was made: scanned, procedural, or from a photo.' },
  maxResolution: { type: 'string', description: 'The largest resolution, such as 8k.' },
  downloads: INTEGER,
  page: STRING,
} as const

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: STRING,
    type: { type: 'string', enum: ['materials', 'decals', 'atlases', 'hdris'] },
    total: INTEGER,
    offset: INTEGER,
    relaxed: { type: 'boolean', description: 'True when no asset has every word of the query, and the list ranks the assets that have some.' },
    assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: SUMMARY_PROPERTIES } },
    categories: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: STRING, type: KIND, count: INTEGER } } },
  },
} as const

const ASSET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SUMMARY_PROPERTIES,
    license: STRING,
    released: { type: 'string', description: 'Release date, YYYY-MM-DD.' },
    /* jscpd:ignore-start -- polyhaven_asset lists its formats and resolutions in the same fields by design, so an agent
     * reads both libraries' results alike. */
    formats: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: STRING,
          resolutions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { resolution: STRING, bytes: INTEGER } } },
        },
      },
    },
    /* jscpd:ignore-end */
    preview: ATTACHED_IMAGE_SCHEMA,
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
    maps: STRINGS,
    files: WRITTEN_FILES_SCHEMA,
    totalBytes: INTEGER,
    downloadedBytes: {
      type: 'integer',
      required: true,
      description: 'Size of the archive this call fetched; 0 when it fetched none, which needs every map in place and an earlier download of the archive since WASD Engine started.',
    },
    sizeM: SIZE,
    page: STRING,
    license: STRING,
  },
} as const

/** The value of `ambientcg_search`. */
type SearchValue = InferValue<typeof SEARCH_SCHEMA>

/** One asset as a search lists it. */
type AssetSummary = SearchValue['assets'][number]

/** The value of `ambientcg_asset`. */
type AssetValue = InferValue<typeof ASSET_SCHEMA>

/** The value of `ambientcg_download`. */
type DownloadValue = InferValue<typeof DOWNLOAD_SCHEMA>

/**
 * The page of an asset on ambientcg.com.
 * @param id - asset id.
 * @returns the page URL.
 */
export function assetPage(id: string): string {
  return `https://ambientcg.com/a/${id}`
}

function fail(message: string): never {
  throw new ToolArgsError([message])
}

function sizeText(sizeM: readonly number[] | undefined): string | undefined {
  return sizeM === undefined ? undefined : `${sizeM.map(value => Number(value.toPrecision(3)).toString()).join(' × ')} m`
}

/** The tags worth a line: without bare numbers and the asset's own id. */
function tagsOf(asset: AmbientCgAsset): string[] {
  const id = asset.id.toLowerCase()
  return asset.tags.filter(tag => !/^\d+$/u.test(tag) && tag.toLowerCase() !== id).slice(0, LISTED_TAGS)
}

function summaryOf(asset: AmbientCgAsset): AssetSummary {
  const made = MADE[asset.technique]
  const largest = asset.archives.map(archive => archive.resolution).sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0]
  return {
    id: asset.id,
    name: asset.title,
    type: asset.kind,
    tags: tagsOf(asset),
    maps: [...asset.maps],
    ...asset.sizeCm === undefined ? {} : { sizeM: asset.sizeCm.map(value => value / 100) },
    ...made === undefined ? {} : { made },
    ...largest === undefined ? {} : { maxResolution: largest },
    downloads: Math.round(asset.downloads),
    page: assetPage(asset.id),
  }
}

/** One asset's facts in a parenthesis: kind, size, how it was made, largest resolution, and maps. */
function factsOf(asset: AssetSummary): string {
  const size = sizeText(asset.sizeM)
  return [
    KIND_NAME[asset.type],
    ...size === undefined ? [] : [size],
    ...asset.made === undefined ? [] : [asset.made],
    ...asset.maxResolution === undefined ? [] : [`up to ${asset.maxResolution}`],
    ...asset.maps.length === 0 ? [] : [`maps ${asset.maps.join(', ')}`],
  ].join('; ')
}

/** The keywords of a query: its words in lowercase, each once. */
function wordsOf(query: string | undefined): string[] {
  const words = (query ?? '').toLowerCase().split(/[\s,;]+/u).filter(word => word !== '')
  return [...new Set(words)].slice(0, MAX_WORDS)
}

/**
 * Rank the assets that have some of the words, for a query that no asset has every word of. Each word is looked up by
 * itself. An asset with more of the words comes first; among equals, the one whose words fewer assets have, so a rare
 * word such as `mossy` counts for more than a common one such as `floor`; then the more popular one.
 * @returns every such asset, at most `RELAXED_LIMIT` per word.
 */
async function someWords(
  host: AmbientCgToolHost, words: readonly string[], kinds: readonly AmbientCgAssetKind[], signal: AbortSignal,
): Promise<AmbientCgAsset[]> {
  const found = new Map<string, { readonly asset: AmbientCgAsset; words: number; weight: number }>()
  // One word after another: the lookups are few, and ambientCG asks for no more load than needed.
  for (const word of [...words].sort((a, b) => b.length - a.length).slice(0, RELAXED_WORDS)) {
    const page = await host.api.search([word], kinds, RELAXED_LIMIT, 0, signal)
    for (const asset of page.assets) {
      const entry = found.get(asset.id) ?? { asset, words: 0, weight: 0 }
      entry.words += 1
      entry.weight += 1 / page.total
      found.set(asset.id, entry)
    }
  }
  return [...found.values()]
    .sort((a, b) => b.words - a.words || b.weight - a.weight
      || b.asset.downloads - a.asset.downloads || a.asset.id.localeCompare(b.asset.id))
    .map(entry => entry.asset)
}

/**
 * Find one asset by id.
 * @throws ToolArgsError when the id is malformed, and AmbientCgError `AMBIENTCG_ASSET_NOT_FOUND` when it names no asset
 * the tools offer.
 */
async function findAsset(host: AmbientCgToolHost, id: string, signal: AbortSignal): Promise<AmbientCgAsset> {
  if (!ASSET_ID_PATTERN.test(id)) throw new ToolArgsError([`${JSON.stringify(id)} is not an ambientCG asset id; ids are like "Bricks097", as ambientcg_search lists them.`])
  const asset = await host.api.asset(id, signal)
  if (asset === undefined) {
    throw new AmbientCgError(`ambientCG has no material, decal, atlas, or HDRI with the id ${JSON.stringify(id)}; find one with ambientcg_search.`, 'AMBIENTCG_ASSET_NOT_FOUND')
  }
  return asset
}

/**
 * The categories that a search without keywords lists: none when ambientCG cannot answer and none are kept, since the
 * assets alone answer the search.
 * @throws the call's cancellation, and every failure other than a failed request.
 */
async function categoriesOf(host: AmbientCgToolHost, signal: AbortSignal): Promise<readonly AmbientCgCategory[]> {
  try {
    return await host.api.categories(signal)
  } catch (error) {
    if (signal.aborted || !(error instanceof AmbientCgError && error.code === 'AMBIENTCG_REQUEST_FAILED')) throw error
    return []
  }
}

function renderSearch(value: SearchValue): string {
  const what = value.type === undefined ? 'assets' : PLURAL[KIND_OF_FILTER[value.type]]
  const lines: string[] = []
  if (value.query === '') lines.push(`Most popular ambientCG ${what}: ${value.total} in all.`)
  else if (value.relaxed === true) lines.push(`No ambientCG ${value.type === undefined ? 'asset' : KIND_NAME[KIND_OF_FILTER[value.type]]} has every word of ${JSON.stringify(value.query)}; these have some of them, most words first: ${value.total} found.`)
  else lines.push(`ambientCG ${what} for ${JSON.stringify(value.query)}, most popular first: ${value.total} found.`)
  if (value.assets.length === 0) {
    lines.push(value.total > 0
      ? `No results at offset ${value.offset}; pass a smaller offset.`
      : 'Nothing matches; try fewer or other English keywords in their plain form, such as wood instead of wooden, or another type.')
  } else {
    lines.push(`Showing ${value.offset + 1}–${value.offset + value.assets.length}. Every ambientCG asset is CC0: free for any use, also commercial, without attribution.`)
    for (const asset of value.assets) lines.push(`- ${asset.id}: ${asset.name} (${factsOf(asset)}).${asset.tags.length === 0 ? '' : ` Tags: ${asset.tags.join(', ')}.`}`)
  }
  if (value.categories.length > 0) lines.push(`Kinds to search for: ${value.categories.map(category => `${category.name} (${category.count})`).join(', ')}.`)
  const next = value.offset + value.assets.length
  if (next < value.total && value.assets.length > 0) lines.push(`More: pass offset ${next}.`)
  lines.push('ambientcg_asset shows an asset\'s file sizes and preview; ambientcg_download saves it into the project.')
  return lines.join('\n')
}

function renderAsset(value: AssetValue): string {
  const size = sizeText(value.sizeM)
  const facts = [
    ...size === undefined ? [] : [`One repeat covers ${size}.`],
    ...value.made === undefined ? [] : [`Made: ${value.made}.`],
    ...value.tags.length === 0 ? [] : [`Tags: ${value.tags.join(', ')}.`],
  ]
  const lines = [
    `${value.name} (${value.id}): ambientCG ${KIND_NAME[value.type]}, license ${value.license}. ${value.page}`,
    ...facts.length === 0 ? [] : [facts.join(' ')],
    ...value.maps.length === 0 ? [] : [`Maps: ${value.maps.join(', ')}.`],
  ]
  if (value.formats.length === 0) {
    lines.push('It has no files that ambientcg_download can fetch.')
  } else {
    lines.push(
      'Archives for ambientcg_download, by picture format and resolution:',
      ...value.formats.map(option => `- ${option.format}: ${option.resolutions.map(resolution => `${resolution.resolution} ${kilobytes(resolution.bytes)}`).join(', ')}`),
      value.type === 'hdri'
        ? 'A download fetches one archive and writes its exr panorama.'
        : 'A download fetches one archive and writes its map pictures: every map but the DirectX normal map, unless maps names others.',
    )
  }
  if (value.previewError !== undefined) lines.push(`The preview image could not be shown: ${value.previewError}`)
  return lines.join('\n')
}

function renderDownload(value: DownloadValue): string {
  const size = sizeText(value.sizeM)
  // Each saved map with what it holds: "Color is the base color, Roughness the roughness, and Displacement the height."
  const meanings = value.maps.flatMap((map) => {
    const meaning = MAP_MEANINGS[mapKey(map)]
    return meaning === undefined ? [] : [`${map} ${meaning}`]
  })
  const [first = '', ...others] = meanings
  const listed = `${first.replace(' ', ' is ')}${others.length === 0 ? '' : `${others.length === 1 ? '' : ','} ${[...others.slice(0, -1), `and ${others.at(-1) ?? ''}`].join(', ')}`}.`
  const note = value.type === 'hdri'
    ? 'In Godot, load the .exr as the panorama of a PanoramaSkyMaterial in the Sky of a WorldEnvironment; in Blender, use it as the World\'s Environment Texture.'
    : [...meanings.length === 0 ? [] : [listed], ...size === undefined ? [] : [`One repeat covers ${size}.`]].join(' ')
  return [
    `Saved ${value.name} (ambientCG ${KIND_NAME[value.type]} ${value.id}, ${value.format} at ${value.resolution}) in ${value.directory}: ${value.files.length} ${value.files.length === 1 ? 'file' : 'files'}, ${kilobytes(value.totalBytes)} (${savedCounts(value.files).join(', ')}).`,
    `Files: ${value.files.map(file => file.path).join(', ')}.`,
    `Source: ${value.page}; license ${value.license}, no attribution required. Record the source with the asset.`,
    ...note === '' ? [] : [note],
  ].join('\n')
}

/**
 * Build the ambientCG tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how the definitions show preview images.
 * @returns the definitions, not registered.
 */
export function ambientCgToolDefinitions(host: AmbientCgToolHost, surface: AmbientCgToolSurface): ToolDefinition[] {
  return [defineTool({
    name: 'ambientcg_search',
    description: 'Search ambientCG, a free library of more than 2,000 CC0 PBR materials, such as bricks, wood, metal, fabric, ground, and tiles, with decals, atlases of cut-out pieces such as leaves, and HDRI skies, that any game may use without attribution. Give a few English keywords, such as "brick wall", "rusty metal", or "wood floor": an asset must have every word, so prefer plain nouns such as wood to wooden, and when none has them all the list ranks the assets that have some. Lists the matching assets, most popular first, with their ids, real-world sizes, maps, and tags. Without a query, lists the most popular assets and the kinds of surface to search for. Pass an id to ambientcg_asset to see its preview and file sizes, or to ambientcg_download to save it into the project.',
    parameters: {
      query: { type: 'string', description: 'English keywords, each of which an asset must have. Default: the most popular assets.' },
      type: { type: 'string', enum: ['materials', 'decals', 'atlases', 'hdris'], description: 'Only this kind: materials for tileable surfaces, decals for marks laid over a surface, atlases for cut-out pieces such as leaves, hdris for skies and lighting. Default: all four.' },
      /* jscpd:ignore-start -- polyhaven_search pages its results with the same two arguments by design, so an agent
       * calls both libraries' searches alike. */
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
      /* jscpd:ignore-end */
      const limit = checkedInteger(args.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT, fail)
      const offset = checkedInteger(args.offset, 0, 'offset', 0, MAX_OFFSET, fail)
      const kinds = args.type === undefined ? KINDS : [KIND_OF_FILTER[args.type]]
      const words = wordsOf(args.query)
      let page: AmbientCgPage = await host.api.search(words, kinds, limit, offset, exec.signal)
      let relaxed = false
      if (page.total === 0 && words.length > 1) {
        const ranked = await someWords(host, words, kinds, exec.signal)
        relaxed = ranked.length > 0
        page = { total: ranked.length, assets: ranked.slice(offset, offset + limit) }
      }
      // Only a call without keywords lists the kinds of surface there are to search for.
      const categories = words.length === 0 ? await categoriesOf(host, exec.signal) : []
      return {
        query: words.join(' '),
        ...args.type === undefined ? {} : { type: args.type },
        total: page.total,
        offset,
        ...relaxed ? { relaxed } : {},
        assets: page.assets.map(summaryOf),
        categories: categories.filter(category => kinds.includes(category.kind)).slice(0, LISTED_CATEGORIES)
          .map(({ title, kind, count }) => ({ name: title, type: kind, count })),
      }
    },
  }), defineTool({
    name: 'ambientcg_asset',
    description: 'Show one ambientCG asset: its tags, real-world size, and maps, the picture formats and resolutions ambientcg_download can save with the size of each archive, and its preview image.',
    parameters: {
      id: { type: 'string', required: true, description: 'Asset id, as ambientcg_search lists it, such as "Bricks097".' },
      /* jscpd:ignore-start -- polyhaven_asset takes the same preview argument and attaches the image the same way by
       * design, so an agent calls both libraries' tools alike. */
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
      /* jscpd:ignore-end */
      const asset = await findAsset(host, args.id, exec.signal)
      const thumbnail = asset.thumbnailUrl
      const shown = args.preview === false || thumbnail === undefined
        ? {}
        : await shownPreview(surface, exec, signal => host.api.image(thumbnail, signal), `ambientcg-${asset.id}`)
      return {
        ...summaryOf(asset),
        license: LICENSE,
        ...asset.released === '' ? {} : { released: asset.released },
        formats: formatOptions(asset).map(({ format, resolutions }) => ({
          format,
          resolutions: resolutions.map(resolution => ({ ...resolution })),
        })),
        ...shown,
      }
    },
  }), defineTool({
    name: 'ambientcg_download',
    description: 'Save one ambientCG asset into the project: the texture maps of a material, decal, or atlas, or the panorama of an HDRI, in one resolution. It fetches the asset\'s archive, checks it, and writes only the map pictures, never overwrites a changed file unless replace is true, and leaves files already in place alone. Prefer 1k or 2k and jpg for games.',
    parameters: {
      id: { type: 'string', required: true, description: 'Asset id, as ambientcg_search lists it.' },
      resolution: { type: 'string', description: 'Resolution, such as 1k, 2k, or 4k, from ambientcg_asset. Default: 1k.' },
      format: { type: 'string', description: 'Picture format of the maps: jpg (default) or png, which is lossless and several times larger. An HDRI is always exr; leave this out for one.' },
      maps: { type: 'array', items: { type: 'string' }, description: 'The maps to save, such as ["color", "normal", "roughness"]; normal is the OpenGL normal map. Default: every map but the DirectX normal map; for an HDRI, its exr panorama.' },
      directory: { type: 'string', description: 'Folder to save into, relative to the working directory. Default: assets/ambientcg/<id>.' },
      /* jscpd:ignore-start -- polyhaven_download takes the same replace argument by design, so an agent calls both
       * libraries' downloads alike. */
      replace: { type: 'boolean', description: 'Overwrite files that exist with other contents. Default: false.' },
    },
    output: {
      schema: DOWNLOAD_SCHEMA,
      render: (_args, value) => textBlocks(renderDownload(value)),
    },
    timeoutMs: host.downloadTimeoutMs,
    async execute(args, exec) {
      /* jscpd:ignore-end */
      const asset = await findAsset(host, args.id, exec.signal)
      const archive = chooseArchive(asset, { format: args.format?.trim().toLowerCase(), resolution: args.resolution?.trim().toLowerCase() })
      checkMaps(asset, args.maps)
      if (archive.size > host.maxDownloadBytes) {
        throw new AmbientCgError(
          `The ${archive.resolution} ${archive.format} archive of ${asset.title} is ${kilobytes(archive.size)}, more than the ${kilobytes(host.maxDownloadBytes)} that one download may be; choose a lower resolution${archive.format === 'png' ? ' or jpg' : ''}.`,
          'AMBIENTCG_TOO_LARGE',
        )
      }
      const directory = await host.directory(args.directory, asset.id, exec)
      const saved = await writeDownload(asset, archive, directory, {
        replace: args.replace === true,
        maps: args.maps,
        maxUnpackedBytes: host.maxDownloadBytes,
        open: (url, signal) => host.api.download(url, signal),
        known: host.archives,
        folders: host.folders,
        signal: exec.signal,
      }).catch((error: unknown) => {
        // An archive that no longer fits the listing means the asset changed; the next call reads it again.
        if (isStaleListing(error)) host.api.forget(asset.id)
        throw error
      })
      return {
        id: asset.id,
        name: asset.title,
        type: asset.kind,
        format: archive.format,
        resolution: archive.resolution,
        directory,
        maps: saved.maps,
        files: saved.files.map(file => ({ ...file })),
        totalBytes: saved.files.reduce((total, file) => total + file.bytes, 0),
        downloadedBytes: saved.fetchedBytes,
        ...asset.sizeCm === undefined ? {} : { sizeM: asset.sizeCm.map(value => value / 100) },
        page: assetPage(asset.id),
        license: LICENSE,
      }
    },
  })]
}
