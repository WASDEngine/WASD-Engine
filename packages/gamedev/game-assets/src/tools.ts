/**
 * The model-facing asset tools: `asset_search` lists the game project's 2D art and 3D models, and `asset_view` has a
 * WASD Engine window draw one asset the way its Assets tab does and reports the asset's details: a model from any
 * side, in its materials, as clay, or as wireframe, with its skeleton and frames across a clip; an image at a readable
 * scale with its transparency, colors, and the 2D animations it plays or takes part in. One set of definitions serves
 * one {@link AssetToolSurface}: the Session's own agent, whose images become attachments for its model, or agents
 * connected through WASD Engine's MCP server, whose images travel as image bytes.
 * @module @deepseek-ai/dsh-game-assets/src/tools
 */
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describeDetails, describeSearch, type ListedAsset, type ListedFolder } from './describe.ts'
import { exportOf, formatOf, isBlendFormat, NAME_ORDER } from './formats.ts'
import { ANSWER_LIMITS, parseDetails } from './result.ts'
import { scanProject, type ScanLimits } from './scan.ts'
import type {
  AssetDetails, AssetDrawOptions, AssetRenderedImage, AssetRenderRequest, AssetRenderResult, AssetReveal, AssetViewDirection,
} from './types.ts'

/** Results `asset_search` lists when the call names no limit. */
export const DEFAULT_LIMIT = 50

/** Most results one `asset_search` call lists. */
export const MAX_LIMIT = 200

/** Most frames one `asset_view` call draws across an animation. */
export const MAX_FRAMES = 16

/** Smallest longest edge of a returned image. */
export const MIN_IMAGE_EDGE = 256

/** Directions a model is drawn from, in the order the tools name them. */
export const VIEW_DIRECTIONS: readonly AssetViewDirection[] = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']

/** Most folders `asset_search` lists with their counts. */
const LISTED_FOLDERS = 40

/** Error codes of the asset tools' expected failures. */
export const ASSET_ERROR = {
  /** The path is outside the project folder. */
  outside: 'ASSET_OUTSIDE_PROJECT',
  /** No file at the path. */
  missing: 'ASSET_NOT_FOUND',
  /** The file is not a listed art format. */
  format: 'ASSET_FORMAT',
  /** A Blender file without an exported model. */
  blend: 'ASSET_BLEND_WITHOUT_EXPORT',
  /** An argument out of range. */
  argument: 'ASSET_ARGUMENT',
  /** No WASD Engine window answered. */
  window: 'ASSET_NO_WINDOW',
  /** The window could not draw the asset. */
  draw: 'ASSET_DRAW',
  /** The asset, with the files it loads, is larger than a window reads. */
  tooLarge: 'ASSET_TOO_LARGE',
} as const

/** The message of a call that no window answered. */
export const NO_WINDOW_MESSAGE = 'No WASD Engine window is open to draw the asset. Ask the user to open WASD Engine\'s window, then call asset_view again.'

/** What the tools need from the plugin. */
export interface AssetToolHost {
  /** Caps of the project walk. */
  readonly scanLimits: ScanLimits
  /** Time limit of one `asset_view` call in milliseconds. */
  readonly renderTimeoutMs: number
  /** Longest edge of a returned image when the call names none. */
  readonly defaultImageEdge: number
  /** Largest longest edge of a returned image. */
  readonly maxImageEdge: number
  /** Largest area of a returned image in pixels. */
  readonly maxImagePixels: number
  /** Largest file a window reads to draw it, in bytes. */
  readonly maxPreviewBytes: number
  /**
   * The project folder of one call: the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute folder.
   */
  project(exec: ToolRunContext): Promise<string>
  /**
   * Ask a WASD Engine window that may read the Agent's Session to draw an asset.
   * @param agent - the calling Agent; its Session's workspace holds the asset.
   * @param request - the asset and what to draw.
   * @param signal - the call's cancellation.
   * @returns the window's validated answer.
   * @throws {HarnessError} `ASSET_NO_WINDOW` when no window answers, or the window's failure.
   */
  render(agent: Agent, request: AssetRenderRequest, signal: AbortSignal): Promise<AssetRenderResult>
  /**
   * The Agent whose Session's Assets tab shows what an Agent asks to show: the root of its subagent tree, whose
   * Session the user watches while teammates and subagents work, or the Agent itself.
   * @param agent - the calling Agent.
   * @returns the Agent whose Session shows the asset.
   */
  revealTarget(agent: Agent): Agent
  /**
   * Open an asset in the Session's Assets tab of the windows that may read the Session.
   * @param reveal - the Session, the asset, and the animation.
   */
  reveal(reveal: AssetReveal): void
}

