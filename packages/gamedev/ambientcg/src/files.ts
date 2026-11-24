/**
 * What one download of an ambientCG asset takes: the archive of a resolution and picture format, and the map pictures
 * inside it. An archive names each picture `<id>_<archive>_<Map>.<extension>`, such as `Bricks097_1K-JPG_Color.jpg`,
 * and also holds material files for other programs and a preview, which a download leaves out.
 * @module @deepseek-ai/dsh-ambientcg/src/files
 */
import type { AmbientCgArchive, AmbientCgAsset, AmbientCgPicture } from './types.ts'

/** The resolution a download takes when the call names none. */
const DEFAULT_RESOLUTION = '1k'

/** The picture formats of a surface, the one a download takes by default first. */
const SURFACE_FORMATS = ['jpg', 'png'] as const

/**
 * What follows `<id>_` in the name of a picture a download may write: letters, digits, `-`, and `_`, such as the
 * archive's `1K-JPG`, then `_<Map>` and a picture extension.
 */
const PICTURE_NAME = /^(?:[a-z0-9_-]*_)?([a-z0-9]+)\.(?:jpe?g|png|exr|hdr|tiff?)$/iu

/** Other names of a map, as models write them, with the key of the map they mean. */
const MAP_ALIASES: Readonly<Record<string, string>> = {
  normal: 'normalgl',
  albedo: 'color',
  diffuse: 'color',
  basecolor: 'color',
  ao: 'ambientocclusion',
  metal: 'metalness',
  metallic: 'metalness',
  rough: 'roughness',
  height: 'displacement',
  alpha: 'opacity',
  emissive: 'emission',
}

/** The resolutions of one picture format. */
export interface FormatOption {
  /** Picture format: `jpg`, `png`, or `exr`. */
  readonly format: string
  /** Each resolution with the size of its archive in bytes, from the smallest up. */
  readonly resolutions: ReadonlyArray<{ readonly resolution: string; readonly bytes: number }>
}

/**
 * The key that tells maps apart: the name's letters and digits in lowercase, with the other names of a map folded into
 * one. `normal` means the OpenGL normal map, `NormalGL`, which Godot and Blender read.
 * @param name - a map as a call, the API, or a file name writes it.
 * @returns the key.
 */
export function mapKey(name: string): string {
  const plain = name.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
  return MAP_ALIASES[plain] ?? plain
}

/**
 * The picture formats and resolutions an asset offers.
 * @param asset - the asset.
 * @returns the formats, a surface's `jpg` first.
 */
export function formatOptions(asset: AmbientCgAsset): FormatOption[] {
  const formats = [...new Set(asset.archives.map(archive => archive.format))]
  return formats.map(format => ({
    format,
    resolutions: asset.archives.filter(archive => archive.format === format)
      .map(archive => ({ resolution: archive.resolution, bytes: archive.size })),
  }))
}

/**
 * Choose the archive of one download.
 * @param asset - the asset.
 * @param wanted - the picture format and resolution the call names, in lowercase.
 * @returns the archive: without a format a surface's `jpg`, and without a resolution `1k`, or the smallest one when
 * the format has no `1k`.
 * @throws Error naming what the asset offers when it lacks the format or the resolution.
 */
export function chooseArchive(
  asset: AmbientCgAsset, wanted: { readonly format?: string | undefined; readonly resolution?: string | undefined },
): AmbientCgArchive {
  const options = formatOptions(asset)
  const [first] = options
  if (first === undefined) throw new Error(`${asset.title} has no files that ambientcg_download can fetch.`)
  const offered = options.map(option => option.format)
  const format = wanted.format ?? SURFACE_FORMATS.find(candidate => offered.includes(candidate)) ?? first.format
  const inFormat = asset.archives.filter(archive => archive.format === format)
  if (inFormat.length === 0) {
    const why = asset.kind === 'hdri' ? 'an HDRI is an exr panorama; leave format out' : `it offers: ${offered.join(', ')}`
    throw new Error(`${asset.title} has no ${format} files; ${why}.`)
  }
  const archive = wanted.resolution === undefined
    ? inFormat.find(candidate => candidate.resolution === DEFAULT_RESOLUTION) ?? inFormat[0]
    : inFormat.find(candidate => candidate.resolution === wanted.resolution)
  if (archive === undefined) {
    throw new Error(`${asset.title} has no ${String(wanted.resolution)} in ${format}; it offers: ${inFormat.map(candidate => candidate.resolution).join(', ')}.`)
  }
  return archive
}

