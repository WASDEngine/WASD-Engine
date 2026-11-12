/**
 * This window's answer to an agent's `game-assets/render` request: it reads the asset from the calling Session's
 * workspace, measures its details as the Assets tab shows them, and draws the pictures the request asks for. An image
 * is drawn on a checkerboard, enlarged without smoothing when small, with a sprite sheet grid when asked, or as a sheet
 * of an animation's frames; a model is drawn with three.js off screen, one tile per view or pose. Pictures are PNG for
 * 2D art and JPEG for 3D scenes, within the request's bounds. An image whose header states more pixels than the
 * window decodes is refused before it is decoded; a picture holds no full-size copy of an image, and an animation's
 * own frames decode one at a time, only those its sheet shows, at the size of their tile. A failure rejects with a
 * message for the agent.
 */
import type {
  AssetDrawOptions, AssetRenderedImage, AssetRenderRequest, AssetRenderResult, ImageAssetDetails, SpriteAnimationDetails,
} from '@deepseek-ai/dsh-game-assets/types'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { findAnimations, type AnimationSources } from './animations2d.ts'
import { fitDetails, shortened } from './answer.ts'
import { formatOf, type AssetFormat } from './formats.ts'
import { OwnFrames } from './frames.ts'
import { imageSize } from './image-size.ts'
import { checkedImageSize, DECODED_BYTES_PER_PIXEL, decodePicture, ImageTooLargeError, pixelFacts, type Decoded } from './picture.ts'
import type { AssetFile } from './read.ts'
import { drawImagePicture, drawSheet, encodeCanvas, pictureTile, sheetLayout, type Picture, type PictureBounds } from './render2d.ts'
import { animationDetails, DEFAULT_FPS, gridAnimation, sampledFrames, type SpriteAnimation, type SpriteFrame } from './sprites.ts'

type ViewerModule = typeof import('./viewer/index.ts')

/** The first bytes of an image read to size it before its draw waits for its turn; enough for the headers of nearly every file. */
export const HEAD_BYTES = 256 * 1024

/** The window's caps on what one draw decodes. */
export interface AgentDrawLimits {
  /** Most pixels of an image the window decodes, as its header states them. */
  readonly maxDecodedPixels: number
}

/** Frames a 3D clip shows when the request names none. */
export const DEFAULT_CLIP_FRAMES = 6

/** Frames a 2D animation shows at most when the request names none. */
export const DEFAULT_SPRITE_FRAMES = 16

/** How long a model's textures may take to load before it is drawn without the late ones. */
const TEXTURE_WAIT_MS = 20_000

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
  /**
   * Read the first bytes of a workspace file.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns up to {@link HEAD_BYTES} bytes, or undefined when the file cannot be read.
   */
  readonly readHead: (path: string, signal: AbortSignal) => Promise<Uint8Array | undefined>
  /** The reads that find an image's animations. */
  readonly animations: AnimationSources
  /**
   * The URL of a file that a model names, inside the project.
   * @param base - absolute path of the model file.
   * @param path - the model's workspace path, which places the project folder in `base`.
   * @param reference - the name as the model stores it.
   * @returns the URL, or undefined for a file the viewer does not load.
   */
  readonly relatedUrl: (base: string, path: string, reference: string) => string | undefined
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

/**
 * The memory a draw takes while it decodes its asset, which the window's queue counts: the file, and for an image the
 * pixels its header states at what its decoder takes for each.
 * @param request - the request.
 * @param sources - the reads of the calling Session.
 * @param signal - cancellation.
 * @returns the bytes.
 */
export async function drawWeight(request: AssetRenderRequest, sources: AgentRenderSources, signal: AbortSignal): Promise<number> {
  const format = formatOf(request.path)
  if (format?.kind !== 'image') return request.bytes
  const head = await sources.readHead(request.path, signal)
  const size = head === undefined ? undefined : imageSize(head, format)
  return request.bytes + (size === undefined ? 0 : size.width * size.height * DECODED_BYTES_PER_PIXEL[format.decoder])
}