/** How one set of tool definitions hands drawn images to its callers. */
export interface AssetToolSurface {
  /**
   * Whether the caller of a call sees images; a caller that does not gets the details alone.
   * @param exec - the call's execution.
   * @returns true when the caller's model accepts images.
   */
  seesImages(exec: ToolRunContext): Promise<boolean>
  /**
   * Give a call's drawn images to its caller.
   * @param exec - the call's execution.
   * @param images - the images the window drew.
   * @param name - base name for the images, such as the asset's file name.
   * @returns the stored images that the result carries, or none when they reach the caller another way.
   */
  keep(exec: ToolRunContext, images: readonly AssetRenderedImage[], name: string): Promise<ImageAttachmentRef[]>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project: STRING,
    query: STRING,
    kind: { type: 'string', enum: ['2d', '3d'] },
    folder: { type: 'string' },
    total: INTEGER,
    offset: INTEGER,
    assets: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: STRING, kind: { type: 'string', enum: ['image', 'model'], required: true }, format: STRING, bytes: INTEGER },
      },
    },
    folders: {
      type: 'array',
      required: true,
      items: { type: 'object', additionalProperties: false, properties: { path: STRING, images: INTEGER, models: INTEGER } },
    },
    truncated: BOOLEAN,
    unreadable: INTEGER,
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

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: STRING,
    requested: { type: 'string', description: 'The Blender file the call named, when the drawn model was exported from it.' },
    details: { type: 'json', required: true, description: 'What the window measured: an image\'s or a model\'s details.' },
    captions: { type: 'array', required: true, items: { type: 'string' } },
    images: { type: 'array', required: true, items: IMAGE_SCHEMA },
    imagesOmitted: { type: 'boolean', description: 'The caller\'s model does not accept images, so none were drawn.' },
    shown: BOOLEAN,
  },
} as const

/** Value of one `asset_view` call. */
type ViewValue = InferValue<typeof VIEW_SCHEMA>

/**
 * Copy details into the JSON a tool result stores.
 * @param details - validated details.
 * @returns the same fields as JSON.
 */
function detailsJson(details: AssetDetails): JsonValue {
  return JSON.parse(JSON.stringify(details)) as JsonValue
}

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function fail(message: string, code: string): never {
  throw new HarnessError(message, code)
}

function checkedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const chosen = value ?? fallback
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) fail(`${name} must be an integer from ${min} to ${max}.`, ASSET_ERROR.argument)
  return chosen
}

/**
 * Resolve an asset path against the project folder.
 * @param project - absolute project folder.
 * @param path - the path the call names: relative to the project folder, or absolute inside it.
 * @returns the absolute path and the `/`-separated workspace path.
 * @throws {HarnessError} `ASSET_OUTSIDE_PROJECT` for a path outside the project folder.
 */
export function workspacePath(project: string, path: string): { readonly absolute: string; readonly path: string } {
  const absolute = resolve(project, path.trim())
  const inside = relative(project, absolute)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    fail(`${path} is not a file inside the project folder ${project}.`, ASSET_ERROR.outside)
  }
  return { absolute, path: inside.split(sep).join('/') }
}

