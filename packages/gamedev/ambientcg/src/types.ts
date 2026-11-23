/**
 * Types of the ambientCG plugin: the assets of ambientCG's library as the plugin reads them from the ambientCG API,
 * their archives, and the pictures inside an archive.
 * @module @deepseek-ai/dsh-ambientcg/types
 */

/** Kind of an ambientCG asset the tools offer: a tileable PBR material, a decal, an atlas of cut-out pieces, or an HDRI sky. */
export type AmbientCgAssetKind = 'material' | 'decal' | 'atlas' | 'hdri'

/** One archive of an asset: a ZIP file with every map in one resolution and picture format. */
export interface AmbientCgArchive {
  /** Resolution, such as `1k`. */
  readonly resolution: string
  /** Picture format of the maps: `jpg` or `png`, and `exr` for an HDRI. */
  readonly format: string
  /** The API's name of the archive, such as `1K-JPG`, which the names of its files carry. */
  readonly attributes: string
  /** Download URL. */
  readonly url: string
  /** Size in bytes. */
  readonly size: number
}

/** One asset of ambientCG's library, from the API's asset list. */
export interface AmbientCgAsset {
  /** Unique id, also the last part of the asset's page on ambientcg.com: letters and digits, such as `Bricks097`. */
  readonly id: string
  /** Display name, such as `Bricks 097`. */
  readonly title: string
  /** Asset kind. */
  readonly kind: AmbientCgAssetKind
  /** Search tags. */
  readonly tags: readonly string[]
  /** The maps the asset has, as the API names them, such as `color`, `normal`, and `roughness`; empty for an HDRI. */
  readonly maps: readonly string[]
  /** How the asset was made, as the API names it, such as `surface-photogrammetry`; empty when the list omits it. */
  readonly technique: string
  /** How many times the asset was downloaded. */
  readonly downloads: number
  /** Release date as `YYYY-MM-DD`; empty when the list omits it. */
  readonly released: string
  /** Real-world width and height of one repeat in centimeters; absent when ambientCG does not give them. */
  readonly sizeCm?: readonly [number, number]
  /** The archives the tools download, by picture format and then from the smallest resolution up. */
  readonly archives: readonly AmbientCgArchive[]
  /** URL of the asset's preview image. */
  readonly thumbnailUrl?: string
}

/** One page of a search. */
export interface AmbientCgPage {
  /** How many assets match in all. */
  readonly total: number
  /** The assets of this page, most popular first. */
  readonly assets: readonly AmbientCgAsset[]
}

/** One group that ambientCG sorts assets into, such as `Paving Stones` or `Day Sky HDRI`. */
export interface AmbientCgCategory {
  /** Display name. */
  readonly title: string
  /** The kind of its assets. */
  readonly kind: AmbientCgAssetKind
  /** How many assets it holds. */
  readonly count: number
}

/** One picture inside an archive. */
export interface AmbientCgPicture {
  /** The picture's file name in the archive, such as `Bricks097_1K-JPG_Color.jpg`. */
  readonly name: string
  /** What the picture holds, as the end of its name says: `Color`, `NormalGL`, `Roughness`, or `HDR`, among others. */
  readonly map: string
  /** Size in bytes. */
  readonly bytes: number
  /** CRC-32 of its contents, from the archive's directory. */
  readonly crc32: number
}

/** The pictures of one archive, as the plugin read them from the archive's directory. */
export interface AmbientCgArchiveListing {
  /** Size in bytes of the archive the listing came from. */
  readonly size: number
  /** Every map picture of the archive, in the archive's order. */
  readonly pictures: readonly AmbientCgPicture[]
}