/**
 * Check an image's header against the window's caps, before any of its pixels are decoded.
 * @param path - the image, as the agent names it.
 * @param data - the file.
 * @param format - its format.
 * @param request - the request, whose limits bound the size the details can give.
 * @param limits - the window's caps.
 * @throws {AssetDrawError} `ASSET_TOO_LARGE` for an image with more pixels than the window decodes, or a side longer
 * than the details can give.
 */
function checkImage(path: string, data: Uint8Array, format: AssetFormat, request: AssetRenderRequest, limits: AgentDrawLimits): void {
  try {
    const size = checkedImageSize(data, format, limits.maxDecodedPixels)
    if (size !== undefined) checkEdges(path, size, request)
  } catch (error) {
    if (!(error instanceof ImageTooLargeError)) throw error
    throw new AssetDrawError(`${path} is ${error.size.width} × ${error.size.height} pixels, more than the ${error.limit} pixels this window decodes for one image.`, 'ASSET_TOO_LARGE')
  }
}

/**
 * Refuse an image whose size the details cannot give.
 * @throws {AssetDrawError} `ASSET_TOO_LARGE` for a side longer than the request's `edge`.
 */
function checkEdges(path: string, size: { readonly width: number; readonly height: number }, request: AssetRenderRequest): void {
  if (size.width <= request.limits.edge && size.height <= request.limits.edge) return
  throw new AssetDrawError(`${path} is ${size.width} × ${size.height} pixels; the viewer draws images up to ${request.limits.edge} pixels wide and tall.`, 'ASSET_TOO_LARGE')
}

/**
 * Decode an image, or fail for the agent.
 * @throws {AssetDrawError} `ASSET_UNREADABLE` when the file does not decode.
 */
async function decodeOrFail(data: Uint8Array<ArrayBuffer>, format: AssetFormat, viewer: () => Promise<ViewerModule>): Promise<Decoded> {
  try {
    return await decodePicture(data, format, viewer)
  } catch {
    // Error: the decoder's own message names nothing the agent can act on.
    throw new AssetDrawError(`The ${format.label} file could not be decoded: it may be damaged or use a feature the viewer does not support.`, 'ASSET_UNREADABLE')
  }
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
 * A caption that names a clip or an animation, with the name shortened so that the caption fits the request's limit,
 * which the Host checks.
 * @param name - the clip's or animation's name.
 * @param limit - most characters of a caption.
 * @param build - the caption around a name.
 * @returns the caption, at most `limit` characters long.
 */
export function namingCaption(name: string, limit: number, build: (name: string) => string): string {
  const room = limit - build('').length
  return shortened(build(name.length <= room ? name : shortened(name, Math.max(1, room))), limit)
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
      related: reference => sources.relatedUrl(file.absolutePath, request.path, reference),
      changed: () => {},
      maxBytes: request.maxBytes,
    }, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof viewer.ModelTooLargeError) {
      throw new AssetDrawError(`${request.path} asks for ${fileSizeText(error.bytes)} of geometry, more than the ${fileSizeText(error.limit)} the viewer sets aside for one model.`, 'ASSET_TOO_LARGE')
    }
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
    const limit = request.limits.caption
    const caption = clipName === undefined
      ? shortened(`${viewNames} ${shading}${draw.skeleton ? ' with the skeleton' : ''}`, limit)
      : times !== undefined && times.length === 1 && draw.time !== undefined
        ? namingCaption(clipName, limit, name => `${viewNames} ${shading}, posed at ${seconds(times[0] ?? 0)} of ${name}${draw.skeleton ? ', with the skeleton' : ''}`)
        : namingCaption(clipName, limit, name => `${times?.length ?? 0} poses of ${name} across its ${seconds(duration)}, ${viewNames} ${shading}${draw.skeleton ? ', with the skeleton' : ''}`)
    const image: AssetRenderedImage = { data: await encodeCanvas(sheet, 'image/jpeg'), mediaType: 'image/jpeg', width: sheet.width, height: sheet.height, caption }
    return { details, images: [image] }
  } finally {
    model.dispose()
  }
}

