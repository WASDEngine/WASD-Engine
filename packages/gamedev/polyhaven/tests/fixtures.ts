/**
 * A fake Poly Haven on loopback HTTP for the Poly Haven specs: the asset list, the search, file trees, preview
 * images, and file downloads of three assets (the texture `mossy_rock`, the model `WoodenChair_01`, and the HDRI
 * `kiara_8_sunset`), plus two list entries that the plugin must skip. It records each request with its User-Agent.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the fake received. */
export interface FakeRequest {
  /** Path with query. */
  readonly url: string
  /** The `User-Agent` header. */
  readonly userAgent: string | undefined
}

/** A running fake Poly Haven. */
export interface FakePolyHaven {
  /** API base URL. */
  readonly url: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** Status of the search endpoint; 200 answers. */
  searchStatus: number
  /** Status of the asset list; 200 answers. */
  listStatus: number
  /** File paths, as in {@link fileBytes}, whose download sends other bytes. */
  readonly damaged: Set<string>
  /** Content type of preview images. */
  previewType: string
  /** Stop listening. */
  close(): Promise<void>
}

/** Bytes of the preview image the fake sends. */
export const PREVIEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

/**
 * The bytes the fake sends for one file.
 * @param path - file path below `/dl/`.
 * @returns the bytes.
 */
export function fileBytes(path: string): Buffer {
  return Buffer.from(`${path}\n`.repeat(40))
}

function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex')
}

/** A file tree entry for a download path. */
function file(base: string, path: string, include?: Readonly<Record<string, string>>): Record<string, unknown> {
  const data = fileBytes(path)
  return {
    url: `${base}/dl/${path}`,
    size: data.byteLength,
    md5: md5(data),
    ...include === undefined
      ? {}
      : { include: Object.fromEntries(Object.entries(include).map(([at, source]) => [at, file(base, source)])) },
  }
}

/** The asset list. */
function assets(base: string): Record<string, unknown> {
  return {
    mossy_rock: {
      name: 'Mossy Rock', type: 1, description: 'Weathered rock with green moss.', category: 'Stone/Rock & Cliffs/Mossy Rock', tags: ['moss', 'rock'],
      authors: { 'Rob Tuytel': 'All' }, download_count: 117_570, date_published: 1_603_908_102, max_resolution: [2048, 2048], dimensions: [3000, 3000],
      thumbnail_url: `${base}/thumbs/mossy_rock.png?width=256&height=256&format=webp&v=1`,
    },
    WoodenChair_01: {
      name: 'Wooden Chair 01', type: 2, description: 'An ornate wooden chair.', category: 'Furniture/Seating/Chairs', tags: ['chair', 'wood'],
      authors: { 'Jake Mobley': 'All' }, download_count: 19_480, date_published: 1_585_605_600, max_resolution: [2048, 2048], dimensions: [688.17, 658.46, 2273.51],
      polycount: 19_992, thumbnail_url: `${base}/thumbs/WoodenChair_01.png?width=256&height=256&format=webp&v=2`,
    },
    kiara_8_sunset: {
      name: 'Kiara 8 Sunset', type: 0, description: 'A golden sunset over rocky ridges.', category: 'Mountains & Hills/Valleys', tags: ['sun', 'mountain'],
      authors: { 'Greg Zaal': 'All' }, download_count: 116_279, date_published: 1_511_996_400, max_resolution: [2048, 1024],
      thumbnail_url: `${base}/thumbs/kiara_8_sunset.png?width=256&height=256&format=webp&v=3`,
    },
    Broken_Asset: { type: 1, description: 'An entry without a name.' },
    future_thing: { name: 'Future Thing', type: 7 },
  }
}

