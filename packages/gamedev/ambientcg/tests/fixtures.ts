/**
 * A fake ambientCG on loopback HTTP for the ambientCG specs: the asset list with its keyword, kind, and id filters,
 * the categories, preview images, and ZIP archives of five assets (the materials `Bricks097` and `Wood099`, the decal
 * `Leaking019C`, the atlas `LeafSet030`, and the HDRI `EveningSkyHDRI049B`), plus list entries of other kinds and one
 * broken entry that the plugin must skip. Each archive holds the files a real one holds: the map pictures, material
 * files for other programs, and a preview. It records each request with its User-Agent, and can fail the categories,
 * offer an asset's preview only as a PNG, and break the connection partway through an archive.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { zipSync } from 'fflate'

/** One request the fake received. */
export interface FakeRequest {
  /** Path with query. */
  readonly url: string
  /** The `User-Agent` header. */
  readonly userAgent: string | undefined
}

/** A running fake ambientCG. */
export interface FakeAmbientCg {
  /** API base URL. */
  readonly url: string
  /** Origin of the fake, which also serves the archives and preview images. */
  readonly origin: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** Status of the asset list; 200 answers. */
  listStatus: number
  /** Status of the categories; 200 answers, and 0 sends no answer until the client closes the connection. */
  categoriesStatus: number
  /** Ids of the assets whose listing offers their preview only as a 512-pixel PNG, which the fake sends as `image/png`. */
  readonly pngPreviews: Set<string>
  /** Archive file names whose download breaks off: the fake sends half of the archive, then closes the connection. */
  readonly cut: Set<string>
  /** Content type of preview images. */
  previewType: string
  /** Archive file names, such as `Bricks097_1K-JPG.zip`, that arrive with one byte of their first picture changed. */
  readonly damaged: Set<string>
  /** Whether archive responses name their SHA-1 digest, as ambientCG's file host does. */
  digests: boolean
  /** Bytes added to the size that the asset list gives for each archive, as when an asset changed after it was listed. */
  listedSizeOffset: number
  /** Stop listening. */
  close(): Promise<void>
}

/** Bytes of the preview image the fake sends. */
export const PREVIEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

/**
 * The bytes of one file inside an archive.
 * @param name - the file's name in the archive.
 * @returns the bytes.
 */
export function pictureBytes(name: string): Buffer {
  return Buffer.from(`${name}\n`.repeat(30))
}

/** One asset of the fake's list, without its archives. */
interface FakeAsset {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly tags: readonly string[]
  readonly size: readonly [number, number]
  readonly total: number
  readonly maps: readonly string[]
  readonly technique: string
  /** The archives by the API's name, each with the map pictures it holds. */
  readonly archives: Readonly<Record<string, readonly string[]>>
  /** Other files the list offers, which the plugin must leave out. */
  readonly others?: ReadonlyArray<{ readonly attributes: string; readonly extension: string }>
}

const SURFACE = ['Color', 'Displacement', 'NormalDX', 'NormalGL', 'Roughness'] as const

