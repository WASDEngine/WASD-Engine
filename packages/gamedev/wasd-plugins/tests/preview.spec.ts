/** Previews turn a recording into a looping GIF, a looping animation, and a still, kept in the project's preview folder. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotRecordedImage, GodotRecording } from '@deepseek-ai/dsh-godot'
import type sharpType from 'sharp'
import { encodePreview, fileDigest, frameDelays, PREVIEW_DIR, savedPreview, savePreview, type PreviewEncoding } from '../src/preview.ts'
import { STATE_DIR } from '../src/state.ts'

const sharp = createRequire(import.meta.url)('sharp') as typeof sharpType
const signal = new AbortController().signal

/** A PNG of one color, or of noise around it. */
async function png(width: number, height: number, shade: number, noise = false): Promise<Uint8Array> {
  return await sharp({
    create: { width, height, channels: 3, background: { r: shade, g: 255 - shade, b: 90 }, ...noise ? { noise: { type: 'gaussian', mean: shade, sigma: 60 } } : {} },
  }).png().toBuffer()
}

interface RecordingShape { readonly width?: number; readonly height?: number; readonly noise?: boolean; readonly jpeg?: boolean }

async function recording(count: number, options: RecordingShape = {}): Promise<GodotRecording> {
  const width = options.width ?? 160
  const height = options.height ?? 90
  const frames: GodotRecordedImage[] = []
  for (let index = 0; index < count; index++) {
    const image = await png(width, height, (index * 37) % 256, options.noise)
    frames.push(options.jpeg === true
      ? { image: await sharp(image).jpeg({ quality: 90 }).toBuffer(), type: 'image/jpeg', width, height, atMs: 25 + index * 80 }
      : { image, type: 'image/png', width, height, atMs: 25 + index * 80 })
  }
  const still = { image: await png(width * 2, height * 2, 128, options.noise), type: 'image/png', width: width * 2, height: height * 2, atMs: 200 } as const
  return { frames, still, windowWidth: width * 4, windowHeight: height * 4, started: false, paused: false }
}

