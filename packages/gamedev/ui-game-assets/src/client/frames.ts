/**
 * The frames of an animated image (GIF, WebP, PNG, or AVIF), decoded by the browser's `ImageDecoder`. A browser
 * without it, or an image with one frame, has no frames to play.
 */

/** Most frames read from one image. */
export const MAX_OWN_FRAMES = 512

/** Most pixels of all frames kept at once, about 256 MiB of bitmaps. */
const MAX_KEPT_PIXELS = 64 * 1024 * 1024

/** Media types whose files may hold more than one frame. */
const ANIMATED_TYPES: ReadonlySet<string> = new Set(['image/gif', 'image/webp', 'image/png', 'image/apng', 'image/avif'])

/** An animated image's frames. */
export interface OwnFrames {
  /** Each frame's duration in milliseconds. */
  readonly durationsMs: readonly number[]
  /** The kept frames' bitmaps by frame index; the caller closes them with {@link closeFrames}. */
  readonly bitmaps: ReadonlyMap<number, ImageBitmap>
}

/**
 * Release the bitmaps of decoded frames.
 * @param frames - the frames.
 */
export function closeFrames(frames: OwnFrames): void {
  for (const bitmap of frames.bitmaps.values()) bitmap.close()
}

/**
 * Decode the frames of an animated image.
 * @param data - the file.
 * @param mediaType - its media type.
 * @param keep - which frames to keep as bitmaps; every frame by default, within the memory cap.
 * @param signal - cancellation.
 * @returns the frames, or undefined when the browser cannot decode them or the image has one frame.
 */
export async function decodeOwnFrames(
  data: Uint8Array<ArrayBuffer>,
  mediaType: string,
  keep: (index: number) => boolean = () => true,
  signal?: AbortSignal,
): Promise<OwnFrames | undefined> {
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
  const bitmaps = new Map<number, ImageBitmap>()
  try {
    await decoder.completed
    const track = decoder.tracks.selectedTrack
    if (track === null || !track.animated || track.frameCount < 2) return undefined
    const count = Math.min(track.frameCount, MAX_OWN_FRAMES)
    const durationsMs: number[] = []
    let kept = 0
    for (let index = 0; index < count; index += 1) {
      signal?.throwIfAborted()
      const { image } = await decoder.decode({ frameIndex: index })
      try {
        durationsMs.push(image.duration === null ? 100 : Math.max(10, image.duration / 1000))
        const pixels = image.displayWidth * image.displayHeight
        if (keep(index) && kept + pixels <= MAX_KEPT_PIXELS) {
          bitmaps.set(index, await createImageBitmap(image))
          kept += pixels
        }
      } finally {
        image.close()
      }
    }
    return { durationsMs, bitmaps }
  } catch (error) {
    for (const bitmap of bitmaps.values()) bitmap.close()
    if (signal?.aborted === true) throw error
    // EncodingError or RangeError: an image the decoder cannot step through shows its first frame only.
    return undefined
  } finally {
    decoder.close()
  }
}
