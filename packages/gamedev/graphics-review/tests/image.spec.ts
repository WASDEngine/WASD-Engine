/**
 * The image a review sends: its size, which reaches the reviewer route's pixel floor by whole pixels within the upper
 * limits, and the files it refuses before reading them, such as a device or a pipe that never ends.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { readReviewImage, sentSize, UnreadableImage, type ImageLimits } from '../src/image.ts'

/** The shipped limits: 1,568 pixels a side, 1.15 megapixels, and the account route's 544×544 upscale floor. */
const LIMITS: ImageLimits = { maxBytes: 50 * 1024 * 1024, maxEdge: 1568, maxPixels: 1_150_000, minPixels: 544 * 544 }

let folder: string | undefined

afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true, force: true })
  folder = undefined
})

describe('sentSize', () => {
  it.each([
    // Pixel art reaches the floor by the smallest whole factor: 32×16 needs 25, a 16×16 icon exactly 34.
    [32, 16, 800, 400, true],
    [16, 16, 544, 544, true],
    [100, 100, 600, 600, true],
    [500, 500, 1000, 1000, true],
    [640, 360, 1280, 720, true],
    // The long edge caps a strip: 600×40 would need 4 but stops at 2, and 1024×32 cannot grow at all.
    [600, 40, 1200, 80, true],
    [1024, 32, 1024, 32, false],
    // Just below the floor, doubling would pass 1.15 megapixels, so the image goes as it is.
    [543, 545, 543, 545, false],
    [544, 544, 544, 544, false],
    [1280, 720, 1280, 720, false],
    // Above the upper limits, an image is scaled down to them.
    [1920, 1080, 1429, 804, false],
    [4000, 2000, 1516, 758, false],
  ])('sends %ix%i as %ix%i', (width, height, sentWidth, sentHeight, enlarged) => {
    expect(sentSize(width, height, LIMITS)).toEqual({ width: sentWidth, height: sentHeight, enlarged })
  })

  it('enlarges by the smallest whole factor that reaches the floor, unless an upper limit stops it first', () => {
    const violations: string[] = []
    for (let width = 1; width <= 640; width += 7) {
      for (let height = 1; height <= 640; height += 5) {
        const area = width * height
        const sent = sentSize(width, height, LIMITS)
        const factor = sent.width / width
        const fits = (f: number): boolean => f * Math.max(width, height) <= LIMITS.maxEdge && f * f * area <= LIMITS.maxPixels
        // Below the floor, one more step must break an upper limit; at or above it, one step less must fall below it.
        const notSmallest = factor * factor * area < LIMITS.minPixels
          ? fits(factor + 1)
          : factor > 1 && (factor - 1) ** 2 * area >= LIMITS.minPixels
        if (!Number.isInteger(factor) || sent.height !== height * factor || sent.enlarged !== factor > 1 || !fits(factor)) {
          violations.push(`${width}x${height} -> ${sent.width}x${sent.height}`)
        } else if (notSmallest) {
          violations.push(`${width}x${height} -> ${sent.width}x${sent.height} is not the smallest factor reaching the floor`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('leaves a small image as it is without a floor', () => {
    expect(sentSize(32, 16, { ...LIMITS, minPixels: 0 })).toEqual({ width: 32, height: 16, enlarged: false })
  })
})

describe('readReviewImage', () => {
  // Devices and named pipes are POSIX files.
  it.skipIf(process.platform === 'win32')('refuses a device and a named pipe at once, before it reads them', async () => {
    folder = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-image-'))
    const pipe = join(folder, 'pipe.png')
    execFileSync('mkfifo', [pipe])
    const signal = new AbortController().signal
    for (const path of [pipe, '/dev/zero']) {
      const refused = readReviewImage(path, LIMITS, signal)
      await expect(refused).rejects.toBeInstanceOf(UnreadableImage)
      await expect(refused).rejects.toThrow(`${path} is a device, pipe, or socket, not an image file; pass the path of a PNG, JPEG, or WebP image.`)
    }
  })

  it('stops at the call\'s cancellation', async () => {
    folder = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-image-'))
    const path = join(folder, 'shot.png')
    await writeFile(path, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer())
    const cancelled = new AbortController()
    cancelled.abort(new Error('the call was cancelled'))
    await expect(readReviewImage(path, LIMITS, cancelled.signal)).rejects.toThrow('the call was cancelled')
    await expect(readReviewImage(path, LIMITS, new AbortController().signal)).resolves.toMatchObject({ width: 64, sentWidth: 576 })
  })
})
