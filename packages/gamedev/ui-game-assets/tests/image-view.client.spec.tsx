// @vitest-environment jsdom
/**
 * The 2D view's animations over stand-ins for the browser's decoders: frames that are other image files draw their
 * own pictures, frames past the decoder's memory budget draw themselves rather than the first frame, playback waits
 * while the view is off screen, and an image whose header states more pixels than the viewer decodes shows a notice
 * without being decoded.
 */
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnimationSources } from '../src/client/animations2d.ts'
import { formatOf } from '../src/client/formats.ts'
import { ImageView, type ImageViewProps } from '../src/client/ImageView.tsx'
import type { AssetFile } from '../src/client/read.ts'

/** A decoded picture's stand-in, named by what it shows. */
interface FakeBitmap {
  readonly tag: string
  readonly width: number
  readonly height: number
  readonly close: () => void
}

/** What each frame canvas drew: the tag of every picture drawn into it, in order. */
let drawn: string[] = []
let decodes = 0
const restore: (() => void)[] = []

function stub(target: object, key: string, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, ...descriptor })
  restore.push(() => {
    if (previous === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, previous)
  })
}

/** A file's bytes: a 16 × 16 PNG header followed by its name, which the stand-in decoders read back. */
function pngFile(name: string, width = 16, height = 16): Uint8Array<ArrayBuffer> {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  const size = [width, height].flatMap(value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
  return Uint8Array.from([...header, ...size, 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(`#${name}`)])
}

async function tagOf(blob: Blob): Promise<string> {
  const text = new TextDecoder().decode(await blob.arrayBuffer())
  return text.slice(text.lastIndexOf('#') + 1)
}

beforeEach(() => {
  drawn = []
  decodes = 0
  const blobs = new Map<string, Blob>()
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:view/${String(blobs.size + 1)}`
      blobs.set(url, blob)
      return url
    }),
    revokeObjectURL: vi.fn(),
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  // Image elements decode at once, at 16 × 16; the tag names the file their URL holds.
  stub(HTMLImageElement.prototype, 'decode', { value: async function decode(this: HTMLImageElement) {
    decodes += 1
    const blob = blobs.get(this.src)
    if (blob !== undefined) this.dataset.tag = await tagOf(blob)
  } })
  stub(HTMLImageElement.prototype, 'naturalWidth', { get: () => 16 })
  stub(HTMLImageElement.prototype, 'naturalHeight', { get: () => 16 })
  // Bitmaps of a file carry its name; bitmaps of an animated image's frame carry the frame's number.
  vi.stubGlobal('createImageBitmap', vi.fn(async (source: Blob | { readonly tag: string; readonly displayWidth: number; readonly displayHeight: number }) => {
    decodes += 1
    const tag = source instanceof Blob ? await tagOf(source) : source.tag
    const size = source instanceof Blob ? 16 : source.displayWidth
    return { tag, width: size, height: size, close: () => {} } satisfies FakeBitmap
  }))
  // A 2D context that records what is drawn into a canvas of the page; a detached one measures pixels.
  stub(HTMLCanvasElement.prototype, 'getContext', { value: function getContext(this: HTMLCanvasElement) {
    const shown = (): boolean => this.isConnected
    return {
      imageSmoothingEnabled: true,
      clearRect: () => { if (shown()) drawn.push('') },
      drawImage: (source: FakeBitmap | HTMLImageElement) => {
        if (shown()) drawn.push(source instanceof HTMLImageElement ? source.dataset.tag ?? '?' : source.tag)
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }
  } })
})

afterEach(() => {
  cleanup()
  for (const undo of restore.splice(0).reverse()) undo()
  vi.unstubAllGlobals()
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)) as ImageViewProps['t']

function props(path: string, data: Uint8Array<ArrayBuffer>, overrides: Partial<ImageViewProps> = {}): ImageViewProps {
  const format = formatOf(path)
  if (format === undefined) throw new Error(path)
  const slash = path.lastIndexOf('/')
  const file: AssetFile = { data, absolutePath: `/p/${path}`, version: 'v1' }
  return {
    asset: { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format },
    file,
    maxDecodedPixels: 8192 * 8192,
    visible: true,
    t,
    ...overrides,
  }
}

/** The numbered images `fx/boom_1.png` to `fx/boom_4.png`. */
const BOOM = ['fx/boom_1.png', 'fx/boom_2.png', 'fx/boom_3.png', 'fx/boom_4.png']

function boomSources(): { readonly animations: AnimationSources; readonly read: ImageViewProps['read'] } {
  return {
    animations: { readText: async () => undefined, files: async () => BOOM, godot: async () => ({ files: [], projects: [] }) },
    read: async (path): Promise<RemoteResult<AssetFile>> => (BOOM.includes(path)
      ? { ok: true, value: { data: pngFile(path), absolutePath: `/p/${path}`, version: 'v1' } }
      : { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }),
  }
}

describe('ImageView animations', () => {
  it('plays numbered images frame by frame, each frame the picture of its own file', async () => {
    const sources = boomSources()
    render(<ImageView {...props('fx/boom_2.png', pngFile('fx/boom_2.png'), { ...sources, requested: { animation: 'boom', request: 1 } })} />)
    await waitFor(() => {
      for (const path of BOOM) expect(drawn).toContain(path)
    }, { timeout: 5000 })
    // Every frame drew a picture: none was cleared and left blank while the counter moved on.
    const frames = drawn.filter(tag => tag !== '')
    expect(frames.slice(0, 4)).toEqual(BOOM)
  })

  it('waits while the view is off screen, and plays again when it shows', async () => {
    const hidden = props('fx/boom_2.png', pngFile('fx/boom_2.png'), { ...boomSources(), requested: { animation: 'boom', request: 1 }, visible: false })
    const view = render(<ImageView {...hidden} />)
    await screen.findByText('image.frame {"number":1,"count":4}')
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(screen.getByText('image.frame {"number":1,"count":4}')).toBeTruthy()
    view.rerender(<ImageView {...hidden} visible />)
    await screen.findByText('image.frame {"number":2,"count":4}', {}, { timeout: 3000 })
  })

  it('draws an animated image\'s frame past the memory its frames may keep, never the first frame in its place', async () => {
    // 300 frames of 512 × 512: more than the 64 Mi pixels a player keeps at once.
    class FakeDecoder {
      static isTypeSupported = async () => true
      readonly completed = Promise.resolve()
      readonly tracks = { selectedTrack: { animated: true, frameCount: 300 } }
      decode({ frameIndex }: { readonly frameIndex: number }) {
        return Promise.resolve({ image: { tag: `frame ${String(frameIndex)}`, displayWidth: 512, displayHeight: 512, duration: 33_000, close: () => {} } })
      }

      close() {}
    }
    vi.stubGlobal('ImageDecoder', FakeDecoder)
    render(<ImageView {...props('fx/blast.gif', pngFile('fx/blast.gif'), {
      animations: { readText: async () => undefined, files: async () => [], godot: async () => ({ files: [], projects: [] }) },
      requested: { animation: 'frames', request: 1 },
    })} />)
    const seek = await screen.findByRole('slider', { name: 'image.seek' })
    fireEvent.click(screen.getByRole('button', { name: 'image.pause' }))
    fireEvent.change(seek, { target: { value: '280' } })
    await waitFor(() => { expect(drawn.at(-1)).toBe('frame 280') })
    expect(screen.getByText('image.frame {"number":281,"count":300}')).toBeTruthy()
  })

  it('shows a notice for an image whose header states more pixels than the viewer decodes, and decodes nothing', async () => {
    render(<ImageView {...props('art/huge.png', pngFile('art/huge.png', 50_000, 50_000))} />)
    expect((await screen.findByRole('alert')).textContent).toBe('viewer.imageTooLarge {"width":50000,"height":50000}')
    expect(decodes).toBe(0)
    expect(document.querySelector('img')).toBeNull()
  })

  it('shows an image whose header states no size the viewer reads as unreadable, and decodes nothing', async () => {
    // A JPEG name over bytes that state no frame: the browser would decide its size alone.
    render(<ImageView {...props('art/broken.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xd8, 0, 1, 2]))} />)
    expect((await screen.findByRole('alert')).textContent).toBe('viewer.unreadable')
    expect(decodes).toBe(0)
    expect(document.querySelector('img')).toBeNull()
  })
})
