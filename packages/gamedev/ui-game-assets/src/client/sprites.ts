/**
 * 2D animations as the Assets tab plays them and the agent sees them: a list of frames, each a workspace image or a
 * region of one, shown for its duration. They come from an image's own frames (animated GIF, WebP, or PNG), numbered
 * images beside it, a sprite sheet JSON file beside it (Aseprite or TexturePacker), the Godot scenes and resources
 * that use it, or a grid the reader or the agent gives.
 */
import type { AssetGrid, SpriteAnimationDetails, SpriteAnimationSource } from '@deepseek-ai/dsh-game-assets/types'
import { formatOf } from './formats.ts'
import { godotAnimations, workspacePathOf, type PixelRect } from './godot.ts'

/** Frames per second of an animation without its own timing. */
export const DEFAULT_FPS = 12

/** Most frames one animation keeps. */
export const MAX_ANIMATION_FRAMES = 1024

/** One frame of a 2D animation. */
export interface SpriteFrame {
  /** Workspace path of the image the frame shows. */
  readonly path: string
  /** The part of the image, or undefined for all of it. */
  readonly region?: PixelRect
  /** For an animated image: which of its own frames. */
  readonly index?: number
  readonly durationMs: number
}

/** A playable 2D animation. */
export interface SpriteAnimation {
  /** Name, unique among one image's animations. */
  readonly name: string
  readonly source: SpriteAnimationSource
  /** Workspace path of the file that defines it. */
  readonly definedIn?: string
  readonly frames: readonly SpriteFrame[]
  readonly loop: boolean
}

/**
 * The cells of a grid over an image, left to right, then top to bottom.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param grid - columns, rows, and the number of frames.
 * @returns one region per frame.
 */
export function gridRegions(width: number, height: number, grid: AssetGrid): PixelRect[] {
  const cellWidth = Math.floor(width / grid.columns)
  const cellHeight = Math.floor(height / grid.rows)
  if (cellWidth < 1 || cellHeight < 1) return []
  const count = Math.min(grid.count ?? grid.columns * grid.rows, grid.columns * grid.rows)
  return Array.from({ length: count }, (_, index) => ({
    x: (index % grid.columns) * cellWidth,
    y: Math.floor(index / grid.columns) * cellHeight,
    width: cellWidth,
    height: cellHeight,
  }))
}

/**
 * Read an image as a sprite sheet of a grid.
 * @param path - workspace path of the image.
 * @param width - image width.
 * @param height - image height.
 * @param grid - the grid.
 * @param fps - frames per second.
 * @returns the animation, named `grid`.
 */
export function gridAnimation(path: string, width: number, height: number, grid: AssetGrid, fps = DEFAULT_FPS): SpriteAnimation {
  return {
    name: 'grid',
    source: 'grid',
    frames: gridRegions(width, height, grid).map(region => ({ path, region, durationMs: 1000 / fps })),
    loop: true,
  }
}

/**
 * A grid that a strip's shape suggests: square frames side by side or stacked.
 * @param width - image width.
 * @param height - image height.
 * @returns the grid, or undefined when the image is not a strip of square frames.
 */
export function stripGuess(width: number, height: number): AssetGrid | undefined {
  if (width > height && height > 0 && width % height === 0) return { columns: width / height, rows: 1 }
  if (height > width && width > 0 && height % width === 0) return { columns: 1, rows: height / width }
  return undefined
}

/** A numbered image's name split around its last run of digits. */
interface NumberedName {
  readonly folder: string
  readonly prefix: string
  readonly digits: string
  readonly suffix: string
}

/** The name of a numbered image split around its last run of digits. */
function numbered(path: string): NumberedName | undefined {
  const slash = path.lastIndexOf('/')
  const folder = slash < 0 ? '' : path.slice(0, slash)
  const name = path.slice(slash + 1)
  const match = /^(.*?)(\d+)(\D*)$/u.exec(name)
  if (match === null) return undefined
  return { folder, prefix: match[1] ?? '', digits: match[2] ?? '', suffix: match[3] ?? '' }
}

/**
 * The numbered images an image belongs to, such as `walk_01.png` … `walk_12.png`.
 * @param path - workspace path of one numbered image.
 * @param siblings - workspace paths of the files in its folder.
 * @param fps - frames per second.
 * @returns the animation of at least two images in number order, or undefined when the image is not one of them.
 */
