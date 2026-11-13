/**
 * The 2D view's animation state outside React: the shown image's picture and own frames, the animations found for it,
 * and the pictures its animations' frames show. The shown image decodes once, from the object URL its view's image
 * element shows, so both share one decoded image; a frame's picture, one of the image's own frames or another image of
 * the project, decodes when the view asks for it and is kept, the most recently shown first, within a memory budget,
 * so an animation of any length plays every frame. An image whose header states more pixels than the viewer decodes
 * decodes nothing. One instance serves one shown file and is closed with it, which releases every picture.
 */
import type { ImageAssetDetails } from '@deepseek-ai/dsh-game-assets/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { findAnimations, type AnimationSources } from './animations2d.ts'
import { formatOf, type AssetFormat } from './formats.ts'
import { OwnFrames } from './frames.ts'
import { imageSize, type PixelSize } from './image-size.ts'
import { checkedImageSize, decodePicture, ImageTooLargeError, pixelFacts, type Decoded } from './picture.ts'
import type { AssetFile } from './read.ts'
import type { Picture } from './render2d.ts'
import { animationDetails, type SpriteAnimation, type SpriteFrame } from './sprites.ts'

type ViewerModule = typeof import('./viewer/index.ts')

/** Most pixels of the frames' pictures one player keeps at once, about 256 MiB; a frame let go decodes again. */
const MAX_KEPT_PIXELS = 64 * 1024 * 1024

/** What the 2D view knows about the shown image once it is decoded and its animations are found. */
export interface SpriteState {
  readonly picture: Picture
  readonly animations: readonly SpriteAnimation[]
  readonly facts: Pick<ImageAssetDetails, 'transparency' | 'colors'>
}

/** Where the picture of one frame stands: ready to draw, still decoding, or not readable. */
export type FrameState =
  | { readonly kind: 'ready'; readonly picture: Picture }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }

const PENDING: FrameState = { kind: 'pending' }
const FAILED: FrameState = { kind: 'failed' }

/** The shown image's decoded pictures and animations. */
export class SpritePlayer {
  /** The object URL that the view's image element shows, for the browser's formats; revoked when the player closes. */
  readonly url: string | undefined
  /** The size the image's header states when it is more pixels than the viewer decodes; nothing is decoded then. */
  readonly tooLarge: PixelSize | undefined
  private own: Promise<Decoded> | undefined
  private ownPicture: Picture | undefined
  private ownFailed = false
  private frames: OwnFrames | undefined
  /** Decoded frame pictures by key, the least recently shown first. */
  private readonly kept = new Map<string, Decoded>()
  private keptPixels = 0
  private readonly loading = new Map<string, Promise<void>>()
  private readonly failed = new Set<string>()
  /** Ends the reads the player starts; a frame's read is not tied to the frame that asked for it. */
  private readonly lifetime = new AbortController()
  private closed = false