/** Decoded pictures of the other images an animation's frames show, read and checked once each. */
class FramePictures {
  private readonly decoded = new Map<string, Promise<Decoded>>()

  constructor(
    private readonly sources: AgentRenderSources,
    private readonly request: AssetRenderRequest,
    private readonly limits: AgentDrawLimits,
    private readonly signal: AbortSignal,
  ) {}

  of(path: string): Promise<Decoded> {
    let known = this.decoded.get(path)
    if (known === undefined) {
      known = (async () => {
        const format = formatOf(path)
        if (format?.kind !== 'image') throw new AssetDrawError(`${path} is not an image.`, 'ASSET_FORMAT')
        const file = await readOrFail(this.sources, path, this.request.maxBytes, this.signal)
        checkImage(path, file.data, format, this.request, this.limits)
        return await decodeOrFail(file.data, format, this.sources.viewer)
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
  limits: AgentDrawLimits,
  signal: AbortSignal,
): Promise<AssetRenderResult> {
  if (format.kind !== 'image') throw new AssetDrawError(`${request.path} is not an image.`, 'ASSET_FORMAT')
  const file = await readOrFail(sources, request.path, request.maxBytes, signal)
  checkImage(request.path, file.data, format, request, limits)
  const own = await decodeOrFail(file.data, format, sources.viewer)
  const pictures = new FramePictures(sources, request, limits, signal)
  // The own frames that the sheet shows, each decoded at the size of its tile.
  const drawn: ImageBitmap[] = []
  let frames: OwnFrames | undefined
  try {
    const size = { width: own.picture.width, height: own.picture.height }
    // An image without a header size, such as an SVG, is checked once decoded.
    checkEdges(request.path, size, request)
    frames = format.mediaType === undefined ? undefined : await OwnFrames.open(file.data, format.mediaType, signal)
    const draw: AssetDrawOptions = request.draw
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
      // Drawn from the decoded image straight into a picture of the requested size.
      const { canvas, scale } = drawImagePicture(own.picture, bounds, draw.region, draw.grid)
      const part = draw.region === undefined ? 'the image' : `pixels (${draw.region.x}, ${draw.region.y}) to (${draw.region.x + draw.region.width}, ${draw.region.y + draw.region.height})`
      const caption = shortened(`${part} at ${scale >= 1 ? `${scale}×` : `${Math.round(scale * 100)}%`} on a checkerboard that shows transparency${draw.grid === undefined ? '' : `, with the ${draw.grid.columns} × ${draw.grid.rows} grid and each cell's number`}`, request.limits.caption)
      return { details, images: [{ data: await encodeCanvas(canvas, 'image/png'), mediaType: 'image/png', width: canvas.width, height: canvas.height, caption }] }
    }
    const wanted = draw.animation
    const animation = animations.find(candidate => candidate.name === wanted)
      ?? animations.find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase())
    if (animation === undefined) throw animationNotFound(request.path, wanted, animations)
    const timed = retimed(animation, draw.fps)
    const chosen = sampledFrames(timed.frames, draw.frames ?? DEFAULT_SPRITE_FRAMES)
    // An own frame has the image's size; a frame of another image, that image's.
    const sizeOf = async (frame: SpriteFrame): Promise<{ readonly width: number; readonly height: number }> =>
      frame.region ?? (frame.index !== undefined || frame.path === request.path ? size : (await pictures.of(frame.path)).picture)
    const first = chosen[0]?.frame
    const firstSize = first === undefined ? undefined : await sizeOf(first)
    const aspect = firstSize === undefined ? 1 : firstSize.width / Math.max(1, firstSize.height)
    const layout = sheetLayout(chosen.length, aspect, bounds)
    const tiles = []
    for (const { frame, index } of chosen) {
      const picture = await framePicture(frame, request.path, own.picture, size, frames, pictures, layout, drawn)
      tiles.push(pictureTile(picture, frame.region, `${index} · ${Math.round(frame.durationMs)} ms`))
    }
    const sheet = drawSheet(tiles, aspect, bounds)
    const detail = animationDetails(timed, imageSize)
    const counted = chosen.length === timed.frames.length ? `all ${chosen.length}` : `${chosen.length} of ${timed.frames.length}`
    const caption = namingCaption(timed.name, request.limits.caption, name => `${counted} frames of ${name} in order, each labeled with its index and duration (${detail.fps} fps)`)
    return { details, images: [{ data: await encodeCanvas(sheet, 'image/png'), mediaType: 'image/png', width: sheet.width, height: sheet.height, caption }] }
  } finally {
    own.close()
    for (const bitmap of drawn) bitmap.close()
    frames?.close()
    await pictures.close()
  }
}

/** An animation at the request's frames per second, for sources without their own timing. */
function retimed(animation: SpriteAnimation, fps: number | undefined): SpriteAnimation {
  if (fps === undefined || (animation.source !== 'grid' && animation.source !== 'sequence')) return animation
  return { ...animation, frames: animation.frames.map(frame => ({ ...frame, durationMs: 1000 / fps })) }
}

/**
 * The picture one frame of a sheet shows. One of the image's own frames is decoded now, at most the size of its tile,
 * and kept in `drawn` until the sheet is drawn; never the first frame in its place.
 * @throws {AssetDrawError} `ASSET_UNREADABLE` when an own frame does not decode.
 */
async function framePicture(
  frame: SpriteFrame,
  path: string,
  own: Picture,
  size: { readonly width: number; readonly height: number },
  ownFrames: OwnFrames | undefined,
  pictures: FramePictures,
  layout: { readonly tileWidth: number; readonly tileHeight: number },
  drawn: ImageBitmap[],
): Promise<Picture> {
  if (frame.index !== undefined) {
    const fit = Math.min(1, layout.tileWidth / size.width, layout.tileHeight / size.height)
    let bitmap: ImageBitmap
    try {
      if (ownFrames === undefined) throw new Error('no frames')
      bitmap = await ownFrames.bitmap(frame.index, fit < 1 ? { width: size.width * fit, height: size.height * fit } : undefined)
    } catch {
      // EncodingError or a closed decoder: the frame cannot be shown, and no other frame is shown in its place.
      throw new AssetDrawError(`Frame ${frame.index} of ${path} could not be decoded.`, 'ASSET_UNREADABLE')
    }
    drawn.push(bitmap)
    return { source: bitmap, width: bitmap.width, height: bitmap.height }
  }
  if (frame.path === path) return own
  return (await pictures.of(frame.path)).picture
}

/**
 * Answer one render request.
 * @param request - the asset and what to draw.
 * @param sources - reads and loads bound to the calling Session.
 * @param limits - the window's caps on what one draw decodes.
 * @param signal - the request's cancellation.
 * @returns the details, fitted to the request's limits, and pictures.
 * @throws {AssetDrawError} for a failure the agent reads.
 */
export async function answerRender(
  request: AssetRenderRequest,
  sources: AgentRenderSources,
  limits: AgentDrawLimits,
  signal: AbortSignal,
): Promise<AssetRenderResult> {
  // A request cancelled while it waited behind another draws nothing.
  signal.throwIfAborted()
  const format = formatOf(request.path)
  if (format === undefined) throw new AssetDrawError(`${request.path} is not an asset the viewer reads.`, 'ASSET_FORMAT')
  const answer = format.kind === 'model'
    ? await answerModel(request, format, sources, signal)
    : await answerImage(request, format, sources, limits, signal)
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