/**
 * The path a window reads a file at. The window resolves a Session's relative paths against the folder in the
 * Session's header, which stays the project folder when an agent's working directory moves below it, as for a teammate
 * started in a subfolder; a path relative to that folder also lets the window find the file's siblings and the Godot
 * resources that use it.
 * @param root - the folder in the Session's header, or undefined when the header has none.
 * @param absolute - absolute path of the file.
 * @returns the `/`-separated path relative to `root` for a file inside it, and the absolute path otherwise.
 */
export function windowPath(root: string | undefined, absolute: string): string {
  if (root === undefined) return absolute
  const inside = relative(root, absolute)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return absolute
  return inside.split(sep).join('/')
}

/**
 * A path a window gave, which names a file from the folder in the Session's header, as the calling agent names it.
 * @param root - the folder in the Session's header.
 * @param project - the calling agent's project folder: its working directory.
 * @param reported - the window's path, relative to `root` or absolute.
 * @returns the `/`-separated path relative to `project` for a file inside it, and the absolute path otherwise.
 */
export function callerPath(root: string, project: string, reported: string): string {
  const target = isAbsolute(reported) ? reported : resolve(root, reported)
  const inside = relative(project, target)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return target
  return inside.split(sep).join('/')
}

/**
 * The details a window measured, with the files that define an image's animations named as the calling agent names
 * them.
 * @param details - the window's details.
 * @param root - the folder in the Session's header, from which the window names files.
 * @param project - the calling agent's project folder.
 * @returns the details for the agent.
 */
function callerDetails(details: AssetDetails, root: string, project: string): AssetDetails {
  if (details.kind !== 'image' || root === project) return details
  return {
    ...details,
    animations: details.animations.map(animation => (animation.definedIn === undefined
      ? animation
      : { ...animation, definedIn: callerPath(root, project, animation.definedIn) })),
  }
}

/** Largest .gltf file whose JSON is read for the files it names; a larger one holds its data inside. */
const MAX_GLTF_JSON_BYTES = 16 * 1024 * 1024

/** Most distinct files one glTF model may name for the window to load with it. */
export const MAX_GLTF_FILES = 1024

/** Files whose sizes are read at once while summing a glTF model's files. */
const GLTF_STAT_CONCURRENCY = 16

/**
 * The total size of the files a glTF model names outside its .gltf file, its buffers and images, which the window
 * loads with it. Names resolve as the window resolves them: from the model's folder, and an absolute name by its file
 * name in that folder. The sizes are read {@link GLTF_STAT_CONCURRENCY} at a time.
 * @param file - absolute path of the .gltf file.
 * @param size - its size in bytes.
 * @param signal - the call's cancellation, checked before each read.
 * @returns the total size in bytes, 0 when the file holds its data inside or is not readable JSON.
 * @throws {HarnessError} `ASSET_TOO_LARGE` when the model names more than {@link MAX_GLTF_FILES} distinct files.
 */
export async function gltfFilesBytes(file: string, size: number, signal: AbortSignal): Promise<number> {
  if (size > MAX_GLTF_JSON_BYTES) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // ENOENT, EACCES, or SyntaxError: the window reports the file it cannot read.
    return 0
  }
  const uris = (key: string): string[] => {
    const list: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined
    if (!Array.isArray(list)) return []
    return list.flatMap((entry: unknown) => {
      const uri: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'uri') : undefined
      return typeof uri === 'string' && !/^(?:data|blob):/iu.test(uri) ? [uri] : []
    })
  }
  const folder = dirname(file)
  const named = new Set([...uris('buffers'), ...uris('images')].map((uri) => {
    let name = uri
    try {
      name = decodeURIComponent(uri)
    } catch {
      // URIError: a name with a stray `%` is a literal file name, as the window reads it.
    }
    const slashed = name.replaceAll('\\', '/')
    return isAbsolute(name) || /^[A-Za-z]:\//u.test(slashed) ? join(folder, basename(slashed)) : resolve(folder, name)
  }))
  if (named.size > MAX_GLTF_FILES) {
    fail(`The glTF model names ${String(named.size)} files, more than the ${String(MAX_GLTF_FILES)} the viewer loads with one model.`, ASSET_ERROR.tooLarge)
  }
  const paths = [...named]
  let total = 0
  for (let start = 0; start < paths.length; start += GLTF_STAT_CONCURRENCY) {
    signal.throwIfAborted()
    const sizes = await Promise.all(paths.slice(start, start + GLTF_STAT_CONCURRENCY).map(async path => (await statOf(path))?.size ?? 0))
    for (const next of sizes) total += next
  }
  return total
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Rank assets for a query: names containing it first, then paths containing it, then paths that hold its characters
 * in order; the rest are left out.
 * @param assets - the assets.
 * @param query - lowercase search text.
 * @returns the matching assets, best first.
 */
