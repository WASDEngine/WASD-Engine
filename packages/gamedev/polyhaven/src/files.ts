/**
 * What an asset offers to download and which files one download writes. An HDRI offers its panorama as `hdr` or
 * `exr`; a texture offers its maps, such as `Diffuse` and `nor_gl`, as `jpg`, `png`, or `exr` images, and ready-made
 * `gltf`, `blend`, and `mtlx` materials; a model offers `gltf`, `fbx`, `blend`, and `usd` files. Each comes in
 * resolutions such as `1k` and `4k`. Every path a plan writes is checked to stay inside the download folder.
 * @module @deepseek-ai/dsh-polyhaven/src/files
 */
import type { PolyHavenAssetKind, PolyHavenDownloadPlan, PolyHavenFileEntry, PolyHavenFileTree, PolyHavenPlannedFile } from './types.ts'

/** Ready-made formats of each kind: one file with the files it references. */
export const PACKAGE_FORMATS: Readonly<Record<PolyHavenAssetKind, readonly string[]>> = {
  hdri: [],
  texture: ['gltf', 'blend', 'mtlx'],
  model: ['gltf', 'fbx', 'blend', 'usd'],
}

/** Formats of single texture maps. */
export const MAP_FORMATS: readonly string[] = ['jpg', 'png', 'exr']

/** Formats of HDRI panoramas. */
export const HDRI_FORMATS: readonly string[] = ['hdr', 'exr']

/** Format a download uses when the call names none. */
export const DEFAULT_FORMAT: Readonly<Record<PolyHavenAssetKind, string>> = { hdri: 'hdr', texture: 'jpg', model: 'gltf' }

/** Resolution a download uses when the call names none and the format has it; otherwise the smallest one. */
export const DEFAULT_RESOLUTION = '1k'

/** Group of an HDRI's panoramas in its file tree. */
const HDRI_GROUP = 'hdri'

/** Groups of a texture or model file tree that hold ready-made files rather than maps. */
const PACKAGE_GROUPS: ReadonlySet<string> = new Set(['gltf', 'blend', 'mtlx', 'fbx', 'usd'])

/** DirectX normal maps, which neither Godot nor Blender reads; a download leaves them out unless the call names them. */
const DIRECTX_NORMAL = /(?:^|_)nor_dx$/iu

/** One resolution of a format: its size and how many files it writes. */
export interface ResolutionOption {
  /** Resolution, such as `2k`. */
  readonly resolution: string
  /** Total size in bytes; for map formats, of the default maps. */
  readonly bytes: number
  /** Number of files. */
  readonly files: number
}

/** One format an asset offers. */
export interface FormatOption {
  /** Format, such as `gltf`. */
  readonly format: string
  /** Resolutions, smallest first. */
  readonly resolutions: readonly ResolutionOption[]
}

/** What an asset offers to download. */
export interface DownloadOptions {
  /** Formats in the order polyhaven_download documents them. */
  readonly formats: readonly FormatOption[]
  /** Texture maps that the map formats download, in Poly Haven's order; empty for HDRIs and models. */
  readonly maps: readonly string[]
  /** The maps that a map format downloads when the call names none. */
  readonly defaultMaps: readonly string[]
}

/** What one download asks for. */
export interface DownloadRequest {
  /** Format; undefined for the kind's default. */
  readonly format?: string | undefined
  /** Resolution; undefined for the default. */
  readonly resolution?: string | undefined
  /** Texture maps, for map formats; undefined for the default maps. */
  readonly maps?: readonly string[] | undefined
}

