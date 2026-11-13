/**
 * The frames of an animated image (GIF, WebP, PNG, or AVIF), decoded by the browser's `ImageDecoder`. Opening the
 * image decodes each frame once for its duration and keeps none; a frame's picture is decoded again when it is drawn,
 * at the size it is drawn, so an animation of any length keeps only the frames its viewer holds. A browser without
 * `ImageDecoder`, or an image with one frame, has no frames to play.
 */

/** Most frames read from one image. */
export const MAX_OWN_FRAMES = 512

/** Media types whose files may hold more than one frame. */
const ANIMATED_TYPES: ReadonlySet<string> = new Set(['image/gif', 'image/webp', 'image/png', 'image/apng', 'image/avif'])

/** A size in pixels. */
interface Size {
  readonly width: number
  readonly height: number
}

/** An animated image's frames, decoded on demand until it is closed. */
export class OwnFrames {
  private closed = false

  /**
   * @param decoder - the open decoder of the image.
   * @param durationsMs - each frame's duration in milliseconds.
   */
  private constructor(private readonly decoder: ImageDecoder, readonly durationsMs: readonly number[]) {}

  /**
   * Open an animated image's frames: each is decoded once for its duration.
   * @param data - the file.
   * @param mediaType - its media type.
   * @param signal - cancellation.
   * @returns the frames, which the caller closes, or undefined when the browser cannot decode them or the image has
   * one frame.
   * @throws the signal's reason when it is cancelled.
   */
  static async open(data: Uint8Array<ArrayBuffer>, mediaType: string, signal?: AbortSignal): Promise<OwnFrames | undefined> {
    if (!ANIMATED_TYPES.has(mediaType) || typeof globalThis.ImageDecoder !== 'function') return undefined
    let supported = false
    try {
      supported = await ImageDecoder.isTypeSupported(mediaType)
    } catch {
      // TypeError: a browser that rejects the query decodes no frames.
      return undefined
    }
    if (!supported) return undefined
    const decoder = new ImageDecoder({ data, type: mediaType })
    let opened = false
    try {
      await decoder.completed
      const track = decoder.tracks.selectedTrack
      if (track === null || !track.animated || track.frameCount < 2) return undefined
      const count = Math.min(track.frameCount, MAX_OWN_FRAMES)
      const durationsMs: number[] = []
      for (let index = 0; index < count; index += 1) {
        signal?.throwIfAborted()
        const { image } = await decoder.decode({ frameIndex: index })
        try {
          durationsMs.push(image.duration === null ? 100 : Math.max(10, image.duration / 1000))
        } finally {
          image.close()
        }
      }
      opened = true
      return new OwnFrames(decoder, durationsMs)
    } catch (error) {
      if (signal?.aborted === true) throw error
      // EncodingError or RangeError: an image the decoder cannot step through shows its first frame only.
      return undefined
    } finally {
      if (!opened) decoder.close()
    }
  }

  /**
   * Decode one frame into a bitmap that the caller closes.
   * @param index - the frame, from 0.
   * @param size - the bitmap's size when it is not the frame's own; it is smoothed.
   * @returns the bitmap.
   * @throws {Error} when the frames are closed or the frame does not decode.
   */
  async bitmap(index: number, size?: Size): Promise<ImageBitmap> {
    if (this.closed) throw new Error('The image\'s frames are closed.')
    const { image } = await this.decoder.decode({ frameIndex: index })
    try {
      return await createImageBitmap(image, size === undefined
        ? {}
        : { resizeWidth: Math.max(1, Math.round(size.width)), resizeHeight: Math.max(1, Math.round(size.height)), resizeQuality: 'high' })
    } finally {
      image.close()
    }
  }

  /** Release the decoder; a decode still waiting rejects. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.decoder.close()
  }
}
