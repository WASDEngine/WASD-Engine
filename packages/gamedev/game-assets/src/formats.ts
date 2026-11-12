/**
 * The art formats that the Assets tab lists and that `asset_search` and `asset_view` accept, by lowercase file
 * extension, and how the viewer decodes each one. Images the browser decodes show as they are; TGA, Radiance HDR,
 * and OpenEXR images and every model are decoded by three.js. A Blender file is listed but has no decoder: the viewer
 * shows a model exported from it instead. This module has no Host dependencies, so the browser half imports it too.
 * @module @deepseek-ai/dsh-game-assets/formats
 */

/** Whether an asset is a picture or a model. */
export type AssetKind = 'image' | 'model'

/** How an image is decoded: by the browser from its media type, or by a three.js loader. */
export type ImageDecoder = 'browser' | 'tga' | 'hdr' | 'exr'

/** The three.js loader that reads a model. */
export type ModelDecoder = 'gltf' | 'obj' | 'fbx' | 'dae' | 'stl' | 'ply' | 'vox'

/** One listed format. */
export type AssetFormat =
  | {
    readonly kind: 'image'
    /** Format name shown beside the asset, the same in every language. */
    readonly label: string
    readonly decoder: ImageDecoder
    /** Media type of the Blob the browser decodes; present for `browser` images. */
    readonly mediaType?: string
  }
  | {
    readonly kind: 'model'
    readonly label: string
    /** The loader, or `blend` for a Blender file, which the viewer shows through a model exported from it. */
    readonly decoder: ModelDecoder | 'blend'
  }

/** Every listed format by lowercase extension, images first, in the order the tools name them. */
export const ASSET_FORMATS: Readonly<Record<string, AssetFormat>> = {
  png: { kind: 'image', label: 'PNG', decoder: 'browser', mediaType: 'image/png' },
  jpg: { kind: 'image', label: 'JPEG', decoder: 'browser', mediaType: 'image/jpeg' },
  jpeg: { kind: 'image', label: 'JPEG', decoder: 'browser', mediaType: 'image/jpeg' },
  webp: { kind: 'image', label: 'WebP', decoder: 'browser', mediaType: 'image/webp' },
  gif: { kind: 'image', label: 'GIF', decoder: 'browser', mediaType: 'image/gif' },
  bmp: { kind: 'image', label: 'BMP', decoder: 'browser', mediaType: 'image/bmp' },
  svg: { kind: 'image', label: 'SVG', decoder: 'browser', mediaType: 'image/svg+xml' },
  avif: { kind: 'image', label: 'AVIF', decoder: 'browser', mediaType: 'image/avif' },
  ico: { kind: 'image', label: 'ICO', decoder: 'browser', mediaType: 'image/x-icon' },
  tga: { kind: 'image', label: 'TGA', decoder: 'tga' },
  hdr: { kind: 'image', label: 'HDR', decoder: 'hdr' },
  exr: { kind: 'image', label: 'EXR', decoder: 'exr' },
  glb: { kind: 'model', label: 'GLB', decoder: 'gltf' },
  gltf: { kind: 'model', label: 'glTF', decoder: 'gltf' },
  obj: { kind: 'model', label: 'OBJ', decoder: 'obj' },
  fbx: { kind: 'model', label: 'FBX', decoder: 'fbx' },
  dae: { kind: 'model', label: 'DAE', decoder: 'dae' },
  stl: { kind: 'model', label: 'STL', decoder: 'stl' },
  ply: { kind: 'model', label: 'PLY', decoder: 'ply' },
  vox: { kind: 'model', label: 'VOX', decoder: 'vox' },
  blend: { kind: 'model', label: 'Blender', decoder: 'blend' },
}

/**
 * The lowercase extension of a file name, without its dot.
 * @param name - a file name or `/`-separated path.
 * @returns the extension, or an empty string for a name without one or a dotfile.
 */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * The format of a file, judged by its extension.
 * @param name - a file name or `/`-separated path.
 * @returns the format, or undefined for a file the tab does not list.
 */
export function formatOf(name: string): AssetFormat | undefined {
  const extension = extensionOf(name)
  return Object.hasOwn(ASSET_FORMATS, extension) ? ASSET_FORMATS[extension] : undefined
}

/**
 * Whether a format is a Blender file, which the viewer shows through a model exported from it.
 * @param format - a listed format.
 * @returns true for `.blend`.
 */
export function isBlendFormat(format: AssetFormat): boolean {
  return format.kind === 'model' && format.decoder === 'blend'
}

/** Orders folder paths and file names the way people read them: case-insensitively, with numbers by value. */
export const NAME_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** An asset path with the name and folder that pick a Blender file's export. */
export interface ExportCandidate {
  /** Workspace path: relative to the project folder and `/`-separated. */
  readonly path: string
  /** File name. */
  readonly name: string
  /** Workspace path of the folder holding the file; empty for the project folder itself. */
  readonly folder: string
  /** The file's format. */
  readonly format: AssetFormat
}

/**
 * The model exported from a Blender file: a listed model of the same name, nearest first, in the Blender file's folder,
 * then in a folder above it, then in a folder below it, then anywhere; GLB before glTF before other formats.
 * @param blend - the Blender file.
 * @param assets - the project's assets.
 * @returns the export, or undefined when the project has none.
 */
export function exportOf<T extends ExportCandidate>(blend: ExportCandidate, assets: readonly T[]): T | undefined {
  const stem = (name: string): string => name.slice(0, name.lastIndexOf('.')).toLowerCase()
  const wanted = stem(blend.name)
  const distance = (folder: string): number => {
    if (folder === blend.folder) return 0
    const above = blend.folder === '' ? undefined : blend.folder.split('/')
    const below = folder === '' ? [] : folder.split('/')
    if (above !== undefined && (folder === '' || blend.folder.startsWith(`${folder}/`))) return above.length - below.length
    if (blend.folder === '' || folder.startsWith(`${blend.folder}/`)) return 100 + below.length - (above?.length ?? 0)
    return 1000
  }
  const preference = (asset: T): number => asset.format.label === 'GLB' ? 0 : asset.format.label === 'glTF' ? 1 : 2
  return assets
    .filter(asset => asset.format.kind === 'model' && !isBlendFormat(asset.format) && stem(asset.name) === wanted)
    .sort((left, right) => distance(left.folder) - distance(right.folder)
      || preference(left) - preference(right)
      || NAME_ORDER.compare(left.path, right.path))[0]
}
