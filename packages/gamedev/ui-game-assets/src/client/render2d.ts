/**
 * The pictures an agent receives of 2D art and of a 3D sheet's tiles: an image on a checkerboard that shows its
 * transparency, small pixel art enlarged by a whole factor without smoothing, an optional grid drawn over a sprite
 * sheet with each cell's number, and sheets of labeled tiles; and the encoding of a canvas as base64 image bytes.
 * Every picture stays within a longest edge and an area.
 */
import type { AssetGrid, AssetRegion } from '@deepseek-ai/dsh-game-assets/types'
import { gridRegions } from './sprites.ts'

/** A picture to draw: a bitmap, an image element, or a canvas, with its size in pixels. */
export interface Picture {
  readonly source: CanvasImageSource
  readonly width: number
  readonly height: number
}

/** Bounds of one returned picture. */
export interface PictureBounds {
  /** Longest edge in pixels. */
  readonly size: number
  /** Largest area in pixels. */
  readonly maxPixels: number
}

/** Light and dark squares of the transparency checkerboard. */
const CHECKER = ['#d8d8d8', '#b8b8b8'] as const

/** Background of a sheet behind its tiles. */
const SHEET_BACKGROUND = '#1e2024'

/** Grid line color over a sprite sheet. */
const GRID_LINE = 'rgba(255, 64, 160, 0.9)'

/** Space between a sheet's tiles in pixels. */
const GAP = 4

/**
 * The scale that fits a picture within the bounds: a whole factor at or above 1, so pixels stay square.
 * @param width - picture width.
 * @param height - picture height.
 * @param bounds - longest edge and area.
 * @returns the scale.
 */
export function fitScale(width: number, height: number, bounds: PictureBounds): number {
  const edge = Math.min(bounds.size / Math.max(width, height), Math.sqrt(bounds.maxPixels / Math.max(1, width * height)))
  return edge >= 1 ? Math.floor(edge) : edge
}

function canvasOf(width: number, height: number): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('This window cannot draw 2D pictures.')
  return { canvas, context }
}

function checkerboard(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  const square = 8
  context.save()
  context.beginPath()
  context.rect(x, y, width, height)
  context.clip()
  for (let row = 0; row * square < height; row += 1) {
    for (let column = 0; column * square < width; column += 1) {
      context.fillStyle = CHECKER[(row + column) % 2] ?? CHECKER[0]
      context.fillRect(x + column * square, y + row * square, square, square)
    }
  }
  context.restore()
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, fontSize: number): void {
  context.save()
  context.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
  const padding = Math.round(fontSize * 0.35)
  const measured = Math.min(width, context.measureText(text).width + padding * 2)
  context.fillStyle = 'rgba(0, 0, 0, 0.62)'
  context.fillRect(x, y, measured, fontSize + padding * 2)
  context.fillStyle = '#ffffff'
  context.textBaseline = 'top'
  context.fillText(text, x + padding, y + padding, width - padding * 2)
  context.restore()
}

/**
 * Draw one image, or a region of it, on a checkerboard, with an optional sprite sheet grid and cell numbers.
 * @param picture - the image.
 * @param bounds - the returned picture's bounds.
 * @param region - the part to draw; all of it by default.
 * @param grid - a grid to draw over the image, in the image's pixels.
 * @returns the canvas and the scale it was drawn at.
 */
export function drawImagePicture(
  picture: Picture,
  bounds: PictureBounds,
  region?: AssetRegion,
  grid?: AssetGrid,
): { readonly canvas: HTMLCanvasElement; readonly scale: number } {
  const part = region === undefined
    ? { x: 0, y: 0, width: picture.width, height: picture.height }
    : {
      x: Math.min(region.x, picture.width - 1),
      y: Math.min(region.y, picture.height - 1),
      width: Math.max(1, Math.min(region.width, picture.width - Math.min(region.x, picture.width - 1))),
      height: Math.max(1, Math.min(region.height, picture.height - Math.min(region.y, picture.height - 1))),
    }
  const scale = fitScale(part.width, part.height, bounds)
  const { canvas, context } = canvasOf(part.width * scale, part.height * scale)
  checkerboard(context, 0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = scale < 1
  context.imageSmoothingQuality = 'high'
  context.drawImage(picture.source, part.x, part.y, part.width, part.height, 0, 0, canvas.width, canvas.height)
  if (grid !== undefined) {
    const cells = gridRegions(picture.width, picture.height, grid)
    const fontSize = Math.max(10, Math.min(16, Math.round((cells[0]?.width ?? 0) * scale / 4)))
    context.strokeStyle = GRID_LINE
    context.lineWidth = 1
    cells.forEach((cell, index) => {
      const x = (cell.x - part.x) * scale
      const y = (cell.y - part.y) * scale
      const width = cell.width * scale
      const height = cell.height * scale
      if (x + width < 0 || y + height < 0 || x > canvas.width || y > canvas.height) return
      context.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, Math.round(height) - 1)
      if (width >= 20 && height >= 16) label(context, String(index), x + 1, y + 1, width - 2, fontSize)
    })
  }
  return { canvas, scale }
}