const ASSETS: readonly FakeAsset[] = [
  {
    id: 'Bricks097', type: 'material', title: 'Bricks 097', tags: ['97', 'brick', 'bricks', 'red', 'wall', 'bricks097'], size: [240, 120], total: 62_514,
    maps: ['color', 'displacement', 'normal', 'roughness', 'ambient-occlusion'], technique: 'surface-photogrammetry',
    archives: { '2K-JPG': [...SURFACE, 'AmbientOcclusion'], '1K-JPG': [...SURFACE, 'AmbientOcclusion'], '1K-PNG': [...SURFACE, 'AmbientOcclusion'] },
  },
  {
    id: 'Wood099', type: 'material', title: 'Wood 099', tags: ['099', '99', 'pattern', 'wood', 'planks'], size: [0, 0], total: 116,
    maps: ['color', 'displacement', 'normal', 'roughness'], technique: 'surface-approximated',
    archives: { '1K-JPG': SURFACE, '2K-JPG': SURFACE },
  },
  {
    id: 'Leaking019C', type: 'decal', title: 'Leaking 019 C', tags: ['leaking', 'metal', 'rust', 'water'], size: [0, 0], total: 14_754,
    maps: ['color', 'displacement', 'normal', 'roughness', 'metalness'], technique: 'surface-fully-procedural',
    archives: { '1K-JPG': [...SURFACE, 'Metalness'] },
    others: [{ attributes: '1K-JPG-ANIMATED', extension: 'zip' }],
  },
  {
    id: 'LeafSet030', type: 'atlas', title: 'Leaf Set 030', tags: ['030', 'autumn', 'foliage', 'leaf', 'leaves', 'red'], size: [0, 0], total: 11_228,
    maps: ['color', 'normal', 'roughness', 'opacity', 'scattering'], technique: 'surface-photometric-stereo',
    archives: { '1K-JPG': ['Color', 'NormalDX', 'NormalGL', 'Opacity', 'Roughness', 'Scattering'] },
  },
  {
    id: 'EveningSkyHDRI049B', type: 'hdri', title: 'Evening Sky HDRI 049 B', tags: ['049', 'evening', 'hdri', 'sky', 'sunset'], size: [0, 0], total: 907,
    maps: [], technique: 'hdri-bracketed-panorama-horizon-clearing',
    archives: { '1K': ['HDR', 'TONEMAPPED'], '2K': ['HDR', 'TONEMAPPED'] },
  },
  {
    id: 'BricksSubstance008', type: 'substance', title: 'Bricks Substance 008', tags: ['bricks', 'substance', 'wall'], size: [0, 0], total: 526,
    maps: [], technique: 'surface-procedural-bitmap-elements', archives: {}, others: [{ attributes: 'COMPILED', extension: 'sbsar' }],
  },
  {
    id: '3DApple002', type: '3d-model', title: '3D Apple 002', tags: ['apple', 'food'], size: [0, 0], total: 17_689,
    maps: ['color', 'normal'], technique: 'model-photogrammetry', archives: { 'LQ-1K-JPG': ['Color'] },
  },
]

const CATEGORIES = [
  { id: 'Tiles', title: 'Tiles', type: 'material', numberOfAssets: 164 },
  { id: 'Bricks', title: 'Bricks', type: 'material', numberOfAssets: 132 },
  { id: 'DaySkyHDRI', title: 'Day Sky HDRI', type: 'hdri', numberOfAssets: 144 },
  { id: 'Leaking', title: 'Leaking', type: 'decal', numberOfAssets: 39 },
  { id: 'LeafSet', title: 'Leaf Set', type: 'atlas', numberOfAssets: 30 },
  { id: 'TilesSubstance', title: 'Tiles Substance', type: 'substance', numberOfAssets: 18 },
  { id: 'Empty', title: 'Empty', type: 'material', numberOfAssets: 0 },
]

/**
 * The names of the files of one archive, as ambientCG packs them.
 * @param id - asset id.
 * @param attributes - the archive's name in the API, such as `1K-JPG`.
 * @returns each file's name with whether it is a map picture.
 */
export function archiveFiles(id: string, attributes: string): Array<{ readonly name: string; readonly map?: string }> {
  const asset = ASSETS.find(candidate => candidate.id === id)
  const maps = asset?.archives[attributes] ?? []
  const extension = attributes.endsWith('PNG') ? 'png' : 'jpg'
  return [
    { name: `${id}_${attributes}.usdc` },
    ...maps.map(map => ({ name: `${id}_${attributes}_${map}.${map === 'HDR' ? 'exr' : map === 'TONEMAPPED' ? 'jpg' : extension}`, map })),
    { name: `${id}_${attributes}.blend` },
    { name: `${id}_${attributes}.tres` },
    { name: `${id}.png` },
  ]
}

