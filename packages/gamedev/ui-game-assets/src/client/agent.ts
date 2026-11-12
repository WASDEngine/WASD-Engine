/**
 * This window's answer to an agent's `game-assets/render` request: it reads the asset from the calling Session's
 * workspace, measures its details as the Assets tab shows them, and draws the pictures the request asks for. An image
 * is drawn on a checkerboard, enlarged without smoothing when small, with a sprite sheet grid when asked, or as a sheet
 * of an animation's frames; a model is drawn with three.js off screen, one tile per view or pose. Pictures are PNG for
 * 2D art and JPEG for 3D scenes, within the request's bounds. A failure rejects with a message for the agent.
 */
import type {
  AssetDrawOptions, AssetRenderedImage, AssetRenderRequest, AssetRenderResult, AssetTransparency, ImageAssetDetails, SpriteAnimationDetails,
} from '@deepseek-ai/dsh-game-assets/types'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { findAnimations, type AnimationSources } from './animations2d.ts'
import { fitDetails } from './answer.ts'
import { formatOf, type AssetFormat } from './formats.ts'
import { closeFrames, decodeOwnFrames } from './frames.ts'
import type { AssetFile } from './read.ts'
import { drawImagePicture, drawSheet, encodeCanvas, pictureTile, sheetLayout, type Picture, type PictureBounds } from './render2d.ts'
import { animationDetails, DEFAULT_FPS, gridAnimation, sampledFrames, type SpriteAnimation, type SpriteFrame } from './sprites.ts'

type ViewerModule = typeof import('./viewer/index.ts')

/** Frames a 3D clip shows when the request names none. */
export const DEFAULT_CLIP_FRAMES = 6

/** Frames a 2D animation shows at most when the request names none. */
export const DEFAULT_SPRITE_FRAMES = 16

/** How long a model's textures may take to load before it is drawn without the late ones. */
const TEXTURE_WAIT_MS = 20_000

/** Largest image area measured pixel by pixel; larger images are measured at a smaller size. */
const MEASURED_PIXELS = 4_000_000

