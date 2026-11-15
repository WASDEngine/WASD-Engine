/**
 * The pictures of the reference tools, drawn with sharp: what a downloaded image is, a fingerprint that finds the same
 * picture at another size or on another site, the numbered contact sheet of a search's images, the sheet of an
 * animated image's frames with their timing, and the copy of an image a caller's model receives. Each picture is decoded
 * at the size it is drawn at, inside sharp's pipeline, so no full-size copy of a large image is held in memory, and an
 * animation's frames are decoded in one pass within {@link MAX_ANIMATION_PIXELS}. A file sharp cannot decode is an
 * {@link UnreadableImage}. Small images, such as pixel art, are enlarged by whole multiples without smoothing, so their
 * pixels stay sharp. Labels are drawn from a built-in pixel font, so no system font is needed. Sharp loads at the first
 * call that reads an image.
 * @module @deepseek-ai/dsh-art-references/src/images
 */
import type sharp from 'sharp'
import type { Sharp } from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type { ModelImage, ReferenceImageFormat, ReferenceImageInfo } from './types.ts'

const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

/** Most pixels one frame of an image may decode to. */
const MAX_INPUT_PIXELS = 12_000 * 12_000

/**
 * Most pixels the plugin's frames sheets decode: the frames up to the last one a sheet draws, times the pixels of one
 * frame. The frames of a GIF or animated WebP decode one after another, so this bounds the work of one sheet to a few
 * seconds; a longer animation is drawn from its first frames that fit.
 */
export const MAX_ANIMATION_PIXELS = 256_000_000

/** Most pixels of decoded frames a frames sheet holds at once, about 64 MB as RGBA. */
const MAX_DECODED_FRAME_PIXELS = 16 * 1024 * 1024

/** Longest part of a decoder's message that an {@link UnreadableImage} quotes. */
const MAX_REASON = 160

/** A file sharp cannot read as a reference image; the message completes "<image> ...". */
export class UnreadableImage extends Error {
  override name = 'UnreadableImage'
}

/** One RGBA picture in memory. */
export interface RawPicture {
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Run sharp's work on an image file, reporting a failure as the file's.
 * @param work - the decoding work.
 * @returns the work's value.
 * @throws UnreadableImage when sharp fails, as it does on a damaged or cut-short file.
 */
async function decoding<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof UnreadableImage) throw error
    const first = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() ?? ''
    const reason = first.length > MAX_REASON ? `${first.slice(0, MAX_REASON - 1)}…` : first
    throw new UnreadableImage(`is a damaged image file that cannot be decoded${reason === '' ? '' : ` (${reason})`}.`, { cause: error })
  }
}

/**
 * Read what an image file is.
 * @param data - the file's bytes.
 * @returns its file type, its first frame's size, and its frames and their timing.
 * @throws UnreadableImage when the file is not a PNG, JPEG, WebP, GIF, or AVIF image sharp reads.
 */