/**
 * Refuse maps the asset does not have, before its archive is downloaded.
 * @param asset - the asset.
 * @param maps - the maps a call names; undefined for the default.
 * @throws Error naming the asset's maps when the call names another.
 */
export function checkMaps(asset: AmbientCgAsset, maps: readonly string[] | undefined): void {
  if (maps === undefined) return
  if (maps.length === 0) throw new Error('maps names no map; leave it out for every map.')
  const offered = asset.kind === 'hdri' ? ['HDR', 'TONEMAPPED'] : asset.maps
  // An asset whose list names no map tells its maps only in its archive.
  if (offered.length === 0) return
  const keys = new Set(offered.map(mapKey))
  // Every asset with a normal map has it in both conventions.
  if (keys.has('normalgl')) keys.add('normaldx')
  const missing = maps.find(name => !keys.has(mapKey(name)))
  if (missing !== undefined) throw new Error(`${asset.title} has no ${JSON.stringify(missing)} map; its maps are: ${offered.join(', ')}.`)
}

/**
 * The map pictures among the files of an asset's archive: the files at the archive's root whose names start with the
 * asset's id and end in `_<Map>` and a picture extension, with only letters, digits, `-`, and `_` between. The preview
 * `<id>.png` and the material files are not maps.
 * @param asset - the asset.
 * @param files - every file of the archive with its size and CRC-32.
 * @returns the pictures, in the archive's order.
 */
export function archivePictures(
  asset: AmbientCgAsset, files: ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly crc32: number }>,
): AmbientCgPicture[] {
  const prefix = `${asset.id.toLowerCase()}_`
  return files.flatMap((file): AmbientCgPicture[] => {
    if (file.name.includes('/') || file.name.includes('\\') || !file.name.toLowerCase().startsWith(prefix)) return []
    const named = PICTURE_NAME.exec(file.name.slice(prefix.length))
    return named === null ? [] : [{ name: file.name, map: named[1] as string, bytes: file.bytes, crc32: file.crc32 }]
  })
}

/**
 * The pictures one download writes.
 * @param asset - the asset.
 * @param pictures - the map pictures of its archive.
 * @param maps - the maps a call names; undefined for the default: an HDRI's `HDR` panorama, and every map of a surface
 * but the DirectX normal map `NormalDX`.
 * @returns the pictures to write, in the archive's order.
 * @throws Error naming the archive's maps when it lacks one the call names, or holds no map at all.
 */
export function selectPictures(
  asset: AmbientCgAsset, pictures: readonly AmbientCgPicture[], maps: readonly string[] | undefined,
): AmbientCgPicture[] {
  const held = [...new Set(pictures.map(picture => picture.map))].join(', ')
  if (pictures.length === 0) throw new Error(`The archive of ${asset.title} holds no map pictures; nothing was saved.`)
  if (maps === undefined) {
    const left = asset.kind === 'hdri' ? pictures.filter(picture => mapKey(picture.map) === 'hdr') : pictures.filter(picture => mapKey(picture.map) !== 'normaldx')
    return left.length === 0 ? [...pictures] : left
  }
  const wanted = new Set(maps.map(mapKey))
  const missing = maps.find(name => !pictures.some(picture => mapKey(picture.map) === mapKey(name)))
  if (missing !== undefined) throw new Error(`The archive of ${asset.title} has no ${JSON.stringify(missing)} map; it holds: ${held}.`)
  return pictures.filter(picture => wanted.has(mapKey(picture.map)))
}