/** One tile of a sheet. */
export interface SheetTile {
  /** Draw the tile's content into the given rectangle of the sheet. */
  readonly draw: (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void
  /** Text under the tile's top left corner. */
  readonly label: string
}

/** Where a sheet's tiles go. */
export interface SheetLayout {
  readonly columns: number
  readonly rows: number
  readonly tileWidth: number
  readonly tileHeight: number
  readonly width: number
  readonly height: number
}

/**
 * Lay tiles out in a grid close to square, within the bounds.
 * @param count - tiles.
 * @param aspect - each tile's width over its height.
 * @param bounds - the sheet's bounds.
 * @returns the layout.
 */
export function sheetLayout(count: number, aspect: number, bounds: PictureBounds): SheetLayout {
  const tiles = Math.max(1, count)
  let best: SheetLayout | undefined
  for (let columns = 1; columns <= tiles; columns += 1) {
    const rows = Math.ceil(tiles / columns)
    // The largest tile height that fits the longest edge and the area with the gaps between tiles.
    const byWidth = (bounds.size - GAP * (columns - 1)) / (columns * aspect)
    const byHeight = (bounds.size - GAP * (rows - 1)) / rows
    let tileHeight = Math.min(byWidth, byHeight)
    const area = (height: number): number => (columns * height * aspect + GAP * (columns - 1)) * (rows * height + GAP * (rows - 1))
    while (tileHeight > 1 && area(tileHeight) > bounds.maxPixels) tileHeight *= 0.97
    tileHeight = Math.floor(tileHeight)
    const tileWidth = Math.floor(tileHeight * aspect)
    if (tileWidth < 1 || tileHeight < 1) continue
    const layout = {
      columns, rows, tileWidth, tileHeight,
      width: columns * tileWidth + GAP * (columns - 1),
      height: rows * tileHeight + GAP * (rows - 1),
    }
    // The largest tiles win; between equal ones, the wider sheet, which reads left to right.
    if (best === undefined || layout.tileWidth * layout.tileHeight >= best.tileWidth * best.tileHeight) best = layout
  }
  return best ?? { columns: 1, rows: 1, tileWidth: 1, tileHeight: 1, width: 1, height: 1 }
}

/**
 * Draw tiles side by side, each labeled.
 * @param tiles - the tiles in reading order.
 * @param aspect - each tile's width over its height.
 * @param bounds - the sheet's bounds.
 * @returns the canvas.
 */
export function drawSheet(tiles: readonly SheetTile[], aspect: number, bounds: PictureBounds): HTMLCanvasElement {
  const layout = sheetLayout(tiles.length, aspect, bounds)
  const { canvas, context } = canvasOf(layout.width, layout.height)
  context.fillStyle = SHEET_BACKGROUND
  context.fillRect(0, 0, canvas.width, canvas.height)
  const fontSize = Math.max(11, Math.min(18, Math.round(layout.tileHeight / 14)))
  tiles.forEach((tile, index) => {
    const x = (index % layout.columns) * (layout.tileWidth + GAP)
    const y = Math.floor(index / layout.columns) * (layout.tileHeight + GAP)
    context.save()
    tile.draw(context, x, y, layout.tileWidth, layout.tileHeight)
    context.restore()
    if (tile.label !== '') label(context, tile.label, x, y, layout.tileWidth, fontSize)
  })
  return canvas
}

/**
 * A tile that shows a picture, or a region of it, fitted on a checkerboard; small pixel art is enlarged without
 * smoothing.
 * @param picture - the picture.
 * @param region - the part to show; all of it by default.
 * @param text - the tile's label.
 * @returns the tile.
 */
export function pictureTile(picture: Picture, region: AssetRegion | undefined, text: string): SheetTile {
  const part = region ?? { x: 0, y: 0, width: picture.width, height: picture.height }
  return {
    label: text,
    draw(context, x, y, width, height) {
      checkerboard(context, x, y, width, height)
      const scale = Math.min(width / part.width, height / part.height)
      const shown = scale >= 1 ? Math.floor(scale) : scale
      const drawnWidth = part.width * shown
      const drawnHeight = part.height * shown
      context.imageSmoothingEnabled = shown < 1
      context.imageSmoothingQuality = 'high'
      const left = Math.round(x + (width - drawnWidth) / 2)
      const top = Math.round(y + (height - drawnHeight) / 2)
      context.drawImage(picture.source, part.x, part.y, part.width, part.height, left, top, Math.round(drawnWidth), Math.round(drawnHeight))
    },
  }
}

/**
 * Encode a canvas as base64 image bytes.
 * @param canvas - the canvas.
 * @param mediaType - PNG for exact pixels, JPEG for rendered scenes.
 * @returns the base64 text.
 * @throws {Error} when the browser cannot encode the canvas.
 */
export async function encodeCanvas(canvas: HTMLCanvasElement, mediaType: 'image/png' | 'image/jpeg'): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, mediaType, 0.9) })
  if (blob === null) throw new Error('This window could not encode the picture.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(text)
}