/** An encoding that keeps the frames' width, within generous limits, unless the spec says otherwise. */
function encoding(overrides: Partial<PreviewEncoding> = {}): PreviewEncoding {
  return {
    gifWidth: 4096, maxGifBytes: 50 * 1024 * 1024, webpWidth: 4096, maxWebpBytes: 50 * 1024 * 1024,
    webpQuality: 75, minWidth: 64, effort: 1, ...overrides,
  }
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

describe('frameDelays', () => {
  it('shows each frame until the next capture, in whole 10 ms, at least 20 ms, and the last one for the average', () => {
    expect(frameDelays([{ atMs: 0 }, { atMs: 84 }, { atMs: 161 }, { atMs: 166 }])).toEqual([80, 80, 20, 60])
    expect(frameDelays([{ atMs: 12 }])).toEqual([100])
  })
})

describe('encodePreview', () => {
  it('encodes a looping GIF and a wider looping animation that keep the recording\'s timing, and a lossless still when PNG is smaller', async () => {
    const preview = await encodePreview(await recording(6), encoding({ gifWidth: 120, webpWidth: 160 }), signal)
    expect(preview).toMatchObject({
      gifWidth: 120, gifHeight: 68, frames: 6, durationMs: 480, webpWidth: 160, webpHeight: 90, webpFrames: 6,
      stillType: 'image/png', stillWidth: 320, stillHeight: 180,
    })
    const gif = await sharp(preview.gif, { animated: true }).metadata()
    expect(gif).toMatchObject({ format: 'gif', pages: 6, loop: 0, width: 120, pageHeight: 68 })
    expect(gif.delay).toEqual([80, 80, 80, 80, 80, 80])
    const webp = await sharp(preview.webp, { animated: true }).metadata()
    expect(webp).toMatchObject({ format: 'webp', pages: 6, loop: 0, width: 160, pageHeight: 90 })
    expect(webp.delay).toEqual([80, 80, 80, 80, 80, 80])
    expect((await sharp(preview.still).metadata()).format).toBe('png')
  })

  // Each encoding runs Sharp on real pixels, so the test allows for a busy machine.
  it('keeps a noisy still as JPEG, and shrinks a GIF or an animation over its limit in width, then in frames', async () => {
    const noisy = await recording(4, { width: 256, height: 144, noise: true })
    const full = await encodePreview(noisy, encoding(), signal)
    expect(full.stillType).toBe('image/jpeg')
    expect([full.gifWidth, full.webpWidth]).toEqual([256, 256])
    const limits = { maxGifBytes: Math.floor(full.gif.length * 0.7), maxWebpBytes: Math.floor(full.webp.length * 0.7) }
    const narrower = await encodePreview(noisy, encoding(limits), signal)
    expect([narrower.gifWidth, narrower.webpWidth].every(width => width < 256)).toBe(true)
    expect([narrower.frames, narrower.webpFrames]).toEqual([4, 4])
    expect(narrower.gif.length).toBeLessThanOrEqual(Math.floor(full.gif.length * 0.7))
    expect(narrower.webp.length).toBeLessThanOrEqual(Math.floor(full.webp.length * 0.7))
    const fewer = await encodePreview(noisy, encoding({ maxGifBytes: 1024, maxWebpBytes: 1024, minWidth: 192 }), signal)
    expect(fewer).toMatchObject({ gifWidth: 192, frames: 2, durationMs: 320, webpWidth: 192, webpFrames: 2 })
  }, 60_000)

  it('fits frames of another size into the first frame\'s size, reads JPEG frames, and stops when cancelled', async () => {
    const mixed = await recording(2)
    const resized = { ...mixed, frames: [...mixed.frames, { image: await png(90, 160, 10), type: 'image/png' as const, width: 90, height: 160, atMs: 185 }] }
    const preview = await encodePreview(resized, encoding(), signal)
    expect((await sharp(preview.gif, { animated: true }).metadata())).toMatchObject({ pages: 3, width: 160, pageHeight: 90 })
    expect((await sharp(preview.webp, { animated: true }).metadata())).toMatchObject({ pages: 3, width: 160, pageHeight: 90 })
    const jpeg = await encodePreview(await recording(3, { jpeg: true }), encoding(), signal)
    expect(jpeg).toMatchObject({ gifWidth: 160, frames: 3, webpWidth: 160, webpFrames: 3 })
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(encodePreview(mixed, encoding({ maxGifBytes: 1024 }), controller.signal)).rejects.toThrow('stopped')
    await expect(encodePreview({ ...mixed, frames: [] }, encoding(), signal)).rejects.toThrow('no frames')
  })
})

describe('savePreview', () => {
  it('replaces the project\'s preview, keeps one still, and finds the saved files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-preview-'))
    folders.push(dir)
    expect(await savedPreview(dir)).toEqual({})
    const encoded = {
      gif: Buffer.from('GIF89a'), gifWidth: 1, gifHeight: 1, frames: 1, durationMs: 100,
      webp: Buffer.from('RIFF'), webpWidth: 1, webpHeight: 1, webpFrames: 1,
      still: Buffer.from('PNG'), stillType: 'image/png', stillWidth: 1, stillHeight: 1,
    } as const
    const first = await savePreview(dir, encoded)
    const folder = join(dir, STATE_DIR, PREVIEW_DIR)
    expect(first).toEqual({ gif: join(folder, 'preview.gif'), image: join(folder, 'preview.png'), webp: join(folder, 'preview.webp') })
    const second = await savePreview(dir, { ...encoded, still: Buffer.from('JPEG'), stillType: 'image/jpeg' })
    expect(second.image).toBe(join(folder, 'preview.jpg'))
    expect((await readdir(folder)).sort()).toEqual(['preview.gif', 'preview.jpg', 'preview.webp'])
    expect(await readFile(second.image, 'utf8')).toBe('JPEG')
    expect(await readFile(second.webp, 'utf8')).toBe('RIFF')
    expect(await savedPreview(dir)).toEqual(second)
    await rm(second.gif)
    expect(await savedPreview(dir)).toEqual({ image: second.image, webp: second.webp })
  })

  it('digests a file as SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-digest-'))
    folders.push(dir)
    await writeFile(join(dir, 'file'), 'preview')
    expect(await fileDigest(join(dir, 'file'), signal)).toBe(createHash('sha256').update('preview').digest('hex'))
  })
})