function ranked<T extends ListedAsset>(assets: readonly T[], query: string): T[] {
  const score = (asset: T): number => {
    const path = asset.path.toLowerCase()
    const name = nameOf(path)
    if (name.startsWith(query)) return 0
    if (name.includes(query)) return 1
    if (path.includes(query)) return 2
    let at = 0
    for (const character of path) if (character === query[at]) at += 1
    return at === query.length ? 3 : -1
  }
  return assets
    .map(asset => ({ asset, score: score(asset) }))
    .filter(entry => entry.score >= 0)
    .sort((left, right) => left.score - right.score || NAME_ORDER.compare(left.asset.path, right.asset.path))
    .map(entry => entry.asset)
}

/**
 * The draw options of one call, validated.
 * @param args - the call's arguments.
 * @param host - the image bounds.
 * @returns the options.
 */
function drawOptions(args: ViewArgs, host: AssetToolHost): AssetDrawOptions {
  const views = args.views === undefined || args.views.length === 0 ? ['iso' as const] : [...new Set(args.views)]
  const size = checkedInteger(args.size, Math.min(host.defaultImageEdge, host.maxImageEdge), 'size', MIN_IMAGE_EDGE, host.maxImageEdge)
  if (args.time !== undefined && (!Number.isFinite(args.time) || args.time < 0)) fail('time must be a number of seconds from 0.', ASSET_ERROR.argument)
  if (args.time !== undefined && args.animation === undefined) fail('time needs animation: the clip to pose the model in.', ASSET_ERROR.argument)
  if (args.fps !== undefined && (!Number.isFinite(args.fps) || args.fps <= 0 || args.fps > 240)) fail('fps must be a number above 0 and at most 240.', ASSET_ERROR.argument)
  const grid = args.grid
  if (grid !== undefined) {
    checkedInteger(grid.columns, 1, 'grid.columns', 1, 256)
    checkedInteger(grid.rows, 1, 'grid.rows', 1, 256)
    if (grid.count !== undefined) checkedInteger(grid.count, 1, 'grid.count', 1, grid.columns * grid.rows)
  }
  const region = args.region
  if (region !== undefined) {
    for (const [key, min] of [['x', 0], ['y', 0], ['width', 1], ['height', 1]] as const) {
      checkedInteger(region[key], min, `region.${key}`, min, 1_000_000)
    }
  }
  return {
    views,
    shading: args.shading ?? 'material',
    skeleton: args.skeleton === true,
    ...args.animation === undefined ? {} : { animation: args.animation },
    ...args.frames === undefined ? {} : { frames: checkedInteger(args.frames, 1, 'frames', 1, MAX_FRAMES) },
    ...args.time === undefined ? {} : { time: args.time },
    ...grid === undefined ? {} : {
      grid: { columns: grid.columns, rows: grid.rows, ...grid.count === undefined ? {} : { count: grid.count } },
    },
    ...args.fps === undefined ? {} : { fps: args.fps },
    ...region === undefined ? {} : { region: { x: region.x, y: region.y, width: region.width, height: region.height } },
    size,
  }
}

/** Arguments of `asset_view`, as the schema types them. */
interface ViewArgs {
  readonly path: string
  readonly views?: readonly AssetViewDirection[]
  readonly shading?: 'material' | 'solid' | 'wireframe'
  readonly skeleton?: boolean
  readonly animation?: string
  readonly frames?: number
  readonly time?: number
  readonly grid?: { readonly columns: number; readonly rows: number; readonly count?: number }
  readonly fps?: number
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly size?: number
  readonly show?: boolean
}