/** What answering a request reads and loads, bound to the calling Session. */
export interface AgentRenderSources {
  /**
   * Read a complete workspace file.
   * @param path - workspace path.
   * @param maxBytes - the largest file to read.
   * @param signal - cancellation.
   * @returns the file, or the Remote failure.
   */
  readonly read: (path: string, maxBytes: number, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>
  /** The reads that find an image's animations. */
  readonly animations: AnimationSources
  /**
   * The URL of a file that a model names.
   * @param base - absolute path of the model file.
   * @param reference - the name as the model stores it.
   * @returns the URL.
   */
  readonly relatedUrl: (base: string, reference: string) => string
  /** @returns the viewer's three.js chunk, loaded on first use. */
  readonly viewer: () => Promise<ViewerModule>
}

/** A failure the agent reads. */
export class AssetDrawError extends Error {
  /**
   * @param message - what went wrong, for the agent.
   * @param code - stable failure code.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AssetDrawError'
  }
}

/** A decoded picture and how to release it. */
interface Decoded {
  readonly picture: Picture
  readonly close: () => void
}

/**
 * Decode an image file into a picture.
 * @param data - the file.
 * @param format - its format.
 * @param viewer - loads the viewer chunk for TGA, HDR, and EXR.
 * @returns the picture.
 * @throws {AssetDrawError} when the file does not decode.
 */
export async function decodePicture(
  data: Uint8Array<ArrayBuffer>,
  format: AssetFormat,
  viewer: () => Promise<ViewerModule>,
): Promise<Decoded> {
  if (format.kind !== 'image') throw new AssetDrawError('Not an image.', 'ASSET_FORMAT')
  try {
    if (format.decoder !== 'browser') {
      const bitmap = await (await viewer()).decodeImage(format.decoder, data)
      return { picture: { source: bitmap, width: bitmap.width, height: bitmap.height }, close: () => { bitmap.close() } }
    }
    const blob = new Blob([data], format.mediaType === undefined ? {} : { type: format.mediaType })
    if (format.mediaType !== 'image/svg+xml') {
      const bitmap = await createImageBitmap(blob)
      return { picture: { source: bitmap, width: bitmap.width, height: bitmap.height }, close: () => { bitmap.close() } }
    }
    // SVG decodes only through an image element.
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.src = url
    try {
      await image.decode()
    } finally {
      URL.revokeObjectURL(url)
    }
    return { picture: { source: image, width: image.naturalWidth || 512, height: image.naturalHeight || 512 }, close: () => {} }
  } catch (error) {
    if (error instanceof AssetDrawError) throw error
    throw new AssetDrawError(`The ${format.label} file could not be decoded: it may be damaged or use a feature the viewer does not support.`, 'ASSET_UNREADABLE')
  }
}

/**
 * How an image's pixels use transparency, and how many colors it has, counted up to 257.
 * @param picture - the image.
 * @returns the facts.
 */
export function pixelFacts(picture: Picture): { readonly transparency: AssetTransparency; readonly colors: number } {
  const scale = Math.min(1, Math.sqrt(MEASURED_PIXELS / Math.max(1, picture.width * picture.height)))
  const width = Math.max(1, Math.round(picture.width * scale))
  const height = Math.max(1, Math.round(picture.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return { transparency: 'opaque', colors: 0 }
  context.imageSmoothingEnabled = false
  context.drawImage(picture.source, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  let transparent = false
  let translucent = false
  const colors = new Set<number>()
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] ?? 255
    if (alpha === 0) transparent = true
    else if (alpha < 255) translucent = true
    if (colors.size > 256) continue
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    colors.add(((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0)
  }
  return { transparency: translucent ? 'translucent' : transparent ? 'cutout' : 'opaque', colors: Math.min(257, colors.size) }
}

function readFailure(path: string, result: RemoteResult<AssetFile>): AssetDrawError | undefined {
  if (result.ok) return undefined
  const error = result.error
  if (error.code === 'workspace-file/not-found') return new AssetDrawError(`${path} is no longer in the project.`, 'ASSET_NOT_FOUND')
  if (error.code === 'workspace-file/too-large') return new AssetDrawError(`${path} is larger than ${fileSizeText(error.details.limit)}, too large to draw.`, 'ASSET_TOO_LARGE')
  return new AssetDrawError(`${path} could not be read: ${error.message}`, 'ASSET_UNREADABLE')
}

async function readOrFail(sources: AgentRenderSources, path: string, maxBytes: number, signal: AbortSignal): Promise<AssetFile> {
  const result = await sources.read(path, maxBytes, signal)
  const failure = readFailure(path, result)
  if (failure !== undefined || !result.ok) throw failure ?? new AssetDrawError(`${path} could not be read.`, 'ASSET_UNREADABLE')
  return result.value
}

function seconds(value: number): string {
  return `${value.toFixed(2)} s`
}

/**
 * Pick a clip by name.
 * @param names - the model's clip names.
 * @param wanted - the requested name.
 * @param path - workspace path of the model, for the message.
 * @returns the clip's index.
 * @throws {AssetDrawError} naming the clips when none has the name.
 */
function clipIndex(names: readonly string[], wanted: string, path: string): number {
  const exact = names.indexOf(wanted)
  if (exact >= 0) return exact
  const folded = names.findIndex(name => name.toLowerCase() === wanted.toLowerCase())
  if (folded >= 0) return folded
  throw new AssetDrawError(names.length === 0
    ? `${path} has no animation clips.`
    : `${path} has no clip named "${wanted}". Its clips: ${names.map(name => `"${name}"`).join(', ')}.`, 'ASSET_ANIMATION')
}

async function answerModel(
  request: AssetRenderRequest,
  format: AssetFormat,
  sources: AgentRenderSources,
  signal: AbortSignal,
): Promise<AssetRenderResult> {
  if (format.kind !== 'model' || format.decoder === 'blend') throw new AssetDrawError(`${request.path} is not a model the viewer reads.`, 'ASSET_FORMAT')
  const file = await readOrFail(sources, request.path, request.maxBytes, signal)
  const viewer = await sources.viewer()
  let model
  try {
    model = await viewer.loadModel({
      decoder: format.decoder,
      data: file.data,
      related: reference => sources.relatedUrl(file.absolutePath, reference),
      changed: () => {},
    }, signal)
  } catch (error) {
    signal.throwIfAborted()
    throw new AssetDrawError(`${request.path} could not be read as ${format.label}: ${error instanceof Error ? error.message : String(error)}. It may be damaged or use a feature the viewer does not support.`, 'ASSET_UNREADABLE')
  }
  try {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, TEXTURE_WAIT_MS)
      signal.addEventListener('abort', done, { once: true })
      void model.settled.then(done, done)
    })
    signal.throwIfAborted()
    const details = viewer.describeModel(model, format.label, file.data.byteLength)
    const draw = request.draw
    const names = model.animations.map(animation => animation.name)
    const clip = draw.animation === undefined ? undefined : clipIndex(names, draw.animation, request.path)
    if (!request.images) return { details, images: [] }
    const duration = clip === undefined ? 0 : model.animations[clip]?.duration ?? 0
    let times: number[] | undefined
    let views = draw.views
    if (clip !== undefined) {
      if (draw.time !== undefined) {
        times = [Math.min(draw.time, duration)]
      } else {
        const count = draw.frames ?? DEFAULT_CLIP_FRAMES
        times = Array.from({ length: count }, (_, index) => (duration * index) / count)
        views = views.slice(0, 1)
      }
    }
    const count = Math.max(1, (times?.length ?? 1) * views.length)
    const bounds: PictureBounds = { size: draw.size, maxPixels: request.maxPixels }
    const layout = sheetLayout(count, 1, bounds)
    let tiles
    try {
      tiles = viewer.renderModelTiles(model, {
        views, shading: draw.shading, skeleton: draw.skeleton,
        ...clip === undefined ? {} : { clip },
        ...times === undefined ? {} : { times },
        tileWidth: layout.tileWidth, tileHeight: layout.tileHeight,
      })
    } catch (error) {
      throw new AssetDrawError(`This WASD Engine window could not draw the model: ${error instanceof Error ? error.message : String(error)}.`, 'ASSET_DRAW')
    }
    const clipName = clip === undefined ? undefined : model.animations[clip]?.name
    const sheet = drawSheet(tiles.map(tile => ({
      label: tile.time === undefined ? tile.view : `${views.length > 1 ? `${tile.view} · ` : ''}${seconds(tile.time)}`,
      draw: (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) => {
        context.drawImage(tile.canvas, x, y, width, height)
      },
    })), 1, bounds)
    const shading = { material: 'in its materials', solid: 'as solid clay', wireframe: 'as wireframe' }[draw.shading]
    const viewNames = `${views.join(', ')} view${views.length === 1 ? '' : 's'}`
    const caption = clipName === undefined
      ? `${viewNames} ${shading}${draw.skeleton ? ' with the skeleton' : ''}`
      : times !== undefined && times.length === 1 && draw.time !== undefined
        ? `${viewNames} ${shading}, posed at ${seconds(times[0] ?? 0)} of ${clipName}${draw.skeleton ? ', with the skeleton' : ''}`
        : `${times?.length ?? 0} poses of ${clipName} across its ${seconds(duration)}, ${viewNames} ${shading}${draw.skeleton ? ', with the skeleton' : ''}`
    const image: AssetRenderedImage = { data: await encodeCanvas(sheet, 'image/jpeg'), mediaType: 'image/jpeg', width: sheet.width, height: sheet.height, caption }
    return { details, images: [image] }
  } finally {
    model.dispose()
  }
}

/** Decoded pictures of the frames' images, read once each. */
class FramePictures {
  private readonly decoded = new Map<string, Promise<Decoded>>()

