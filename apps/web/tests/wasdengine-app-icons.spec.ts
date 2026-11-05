/**
 * WASDEngine fork guard for the Web install icons: the keycap tile the fork renders from the Desktop
 * icon source, and the committed PNGs it produces. `wasdengine/FORK.md` runs this spec after every
 * upstream merge.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_ARTWORK_SCALE } from '../scripts/render-app-icons.ts'
import {
  WASDENGINE_TILE_SOURCE, renderWasdengineAppIcons, wasdengineMaskableDocument, wasdengineTileDocument,
} from '../scripts/wasdengine-app-icons.ts'

/** Mean absolute channel difference between two decoded images of one size. */
async function difference(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([left, right].map(png => sharp(png).ensureAlpha().raw().toBuffer()))
  let total = 0
  for (let index = 0; index < a!.length; index += 1) total += Math.abs(a![index]! - b![index]!)
  return total / a!.length
}

describe('WASDEngine web install icons', () => {
  it('fills the install tile edge to edge with the Desktop tile gradient and keeps the keycap glyph', async () => {
    const source = await readFile(WASDENGINE_TILE_SOURCE, 'utf8')
    const tile = wasdengineTileDocument(source)
    expect(tile).toMatch(/^<svg width="1024" height="1024" viewBox="40 32 1024 1024" /u)
    expect(tile).toContain('<rect x="40" y="32" width="1024" height="1024" fill="url(#tile)"/>')
    expect(tile).not.toContain('url(#tile-shadow)')
    expect(tile).not.toMatch(/translate\(-40 -32\)/u)
    expect(tile).toContain(source.match(/<defs>[\s\S]*<\/defs>/u)![0])
    expect(tile).toContain('<g id="tray-glyph">')
    expect(wasdengineMaskableDocument(source)).toContain(
      `<g id="tray-glyph" transform="translate(552 544) scale(${String(MASKABLE_ARTWORK_SCALE)}) translate(-552 -544)">`)
  })

  it('fails loudly on a source without the parts it rewrites', () => {
    expect(() => wasdengineTileDocument('')).toThrow(/no root element/u)
    expect(() => wasdengineTileDocument('<svg></svg>')).toThrow(/no tile placement group/u)
    expect(() => wasdengineTileDocument('<svg><g transform="translate(-40 -32)"></g></svg>')).toThrow(/no shadowed tile group/u)
    expect(() => wasdengineMaskableDocument('<svg><g transform="translate(-40 -32)"><g filter="url(#tile-shadow)"></g></g></svg>'))
      .toThrow(/no tray-glyph group/u)
  })

  it('ships every upstream install variant as a current render of the keycap tile', async () => {
    const icons = await renderWasdengineAppIcons(await readFile(WASDENGINE_TILE_SOURCE, 'utf8'))
    expect(icons.map(({ variant }) => variant)).toEqual(APP_ICON_VARIANTS)
    for (const { variant, png } of icons) {
      // One level of mean drift allows rasterizer differences between platforms.
      expect(await difference(png, await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))), variant.file).toBeLessThan(1)
    }
  })
})