function renderView(value: ViewValue): ContentBlock[] {
  const lines = []
  if (value.requested !== undefined) lines.push(`${value.requested} is a Blender file, which the viewer cannot read; this is the model exported from it.`)
  lines.push(...describeDetails(value.path, parseDetails(value.details)))
  if (value.imagesOmitted === true) lines.push('Your model does not accept images, so no picture was drawn.')
  else if (value.captions.length > 0) lines.push(`The image${value.captions.length === 1 ? ' shows' : 's show'}: ${value.captions.join('; ')}.`)
  if (value.shown) lines.push('It is open in the user\'s Assets panel.')
  return [
    ...textBlocks(lines.join('\n')),
    // The value holds the references that the attachment store returned, so their ids are stored attachment ids.
    ...value.images.map(image => ({ type: 'image' as const, attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } })),
  ]
}

/**
 * Build the asset tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how the definitions hand drawn images to their callers.
 * @returns the definitions, not registered: `asset_search`, then `asset_view`.
 */
export function assetToolDefinitions(host: AssetToolHost, surface: AssetToolSurface): ToolDefinition[] {
  return [defineTool({
    name: 'asset_search',
    description: 'List the game project\'s 2D art and 3D models: images (PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, ICO, TGA, HDR, EXR) and models (glTF and GLB, OBJ, FBX, DAE, STL, PLY, VOX, and Blender files), with how many each folder holds. Without a query, lists them folder by folder; with one, the assets whose name or path contains it, best match first. Pass a path to asset_view to look at one.',
    parameters: {
      query: { type: 'string', description: 'Text in the asset\'s name or path, such as "knight" or "ui/icons". Default: every asset.' },
      kind: { type: 'string', enum: ['2d', '3d'], description: 'Only images (2d) or only models (3d). Default: both.' },
      folder: { type: 'string', description: 'Only assets in this folder or below it, relative to the project folder.' },
      limit: { type: 'integer', description: `Most assets to list, from 1 to ${MAX_LIMIT}. Default: ${DEFAULT_LIMIT}.` },
      offset: { type: 'integer', description: 'Assets to skip, to list more. Default: 0.' },
    },
    output: {
      schema: SEARCH_SCHEMA,
      render: (_args, value) => textBlocks(describeSearch(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = checkedInteger(args.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT)
      const offset = checkedInteger(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const project = await host.project(exec)
      const folder = args.folder === undefined ? undefined : workspaceFolder(project, args.folder)
      const scan = await scanProject(project, host.scanLimits, exec.signal)
      const kind = args.kind === undefined ? undefined : args.kind === '2d' ? 'image' : 'model'
      const listed: ListedAsset[] = scan.assets
        .filter(asset => kind === undefined || asset.format.kind === kind)
        .filter(asset => folder === undefined || folder === '' || asset.folder === folder || asset.folder.startsWith(`${folder}/`))
        .map(asset => ({ path: asset.path, kind: asset.format.kind, format: asset.format.label, bytes: asset.bytes }))
      const query = args.query?.trim() ?? ''
      const matching = query === '' ? listed : ranked(listed, query.toLowerCase())
      const counts = new Map<string, { images: number; models: number }>()
      for (const asset of matching) {
        const key = folderOf(asset.path)
        const entry = counts.get(key) ?? { images: 0, models: 0 }
        if (asset.kind === 'image') entry.images += 1
        else entry.models += 1
        counts.set(key, entry)
      }
      const folders: ListedFolder[] = [...counts.entries()]
        .sort(([left], [right]) => NAME_ORDER.compare(left, right))
        .slice(0, LISTED_FOLDERS)
        .map(([path, entry]) => ({ path, ...entry }))
      return {
        project,
        query,
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...folder === undefined ? {} : { folder },
        total: matching.length,
        offset,
        assets: matching.slice(offset, offset + limit),
        folders,
        truncated: scan.truncated,
        unreadable: scan.unreadable,
      }
    },
  }), defineTool({
    name: 'asset_view',
    description: 'Look at one 2D or 3D asset of the game project as the Assets panel draws it, and get the details needed to edit it. '
      + 'A model is drawn from the views you ask for, in its materials, as solid clay, or as wireframe, optionally with its skeleton over it; its details give its size and bounds, triangles, materials and their textures, its bones as a tree, its animation clips with their lengths and animated bones, and its morph targets. '
      + 'An image is drawn at a readable size, pixel art enlarged without smoothing, with its pixel size, transparency, and colors, and the 2D animations it plays or takes part in: its own frames (animated GIF, WebP, or PNG), numbered images beside it, Godot SpriteFrames and Sprite2D frame grids that use it, sprite sheet JSON beside it, or a grid you give. '
      + 'Pass animation to see frames across a clip or 2D animation. A Blender file shows the model exported from it. Set show to open the asset in the user\'s Assets panel.',
    parameters: {
      path: { type: 'string', required: true, description: 'The asset, relative to the project folder or absolute inside it, such as "art/hero.glb".' },
      views: { type: 'array', items: { type: 'string', enum: [...VIEW_DIRECTIONS] }, description: 'Models: directions to draw, each a tile of the image. iso looks from the front right and above in perspective; the others look straight at one side without perspective, so proportions can be measured: front at the +Z side, back at -Z, right from +X, left from -X, top down from +Y, bottom up from -Y. Default: ["iso"].' },
      shading: { type: 'string', enum: ['material', 'solid', 'wireframe'], description: 'Models: material (default) draws its own materials and textures; solid draws a uniform clay that shows the shape; wireframe draws the edges of its triangles.' },
      skeleton: { type: 'boolean', description: 'Models: draw the bones over the model. Default: false.' },
      animation: { type: 'string', description: 'A clip name for a model, or an animation name for an image, as the details list them, to draw frames across it.' },
      frames: { type: 'integer', description: `Frames to draw across the animation, from 1 to ${MAX_FRAMES}. Default: 6 for a clip; every frame of a 2D animation up to ${MAX_FRAMES}.` },
      time: { type: 'number', description: 'Models: seconds into the animation to pose the model, instead of frames across it.' },
      grid: {
        type: 'object',
        additionalProperties: false,
        description: 'Images: read the image as a sprite sheet of this grid, frames left to right then top to bottom. The picture shows the grid over the image with each cell\'s number, and the details list it as an animation named grid; pass animation "grid" to see its frames.',
        properties: {
          columns: { type: 'integer', required: true, description: 'Frames across.' },
          rows: { type: 'integer', required: true, description: 'Frames down.' },
          count: { type: 'integer', description: 'Frames in the sheet when its last row is not full.' },
        },
      },
      fps: { type: 'number', description: 'Images: frames per second of a grid, numbered images, or sheet without its own timing. Default: 12.' },
      region: {
        type: 'object',
        additionalProperties: false,
        description: 'Images: draw only this rectangle, in pixels from the top left corner, to see details up close.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      size: { type: 'integer', description: `Longest edge of the returned image in pixels, from ${MIN_IMAGE_EDGE} to ${host.maxImageEdge}. Default: ${Math.min(host.defaultImageEdge, host.maxImageEdge)}.` },
      show: { type: 'boolean', description: 'Also open the asset in the user\'s Assets panel, with the grid and playing the animation you name. Default: false.' },
    },
    output: {
      schema: VIEW_SCHEMA,
      render: (_args, value) => renderView(value),
    },
    timeoutMs: host.renderTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) fail('asset_view needs a Session: the window draws the asset from a Session\'s project.', ASSET_ERROR.window)
      const draw = drawOptions(args, host)
      const project = await host.project(exec)
      const target = workspacePath(project, args.path)
      let format = formatOf(target.path)
      if (format === undefined) {
        fail(`${target.path} is not an asset the viewer reads. It reads images (PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, ICO, TGA, HDR, EXR) and models (glTF, GLB, OBJ, FBX, DAE, STL, PLY, VOX, and Blender files through a model exported from them).`, ASSET_ERROR.format)
      }
      const info = await statOf(target.absolute)
      if (info === undefined) fail(`No file at ${target.path} in ${project}. List the project's assets with asset_search.`, ASSET_ERROR.missing)
      if (!info.isFile()) fail(`${target.path} is a folder, not an asset. List its assets with asset_search and folder.`, ASSET_ERROR.missing)
      let path = target.path
      let absolute = target.absolute
      let bytes = info.size
      let requested: string | undefined
      if (isBlendFormat(format)) {
        const scan = await scanProject(project, host.scanLimits, exec.signal)
        const exported = exportOf({ path: target.path, name: nameOf(target.path), folder: folderOf(target.path), format }, scan.assets)
        if (exported === undefined) {
          fail(`${target.path} is a Blender file, which the viewer cannot read, and the project has no model of the same name exported from it. Export it as GLB beside it, or look at it with Blender's render_preview.`, ASSET_ERROR.blend)
        }
        requested = target.path
        path = exported.path
        absolute = resolve(project, exported.path)
        bytes = exported.bytes
        format = exported.format
      }
      // A glTF model's buffers and images in files of their own load with it.
      if (format.label === 'glTF') bytes += await gltfFilesBytes(absolute, bytes, exec.signal)
      const images = await surface.seesImages(exec)
      const root = agent.session.header.cwd
      const sent = windowPath(root, absolute)
      let answer: AssetRenderResult
      try {
        answer = await host.render(agent, {
          path: sent,
          kind: format.kind,
          draw,
          images,
          bytes,
          maxBytes: host.maxPreviewBytes,
          maxPixels: host.maxImagePixels,
          limits: ANSWER_LIMITS,
        }, exec.signal)
      } catch (error) {
        // The window names the asset as it reads it, which an agent working below the project folder names otherwise.
        if (sent === path || !(error instanceof HarnessError)) throw error
        throw new HarnessError(error.message.replaceAll(sent, path), error.code, { cause: error })
      }
      const kept = images && answer.images.length > 0 ? await surface.keep(exec, answer.images, nameOf(path)) : []
      const shown = args.show === true
      if (shown) {
        const watched = host.revealTarget(agent)
        host.reveal({
          sessionId: watched.id,
          path: windowPath(watched.session.header.cwd, absolute),
          ...draw.animation === undefined ? {} : { animation: draw.animation },
          ...draw.grid === undefined ? {} : { grid: draw.grid },
        })
      }
      return {
        path,
        ...requested === undefined ? {} : { requested },
        details: detailsJson(root === undefined ? answer.details : callerDetails(answer.details, root, project)),
        captions: answer.images.map(image => image.caption),
        images: kept,
        ...images ? {} : { imagesOmitted: true },
        shown,
      }
    },
  })]
}

/**
 * Read a path's file information.
 * @param path - absolute path.
 * @returns the information, or undefined when nothing readable is there.
 */
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    // ENOENT, ENOTDIR, or EACCES: nothing readable at the path.
    return undefined
  }
}

/**
 * Resolve a folder filter against the project folder.
 * @param project - absolute project folder.
 * @param folder - the folder the call names.
 * @returns the `/`-separated workspace path of the folder; empty for the project folder.
 * @throws {HarnessError} `ASSET_OUTSIDE_PROJECT` for a folder outside the project folder.
 */
function workspaceFolder(project: string, folder: string): string {
  const trimmed = folder.trim().replace(/[\\/]+$/u, '')
  if (trimmed === '' || trimmed === '.') return ''
  const absolute = resolve(project, trimmed)
  const inside = relative(project, absolute)
  if (inside === '') return ''
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail(`${folder} is not a folder inside the project folder ${project}.`, ASSET_ERROR.outside)
  return inside.split(sep).join('/')
}