/** Each archive's bytes by file name, such as `Bricks097_1K-JPG.zip`; every second one stores its files uncompressed. */
const ARCHIVES: ReadonlyMap<string, Buffer> = new Map(ASSETS.flatMap(
  asset => Object.keys(asset.archives).map((attributes, index): [string, Buffer] => {
    const files = Object.fromEntries(archiveFiles(asset.id, attributes).map(file => [file.name, new Uint8Array(pictureBytes(file.name))]))
    return [`${asset.id}_${attributes}.zip`, Buffer.from(zipSync(files, { level: index % 2 === 0 ? 0 : 6 }))]
  }),
))

/**
 * The archive the fake sends for one asset and resolution.
 * @param name - archive file name, such as `Bricks097_1K-JPG.zip`.
 * @returns its bytes.
 */
export function archiveBytes(name: string): Buffer {
  const archive = ARCHIVES.get(name)
  if (archive === undefined) throw new Error(`The fake has no archive ${name}.`)
  return archive
}

/** One asset as the API lists it. */
function listed(fake: FakeAmbientCg, asset: FakeAsset): Record<string, unknown> {
  return {
    id: asset.id,
    type: asset.type,
    title: asset.title,
    tags: asset.tags,
    dimensions: { width: asset.size[0], height: asset.size[1], depth: 0 },
    downloadStatistics: { total: asset.total, lastMonth: 10, lastWeek: 2, lastDay: 1 },
    maps: asset.maps,
    technique: asset.technique,
    releaseDate: '2026-10-24',
    downloads: [
      ...(asset.others ?? []).map(other => ({ ...other, url: `${fake.origin}/get?file=${asset.id}_${other.attributes}.${other.extension}`, size: 321_650_160 })),
      ...Object.keys(asset.archives).map(attributes => ({
        attributes,
        extension: 'zip',
        url: `${fake.origin}/get?file=${asset.id}_${attributes}.zip`,
        size: archiveBytes(`${asset.id}_${attributes}.zip`).byteLength + fake.listedSizeOffset,
      })),
    ],
    thumbnails: fake.pngPreviews.has(asset.id)
      ? { '64-PNG': `${fake.origin}/thumbs/64/${asset.id}.png`, '512-PNG': `${fake.origin}/thumbs/512/${asset.id}.png` }
      : { '64-PNG': `${fake.origin}/thumbs/64/${asset.id}.png`, '512-JPG-FFFFFF': `${fake.origin}/thumbs/512/${asset.id}.jpg` },
  }
}

/** The asset list for a request's filters, most downloaded first. */
function assetList(fake: FakeAmbientCg, url: URL): Record<string, unknown> {
  const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/[\s,]+/u).filter(word => word !== '')
  const types = (url.searchParams.get('type') ?? '').split(',').filter(type => type !== '')
  const ids = (url.searchParams.get('id') ?? '').toLowerCase().split(',').filter(id => id !== '')
  const limit = Number(url.searchParams.get('limit') ?? 100)
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const matching = ASSETS
    .filter(asset => types.length === 0 || types.includes(asset.type))
    .filter(asset => ids.length === 0 || ids.includes(asset.id.toLowerCase()))
    .filter(asset => words.every(word => asset.tags.includes(word) || asset.title.toLowerCase().split(' ').includes(word)))
    .sort((a, b) => b.total - a.total)
  return {
    totalResults: matching.length,
    nextPageHttp: null,
    currentPageHttp: url.href,
    previousPageHttp: null,
    // Beside assets, a first page also holds an entry that no plugin can read: its id is not an id.
    assets: [...matching.slice(offset, offset + limit).map(asset => listed(fake, asset)), ...ids.length === 0 && offset === 0 && matching.length > 0 ? [{ id: 'not an id', type: 'material' }] : []],
  }
}

/** One answer of the fake. */
interface Reply {
  readonly status: number
  readonly body: Buffer | string
  readonly type: string
  readonly headers?: Readonly<Record<string, string>>
  /** Send half of the body, then close the connection. */
  readonly cut?: boolean
}

