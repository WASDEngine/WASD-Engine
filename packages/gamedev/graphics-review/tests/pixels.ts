/**
 * Pixel art for the review's specs: a checkerboard of single pixels, and the pixels of an enlarged copy that differ from
 * whole-pixel blocks of it, which smoothing would add.
 */
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'

/** The two colors of the checkerboard. */
const DARK = [24, 20, 37] as const
const LIGHT = [240, 200, 80] as const

/**
 * Save a PNG checkerboard of single pixels, without transparency.
 * @param path - the file to write.
 * @param width - its width in pixels.
 * @param height - its height in pixels.
 */
export async function writeCheckerboard(path: string, width: number, height: number): Promise<void> {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set((x + y) % 2 === 0 ? DARK : LIGHT, (y * width + x) * 3)
  }
  await writeFile(path, await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer())
}

/**
 * Compare an image with the checkerboard enlarged by a whole factor.
 * @param data - the image's encoded bytes.
 * @param factor - the whole factor each checkerboard pixel should be enlarged by.
 * @returns its size and the number of pixels whose color is not the checkerboard's at that block.
 */
export async function checkerboardDifference(data: Buffer, factor: number): Promise<{ width: number; height: number; differing: number }> {
  const { data: pixels, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true })
  let differing = 0
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const expected = (Math.floor(x / factor) + Math.floor(y / factor)) % 2 === 0 ? DARK : LIGHT
      const at = (y * info.width + x) * info.channels
      if (expected.some((value, channel) => pixels[at + channel] !== value)) differing += 1
    }
  }
  return { width: info.width, height: info.height, differing }
}