export async function probeImage(data: Buffer): Promise<ReferenceImageInfo> {
  let meta
  try {
    meta = await requireSharp()(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch (error) {
    throw new UnreadableImage('is not an image file.', { cause: error })
  }
  const format: ReferenceImageFormat | undefined = meta.format === 'heif'
    ? meta.compression === 'av1' ? 'avif' : undefined
    : (['png', 'jpeg', 'webp', 'gif'] as const).find(known => known === meta.format)
  if (format === undefined) throw new UnreadableImage(`is a ${meta.format} file; references are PNG, JPEG, WebP, GIF, or AVIF images.`)
  const frames = format === 'gif' || format === 'webp' ? Math.max(1, meta.pages ?? 1) : 1
  const { width, height } = meta.autoOrient
  return {
    format, width, height, frames,
    delays: frames > 1 ? Array.from({ length: frames }, (_, index) => Math.max(20, meta.delay?.[index] ?? 100)) : [],
  }
}

/** The size a picture is drawn at. */
interface Fit {
  readonly width: number
  readonly height: number
  /** Whether the picture is enlarged by a whole multiple without smoothing. */
  readonly nearest: boolean
}

/**
 * The size a picture is drawn at in a box: a whole multiple of its size, enlarged without smoothing, when it fits at
 * least twice and may be enlarged; else its own size, or smaller to fit.
 * @param width - the picture's width.
 * @param height - the picture's height.
 * @param boxWidth - the box's width.
 * @param boxHeight - the box's height.
 * @param enlarge - whether a picture that fits at least twice is enlarged.
 * @returns the size, at most the box's.
 */
function fitInto(width: number, height: number, boxWidth: number, boxHeight: number, enlarge: boolean): Fit {
  const factor = enlarge ? Math.floor(Math.min(boxWidth / width, boxHeight / height)) : 1
  if (factor >= 2) return { width: width * factor, height: height * factor, nearest: true }
  const scale = Math.min(1, boxWidth / width, boxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), nearest: false }
}

/** An image's first frame decoded at the size it is drawn at, and the frame's own upright size. */
interface DrawnFrame {
  readonly picture: RawPicture
  readonly width: number
  readonly height: number
}

/**
 * Decode an image's first frame to RGBA, upright, at the size `size` chooses for it, resizing inside sharp's pipeline.
 * @param data - the file's bytes.
 * @param size - the size to draw a frame of the given upright size at.
 * @returns the picture and the frame's own size.
 * @throws UnreadableImage when the file cannot be decoded.
 */
async function decodeFirstFrame(data: Buffer, size: (width: number, height: number) => Fit): Promise<DrawnFrame> {
  return await decoding(async () => {
    const load = (): Sharp => requireSharp()(data, { limitInputPixels: MAX_INPUT_PIXELS, page: 0, pages: 1 })
    const { width, height } = (await load().metadata()).autoOrient
    const fit = size(width, height)
    const upright = load().autoOrient().ensureAlpha()
    const drawn = fit.width === width && fit.height === height
      ? upright
      : upright.resize(fit.width, fit.height, { fit: 'fill', ...fit.nearest ? { kernel: 'nearest' as const } : {} })
    const { data: pixels, info } = await drawn.raw().toBuffer({ resolveWithObject: true })
    return { picture: { data: pixels, width: info.width, height: info.height }, width, height }
  })
}

/**
 * A 64-bit difference hash of an image's first frame: equal or close hashes mark the same picture, even resized,
 * recompressed, or uploaded to another site.
 * @param data - the file's bytes.
 * @returns the hash.
 * @throws UnreadableImage when the file cannot be decoded.
 */
export async function fingerprint(data: Buffer): Promise<bigint> {
  const gray = await decoding(async () => {
    const { data: pixels } = await requireSharp()(data, { limitInputPixels: MAX_INPUT_PIXELS, page: 0, pages: 1 })
      .autoOrient().flatten({ background: '#808080' }).greyscale().resize(9, 8, { fit: 'fill' }).raw()
      .toBuffer({ resolveWithObject: true })
    return pixels
  })
  let hash = 0n
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      hash = (hash << 1n) | ((gray[row * 9 + column] as number) > (gray[row * 9 + column + 1] as number) ? 1n : 0n)
    }
  }
  return hash
}

/**
 * The number of bits two fingerprints differ in.
 * @param a - one fingerprint.
 * @param b - the other.
 * @returns 0 for the same picture, up to 64.
 */
export function fingerprintDistance(a: bigint, b: bigint): number {
  let rest = a ^ b
  let count = 0
  while (rest !== 0n) {
    rest &= rest - 1n
    count++
  }
  return count
}

/** Pixel font glyphs, 5 wide and 7 tall, `#` drawn. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#### ', '    #', '    #', ' ### ', '    #', '    #', '#### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': [' ### ', '#    ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '    #', ' ### '],
  'A': [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  'D': ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  'E': ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  'F': ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  'G': [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  'I': [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  'M': ['#   #', '## ##', '# # #', '#   #', '#   #', '#   #', '#   #'],
  'N': ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
  'O': [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  'S': [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  'V': ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
}

/**
 * Draw a label: white pixel-font text on a dark box.
 * @param text - digits and the letters of GIF, ANIM, VIDEO, and MS; other characters are skipped.
 * @param scale - size of one font pixel.
 * @returns the label.
 */