function resolutionOrder(resolution: string): number {
  const match = /^(\d+)k$/iu.exec(resolution)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

function byResolution(a: string, b: string): number {
  return resolutionOrder(a) - resolutionOrder(b) || a.localeCompare(b)
}

function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} and ${items.at(-1) ?? ''}`
}

function bytesOf(entry: PolyHavenFileEntry): number {
  return Object.values(entry.include).reduce((total, file) => total + file.size, entry.size)
}

/**
 * The texture maps of a texture's file tree.
 * @param kind - asset kind.
 * @param tree - the asset's files.
 * @returns map names in tree order; empty for HDRIs and models.
 */
function mapsOf(kind: PolyHavenAssetKind, tree: PolyHavenFileTree): string[] {
  return kind === 'texture' ? [...tree.keys()].filter(group => !PACKAGE_GROUPS.has(group)) : []
}

/**
 * Check that a path from a file tree stays inside the download folder.
 * @param path - relative path with `/` separators.
 * @returns the path.
 * @throws Error for an empty, absolute, or parent-relative path, or one with a backslash, colon, or NUL.
 */
export function safeRelativePath(path: string): string {
  const segments = path.split('/')
  const unsafe = path === '' || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\:\0]/u.test(segment))
  if (unsafe) throw new Error(`Poly Haven named a file ${JSON.stringify(path)}, which would leave the download folder; the download stopped.`)
  return path
}

/**
 * The file name of a download URL.
 * @param url - file URL.
 * @returns the URL's last path segment, decoded.
 * @throws Error when the URL has no safe file name.
 */
export function fileNameOf(url: string): string {
  let name: string
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
  } catch (error) {
    throw new Error(`Poly Haven named a file at ${JSON.stringify(url)}, which has no file name; the download stopped.`, { cause: error })
  }
  if (name.includes('/')) throw new Error(`Poly Haven named a file ${JSON.stringify(name)}, which would leave the download folder; the download stopped.`)
  return safeRelativePath(name)
}

/**
 * List what an asset offers to download.
 * @param kind - asset kind.
 * @param tree - the asset's files.
 * @returns its formats with their resolutions and sizes, and its texture maps.
 */
export function downloadOptions(kind: PolyHavenAssetKind, tree: PolyHavenFileTree): DownloadOptions {
  const formats: FormatOption[] = []
  const add = (format: string, resolutions: ResolutionOption[]): void => {
    if (resolutions.length > 0) formats.push({ format, resolutions: resolutions.sort((a, b) => byResolution(a.resolution, b.resolution)) })
  }
  const maps = mapsOf(kind, tree)
  const defaultMaps = maps.filter(map => !DIRECTX_NORMAL.test(map))
  if (kind === 'hdri') {
    const panoramas = tree.get(HDRI_GROUP)
    for (const format of HDRI_FORMATS) {
      add(format, [...panoramas?.entries() ?? []].flatMap(([resolution, files]) => {
        const file = files.get(format)
        return file === undefined ? [] : [{ resolution, bytes: bytesOf(file), files: 1 }]
      }))
    }
  }
  if (kind === 'texture') {
    const resolutions = new Set(defaultMaps.flatMap(map => [...tree.get(map)?.keys() ?? []]))
    for (const format of MAP_FORMATS) {
      add(format, [...resolutions].flatMap((resolution) => {
        const files = defaultMaps.flatMap(map => tree.get(map)?.get(resolution)?.get(format) ?? [])
        return files.length === 0 ? [] : [{ resolution, bytes: files.reduce((total, file) => total + file.size, 0), files: files.length }]
      }))
    }
  }
  for (const format of PACKAGE_FORMATS[kind]) {
    add(format, [...tree.get(format)?.entries() ?? []].flatMap(([resolution, files]) => {
      const file = files.get(format)
      return file === undefined ? [] : [{ resolution, bytes: bytesOf(file), files: 1 + Object.keys(file.include).length }]
    }))
  }
  return { formats, maps, defaultMaps }
}

/**
 * Choose the files of one download.
 * @param name - asset name, for errors.
 * @param kind - asset kind.
 * @param tree - the asset's files.
 * @param request - format, resolution, and maps.
 * @returns the plan, the entry file first.
 * @throws Error naming what the asset offers when it lacks the format, the resolution, or a map, or when a path is unsafe.
 */
export function planDownload(
  name: string,
  kind: PolyHavenAssetKind,
  tree: PolyHavenFileTree,
  request: DownloadRequest,
): PolyHavenDownloadPlan {
  const options = downloadOptions(kind, tree)
  const format = request.format ?? DEFAULT_FORMAT[kind]
  const offered = options.formats.find(option => option.format === format)
  if (offered === undefined) {
    const formats = options.formats.map(option => option.format)
    throw new Error(formats.length === 0
      ? `${name} has no files that polyhaven_download can fetch.`
      : `${name} has no ${format} files; it offers ${listing(formats)}.`)
  }
  const isMapFormat = kind === 'texture' && MAP_FORMATS.includes(format)
  if (request.maps !== undefined && !isMapFormat) throw new Error(`maps applies only to the jpg, png, and exr texture maps, not to ${format}.`)
  const available = offered.resolutions.map(option => option.resolution)
  const resolution = request.resolution
    ?? (available.includes(DEFAULT_RESOLUTION) ? DEFAULT_RESOLUTION : available[0] ?? DEFAULT_RESOLUTION)
  if (!available.includes(resolution)) throw new Error(`${name} has no ${format} files at ${resolution}; it offers ${listing(available)}.`)
  if (isMapFormat) return planMaps(name, tree, options, format, resolution, request.maps)
  const group = kind === 'hdri' ? HDRI_GROUP : format
  const entry = tree.get(group)?.get(resolution)?.get(format)
  if (entry === undefined) throw new Error(`${name} has no ${format} files at ${resolution}.`)
  const main = fileNameOf(entry.url)
  const files: PolyHavenPlannedFile[] = [
    { path: main, file: entry },
    ...Object.entries(entry.include).map(([path, file]) => ({ path: safeRelativePath(path), file })),
  ]
  return { format, resolution, entry: main, maps: [], files: unique(files) }
}

function planMaps(
  name: string,
  tree: PolyHavenFileTree,
  options: DownloadOptions,
  format: string,
  resolution: string,
  requested: readonly string[] | undefined,
): PolyHavenDownloadPlan {
  if (requested !== undefined) {
    if (requested.length === 0) throw new Error('maps must name at least one map.')
    const unknown = requested.filter(map => !options.maps.includes(map))
    if (unknown.length > 0) throw new Error(`${name} has no ${listing(unknown)} ${unknown.length === 1 ? 'map' : 'maps'}; its maps are ${listing(options.maps)}.`)
  }
  const maps: string[] = []
  const files: PolyHavenPlannedFile[] = []
  for (const map of requested ?? options.defaultMaps) {
    const file = tree.get(map)?.get(resolution)?.get(format)
    if (file === undefined) {
      if (requested !== undefined) throw new Error(`${name} has no ${format} ${map} map at ${resolution}.`)
      continue
    }
    maps.push(map)
    files.push({ path: fileNameOf(file.url), file })
  }
  if (files.length === 0) throw new Error(`${name} has no ${format} maps at ${resolution}.`)
  return { format, resolution, maps, files: unique(files) }
}

/**
 * Drop repeated files: one path may appear twice, as when two maps share an image.
 * @throws Error when one path names two different files.
 */
function unique(files: readonly PolyHavenPlannedFile[]): PolyHavenPlannedFile[] {
  const seen = new Map<string, PolyHavenPlannedFile>()
  for (const planned of files) {
    const earlier = seen.get(planned.path.toLowerCase())
    if (earlier === undefined) seen.set(planned.path.toLowerCase(), planned)
    else if (earlier.file.md5 !== planned.file.md5) throw new Error(`Poly Haven names two different files ${JSON.stringify(planned.path)} in one download; the download stopped.`)
  }
  return [...seen.values()]
}
