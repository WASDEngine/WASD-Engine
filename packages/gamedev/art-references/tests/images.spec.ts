/**
 * The reference tools' pictures: what an image file is, fingerprints of the same picture, the numbered contact sheet,
 * an animation's frames sheet, and the copy a model receives, with small pixel art enlarged without smoothing.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  drawContactSheet, drawFramesSheet, drawLabel, fingerprint, fingerprintDistance, MAX_ANIMATION_PIXELS, modelCopy, probeImage,
  sampledFrames, sheetPicture, UnreadableImage,
} from '../src/images.ts'
import { animatedGif, patternImage } from './fixtures.ts'

/** A JPEG cut short: the header reads, but its pixels do not decode. Browsers show what arrived. */
async function cutJpeg(keep: number): Promise<Buffer> {
  const jpeg = await patternImage(400, 300, 3, 'jpeg')
  return jpeg.subarray(0, Math.floor(jpeg.length * keep))
}

const FRAMES = { maxFrames: 24, maxEdge: 512, maxPixels: MAX_ANIMATION_PIXELS }

describe('probeImage', () => {
  it('reads a still image\'s type and size', async () => {
    expect(await probeImage(await patternImage(120, 80, 1, 'jpeg'))).toEqual({ format: 'jpeg', width: 120, height: 80, frames: 1, delays: [] })
  })

  it('reads an animation\'s frames and their delays', async () => {
    expect(await probeImage(await animatedGif(40, 30, [80, 120, 80], 2))).toEqual({ format: 'gif', width: 40, height: 30, frames: 3, delays: [80, 120, 80] })
    // Two different frames: the WebP encoder merges identical ones.
    const frames = Buffer.concat([Buffer.alloc(10 * 10 * 4, 200), Buffer.alloc(10 * 10 * 4, 90)])
    const webp = await sharp(frames, { raw: { width: 10, height: 20, channels: 4, pageHeight: 10 } }).webp({ delay: [50, 60] }).toBuffer()
    expect(await probeImage(webp)).toEqual({ format: 'webp', width: 10, height: 10, frames: 2, delays: [50, 60] })
  })

  it('refuses files that are not reference images', async () => {
    await expect(probeImage(Buffer.from('<html></html>'))).rejects.toBeInstanceOf(UnreadableImage)
    const tiff = await sharp(Buffer.alloc(4 * 4 * 3), { raw: { width: 4, height: 4, channels: 3 } }).tiff().toBuffer()
    await expect(probeImage(tiff)).rejects.toThrow('is a tiff file; references are PNG, JPEG, WebP, GIF, or AVIF images.')
  })
})

describe('fingerprint', () => {
  it('finds the same picture at another size and file type, and tells different pictures apart', async () => {
    const original = await fingerprint(await patternImage(400, 300, 7))
    const smaller = await fingerprint(await patternImage(200, 150, 7, 'jpeg'))
    const other = await fingerprint(await patternImage(400, 300, 8))
    expect(fingerprintDistance(original, smaller)).toBeLessThanOrEqual(6)
    expect(fingerprintDistance(original, other)).toBeGreaterThan(6)
    expect(fingerprintDistance(0n, (1n << 64n) - 1n)).toBe(64)
  })

  it('reports an image whose header reads but whose pixels do not decode as unreadable', async () => {
    for (const keep of [0.6, 0.99]) {
      const cut = await cutJpeg(keep)
      // The header still reads, so the file passes for an image until it is decoded.
      expect((await probeImage(cut)).format).toBe('jpeg')
      const failure = await fingerprint(cut).then(() => undefined, (error: unknown) => error)
      expect(failure, String(keep)).toBeInstanceOf(UnreadableImage)
      expect((failure as Error).message).toMatch(/^is a damaged image file that cannot be decoded \(.+\)\.$/u)
    }
    await expect(sheetPicture(await cutJpeg(0.6), 96)).rejects.toBeInstanceOf(UnreadableImage)
    await expect(modelCopy(await cutJpeg(0.6), 1024, 'cut')).rejects.toBeInstanceOf(UnreadableImage)
  })
})

describe('drawLabel', () => {
  it('draws white glyphs on a dark box sized by the text and the scale', () => {
    const label = drawLabel('12', 2)
    expect([label.width, label.height]).toEqual([(2 * 6 - 1) * 2 + 8, 7 * 2 + 8])
    const lit = [...Array(label.width * label.height).keys()].filter(index => label.data[index * 4] === 255).length
    expect(lit).toBeGreaterThan(0)
    expect(drawLabel('GIF 24', 1).width).toBe((6 * 6 - 1) + 4)
  })
})

describe('drawContactSheet', () => {
  it('lays the images out in rows of the configured columns as one JPEG', async () => {
    const entries = await Promise.all([1, 2, 3, 4, 5].map(async number => ({ picture: await sheetPicture(await patternImage(100 + number * 40, 90, number), 96), number, tag: number === 2 ? 'GIF 8' : '' })))
    const sheet = await drawContactSheet(entries, { cell: 96, columns: 4 })
    expect([sheet.width, sheet.height]).toEqual([8 + 4 * (96 + 8), 8 + 2 * (96 + 8)])
    const meta = await sharp(sheet.data).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', sheet.width, sheet.height])
  })

  it('enlarges small pixel art by a whole multiple without smoothing', async () => {
    // Red, blue, green, and white pixels, row by row.
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255])
    const pixel = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer()
    const sheet = await drawContactSheet([{ picture: await sheetPicture(pixel, 100), number: 1, tag: '' }], { cell: 100, columns: 4 })
    const { data, info } = await sharp(sheet.data).raw().toBuffer({ resolveWithObject: true })
    // The 2×2 picture becomes 100×100 in the cell: the pixel at (60, 60) of the cell is the bottom-right white block.
    const at = (x: number, y: number): number[] => {
      const offset = (y * info.width + x) * info.channels
      return [...data.subarray(offset, offset + 3)]
    }
    expect(at(8 + 75, 8 + 75).every(channel => channel > 230)).toBe(true)
    expect(at(8 + 75, 8 + 25)[2]).toBeGreaterThan(200)
  })
})