export function drawLabel(text: string, scale: number): RawPicture {
  // The glyphs are ASCII, so splitting into UTF-16 units loses nothing.
  const glyphs = text.toUpperCase().split('').flatMap(character => GLYPHS[character] === undefined ? [] : [GLYPHS[character]])
  const pad = 2 * scale
  const width = Math.max(1, glyphs.length * 6 - 1) * scale + 2 * pad
  const height = 7 * scale + 2 * pad
  const data = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 17
    data[offset + 1] = 17
    data[offset + 2] = 20
    data[offset + 3] = 224
  }
  glyphs.forEach((rows, index) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < 5; x++) {
        if (row[x] !== '#') continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const offset = ((pad + y * scale + dy) * width + pad + (index * 6 + x) * scale + dx) * 4
            data[offset] = 255
            data[offset + 1] = 255
            data[offset + 2] = 255
            data[offset + 3] = 255
          }
        }
      }
    })
  })
  return { data, width, height }
}

/**
 * A checkerboard that shows where an image is transparent.
 * @param width - its width.
 * @param height - its height.
 * @returns the checkerboard.
 */
function checkerboard(width: number, height: number): RawPicture {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shade = ((x >> 3) + (y >> 3)) % 2 === 0 ? 58 : 44
      const offset = (y * width + x) * 4
      data[offset] = shade
      data[offset + 1] = shade
      data[offset + 2] = shade
      data[offset + 3] = 255
    }
  }
  return { data, width, height }
}

/**
 * Enlarge a picture in memory by a whole multiple, without smoothing.
 * @param picture - the picture.
 * @param fit - the enlarged size.
 * @returns the enlarged picture, or the picture itself when `fit` keeps its size.
 */
