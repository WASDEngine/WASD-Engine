/**
 * Test pictures and a fake web: pages and image files served by address from memory, and host names that resolve to a
 * public address or, for `.lan` hosts, to a private one.
 */
import sharp from 'sharp'
import type { LookupAddress, ReferenceWeb } from '../src/net.ts'

/** A public address that fake hosts resolve to. */
export const PUBLIC_ADDRESS = '93.184.216.34'

/** A private address that `.lan` hosts resolve to. */
export const PRIVATE_ADDRESS = '192.168.1.20'

/**
 * Raw RGBA blocks of seeded random colors, a picture whose fingerprint differs from every other seed's.
 * @param width - width in pixels.
 * @param height - height in pixels.
 * @param seed - the pattern.
 * @returns the pixels.
 */
function pattern(width: number, height: number, seed: number): Buffer {
  let state = seed * 2654435761 % 4294967296
  const random = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  const blocks = Array.from({ length: 64 }, () => [random() * 255, random() * 255, random() * 255])
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = blocks[Math.floor((y * 8) / height) * 8 + Math.floor((x * 8) / width)] as number[]
      const offset = (y * width + x) * 4
      data[offset] = block[0] as number
      data[offset + 1] = block[1] as number
      data[offset + 2] = block[2] as number
      data[offset + 3] = 255
    }
  }
  return data
}

/**
 * A PNG or JPEG picture of a seeded pattern.
 * @param width - width in pixels.
 * @param height - height in pixels.
 * @param seed - the pattern; the same seed at another size shows the same picture.
 * @param format - the file type.
 * @returns the file's bytes.
 */
export async function patternImage(width: number, height: number, seed: number, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  const image = sharp(pattern(width, height, seed), { raw: { width, height, channels: 4 } })
  return format === 'png' ? await image.png().toBuffer() : await image.jpeg().toBuffer()
}

/**
 * An animated GIF whose frames show seeded patterns.
 * @param width - width in pixels.
 * @param height - height of one frame in pixels.
 * @param delays - each frame's delay in milliseconds.
 * @param seed - the first frame's pattern; each later frame adds one.
 * @returns the file's bytes.
 */
export async function animatedGif(width: number, height: number, delays: readonly number[], seed: number): Promise<Buffer> {
  const frames = Buffer.concat(delays.map((_, index) => pattern(width, height, seed + index)))
  return await sharp(frames, { raw: { width, height: height * delays.length, channels: 4, pageHeight: height } })
    .gif({ delay: [...delays], loop: 0 }).toBuffer()
}

/** One response of the fake web. */
export interface FakeResponse {
  readonly status?: number
  readonly type?: string
  readonly body?: string | Buffer
  readonly headers?: Readonly<Record<string, string>>
}

/** Pages and files served by address, and the requests they received. */
export class FakeWeb implements ReferenceWeb {
  readonly userAgent = 'test-agent'
  /** Addresses requested, in order. */
  readonly requests: string[] = []
  /** `User-Agent` and `Accept` headers of each request, in order. */
  readonly headers: Record<string, string>[] = []
  private readonly routes = new Map<string, FakeResponse>()

  /**
   * Serve a response at an address.
   * @param address - the full address.
   * @param response - the response.
   * @returns this web, for chaining.
   */
  serve(address: string, response: FakeResponse): this {
    this.routes.set(address, response)
    return this
  }

  /**
   * Serve an HTML page.
   * @param address - the full address.
   * @param html - the page.
   * @returns this web, for chaining.
   */
  page(address: string, html: string): this {
    return this.serve(address, { type: 'text/html; charset=utf-8', body: html })
  }

  /**
   * Serve an image file.
   * @param address - the full address.
   * @param data - the file.
   * @param type - its `Content-Type`.
   * @returns this web, for chaining.
   */
  image(address: string, data: Buffer, type = 'image/png'): this {
    return this.serve(address, { type, body: data })
  }

  /**
   * Whether a host is served by this web.
   * @param address - an address.
   * @returns true for a host with a route.
   */
  serves(address: string): boolean {
    const host = new URL(address).host
    return [...this.routes.keys()].some(route => new URL(route).host === host)
  }

  lookup(hostname: string): Promise<readonly LookupAddress[]> {
    if (hostname.endsWith('.missing')) return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
    return Promise.resolve([{ address: hostname.endsWith('.lan') ? PRIVATE_ADDRESS : PUBLIC_ADDRESS, family: 4 }])
  }

  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response> {
    init.signal.throwIfAborted()
    this.requests.push(url)
    this.headers.push(init.headers)
    const route = this.routes.get(url)
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    const body = route.body === undefined ? null : typeof route.body === 'string' ? route.body : new Uint8Array(route.body)
    return Promise.resolve(new Response(body, {
      status: route.status ?? 200,
      headers: { ...route.type === undefined ? {} : { 'content-type': route.type }, ...route.headers },
    }))
  }
}

/**
 * An HTML page that names a preview image and, optionally, a video.
 * @param title - the page's title.
 * @param image - the preview image's address, as the page writes it.
 * @param video - the video's address.
 * @returns the page.
 */
export function previewPage(title: string, image: string, video?: string): string {
  return `<!doctype html><html><head><title>${title} - Site</title>
<meta property="og:title" content="${title}">
<meta property="og:image" content="${image}">
${video === undefined ? '' : `<meta property="og:video:url" content="${video}">`}
</head><body><img src="/logo.svg" alt="logo"><p>${title}</p></body></html>`
}