  constructor(
    private readonly sources: AgentRenderSources,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal,
  ) {}

  of(path: string): Promise<Decoded> {
    let known = this.decoded.get(path)
    if (known === undefined) {
      known = (async () => {
        const format = formatOf(path)
        if (format?.kind !== 'image') throw new AssetDrawError(`${path} is not an image.`, 'ASSET_FORMAT')
        return await decodePicture((await readOrFail(this.sources, path, this.maxBytes, this.signal)).data, format, this.sources.viewer)
      })()
      this.decoded.set(path, known)
    }
    return known
  }

  async close(): Promise<void> {
    for (const pending of this.decoded.values()) {
      try {
        (await pending).close()
      } catch {
        // AssetDrawError: a frame that failed to decode holds nothing to release.
      }
    }
  }
}

function animationNotFound(path: string, wanted: string, animations: readonly SpriteAnimation[]): AssetDrawError {
  return new AssetDrawError(animations.length === 0
    ? `${path} has no 2D animations. Pass grid to read it as a sprite sheet.`
    : `${path} has no 2D animation named "${wanted}". Its animations: ${animations.map(animation => `"${animation.name}"`).join(', ')}.`, 'ASSET_ANIMATION')
}

async function answerImage(
  request: AssetRenderRequest,
  format: AssetFormat,
  sources: AgentRenderSources,
  signal: AbortSignal,
): Promise<AssetRenderResult> {
  if (format.kind !== 'image') throw new AssetDrawError(`${request.path} is not an image.`, 'ASSET_FORMAT')
  const file = await readOrFail(sources, request.path, request.maxBytes, signal)
  const own = await decodePicture(file.data, format, sources.viewer)
  const draw: AssetDrawOptions = request.draw
  const frames = format.mediaType !== undefined
    ? await decodeOwnFrames(file.data, format.mediaType, () => request.images && draw.animation !== undefined, signal)
    : undefined
  const pictures = new FramePictures(sources, request.maxBytes, signal)
  try {
    const size = { width: own.picture.width, height: own.picture.height }
    const found = await findAnimations(request.path, size, frames?.durationsMs, sources.animations, signal)
    // The search treats its failed reads, cancelled ones included, as finding nothing.
    signal.throwIfAborted()
    const animations = draw.grid === undefined
      ? found
      : [...found, gridAnimation(request.path, size.width, size.height, draw.grid, draw.fps ?? DEFAULT_FPS)]
    const imageSize = (path: string): typeof size | undefined => (path === request.path ? size : undefined)
    const facts = pixelFacts(own.picture)
    const details: ImageAssetDetails = {
      kind: 'image',
      format: format.label,
      bytes: file.data.byteLength,
      width: size.width,
      height: size.height,
      ...facts,
      animations: animations.map((animation): SpriteAnimationDetails => animationDetails(retimed(animation, draw.fps), imageSize)),
    }
    if (!request.images) return { details, images: [] }
    const bounds: PictureBounds = { size: draw.size, maxPixels: request.maxPixels }
    if (draw.animation === undefined) {
      const { canvas, scale } = drawImagePicture(own.picture, bounds, draw.region, draw.grid)
      const part = draw.region === undefined ? 'the image' : `pixels (${draw.region.x}, ${draw.region.y}) to (${draw.region.x + draw.region.width}, ${draw.region.y + draw.region.height})`
      const caption = `${part} at ${scale >= 1 ? `${scale}×` : `${Math.round(scale * 100)}%`} on a checkerboard that shows transparency${draw.grid === undefined ? '' : `, with the ${draw.grid.columns} × ${draw.grid.rows} grid and each cell's number`}`
      return { details, images: [{ data: await encodeCanvas(canvas, 'image/png'), mediaType: 'image/png', width: canvas.width, height: canvas.height, caption }] }
    }
    const wanted = draw.animation
    const animation = animations.find(candidate => candidate.name === wanted)
      ?? animations.find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase())
    if (animation === undefined) throw animationNotFound(request.path, wanted, animations)
    const timed = retimed(animation, draw.fps)
    const chosen = sampledFrames(timed.frames, draw.frames ?? DEFAULT_SPRITE_FRAMES)
    const tiles = []
    for (const { frame, index } of chosen) {
      const picture = await framePicture(frame, request.path, own.picture, frames?.bitmaps, pictures)
      tiles.push(pictureTile(picture, frame.region, `${index} · ${Math.round(frame.durationMs)} ms`))
    }
    const first = chosen[0]?.frame
    const firstSize = first === undefined
      ? undefined
      : first.region ?? await framePicture(first, request.path, own.picture, frames?.bitmaps, pictures)
    const aspect = firstSize === undefined ? 1 : firstSize.width / Math.max(1, firstSize.height)
    const sheet = drawSheet(tiles, aspect, bounds)
    const detail = animationDetails(timed, imageSize)
    const caption = `${chosen.length === timed.frames.length ? `all ${chosen.length}` : `${chosen.length} of ${timed.frames.length}`} frames of ${timed.name} in order, each labeled with its index and duration (${detail.fps} fps)`
    return { details, images: [{ data: await encodeCanvas(sheet, 'image/png'), mediaType: 'image/png', width: sheet.width, height: sheet.height, caption }] }
  } finally {
    own.close()
    if (frames !== undefined) closeFrames(frames)
    await pictures.close()
  }
}

/** An animation at the request's frames per second, for sources without their own timing. */
function retimed(animation: SpriteAnimation, fps: number | undefined): SpriteAnimation {
  if (fps === undefined || (animation.source !== 'grid' && animation.source !== 'sequence')) return animation
  return { ...animation, frames: animation.frames.map(frame => ({ ...frame, durationMs: 1000 / fps })) }
}

async function framePicture(
  frame: SpriteFrame,
  path: string,
  own: Picture,
  ownFrames: ReadonlyMap<number, ImageBitmap> | undefined,
  pictures: FramePictures,
): Promise<Picture> {
  if (frame.index !== undefined) {
    const bitmap = ownFrames?.get(frame.index)
    if (bitmap !== undefined) return { source: bitmap, width: bitmap.width, height: bitmap.height }
    return own
  }
  if (frame.path === path) return own
  return (await pictures.of(frame.path)).picture
}

/**
 * Answer one render request.
 * @param request - the asset and what to draw.
 * @param sources - reads and loads bound to the calling Session.
 * @param signal - the request's cancellation.
 * @returns the details, fitted to the request's limits, and pictures.
 * @throws {AssetDrawError} for a failure the agent reads.
 */
export async function answerRender(
  request: AssetRenderRequest,
  sources: AgentRenderSources,
  signal: AbortSignal,
): Promise<AssetRenderResult> {
  // A request cancelled while it waited behind another draws nothing.
  signal.throwIfAborted()
  const format = formatOf(request.path)
  if (format === undefined) throw new AssetDrawError(`${request.path} is not an asset the viewer reads.`, 'ASSET_FORMAT')
  const answer = format.kind === 'model'
    ? await answerModel(request, format, sources, signal)
    : await answerImage(request, format, sources, signal)
  return { ...answer, details: fitDetails(answer.details, request.limits) }
}

/**
 * Whether this window can draw 3D pictures.
 * @returns true when a WebGL context can be created.
 */
export function canDrawModels(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    const lose = context?.getExtension('WEBGL_lose_context')
    lose?.loseContext()
    return context !== null
  } catch {
    // SecurityError or an unsupported context: this window draws no 3D pictures.
    return false
  }
}