/** The file trees, by asset id. */
function trees(base: string): Record<string, unknown> {
  type Maps = Record<string, unknown>
  const maps = (id: string, names: readonly string[], resolutions: readonly string[]): Maps => Object.fromEntries(names.map(map => [
    map,
    Object.fromEntries(resolutions.map(resolution => [resolution, {
      jpg: file(base, `${id}/${id}_${map.toLowerCase()}_${resolution}.jpg`),
      exr: file(base, `${id}/${id}_${map.toLowerCase()}_${resolution}.exr`),
    }])),
  ]))
  return {
    mossy_rock: {
      ...maps('mossy_rock', ['Diffuse', 'nor_dx', 'nor_gl', 'Rough', 'AO'], ['1k', '2k']),
      gltf: {
        '1k': { gltf: file(base, 'mossy_rock/mossy_rock_1k.gltf', { 'mossy_rock.bin': 'mossy_rock/mossy_rock.bin', 'textures/mossy_rock_diff_1k.jpg': 'mossy_rock/mossy_rock_diffuse_1k.jpg' }) },
      },
      blend: { '1k': { blend: file(base, 'mossy_rock/mossy_rock_1k.blend', { 'textures/mossy_rock_diff_1k.jpg': 'mossy_rock/mossy_rock_diffuse_1k.jpg' }) } },
    },
    WoodenChair_01: {
      ...maps('WoodenChair_01', ['Diffuse', 'nor_gl'], ['1k']),
      gltf: Object.fromEntries(['1k', '2k'].map(resolution => [resolution, {
        gltf: file(base, `WoodenChair_01/WoodenChair_01_${resolution}.gltf`, {
          'WoodenChair_01.bin': 'WoodenChair_01/WoodenChair_01.bin',
          [`textures/WoodenChair_01_diff_${resolution}.jpg`]: `WoodenChair_01/WoodenChair_01_diffuse_${resolution}.jpg`,
        }),
      }])),
      fbx: { '1k': { fbx: file(base, 'WoodenChair_01/WoodenChair_01_1k.fbx') } },
    },
    kiara_8_sunset: {
      hdri: Object.fromEntries(['1k', '2k'].map(resolution => [resolution, {
        hdr: file(base, `kiara_8_sunset/kiara_8_sunset_${resolution}.hdr`),
        exr: file(base, `kiara_8_sunset/kiara_8_sunset_${resolution}.exr`),
      }])),
      tonemapped: file(base, 'kiara_8_sunset/kiara_8_sunset.jpg'),
      backplates: { DSC01828: { jpg_plain: file(base, 'kiara_8_sunset/DSC01828.jpg') } },
    },
  }
}

/** The ranked search: the ids whose name, tags, or category hold a query word, in list order. */
function search(base: string, query: string, type: string): Array<{ slug: string; score: number }> {
  const kinds: Record<string, number> = { hdris: 0, textures: 1, models: 2 }
  const words = query.split(/\s+/u).filter(word => word !== '')
  return Object.entries(assets(base)).flatMap(([slug, value]) => {
    const asset = value as { name?: string; type: number; tags?: string[]; category?: string }
    if (type !== 'all' && asset.type !== kinds[type]) return []
    const text = `${asset.name ?? ''} ${(asset.tags ?? []).join(' ')} ${asset.category ?? ''}`.toLowerCase()
    return words.some(word => text.includes(word)) ? [{ slug, score: 0.6 }] : []
  })
}

/** One answer of the fake. */
interface Reply {
  readonly status: number
  readonly body: Buffer | string
  readonly type: string
  readonly headers?: Readonly<Record<string, string>>
}

function plain(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Reply {
  return { status, body, type: 'text/plain', headers }
}

function json(value: unknown): Reply {
  return { status: 200, body: JSON.stringify(value), type: 'application/json' }
}

/** The fake's answer to one request. */
function route(fake: FakePolyHaven, base: string, url: URL): Reply {
  if (url.pathname === '/assets') return fake.listStatus === 200 ? json(assets(base)) : plain(fake.listStatus, 'unavailable')
  if (url.pathname === '/search') {
    if (fake.searchStatus === 429) return plain(429, 'slow down', { 'retry-after': '12' })
    if (fake.searchStatus !== 200) return plain(fake.searchStatus, 'unavailable')
    const results = search(base, url.searchParams.get('q') ?? '', url.searchParams.get('t') ?? 'all')
    return json({ query: url.searchParams.get('q'), total: results.length, results })
  }
  const files = /^\/files\/([^/]+)$/u.exec(url.pathname)
  if (files !== null) {
    const tree = trees(base)[decodeURIComponent(files[1] ?? '')]
    return tree === undefined ? plain(404, 'not found') : json(tree)
  }
  if (url.pathname.startsWith('/thumbs/')) return { status: 200, body: PREVIEW, type: fake.previewType }
  if (url.pathname.startsWith('/dl/')) {
    const path = decodeURIComponent(url.pathname.slice('/dl/'.length))
    const data = fileBytes(path)
    return { status: 200, body: fake.damaged.has(path) ? Buffer.from(data.toString('utf8').toUpperCase()) : data, type: 'application/octet-stream' }
  }
  return plain(404, 'not found')
}

/**
 * Start a fake Poly Haven on a free loopback port.
 * @returns the running fake; close it in teardown.
 */
export async function startFakePolyHaven(): Promise<FakePolyHaven> {
  let base = ''
  const fake: FakePolyHaven = {
    url: '',
    requests: [],
    searchStatus: 200,
    listStatus: 200,
    damaged: new Set(),
    previewType: 'image/jpeg',
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', base)
    fake.requests.push({ url: `${url.pathname}${url.search}`, userAgent: request.headers['user-agent'] })
    const reply = route(fake, base, url)
    response.writeHead(reply.status, { 'content-type': reply.type, ...reply.headers })
    response.end(reply.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return Object.assign(fake, { url: base })
}