  /**
   * @param path - workspace path of the image.
   * @param format - its format.
   * @param data - its bytes.
   * @param read - reads another image of the workspace for frames that show it.
   * @param viewer - loads the viewer chunk for TGA, HDR, and EXR.
   * @param maxPixels - the most pixels the viewer decodes for one image.
   */
  constructor(
    private readonly path: string,
    private readonly format: AssetFormat,
    private readonly data: Uint8Array<ArrayBuffer>,
    private readonly read: (path: string, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>,
    private readonly viewer: () => Promise<ViewerModule>,
    private readonly maxPixels: number,
  ) {
    const stated = imageSize(data, format)
    this.tooLarge = stated !== undefined && stated.width * stated.height > maxPixels ? stated : undefined
    this.url = this.tooLarge === undefined && format.kind === 'image' && format.decoder === 'browser'
      ? URL.createObjectURL(new Blob([data], format.mediaType === undefined ? {} : { type: format.mediaType }))
      : undefined
  }

  /**
   * The shown image's picture, decoded once.
   * @returns the picture.
   * @throws {ImageTooLargeError} for an image larger than the viewer decodes, or {Error} when it does not decode.
   */
  async picture(): Promise<Picture> {
    if (this.tooLarge !== undefined) throw new ImageTooLargeError(this.tooLarge, this.maxPixels)
    this.own ??= decodePicture(this.data, this.format, this.viewer, this.url).then((decoded) => {
      if (this.closed) decoded.close()
      else this.ownPicture = decoded.picture
      return decoded
    }, (error: unknown) => {
      this.ownFailed = true
      throw error
    })
    return (await this.own).picture
  }

  /**
   * Decode the image, open its own frames, and find its animations.
   * @param sources - the reads that find animations; none when absent.
   * @param signal - cancellation.
   * @returns the state, or undefined when the player closed first.
   * @throws {Error} when the image is too large or does not decode.
   */
  async load(sources: AnimationSources | undefined, signal: AbortSignal): Promise<SpriteState | undefined> {
    const picture = await this.picture()
    if (this.isClosed()) return undefined
    if (this.format.kind === 'image' && this.format.mediaType !== undefined) {
      const frames = await OwnFrames.open(this.data, this.format.mediaType, signal)
      if (this.isClosed()) {
        frames?.close()
        return undefined
      }
      this.frames = frames
    }
    const size = { width: picture.width, height: picture.height }
    const animations = sources === undefined ? [] : await findAnimations(this.path, size, this.frames?.durationsMs, sources, signal)
    if (this.isClosed()) return undefined
    return { picture, animations, facts: pixelFacts(picture) }
  }

  /**
   * Where the picture a frame shows stands now. A ready picture counts as the most recently shown.
   * @param frame - the frame.
   * @returns the picture once decoded; pending until then; failed for one that cannot be read or decoded.
   */
  frame(frame: SpriteFrame): FrameState {
    const key = this.keyOf(frame)
    if (key === undefined) {
      if (this.ownPicture !== undefined) return { kind: 'ready', picture: this.ownPicture }
      return this.ownFailed || this.tooLarge !== undefined ? FAILED : PENDING
    }
    const kept = this.kept.get(key)
    if (kept === undefined) return this.failed.has(key) ? FAILED : PENDING
    this.kept.delete(key)
    this.kept.set(key, kept)
    return { kind: 'ready', picture: kept.picture }
  }

  /**
   * Decode the picture a frame shows, unless it is ready, failed, or decoding.
   * @param frame - the frame.
   * @returns settles once the frame is ready or failed; it never rejects.
   */
  async request(frame: SpriteFrame): Promise<void> {
    const key = this.keyOf(frame)
    if (key === undefined) {
      await this.picture().catch(() => {
        // Error: the shown image's failure is the view's to show; its frames show nothing.
      })
      return
    }
    if (this.closed || this.kept.has(key) || this.failed.has(key)) return
    let loading = this.loading.get(key)
    if (loading === undefined) {
      loading = this.decodeFrame(frame).then((decoded) => { this.keep(key, decoded) }, () => {
        // Error or a Remote failure: a frame that cannot be read or decoded shows nothing.
        if (!this.closed) this.failed.add(key)
      }).finally(() => { this.loading.delete(key) })
      this.loading.set(key, loading)
    }
    await loading
  }

  /**
   * The details of the image with its animations.
   * @param state - the loaded state.
   * @param animations - the animations to list, the found ones and the reader's grid.
   * @param bytes - file size.
   * @returns the details.
   */
  details(state: SpriteState, animations: readonly SpriteAnimation[], bytes: number): ImageAssetDetails {
    const size = { width: state.picture.width, height: state.picture.height }
    return {
      kind: 'image',
      format: this.format.label,
      bytes,
      width: size.width,
      height: size.height,
      ...state.facts,
      animations: animations.map(animation => animationDetails(animation, path => (path === this.path ? size : undefined))),
    }
  }

  /** @returns whether the player closed, also while one of its reads waited. */
  private isClosed(): boolean {
    return this.closed
  }

  /** Release every picture and the image's frames; later loads and decodes give nothing. */
  close(): void {
    this.closed = true
    this.lifetime.abort()
    void this.own?.then((decoded) => { decoded.close() }, () => {
      // Error: an image that did not decode holds nothing to release.
    })
    this.frames?.close()
    this.frames = undefined
    for (const decoded of this.kept.values()) decoded.close()
    this.kept.clear()
    this.keptPixels = 0
    if (this.url !== undefined) URL.revokeObjectURL(this.url)
  }

  /** The key of the picture a frame shows: its own frame's number, another image's path, or undefined for the image. */
  private keyOf(frame: SpriteFrame): string | undefined {
    if (frame.index !== undefined) return `\u0000${String(frame.index)}`
    return frame.path === this.path ? undefined : frame.path
  }

  /** Decode the picture of one of the image's own frames or of another image. */
  private async decodeFrame(frame: SpriteFrame): Promise<Decoded> {
    if (frame.index !== undefined) {
      if (this.frames === undefined) throw new Error('The image has no frames to decode.')
      const bitmap = await this.frames.bitmap(frame.index)
      return { picture: { source: bitmap, width: bitmap.width, height: bitmap.height }, close: () => { bitmap.close() } }
    }
    const format = formatOf(frame.path)
    if (format?.kind !== 'image') throw new Error(`${frame.path} is not an image.`)
    const result = await this.read(frame.path, this.lifetime.signal)
    if (!result.ok) throw result.error
    checkedImageSize(result.value.data, format, this.maxPixels)
    if (format.decoder === 'browser' && format.mediaType !== 'image/svg+xml') {
      // A bitmap, whose memory the budget counts and frees.
      const blob = new Blob([result.value.data], format.mediaType === undefined ? {} : { type: format.mediaType })
      const bitmap = await createImageBitmap(blob)
      return { picture: { source: bitmap, width: bitmap.width, height: bitmap.height }, close: () => { bitmap.close() } }
    }
    return await decodePicture(result.value.data, format, this.viewer)
  }

  /** Keep a decoded picture, letting the least recently shown go while the kept pixels exceed the budget. */
  private keep(key: string, decoded: Decoded): void {
    if (this.closed) {
      decoded.close()
      return
    }
    this.kept.set(key, decoded)
    this.keptPixels += decoded.picture.width * decoded.picture.height
    for (const [oldKey, old] of this.kept) {
      // The picture just decoded stays, whatever its size.
      if (this.keptPixels <= MAX_KEPT_PIXELS || oldKey === key) break
      this.kept.delete(oldKey)
      this.keptPixels -= old.picture.width * old.picture.height
      old.close()
    }
  }
}
