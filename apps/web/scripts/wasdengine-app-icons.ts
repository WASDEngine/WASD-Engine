/**
 * Render the WASDEngine install icons of the Web application (fork-owned;
 * `wasdengine/FORK.md` lists the fork changes).
 *
 * The icons draw the keycap glyph of the Desktop icon source
 * (`apps/desktop/wasdengine/icon-windows.svg`) on that source's tile color.
 * Every variant fills its whole square with the tile, without the Desktop
 * icon's rounded corners, rim, and drop shadow, because a launcher masks the
 * icon itself; the maskable variant also scales the glyph about the tile centre
 * into the safe zone a platform mask may crop. The variants, their output
 * directory, and the maskable scale are those of the upstream generator,
 * `render-app-icons.ts`.
 *
 * The committed PNGs under `public/` are the output; rerun
 * `pnpm exec tsx scripts/wasdengine-app-icons.ts` in `apps/web` after changing
 * the icon source.
 * @module wasdengine-app-icons
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_ARTWORK_SCALE } from './render-app-icons.ts'
import type { AppIconVariant } from './render-app-icons.ts'

/** Desktop icon source whose tile color and keycap glyph the install icons draw. */
export const WASDENGINE_TILE_SOURCE = fileURLToPath(new URL('../../desktop/wasdengine/icon-windows.svg', import.meta.url))

/** The source's tile frame: a 1024-unit square at (40, 32), which a placement group maps onto the Desktop canvas. */
const TILE = { x: 40, y: 32, edge: 1024 } as const

/** Root element of the source document, rewritten to crop the canvas to the tile frame. */
const SOURCE_ROOT = /^<svg[^>]*>/u

/** The group placing the tile frame on the Desktop canvas; an install icon is the frame itself. */
const TILE_PLACEMENT = /<g transform="[^"]*translate\(-40 -32\)">/u

/** The Desktop tile with its rounded corners and drop shadow. */
const DESKTOP_TILE = /<g filter="url\(#tile-shadow\)">[\s\S]*?<\/g>/u

/** The paint of the Desktop tile's rounded square, which the install tile fills edge to edge with. */
const TILE_FILL = /<g filter="url\(#tile-shadow\)">\s*<rect [^>]*fill="([^"]+)"/u

/** The keycap glyph group; the only element a maskable icon scales. */
const GLYPH_GROUP = '<g id="tray-glyph"'

/** Samples per output pixel along each axis before reduction. */
const RENDER_SCALE = 4

/** Density at which the source's own 1:1 scale renders. */
const SOURCE_DENSITY = 72

/** Rewrite the source so the icon canvas is exactly the tile frame, filled edge to edge by the tile paint. */
function reframe(source: string): string {
  const trimmed = source.trim()
  const root = SOURCE_ROOT.exec(trimmed)
  if (root === null) throw new Error('wasdengine app icons: the icon source has no root element')
  if (!TILE_PLACEMENT.test(trimmed)) throw new Error('wasdengine app icons: the icon source has no tile placement group')
  if (!DESKTOP_TILE.test(trimmed)) throw new Error('wasdengine app icons: the icon source has no shadowed tile group')
  if (!trimmed.includes(GLYPH_GROUP)) throw new Error('wasdengine app icons: the icon source has no tray-glyph group')
  const fill = TILE_FILL.exec(trimmed)?.[1]
  if (fill === undefined) throw new Error('wasdengine app icons: the icon source tile has no fill')
  const square = `<rect x="${String(TILE.x)}" y="${String(TILE.y)}" width="${String(TILE.edge)}" height="${String(TILE.edge)}" fill="${fill}"/>`
  return `<svg width="${String(TILE.edge)}" height="${String(TILE.edge)}"`
    + ` viewBox="${String(TILE.x)} ${String(TILE.y)} ${String(TILE.edge)} ${String(TILE.edge)}" fill="none" xmlns="http://www.w3.org/2000/svg">`
    + trimmed.slice(root[0].length).replace(TILE_PLACEMENT, '<g>').replace(DESKTOP_TILE, square)
}

/**
 * Rewrite the icon source into the install tile.
 * @param source - complete `icon-windows.svg` document.
 * @returns an SVG document whose 1024-unit square is the tile paint with the keycap glyph.
 */
export function wasdengineTileDocument(source: string): string {
  return reframe(source)
}

/**
 * Rewrite the icon source into a maskable install icon: the tile keeps its full extent, and only
 * the keycap glyph scales about the tile centre.
 * @param source - complete `icon-windows.svg` document.
 * @returns an SVG document whose glyph survives a circular platform mask whole.
 */
export function wasdengineMaskableDocument(source: string): string {
  const x = TILE.x + TILE.edge / 2
  const y = TILE.y + TILE.edge / 2
  return reframe(source).replace(GLYPH_GROUP,
    `${GLYPH_GROUP} transform="translate(${String(x)} ${String(y)}) scale(${String(MASKABLE_ARTWORK_SCALE)}) translate(${String(-x)} ${String(-y)})"`)
}

function documentForVariant(source: string, kind: AppIconVariant['kind']): string {
  switch (kind) {
    case 'tile': return wasdengineTileDocument(source)
    case 'maskable': return wasdengineMaskableDocument(source)
    default: return assertNever(kind)
  }
}

/** Rasterize one document at a supersampled density, then reduce it to the icon edge. */
async function renderPng(document: string, size: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const edge = Math.max(TILE.edge, size * RENDER_SCALE)
  const raster = await sharp(Buffer.from(document), { density: SOURCE_DENSITY * edge / TILE.edge }).png().toBuffer()
  return sharp(raster).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer()
}

/**
 * Render every install icon from the icon source.
 * @param source - complete `icon-windows.svg` document.
 * @returns one PNG per upstream `APP_ICON_VARIANTS` entry, in declaration order.
 */
export async function renderWasdengineAppIcons(source: string): Promise<readonly { variant: AppIconVariant; png: Buffer }[]> {
  return Promise.all(APP_ICON_VARIANTS.map(async variant => ({
    variant,
    png: await renderPng(documentForVariant(source, variant.kind), variant.size),
  })))
}

async function main(): Promise<void> {
  const icons = await renderWasdengineAppIcons(await readFile(WASDENGINE_TILE_SOURCE, 'utf8'))
  await Promise.all(icons.map(async ({ variant, png }) => {
    await writeFile(resolve(ICON_OUTPUT_DIRECTORY, variant.file), png)
  }))
  console.info(`wasdengine app icons: wrote ${icons.map(icon => icon.variant.file).join(', ')} to ${ICON_OUTPUT_DIRECTORY}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
