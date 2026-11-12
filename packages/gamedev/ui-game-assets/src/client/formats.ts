/**
 * The art formats the Assets tab lists, by lowercase file extension, and how the viewer decodes each one. Images the
 * browser decodes show as they are; TGA, Radiance HDR, and OpenEXR images and every model are decoded by three.js in
 * the viewer's lazily loaded chunk. A Blender file is listed but has no decoder: the viewer shows a model exported
 * from it instead. The agent's asset tools read the same table from `@deepseek-ai/dsh-game-assets/formats`; the
 * browser half keeps this copy because a plugin's browser bundle imports no other plugin's values, and a spec keeps
 * the two equal.
 */
import type { AssetFormat } from '@deepseek-ai/dsh-game-assets/formats'

export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from '@deepseek-ai/dsh-game-assets/formats'

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