function plain(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Reply {
  return { status, body, type: 'text/plain', headers }
}

function json(value: unknown): Reply {
  return { status: 200, body: JSON.stringify(value), type: 'application/json' }
}

/** An archive as the fake sends it: whole, or with one byte of its first picture changed. */
function sentArchive(fake: FakeAmbientCg, name: string): Buffer | undefined {
  const archive = ARCHIVES.get(name)
  if (archive === undefined || !fake.damaged.has(name)) return archive
  const [id = '', attributes = ''] = name.replace(/\.zip$/u, '').split('_')
  const picture = archiveFiles(id, attributes).find(file => file.map !== undefined)
  const changed = Buffer.from(archive)
  // Only an archive that stores its files uncompressed holds a picture's bytes as they are.
  const at = picture === undefined ? -1 : changed.indexOf(pictureBytes(picture.name))
  if (at < 0) throw new Error(`The fake cannot damage ${name}: it compresses its files.`)
  changed[at + 5] = (changed[at + 5] as number) ^ 0xff
  return changed
}

/** The fake's answer to one request. */
function route(fake: FakeAmbientCg, url: URL): Reply {
  if (url.pathname === '/api/v3/assets') {
    if (fake.listStatus === 429) return plain(429, 'slow down', { 'retry-after': '12' })
    return fake.listStatus === 200 ? json(assetList(fake, url)) : plain(fake.listStatus, 'unavailable')
  }
  if (url.pathname === '/api/v3/categories') return fake.categoriesStatus === 200 ? json(CATEGORIES) : plain(fake.categoriesStatus, 'unavailable')
  if (url.pathname === '/get') return { status: 302, body: '', type: 'text/plain', headers: { location: `/file/download/${url.searchParams.get('file') ?? ''}` } }
  if (url.pathname.startsWith('/thumbs/')) return { status: 200, body: PREVIEW, type: url.pathname.endsWith('.png') ? 'image/png' : fake.previewType }
  if (url.pathname.startsWith('/file/download/')) {
    const name = decodeURIComponent(url.pathname.slice('/file/download/'.length))
    const archive = sentArchive(fake, name)
    if (archive === undefined) return plain(404, 'not found')
    const digest = createHash('sha1').update(archiveBytes(name)).digest('hex')
    return { status: 200, body: archive, type: 'application/zip', headers: fake.digests ? { 'x-bz-content-sha1': digest } : {}, cut: fake.cut.has(name) }
  }
  return plain(404, 'not found')
}

/**
 * Start a fake ambientCG on a free loopback port.
 * @returns the running fake; close it in teardown.
 */
export async function startFakeAmbientCg(): Promise<FakeAmbientCg> {
  let origin = ''
  const fake: FakeAmbientCg = {
    url: '',
    origin: '',
    requests: [],
    listStatus: 200,
    categoriesStatus: 200,
    pngPreviews: new Set(),
    cut: new Set(),
    previewType: 'image/jpeg',
    damaged: new Set(),
    digests: true,
    listedSizeOffset: 0,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin)
    fake.requests.push({ url: `${url.pathname}${url.search}`, userAgent: request.headers['user-agent'] })
    if (url.pathname === '/api/v3/categories' && fake.categoriesStatus === 0) {
      // No answer: the client's cancellation closes the connection, or the fake gives up after a while.
      const gaveUp = setTimeout(() => { response.destroy() }, 10_000)
      response.once('close', () => { clearTimeout(gaveUp) })
      return
    }
    const reply = route(fake, url)
    if (reply.cut === true) {
      const body = Buffer.from(reply.body)
      response.writeHead(reply.status, { 'content-type': reply.type, 'content-length': String(body.byteLength), ...reply.headers })
      response.write(body.subarray(0, Math.floor(body.byteLength / 2)))
      setTimeout(() => { response.socket?.destroy() }, 20)
      return
    }
    response.writeHead(reply.status, { 'content-type': reply.type, ...reply.headers })
    response.end(reply.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return Object.assign(fake, { url: `${origin}/api/v3`, origin })
}
