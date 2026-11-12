/**
 * The 2D view's animation state outside React: the image's decoded picture and own frames, the animations found for
 * it, the pictures of other images that frames show, read once each, and the measured details. One instance serves
 * one shown file and is closed with it, which releases every bitmap.
 */
import type { ImageAssetDetails } from '@deepseek-ai/dsh-game-assets/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { decodePicture, pixelFacts } from './agent.ts'
import { findAnimations, type AnimationSources } from './animations2d.ts'
import { formatOf, type AssetFormat } from './formats.ts'
import { closeFrames, decodeOwnFrames, type OwnFrames } from './frames.ts'
import type { AssetFile } from './read.ts'
import type { Picture } from './render2d.ts'
import { animationDetails, type SpriteAnimation, type SpriteFrame } from './sprites.ts'

type ViewerModule = typeof import('./viewer/index.ts')

/** What the 2D view knows about the shown image once it is decoded and its animations are found. */
export interface SpriteState {
  readonly picture: Picture
  readonly animations: readonly SpriteAnimation[]
  readonly facts: Pick<ImageAssetDetails, 'transparency' | 'colors'>
}

/** The shown image's decoded pictures and animations. */
export class SpritePlayer {
  private own: { readonly picture: Picture; readonly close: () => void } | undefined
  private frames: OwnFrames | undefined
  private readonly others = new Map<string, Promise<Picture | undefined>>()
  private readonly releases: (() => void)[] = []
  private closed = false

  /**
   * @param path - workspace path of the image.
   * @param format - its format.
   * @param read - reads another image of the workspace for frames that show it.
   * @param viewer - loads the viewer chunk for TGA, HDR, and EXR.
   */
  constructor(
    private readonly path: string,
    private readonly format: AssetFormat,
    private readonly read: (path: string, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>,
    private readonly viewer: () => Promise<ViewerModule>,
  ) {}

  /**
   * Decode the image and its own frames, and find its animations.
   * @param file - the image's bytes.
   * @param sources - the reads that find animations; none when absent.
   * @param signal - cancellation.
   * @returns the state, or undefined when the player closed first.
   * @throws {Error} when the image does not decode.
   */
  async load(file: AssetFile, sources: AnimationSources | undefined, signal: AbortSignal): Promise<SpriteState | undefined> {
    const own = await decodePicture(file.data, this.format, this.viewer)
    if (this.isClosed()) {
      own.close()
      return undefined
    }
    this.own = own
    if (this.format.kind === 'image' && this.format.mediaType !== undefined) {
      const frames = await decodeOwnFrames(file.data, this.format.mediaType, undefined, signal)
      if (this.isClosed()) {
        if (frames !== undefined) closeFrames(frames)
        return undefined
      }
      this.frames = frames
    }
    const size = { width: own.picture.width, height: own.picture.height }
    const animations = sources === undefined ? [] : await findAnimations(this.path, size, this.frames?.durationsMs, sources, signal)
    return { picture: own.picture, animations, facts: pixelFacts(own.picture) }
  }

  /**
   * The picture one frame shows.
   * @param frame - the frame.
   * @param signal - cancellation of a read it starts.
   * @returns the picture, or undefined while it cannot be read.
   */
  async picture(frame: SpriteFrame, signal: AbortSignal): Promise<Picture | undefined> {
    if (frame.index !== undefined) {
      const bitmap = this.frames?.bitmaps.get(frame.index)
      if (bitmap !== undefined) return { source: bitmap, width: bitmap.width, height: bitmap.height }
    }
    if (frame.path === this.path || frame.index !== undefined) return this.own?.picture
    let pending = this.others.get(frame.path)
    if (pending === undefined) {
      pending = (async () => {
        const format = formatOf(frame.path)
        if (format?.kind !== 'image') return undefined
        const result = await this.read(frame.path, signal)
        if (!result.ok) return undefined
        try {
          const decoded = await decodePicture(result.value.data, format, this.viewer)
          if (this.isClosed()) {
            decoded.close()
            return undefined
          }
          this.releases.push(decoded.close)
          return decoded.picture
        } catch {
          // AssetDrawError: a frame image that does not decode shows nothing.
          return undefined
        }
      })()
      this.others.set(frame.path, pending)
    }
    return await pending
  }

  /**
   * The picture a frame shows when it is ready now.
   * @param frame - the frame.
   * @returns the picture, or undefined until {@link picture} has read it.
   */
  ready(frame: SpriteFrame): Picture | undefined {
    if (frame.index !== undefined) {
      const bitmap = this.frames?.bitmaps.get(frame.index)
      return bitmap === undefined ? this.own?.picture : { source: bitmap, width: bitmap.width, height: bitmap.height }
    }
    return frame.path === this.path ? this.own?.picture : undefined
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

  /** Release every bitmap; later loads and reads return nothing. */
  close(): void {
    this.closed = true
    this.own?.close()
    this.own = undefined
    if (this.frames !== undefined) closeFrames(this.frames)
    this.frames = undefined
    for (const release of this.releases.splice(0)) release()
  }
}