describe('drawFramesSheet', () => {
  it('draws every frame of a short animation and samples a long one', async () => {
    expect(sampledFrames(5, 24)).toEqual([0, 1, 2, 3, 4])
    expect(sampledFrames(48, 4)).toEqual([0, 12, 24, 36])
    const gif = await animatedGif(32, 32, [100, 100, 100, 100, 100, 100], 3)
    const sheet = await drawFramesSheet(gif, await probeImage(gif), FRAMES, new AbortController().signal)
    const meta = await sharp(sheet.data).metadata()
    expect(meta.format).toBe('png')
    expect(Math.max(sheet.width, sheet.height)).toBeLessThanOrEqual(512)
    expect(sheet.width * sheet.height).toBeGreaterThan(6 * 64 * 64)
    expect(sheet.covered).toBe(6)
  })

  it('draws each sampled frame from one decoding pass, scaled to its cell', async () => {
    // Frame k fills with the k-th pattern; the middle of each cell must show that frame, not a neighbor.
    const delays = Array.from({ length: 40 }, () => 50)
    const gif = await animatedGif(96, 96, delays, 20)
    const sheet = await drawFramesSheet(gif, await probeImage(gif), { ...FRAMES, maxFrames: 4 }, new AbortController().signal)
    const { data, info } = await sharp(sheet.data).raw().toBuffer({ resolveWithObject: true })
    const frames = await sharp(gif, { pages: -1 }).raw().toBuffer({ resolveWithObject: true })
    const pageBytes = 96 * 96 * frames.info.channels
    // Sampled frames 0, 10, 20, and 30 in two columns of square cells, each frame enlarged by a whole multiple and
    // centered; compare a pixel inside each frame's right-hand blocks, away from the label in the top-left corner.
    const cell = (info.width - 8) / 2 - 8
    const factor = Math.floor(cell / 96)
    const inset = Math.floor((cell - 96 * factor) / 2)
    const [x, y] = [90, 42]
    for (const [slot, frame] of [0, 10, 20, 30].entries()) {
      const left = 8 + (slot % 2) * (cell + 8) + inset
      const top = 8 + Math.floor(slot / 2) * (cell + 8) + inset
      const sheetOffset = ((top + y * factor) * info.width + left + x * factor) * info.channels
      const frameOffset = frame * pageBytes + (y * 96 + x) * frames.info.channels
      const drawn = [...data.subarray(sheetOffset, sheetOffset + 3)]
      const expected = [...frames.data.subarray(frameOffset, frameOffset + 3)]
      drawn.forEach((channel, index) => { expect(Math.abs(channel - (expected[index] as number)), `frame ${frame}`).toBeLessThan(40) })
    }
  })

  it('draws a long animation from its first frames that fit the pixel budget', async () => {
    const gif = await animatedGif(40, 40, Array.from({ length: 30 }, () => 40), 5)
    const sheet = await drawFramesSheet(gif, await probeImage(gif), { ...FRAMES, maxPixels: 40 * 40 * 12 }, new AbortController().signal)
    expect(sheet.covered).toBe(12)
  })

  it('stops when its signal aborts, and reports frames that do not decode as unreadable', async () => {
    const gif = await animatedGif(32, 32, [100, 100, 100], 3)
    const controller = new AbortController()
    controller.abort(new Error('stopped by the user'))
    await expect(drawFramesSheet(gif, await probeImage(gif), FRAMES, controller.signal)).rejects.toThrow('stopped by the user')
    // A GIF cut after its second frame, which a record still describes with four.
    const whole = await animatedGif(64, 64, [80, 80, 80, 80], 9)
    const cut = whole.subarray(0, Math.floor(whole.length * 0.5))
    const info = { format: 'gif' as const, width: 64, height: 64, frames: 4, delays: [80, 80, 80, 80] }
    await expect(drawFramesSheet(cut, info, FRAMES, new AbortController().signal)).rejects.toBeInstanceOf(UnreadableImage)
  })
})

describe('modelCopy', () => {
  it('scales a large photo down to the longest side as JPEG', async () => {
    const copy = await modelCopy(await patternImage(3000, 1500, 4, 'jpeg'), 1024, 'photo')
    const meta = await sharp(copy.data).metadata()
    expect([copy.mediaType, copy.name, meta.width, meta.height]).toEqual(['image/jpeg', 'photo.jpg', 1024, 512])
  })

  it('enlarges a small sprite by a whole multiple as PNG', async () => {
    const copy = await modelCopy(await patternImage(32, 16, 5), 1024, 'sprite')
    const meta = await sharp(copy.data).metadata()
    expect([copy.mediaType, copy.name, meta.width, meta.height]).toEqual(['image/png', 'sprite.png', 256, 128])
  })

  it('keeps transparency as PNG, and an opaque mid-size image at its own size as JPEG', async () => {
    const clear = Buffer.alloc(300 * 200 * 4, 0)
    const transparent = await sharp(clear, { raw: { width: 300, height: 200, channels: 4 } }).png().toBuffer()
    expect((await modelCopy(transparent, 1024, 'glass')).mediaType).toBe('image/png')
    const copy = await modelCopy(await patternImage(600, 400, 6), 1024, 'photo')
    const meta = await sharp(copy.data).metadata()
    expect([copy.mediaType, meta.width, meta.height]).toEqual(['image/jpeg', 600, 400])
  })
})
