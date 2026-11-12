/**
 * The model-facing text of the asset tools: the project's art as `asset_search` lists it, and one asset's details as
 * `asset_view` reports them, from the details a window measured.
 * @module @deepseek-ai/dsh-game-assets/src/describe
 */
import type {
  AssetDetails, ImageAssetDetails, ModelAssetDetails, ModelBoneDetails, ModelMaterialDetails, SpriteAnimationDetails,
} from './types.ts'

/** Bone names `asset_view` lists before it summarizes the rest. */
export const LISTED_BONES = 160

/** Kinds as the tools name them. */
const KIND_NAME = { image: '2D', model: '3D' } as const

const INTEGER = new Intl.NumberFormat('en-US')

/**
 * A byte count for people.
 * @param bytes - size in bytes.
 * @returns the size, such as `34 KB` or `2.4 MB`.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`
  const megabytes = kilobytes / 1024
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}

/**
 * A length or coordinate with at most four significant decimals.
 * @param value - the number.
 * @returns its text, without a trailing zero or a negative zero.
 */
export function numberText(value: number): string {
  const rounded = Number(value.toPrecision(4))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/**
 * Seconds for people.
 * @param seconds - a duration.
 * @returns the duration with two decimals, such as `1.07 s`.
 */
export function secondsText(seconds: number): string {
  return `${seconds.toFixed(2)} s`
}

function plural(count: number, one: string, other: string): string {
  return `${INTEGER.format(count)} ${count === 1 ? one : other}`
}

/** One asset as `asset_search` lists it. */
export interface ListedAsset {
  readonly path: string
  readonly kind: 'image' | 'model'
  readonly format: string
  readonly bytes: number
}

/** One folder's asset counts. */
export interface ListedFolder {
  /** Workspace path; empty for the project folder. */
  readonly path: string
  readonly images: number
  readonly models: number
}

/** What `asset_search` found. */
export interface SearchValue {
  readonly project: string
  readonly query: string
  readonly kind?: '2d' | '3d'
  readonly folder?: string
  readonly total: number
  readonly offset: number
  readonly assets: readonly ListedAsset[]
  readonly folders: readonly ListedFolder[]
  readonly truncated: boolean
  readonly unreadable: number
}

/**
 * The text of an `asset_search` result.
 * @param value - the result.
 * @returns the listing.
 */
export function describeSearch(value: SearchValue): string {
  const kind = value.kind === undefined ? '' : `${value.kind.toUpperCase()} `
  const filters = [
    value.query === '' ? undefined : ` matching "${value.query}"`,
    value.folder === undefined ? undefined : ` under ${value.folder === '' ? 'the project folder' : `${value.folder}/`}`,
  ].filter(part => part !== undefined).join('')
  const lines: string[] = [value.total === 0
    ? `No ${kind}assets${filters} in ${value.project}.`
    : `${plural(value.total, `${kind}asset`, `${kind}assets`)}${filters} in ${value.project}.`]
  if (value.folders.length > 0) {
    const folders = value.folders.map((folder) => {
      const counts = [
        folder.images > 0 ? `${INTEGER.format(folder.images)} ${KIND_NAME.image}` : undefined,
        folder.models > 0 ? `${INTEGER.format(folder.models)} ${KIND_NAME.model}` : undefined,
      ].filter(count => count !== undefined).join(', ')
      return `${folder.path === '' ? '(project folder)' : `${folder.path}/`} ${counts}`
    })
    lines.push(`Folders: ${folders.join('; ')}.`)
  }
  for (const asset of value.assets) lines.push(`- ${asset.path} (${KIND_NAME[asset.kind]} ${asset.format}, ${sizeText(asset.bytes)})`)
  if (value.assets.length > 0 && value.assets.length < value.total) {
    const first = value.offset + 1
    lines.push(`Showing ${INTEGER.format(first)}–${INTEGER.format(value.offset + value.assets.length)} of ${INTEGER.format(value.total)}; pass offset to list more.`)
  }
  if (value.truncated) lines.push('The project has more files than one search reads, so some assets are missing; narrow it with folder.')
  if (value.unreadable > 0) lines.push(`${plural(value.unreadable, 'folder', 'folders')} could not be read, so their assets are missing.`)
  if (value.total > 0) lines.push('Pass a path to asset_view to look at an asset.')
  return lines.join('\n')
}

function animationLine(animation: SpriteAnimationDetails): string {
  const source = {
    frames: 'the image\'s own frames',
    sequence: `numbered images${animation.definedIn === undefined ? '' : ` from ${animation.definedIn}`}`,
    godot: `Godot animation in ${animation.definedIn ?? 'the project'}`,
    sheet: `sprite sheet data in ${animation.definedIn ?? 'a JSON file'}`,
    grid: 'the given grid',
  }[animation.source]
  const size = animation.frameWidth === undefined || animation.frameHeight === undefined ? '' : ` of ${animation.frameWidth} × ${animation.frameHeight}`
  return `- ${animation.name}: ${source}, ${plural(animation.frames, 'frame', 'frames')}${size} at ${numberText(animation.fps)} fps (${secondsText(animation.seconds)})${animation.loop ? ', loops' : ''}`
}

function describeImage(path: string, details: ImageAssetDetails): string[] {
  const transparency = {
    opaque: 'no transparency',
    cutout: 'cutout transparency (every pixel fully transparent or opaque)',
    translucent: 'translucent pixels',
  }[details.transparency]
  const colors = details.colors > 256 ? 'more than 256 colors' : plural(details.colors, 'color', 'colors')
  const lines = [`Image ${path} (${details.format}, ${sizeText(details.bytes)}): ${details.width} × ${details.height} pixels, ${transparency}, ${colors}.`]
  const animations = details.animationCount ?? details.animations.length
  if (animations === 0) {
    lines.push('No animations use it. Pass grid to read it as a sprite sheet.')
  } else {
    lines.push(`Animations (${animations}); pass one's name as animation to see its frames:`)
    for (const animation of details.animations) lines.push(animationLine(animation))
    if (details.animations.length < animations) lines.push(`- and ${plural(animations - details.animations.length, 'more animation', 'more animations')}`)
  }
  return lines
}

function materialLine(material: ModelMaterialDetails): string {
  const facts = [
    material.type,
    material.color === undefined ? undefined : `color ${material.color}`,
    material.metalness === undefined ? undefined : `metalness ${numberText(material.metalness)}`,
    material.roughness === undefined ? undefined : `roughness ${numberText(material.roughness)}`,
    material.vertexColors ? 'vertex colors' : undefined,
    material.transparent ? 'transparent' : undefined,
    material.doubleSided ? 'double-sided' : undefined,
  ].filter(fact => fact !== undefined)
  const maps = material.maps.map(map => `${map.slot} ${map.texture}`)
  return `- ${material.name === '' ? '(unnamed)' : material.name}: ${facts.join(', ')}${maps.length === 0 ? '' : `; ${maps.join(', ')}`}`
}

/**
 * The bones as an indented tree, children under their parent.
 * @param bones - bones in depth-first order with parent indices.
 * @param limit - names listed before the rest are counted.
 * @returns one line per bone, then a line counting the bones not listed.
 */
export function boneLines(bones: readonly ModelBoneDetails[], limit = LISTED_BONES): string[] {
  const depths: number[] = []
  const lines: string[] = []
  for (const [index, bone] of bones.entries()) {
    const depth = bone.parent === undefined ? 0 : (depths[bone.parent] ?? 0) + 1
    depths[index] = depth
    if (index < limit) lines.push(`${'  '.repeat(Math.min(depth, 24))}${bone.name === '' ? '(unnamed)' : bone.name}`)
  }
  return lines
}

function describeModel(path: string, details: ModelAssetDetails): string[] {
  const size = details.max.map((value, axis) => numberText(value - (details.min[axis] ?? 0)))
  const lines = [
    `Model ${path} (${details.format}, ${sizeText(details.bytes)}).`,
    `Size ${size.join(' × ')} (x × y × z, y up), from (${details.min.map(numberText).join(', ')}) to (${details.max.map(numberText).join(', ')}).`,
    `Geometry: ${plural(details.triangles, 'triangle', 'triangles')} and ${plural(details.vertices, 'vertex', 'vertices')} in ${plural(details.meshes, 'mesh', 'meshes')}; ${plural(details.nodes, 'node', 'nodes')}.`,
  ]
  if (details.materialCount > 0) {
    lines.push(`Materials (${details.materialCount}):`, ...details.materials.map(materialLine))
    if (details.materials.length < details.materialCount) lines.push(`- and ${plural(details.materialCount - details.materials.length, 'more material', 'more materials')}`)
  }
  if (details.textureCount > 0) {
    const textures = details.textures.map(texture => `${texture.name === '' ? '(unnamed)' : texture.name} ${texture.width} × ${texture.height}`)
    const more = details.textures.length < details.textureCount ? `, and ${details.textureCount - details.textures.length} more` : ''
    lines.push(`Textures (${details.textureCount}): ${textures.join(', ')}${more}.`)
  }
  if (details.boneCount > 0) {
    lines.push(`Skeleton: ${plural(details.boneCount, 'bone', 'bones')}, each under its parent:`, ...boneLines(details.bones))
    const listed = Math.min(details.bones.length, LISTED_BONES)
    if (listed < details.boneCount) lines.push(`(and ${plural(details.boneCount - listed, 'more bone', 'more bones')})`)
  } else {
    lines.push('No skeleton.')
  }
  const clips = details.animationCount ?? details.animations.length
  if (clips === 0) {
    lines.push('No animation clips.')
  } else {
    lines.push(`Animation clips (${clips}); pass one's name as animation to see frames across it:`)
    for (const clip of details.animations) {
      const targets = clip.targets.length === 0 ? '' : `: ${clip.targets.join(', ')}${clip.targets.length < clip.targetCount ? ', …' : ''}`
      lines.push(`- ${clip.name === '' ? '(unnamed)' : clip.name}: ${secondsText(clip.seconds)}, ${plural(clip.tracks, 'track', 'tracks')} on ${plural(clip.targetCount, 'bone or node', 'bones or nodes')}${targets}`)
    }
    if (details.animations.length < clips) lines.push(`- and ${plural(clips - details.animations.length, 'more clip', 'more clips')}`)
  }
  if (details.morphTargets.length > 0) {
    const meshes = details.morphMeshCount ?? details.morphTargets.length
    const morphs = details.morphTargets.map((morph) => {
      const more = (morph.targetCount ?? morph.targets.length) - morph.targets.length
      return `${morph.mesh === '' ? '(unnamed mesh)' : morph.mesh}: ${morph.targets.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`
    })
    const moreMeshes = meshes - details.morphTargets.length
    lines.push(`Morph targets: ${morphs.join('; ')}${moreMeshes > 0 ? `; and ${plural(moreMeshes, 'more mesh', 'more meshes')} with morph targets` : ''}.`)
  }
  if (details.missing.length > 0) lines.push(`Files the model names that are missing or unreadable: ${details.missing.join(', ')}.`)
  return lines
}

/**
 * The details of one drawn asset.
 * @param path - workspace path of the drawn asset.
 * @param details - what the window measured.
 * @returns the lines.
 */
export function describeDetails(path: string, details: AssetDetails): string[] {
  return details.kind === 'image' ? describeImage(path, details) : describeModel(path, details)
}