async function enlarge(picture: RawPicture, fit: Fit): Promise<RawPicture> {
  if (fit.width === picture.width && fit.height === picture.height) return picture
  const { data, info } = await requireSharp()(picture.data, { raw: { width: picture.width, height: picture.height, channels: 4 } })
    .resize(fit.width, fit.height, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** One picture placed on a sheet. */
interface Placement {
  readonly picture: RawPicture
  readonly left: number
  readonly top: number
}

/**
 * Compose placed pictures on a solid background.
 * @param width - the sheet's width.
 * @param height - the sheet's height.
 * @param placements - pictures in drawing order.
 * @returns the composed sheet, not yet encoded.
 */
function compose(width: number, height: number, placements: readonly Placement[]): Sharp {
  return requireSharp()({ create: { width, height, channels: 4, background: { r: 24, g: 24, b: 27, alpha: 1 } } })
    .composite(placements.map(({ picture, left, top }) => ({
      input: picture.data, raw: { width: picture.width, height: picture.height, channels: 4 as const }, left, top,
    })))
}

/**
 * An image as a contact sheet draws it: its first frame fitted into one square cell, small pixel art enlarged by a
 * whole multiple without smoothing.
 * @param data - the file's bytes.
 * @param cell - side of the cell in pixels.
 * @returns the picture, at most `cell` pixels on each side.
 * @throws UnreadableImage when the file cannot be decoded.
 */
export async function sheetPicture(data: Buffer, cell: number): Promise<RawPicture> {
  return (await decodeFirstFrame(data, (width, height) => fitInto(width, height, cell, cell, true))).picture
}

/** One image on a contact sheet. */
export interface SheetEntry {
  /** The image as {@link sheetPicture} draws it for the sheet's cell. */
  readonly picture: RawPicture
  /** Its number on the sheet. */
  readonly number: number
  /** A second label, such as GIF 12 or VIDEO; empty for none. */
  readonly tag: string
}

/** Layout of a contact sheet. */
export interface SheetLayout {
  /** Side of each image's square, in pixels. */
  readonly cell: number
  /** Most images in one row. */
  readonly columns: number
}

/** A drawn sheet. */
export interface EncodedSheet {
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/** Pixels between cells and around the sheet. */
const GAP = 8

/**
 * Draw the numbered contact sheet of a search's images: each image centered in a square over a checkerboard, its
 * number in the top-left corner, and its tag, such as GIF 12, in the bottom-left corner.
 * @param entries - the images in number order, each drawn for the layout's cell; at least one.
 * @param layout - cell size and columns.
 * @returns the sheet as a JPEG file.
 */
export async function drawContactSheet(entries: readonly SheetEntry[], layout: SheetLayout): Promise<EncodedSheet> {
  const columns = Math.min(layout.columns, entries.length)
  const rows = Math.ceil(entries.length / columns)
  const width = GAP + columns * (layout.cell + GAP)
  const height = GAP + rows * (layout.cell + GAP)
  const board = checkerboard(layout.cell, layout.cell)
  const scale = Math.max(2, Math.round(layout.cell / 96))
  const placements: Placement[] = []
  for (const [index, entry] of entries.entries()) {
    const left = GAP + (index % columns) * (layout.cell + GAP)
    const top = GAP + Math.floor(index / columns) * (layout.cell + GAP)
    placements.push({ picture: board, left, top })
    placements.push({
      picture: entry.picture,
      left: left + Math.floor((layout.cell - entry.picture.width) / 2),
      top: top + Math.floor((layout.cell - entry.picture.height) / 2),
    })
    placements.push({ picture: drawLabel(String(entry.number), scale), left, top })
    if (entry.tag !== '') {
      const tag = drawLabel(entry.tag, Math.max(1, scale - 1))
      placements.push({ picture: tag, left, top: top + layout.cell - tag.height })
    }
  }
  const { data, info } = await compose(width, height, placements)
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Limits of a frames sheet. */
export interface FramesLayout {
  /** Most frames drawn; a longer animation is sampled evenly. */
  readonly maxFrames: number
  /** Longest side of the sheet, in pixels. */
  readonly maxEdge: number
  /**
   * Most pixels decoded for one sheet: the frames up to the last one drawn times the pixels of one frame; an animation
   * whose frames hold more is drawn from its first frames that fit. The plugin uses {@link MAX_ANIMATION_PIXELS}.
   */
  readonly maxPixels: number
}

/** A drawn frames sheet. */
export interface FramesSheet extends EncodedSheet {
  /** Frames of the animation the sheet samples: all of them, or the first ones that fit the layout's `maxPixels`. */
  readonly covered: number
}

/**
 * The frames a frames sheet draws: all of them, or an even sample with the first frame.
 * @param frames - frames of the animation.
 * @param maxFrames - most frames to draw.
 * @returns frame indexes in order.
 */
export function sampledFrames(frames: number, maxFrames: number): number[] {
  if (frames <= maxFrames) return Array.from({ length: frames }, (_, index) => index)
  return Array.from({ length: maxFrames }, (_, index) => Math.floor((index * frames) / maxFrames))
}

/**
 * Draw an animated image's frames in a grid, each labeled with its number from 1 and how long it shows, so a model
 * that sees still images can read the motion and its timing. The frames up to the last one drawn are decoded once, in
 * one pass that scales each down to its cell, within the layout's `maxPixels`.
 * @param data - the file's bytes.
 * @param info - what the file is; it has more than one frame.
 * @param layout - the frames and size limits.
 * @param signal - cancellation, checked before and after each step.
 * @returns the sheet as a PNG file, and the frames it samples.
 * @throws UnreadableImage when the file cannot be decoded; the signal's reason once it aborts.
 */
export async function drawFramesSheet(
  data: Buffer,
  info: ReferenceImageInfo,
  layout: FramesLayout,
  signal: AbortSignal,
): Promise<FramesSheet> {
  signal.throwIfAborted()
  // The frames as the file stores them; a GIF or animated WebP carries no orientation.
  const { width, height } = await decoding(async () => {
    const meta = await requireSharp()(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    return { width: meta.width, height: meta.pageHeight ?? meta.height }
  })
  const covered = Math.max(1, Math.min(info.frames, Math.floor(layout.maxPixels / (width * height))))
  const indexes = sampledFrames(covered, layout.maxFrames)
  const columns = Math.min(indexes.length, Math.max(1, Math.ceil(Math.sqrt(indexes.length * (height / width)))))
  const rows = Math.ceil(indexes.length / columns)
  const across = Math.floor((layout.maxEdge - GAP) / columns) - GAP
  const down = Math.floor((layout.maxEdge - GAP) / rows) - GAP
  const scaleToCell = Math.min(across / width, down / height)
  const cellWidth = Math.max(16, Math.floor(width * scaleToCell))
  const cellHeight = Math.max(16, Math.floor(height * scaleToCell))
  // Frames shrink to their cell as they decode; pixel art keeps its size and is enlarged once drawn.
  const fit = fitInto(width, height, cellWidth, cellHeight, true)
  const decoded = (indexes.at(-1) ?? 0) + 1
  let frameWidth = fit.nearest ? width : fit.width
  let frameHeight = fit.nearest ? height : fit.height
  const room = MAX_DECODED_FRAME_PIXELS / (decoded * frameWidth * frameHeight)
  if (room < 1) {
    frameWidth = Math.max(1, Math.floor(frameWidth * Math.sqrt(room)))
    frameHeight = Math.max(1, Math.floor(frameHeight * Math.sqrt(room)))
  }
  const strip = await decoding(async () => {
    const frames = requireSharp()(data, { limitInputPixels: Math.max(width * height, decoded * width * height), pages: decoded })
    const sized = frameWidth === width && frameHeight === height ? frames : frames.resize(frameWidth, frameHeight, { fit: 'fill' })
    return await sized.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  })
  signal.throwIfAborted()
  const frameBytes = frameWidth * frameHeight * 4
  const available = strip.info.width === frameWidth ? Math.floor(strip.data.length / frameBytes) : 0
  const drawn = indexes.filter(frame => frame < available)
  if (drawn.length === 0) throw new UnreadableImage('is a damaged image file: its frames cannot be decoded.')
  const scale = Math.max(1, Math.min(3, Math.round(Math.min(cellWidth, cellHeight) / 80)))
  const placements: Placement[] = []
  const board = checkerboard(cellWidth, cellHeight)
  for (const [slot, frame] of drawn.entries()) {
    const left = GAP + (slot % columns) * (cellWidth + GAP)
    const top = GAP + Math.floor(slot / columns) * (cellHeight + GAP)
    placements.push({ picture: board, left, top })
    const decodedFrame = { data: strip.data.subarray(frame * frameBytes, (frame + 1) * frameBytes), width: frameWidth, height: frameHeight }
    const picture = await enlarge(decodedFrame, fitInto(frameWidth, frameHeight, cellWidth, cellHeight, true))
    placements.push({
      picture,
      left: left + Math.floor((cellWidth - picture.width) / 2),
      top: top + Math.floor((cellHeight - picture.height) / 2),
    })
    placements.push({ picture: drawLabel(`${String(frame + 1)} ${String(info.delays[frame] ?? 100)}MS`, scale), left, top })
  }
  signal.throwIfAborted()
  const { data: encoded, info: out } = await compose(GAP + columns * (cellWidth + GAP), GAP + rows * (cellHeight + GAP), placements)
    .png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
  signal.throwIfAborted()
  return { data: encoded, width: out.width, height: out.height, covered }
}

/**
 * The copy of an image a caller's model receives: its first frame, upright, at most `maxEdge` pixels on its longest
 * side, and a small image enlarged by a whole multiple without smoothing to at least a quarter of that.
 * @param data - the file's bytes.
 * @param maxEdge - longest side in pixels.
 * @param name - the copy's file name, without its extension.
 * @returns PNG for an image with transparency or an enlarged one, JPEG otherwise.
 * @throws UnreadableImage when the file cannot be decoded.
 */
export async function modelCopy(data: Buffer, maxEdge: number, name: string): Promise<ModelImage> {
  const smallest = Math.floor(maxEdge / 4)
  const { picture, width } = await decodeFirstFrame(data, (frameWidth, frameHeight) => {
    const longest = Math.max(frameWidth, frameHeight)
    if (longest >= smallest) return fitInto(frameWidth, frameHeight, maxEdge, maxEdge, false)
    const enlarged = Math.min(maxEdge, longest * Math.ceil(smallest / longest))
    return fitInto(frameWidth, frameHeight, enlarged, enlarged, true)
  })
  const input = requireSharp()(picture.data, { raw: { width: picture.width, height: picture.height, channels: 4 } })
  if (picture.width <= width && !hasTransparency(picture)) {
    return { data: await input.flatten().jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mediaType: 'image/jpeg', name: `${name}.jpg` }
  }
  return { data: await input.png({ compressionLevel: 9 }).toBuffer(), mediaType: 'image/png', name: `${name}.png` }
}

/**
 * Whether any pixel of an RGBA picture is not fully opaque.
 * @param picture - the picture.
 * @returns true when it has transparency.
 */
function hasTransparency(picture: RawPicture): boolean {
  for (let offset = 3; offset < picture.data.length; offset += 4) if ((picture.data[offset] as number) < 255) return true
  return false
}
