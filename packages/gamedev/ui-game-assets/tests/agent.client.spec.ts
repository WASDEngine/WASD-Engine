// @vitest-environment jsdom
/**
 * An agent's 2D pictures over stand-ins for the browser's decoders and canvas: an image whose header states more
 * pixels than the window decodes is refused before any decode, a draw counts the memory its image decodes, and an
 * animation's sheet decodes only the own frames it shows, each at the size of its tile, past any number of frames.
 */
import { ANSWER_LIMITS } from '@deepseek-ai/dsh-game-assets/src/result.ts'
import type { AssetRenderRequest } from '@deepseek-ai/dsh-game-assets/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerRender, drawWeight, type AgentRenderSources } from '../src/client/agent.ts'
import type { AssetFile } from '../src/client/read.ts'

/** Tags of the pictures drawn into any canvas, in order. */
let drawn: string[] = []
/** The sizes the frames were decoded at. */
let bitmaps: { readonly tag: string; readonly width: number; readonly height: number }[] = []
let elementDecodes = 0
const restore: (() => void)[] = []

function stub(target: object, key: string, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, ...descriptor })
  restore.push(() => {
    if (previous === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, previous)
  })
}

/** A PNG header stating a size; the file's own pictures are drawn as `own`. */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const size = [width, height].flatMap(value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return Uint8Array.from([...signature, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...size, 8, 6, 0, 0, 0, 0, 0, 0, 0])
}

/** A GIF header stating a size. */
function gif(width: number, height: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...new TextEncoder().encode('GIF89a'), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0])
}

beforeEach(() => {
  drawn = []
  bitmaps = []
  elementDecodes = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:agent/1'), revokeObjectURL: vi.fn() }))
  stub(HTMLImageElement.prototype, 'decode', { value: async () => { elementDecodes += 1 } })
  stub(HTMLImageElement.prototype, 'naturalWidth', { get: () => 512 })
  stub(HTMLImageElement.prototype, 'naturalHeight', { get: () => 512 })
  vi.stubGlobal('createImageBitmap', vi.fn(async (source: { readonly tag: string; readonly displayWidth: number }, options?: ImageBitmapOptions) => {
    const width = options?.resizeWidth ?? source.displayWidth
    const bitmap = { tag: source.tag, width, height: options?.resizeHeight ?? source.displayWidth, close: () => {} }
    bitmaps.push(bitmap)
    return bitmap
  }))
  // A canvas whose 2D context records the pictures drawn into it and encodes to a few bytes.
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => new Proxy({}, {
    get: (_target, key) => {
      if (key === 'drawImage') return (source: { readonly tag?: string }) => { drawn.push(source instanceof HTMLImageElement ? 'own' : source.tag ?? '?') }
      if (key === 'measureText') return () => ({ width: 10 })
      if (key === 'getImageData') return (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })
      return () => {}
    },
    set: () => true,
  }) })
  stub(HTMLCanvasElement.prototype, 'toBlob', { value: (done: (blob: Blob) => void) => { done(new Blob(['png'])) } })
})

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo()
  vi.unstubAllGlobals()
})

function request(path: string, overrides: Partial<AssetRenderRequest> = {}): AssetRenderRequest {
  return {
    path, kind: 'image', images: true, bytes: 100, maxBytes: 1_000_000, maxPixels: 1_150_000, limits: ANSWER_LIMITS,
    draw: { views: ['iso'], shading: 'material', skeleton: false, size: 1024 },
    ...overrides,
  }
}

function sources(files: Readonly<Record<string, Uint8Array<ArrayBuffer>>>): AgentRenderSources {
  return {
    read: async (path) => {
      const data = files[path]
      if (data === undefined) throw new Error(path)
      return { ok: true, value: { data, absolutePath: `/p/${path}`, version: 'v1' } satisfies AssetFile }
    },
    readHead: async path => files[path]?.subarray(0, 64),
    animations: { readText: async () => undefined, files: async () => [], godot: async () => ({ files: [], projects: [] }) },
    relatedUrl: () => undefined,
    viewer: () => Promise.reject(new Error('no viewer')),
  }
}

const LIMITS = { maxDecodedPixels: 8192 * 8192 }

describe('agent pictures', () => {
  it('refuses an image whose header states more pixels than the window decodes, before decoding it', async () => {
    const huge = sources({ 'art/huge.png': png(50_000, 50_000) })
    await expect(answerRender(request('art/huge.png'), huge, LIMITS, new AbortController().signal)).rejects.toMatchObject({
      code: 'ASSET_TOO_LARGE',
      message: 'art/huge.png is 50000 × 50000 pixels, more than the 67108864 pixels this window decodes for one image.',
    })
    expect(elementDecodes).toBe(0)
    // A side longer than the details can give fails too.
    const strip = sources({ 'art/strip.png': png(ANSWER_LIMITS.edge + 1, 1) })
    await expect(answerRender(request('art/strip.png'), strip, LIMITS, new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE' })
  })

  it('counts the memory an image decodes, from its header, and a model\'s files', async () => {
    const files = sources({ 'art/hero.png': png(1000, 500) })
    expect(await drawWeight(request('art/hero.png'), files, new AbortController().signal)).toBe(100 + 1000 * 500 * 4)
    expect(await drawWeight(request('models/hero.glb', { kind: 'model' }), files, new AbortController().signal)).toBe(100)
    // A header it cannot read counts the file alone.
    expect(await drawWeight(request('art/gone.png'), files, new AbortController().signal)).toBe(100)
  })

  it('draws the sampled frames of an animated image of any length, each decoded at the size of its tile', async () => {
    // 300 frames of 512 × 512: more than the 64 Mi pixels of frames a draw kept before.
    vi.stubGlobal('ImageDecoder', class {
      static isTypeSupported = async () => true
      readonly completed = Promise.resolve()
      readonly tracks = { selectedTrack: { animated: true, frameCount: 300 } }
      decode({ frameIndex }: { readonly frameIndex: number }) {
        return Promise.resolve({ image: { tag: `frame ${String(frameIndex)}`, displayWidth: 512, displayHeight: 512, duration: 33_000, close: () => {} } })
      }

      close() {}
    })
    const files = sources({ 'fx/blast.gif': gif(512, 512) })
    const answer = await answerRender(request('fx/blast.gif', { draw: { views: ['iso'], shading: 'material', skeleton: false, size: 1024, animation: 'frames' } }), files, LIMITS, new AbortController().signal)
    expect(answer.images[0]?.caption).toBe('16 of 300 frames of frames in order, each labeled with its index and duration (30.3 fps)')
    const sampled = [0, 20, 40, 60, 80, 100, 120, 140, 159, 179, 199, 219, 239, 259, 279, 299].map(index => `frame ${String(index)}`)
    // Only the sampled frames were decoded into pictures, at most the size of a tile, and each tile shows its own frame.
    expect(bitmaps.map(bitmap => bitmap.tag)).toEqual(sampled)
    expect(bitmaps.every(bitmap => bitmap.width < 512 && bitmap.width === bitmap.height)).toBe(true)
    expect(drawn.filter(tag => tag.startsWith('frame '))).toEqual(sampled)
  })
})
