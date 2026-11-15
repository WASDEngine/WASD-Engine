/**
 * Types of the art reference tools: the images a reference search finds, the files a save writes, and the images the
 * tools hand to their callers' models.
 * @module @deepseek-ai/dsh-art-references/types
 */

/** The file types a reference image may have, as sharp names them. */
export type ReferenceImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif'

/** What a downloaded image is: its file type, its first frame's pixel size, and its frames. */
export interface ReferenceImageInfo {
  readonly format: ReferenceImageFormat
  /** Width of one frame in pixels. */
  readonly width: number
  /** Height of one frame in pixels. */
  readonly height: number
  /** Frames of an animated GIF or WebP; 1 for a still image. */
  readonly frames: number
  /** How long each frame shows, in milliseconds, for an animated image; empty for a still image. */
  readonly delays: readonly number[]
}

/** One image a reference search found, numbered as the contact sheet shows it. */
export interface ReferenceCandidate extends ReferenceImageInfo {
  /** Number on the contact sheet, from 1. */
  readonly number: number
  /** Address of the image file. */
  readonly image: string
  /** Address of the page the image came from, or of the image itself when a search found the file. */
  readonly page: string
  /** Title of the page or the image; empty when it has none. */
  readonly title: string
  /** Host name of the page, such as itch.io. */
  readonly site: string
  /** Address of the video the page plays, when the image is that video's poster. */
  readonly video?: string
}

/** One image file a reference save wrote into the game project. */
export interface SavedReference extends ReferenceImageInfo {
  /** Absolute path of the file. */
  readonly path: string
  /** Path relative to the game project's folder, with `/` between folders. */
  readonly file: string
  /** Address of the image the file holds. */
  readonly image: string
  /** Address of the page the image came from. */
  readonly page: string
  /** Title of the page or the image; empty when it has none. */
  readonly title: string
  /** Address of the video the page plays, when the image is that video's poster. */
  readonly video?: string
  /** Path relative to the game project's folder of the sheet of an animated image's frames. */
  readonly framesFile?: string
  /** Set when the file was already in the folder, byte for byte, from an earlier save, and this save wrote nothing. */
  readonly savedEarlier?: true
}

/** An image a tool hands to its caller's model, encoded for sending. */
export interface ModelImage {
  readonly data: Buffer
  readonly mediaType: 'image/png' | 'image/jpeg'
  /** File name of the image, without folders. */
  readonly name: string
}
