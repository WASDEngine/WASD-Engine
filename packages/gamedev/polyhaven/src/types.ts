/**
 * Types of the Poly Haven plugin: the assets of Poly Haven's library as the plugin reads them from the Poly Haven API,
 * their files, and the files of one download.
 * @module @deepseek-ai/dsh-polyhaven/types
 */

/** Kind of a Poly Haven asset: an HDRI sky, a tileable PBR texture, or a 3D model. */
export type PolyHavenAssetKind = 'hdri' | 'texture' | 'model'

/** One asset of Poly Haven's library, from the API's asset list. */
export interface PolyHavenAsset {
  /** Unique id, also the slug of the asset's page on polyhaven.com: letters, digits, `_`, and `-`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Asset kind. */
  readonly kind: PolyHavenAssetKind
  /** Short summary that Poly Haven wrote; empty when the asset has none. */
  readonly description: string
  /** Path in Poly Haven's category taxonomy, such as `Furniture/Seating/Chairs`; empty when the asset has none. */
  readonly category: string
  /** Search tags. */
  readonly tags: readonly string[]
  /** Author names, each with what the author did, such as `All` or `Photography`. */
  readonly authors: Readonly<Record<string, string>>
  /** How many times the asset was downloaded. */
  readonly downloads: number
  /** Publication time in seconds since the epoch; 0 when the list omits it. */
  readonly published: number
  /** Width in pixels of the asset's largest texture or panorama. */
  readonly maxWidth?: number
  /** Real-world size in millimeters on each axis, for textures and models. */
  readonly dimensionsMm?: readonly number[]
  /** Polygon count of a model. */
  readonly polycount?: number
  /** URL of the asset's preview image. */
  readonly thumbnailUrl?: string
}

/** One downloadable file of an asset. */
export interface PolyHavenFile {
  /** Download URL. */
  readonly url: string
  /** Size in bytes. */
  readonly size: number
  /** Lowercase hexadecimal MD5 digest of the file's bytes. */
  readonly md5: string
}

/** A file with the files it references, such as a glTF model with its buffer and textures. */
export interface PolyHavenFileEntry extends PolyHavenFile {
  /** Referenced files by their path relative to the file's folder; empty for a single image. */
  readonly include: Readonly<Record<string, PolyHavenFile>>
}

/**
 * An asset's files, by group, resolution, and format. A group is a texture map such as `Diffuse`, a ready-made file
 * format such as `gltf` or `blend`, or `hdri` for the panoramas of an HDRI; a resolution is a size such as `1k` or
 * `4k`; and a format is a file format such as `jpg`, `exr`, `hdr`, or the group's own format.
 */
export type PolyHavenFileTree = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, PolyHavenFileEntry>>>

/** One file that a download writes. */
export interface PolyHavenPlannedFile {
  /** Path relative to the download folder, with `/` separators. */
  readonly path: string
  /** The remote file. */
  readonly file: PolyHavenFile
}

/** The files that one download of an asset writes. */
export interface PolyHavenDownloadPlan {
  /** File format, such as `gltf` or `jpg`. */
  readonly format: string
  /** Resolution, such as `1k`. */
  readonly resolution: string
  /** Path of the file that opens the asset, such as the `.gltf` of a model or the `.hdr` of an HDRI; absent for texture maps. */
  readonly entry?: string
  /** Texture maps the download holds, for map formats. */
  readonly maps: readonly string[]
  /** Every file, the entry file first. */
  readonly files: readonly PolyHavenPlannedFile[]
}

/** What a download did with one file. */
export type PolyHavenFileStatus = 'downloaded' | 'replaced' | 'unchanged'

/** One file that a download wrote or found in place. */
export interface PolyHavenWrittenFile {
  /** Path relative to the download folder, with `/` separators. */
  readonly path: string
  /** Size in bytes. */
  readonly bytes: number
  /** `downloaded` for a new file, `replaced` for a file whose earlier contents differed, `unchanged` for a file already in place. */
  readonly status: PolyHavenFileStatus
}