export function sequenceAnimation(path: string, siblings: readonly string[], fps = DEFAULT_FPS): SpriteAnimation | undefined {
  const own = numbered(path)
  if (own === undefined) return undefined
  const frames = siblings
    .map(sibling => ({ sibling, parts: numbered(sibling) }))
    .filter(({ sibling, parts }) => parts !== undefined && parts.folder === own.folder && parts.prefix === own.prefix
      && parts.suffix.toLowerCase() === own.suffix.toLowerCase() && formatOf(sibling)?.kind === 'image')
    .map(({ sibling, parts }) => ({ sibling, number: Number(parts?.digits ?? 0) }))
    .sort((left, right) => left.number - right.number)
    .slice(0, MAX_ANIMATION_FRAMES)
  if (frames.length < 2) return undefined
  const label = own.prefix.replace(/[\s._-]+$/u, '')
  return {
    name: label === '' ? 'sequence' : label,
    source: 'sequence',
    ...own.folder === '' ? {} : { definedIn: `${own.folder}/` },
    frames: frames.map(({ sibling }) => ({ path: sibling, durationMs: 1000 / fps })),
    loop: true,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function rect(value: unknown): PixelRect | undefined {
  const fields = record(value)
  if (fields === undefined) return undefined
  const [x, y, width, height] = [fields.x, fields.y, fields.w, fields.h]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

/**
 * The animations of a sprite sheet JSON file, as Aseprite and TexturePacker write them: frames as a list or keyed by
 * name, each with its rectangle and duration, and Aseprite's frame tags as named animations.
 * @param json - the parsed file.
 * @param path - workspace path of the image the sheet describes.
 * @param sheetPath - workspace path of the JSON file.
 * @returns the tags' animations, or one animation of every frame named after the image, or none when the file
 * describes another image or holds no frames.
 */
export function sheetAnimations(json: unknown, path: string, sheetPath: string): SpriteAnimation[] {
  const root = record(json)
  if (root === undefined) return []
  const imageName = path.slice(path.lastIndexOf('/') + 1)
  const meta = record(root.meta)
  const named = meta?.image
  if (typeof named === 'string' && named.replaceAll('\\', '/').split('/').at(-1) !== imageName) return []
  const listed: unknown[] = Array.isArray(root.frames) ? root.frames : Object.values(record(root.frames) ?? {})
  const frames: SpriteFrame[] = []
  for (const entry of listed.slice(0, MAX_ANIMATION_FRAMES)) {
    const fields = record(entry)
    const region = rect(fields?.frame)
    if (region === undefined) continue
    const duration = typeof fields?.duration === 'number' && fields.duration > 0 ? fields.duration : 1000 / DEFAULT_FPS
    frames.push({ path, region, durationMs: duration })
  }
  if (frames.length === 0) return []
  const tags = Array.isArray(meta?.frameTags) ? meta.frameTags : []
  const animations: SpriteAnimation[] = []
  for (const tag of tags) {
    const fields = record(tag)
    const from = fields?.from
    const to = fields?.to
    if (typeof fields?.name !== 'string' || typeof from !== 'number' || typeof to !== 'number' || from < 0 || to < from) continue
    let span = frames.slice(from, to + 1)
    if (fields.direction === 'reverse') span = [...span].reverse()
    else if (fields.direction === 'pingpong') span = [...span, ...span.slice(1, -1).reverse()]
    if (span.length > 0) animations.push({ name: fields.name, source: 'sheet', definedIn: sheetPath, frames: span, loop: true })
  }
  if (animations.length > 0) return animations
  const stem = imageName.slice(0, imageName.lastIndexOf('.') > 0 ? imageName.lastIndexOf('.') : imageName.length)
  return [{ name: stem, source: 'sheet', definedIn: sheetPath, frames, loop: true }]
}

/**
 * The project folder of a Godot file: the deepest folder holding `project.godot` that contains it.
 * @param path - workspace path of the file.
 * @param projectFolders - workspace paths of the folders holding `project.godot`; empty for the workspace folder.
 * @returns the folder's workspace path; empty when none contains the file.
 */
export function godotProjectOf(path: string, projectFolders: readonly string[]): string {
  let best = ''
  for (const folder of projectFolders) {
    if ((folder === '' || path.startsWith(`${folder}/`)) && folder.length >= best.length) best = folder
  }
  return best
}

/** One Godot scene or resource and its text. */
export interface GodotFile {
  /** Workspace path. */
  readonly path: string
  readonly text: string
}

/**
 * The Godot animations whose frames show an image.
 * @param files - Godot scenes and resources to read.
 * @param path - workspace path of the image.
 * @param projectFolders - workspace paths of the folders holding `project.godot`.
 * @param size - the image's size, which turns Sprite2D grid cells into regions.
 * @returns the animations, each with the file that defines it; files that do not parse are skipped.
 */
export function godotSpriteAnimations(
  files: readonly GodotFile[],
  path: string,
  projectFolders: readonly string[],
  size: { readonly width: number; readonly height: number },
): SpriteAnimation[] {
  const animations: SpriteAnimation[] = []
  for (const file of files) {
    let parsed
    try {
      parsed = godotAnimations(file.text)
    } catch {
      // GodotParseError: a file in a format this reader does not know shows no animations.
      continue
    }
    const project = godotProjectOf(file.path, projectFolders)
    for (const animation of parsed) {
      const frames: SpriteFrame[] = []
      for (const frame of animation.frames) {
        const image = workspacePathOf(frame.texture, project)
        if (image === undefined) continue
        let region = frame.region
        if (frame.cell !== undefined && image === path) {
          region = gridRegions(size.width, size.height, { columns: frame.cell.columns, rows: frame.cell.rows })[frame.cell.index]
          if (region === undefined) continue
        }
        frames.push({ path: image, ...region === undefined ? {} : { region }, durationMs: frame.seconds * 1000 })
      }
      if (!frames.some(frame => frame.path === path)) continue
      animations.push({ name: animation.name, source: 'godot', definedIn: file.path, frames: frames.slice(0, MAX_ANIMATION_FRAMES), loop: animation.loop })
    }
  }
  return animations
}

/**
 * The animation of an image's own frames.
 * @param path - workspace path of the animated image.
 * @param durationsMs - each frame's duration.
 * @returns the animation, named `frames`.
 */
export function ownFramesAnimation(path: string, durationsMs: readonly number[]): SpriteAnimation {
  return {
    name: 'frames',
    source: 'frames',
    frames: durationsMs.slice(0, MAX_ANIMATION_FRAMES).map((durationMs, index) => ({
      path, index, durationMs: durationMs > 0 ? durationMs : 100,
    })),
    loop: true,
  }
}

/**
 * Make names unique: a repeated name gains the file that defines it, then a number.
 * @param animations - animations in order of preference.
 * @returns the same animations with unique names.
 */
export function uniqueNames(animations: readonly SpriteAnimation[]): SpriteAnimation[] {
  const counts = new Map<string, number>()
  for (const animation of animations) counts.set(animation.name, (counts.get(animation.name) ?? 0) + 1)
  const used = new Set<string>()
  return animations.map((animation) => {
    let name = animation.name
    if ((counts.get(name) ?? 0) > 1 && animation.definedIn !== undefined) name = `${name} (${animation.definedIn.slice(animation.definedIn.lastIndexOf('/', animation.definedIn.length - 2) + 1)})`
    let candidate = name
    for (let number = 2; used.has(candidate); number += 1) candidate = `${name} ${number}`
    used.add(candidate)
    return candidate === animation.name ? animation : { ...animation, name: candidate }
  })
}

/**
 * Pick frames evenly across an animation.
 * @param frames - every frame.
 * @param count - frames wanted.
 * @returns the frames with their indices, all of them when there are no more than `count`.
 */
export function sampledFrames<T>(frames: readonly T[], count: number): { readonly frame: T; readonly index: number }[] {
  if (frames.length <= count) return frames.map((frame, index) => ({ frame, index }))
  return Array.from({ length: count }, (_, step) => {
    const index = Math.round((step * (frames.length - 1)) / Math.max(1, count - 1))
    return { frame: frames[index] as T, index }
  })
}

/**
 * The details of one animation, as the agent reads them.
 * @param animation - the animation.
 * @param imageSize - each workspace image's size, for frames that show a whole image.
 * @returns the details.
 */
export function animationDetails(
  animation: SpriteAnimation,
  imageSize: (path: string) => { readonly width: number; readonly height: number } | undefined,
): SpriteAnimationDetails {
  const totalMs = animation.frames.reduce((sum, frame) => sum + frame.durationMs, 0)
  const sizes = animation.frames.map(frame => frame.region ?? imageSize(frame.path))
  const first = sizes[0]
  const uniform = first !== undefined && sizes.every(size => size?.width === first.width && size.height === first.height)
  return {
    name: animation.name,
    source: animation.source,
    ...animation.definedIn === undefined ? {} : { definedIn: animation.definedIn },
    frames: animation.frames.length,
    fps: totalMs > 0 ? Number(((animation.frames.length * 1000) / totalMs).toFixed(2)) : 0,
    seconds: Number((totalMs / 1000).toFixed(3)),
    loop: animation.loop,
    ...uniform ? { frameWidth: first.width, frameHeight: first.height } : {},
  }
}
