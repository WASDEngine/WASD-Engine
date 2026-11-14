/**
 * Types of the image generation plugin: the shapes, sizes, and file types of Nano Banana 2.1's images, the images a
 * generation sends, and the image it returns.
 * @module @deepseek-ai/dsh-image-generation/src/types
 */

/** Nano Banana 2.1's image shapes, width to height. */
export type ImageAspectRatio = '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | '1:4' | '4:1' | '1:8' | '8:1'

/** Nano Banana 2.1's resolutions: about 1, 4, and 16 megapixels. */
export type ImageSize = '1K' | '2K' | '4K'

/** The file types the plugin sends and writes. */
export type ImageFormat = 'png' | 'jpeg' | 'webp'

/** One image a generation sends: a PNG, JPEG, or WebP file the WASD Engine API takes. */
export interface SentImage {
  readonly mimeType: `image/${ImageFormat}`
  readonly data: Buffer
  /** Width in pixels, upright. */
  readonly width: number
  /** Height in pixels, upright. */
  readonly height: number
}

/** One generated image, as the WASD Engine API returned it. */
export interface GeneratedImage {
  readonly data: Buffer
  readonly format: ImageFormat
  readonly width: number
  readonly height: number
}
