/** The Poly Haven API client against a fake Poly Haven: the cached asset list, the search, file trees, and images. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolyHavenApi, PolyHavenRequestError, type PolyHavenApiOptions } from '../src/api.ts'
import { PREVIEW, startFakePolyHaven, type FakePolyHaven } from './fixtures.ts'

const signal = new AbortController().signal

let fake: FakePolyHaven
let now: number

beforeEach(async () => {
  fake = await startFakePolyHaven()
  now = 1_000_000
})

afterEach(async () => {
  await fake.close()
})

function api(overrides: Partial<PolyHavenApiOptions> = {}): PolyHavenApi {
  return new PolyHavenApi({ apiUrl: fake.url, userAgent: 'WASD Engine', catalogMaxAgeMs: 60_000, fetch: (input, init) => fetch(input, init), now: () => now, ...overrides })
}

describe('PolyHavenApi', () => {
  it('reads the asset list with the WASD Engine user agent and skips entries it cannot read', async () => {
    const assets = await api().assets(signal)
    expect([...assets.keys()]).toEqual(['mossy_rock', 'WoodenChair_01', 'kiara_8_sunset'])
    expect(assets.get('WoodenChair_01')).toEqual({
      id: 'WoodenChair_01',
      name: 'Wooden Chair 01',
      kind: 'model',
      description: 'An ornate wooden chair.',
      category: 'Furniture/Seating/Chairs',
      tags: ['chair', 'wood'],
      authors: { 'Jake Mobley': 'All' },
      downloads: 19_480,
      published: 1_585_605_600,
      maxWidth: 2048,
      dimensionsMm: [688.17, 658.46, 2273.51],
      polycount: 19_992,
      thumbnailUrl: `${fake.url}/thumbs/WoodenChair_01.png?width=256&height=256&format=webp&v=2`,
    })
    expect(assets.get('kiara_8_sunset')).toMatchObject({ kind: 'hdri', maxWidth: 2048 })
    expect(fake.requests).toEqual([{ url: '/assets?type=all', userAgent: 'WASD Engine' }])
  })

  it('answers from memory while the list is fresh, reads it again after, and keeps the old list when that fails', async () => {
    const client = api()
    await client.assets(signal)
    now += 59_999
    await client.assets(signal)
    expect(fake.requests).toHaveLength(1)
    now += 1
    fake.listStatus = 503
    expect((await client.assets(signal)).size).toBe(3)
    expect(fake.requests).toHaveLength(2)
    await expect(api().assets(signal)).rejects.toThrow(new PolyHavenRequestError(503, 'Poly Haven answered HTTP 503 for the asset list.'))
  })

  it('searches with the trimmed, lowercased query and the kind\'s filter, and leaves ranking to the caller when the API cannot', async () => {
    const client = api()
    expect(await client.search('  Wooden CHAIR ', 'model', signal)).toEqual(['WoodenChair_01'])
    expect(await client.search('rock', undefined, signal)).toEqual(['mossy_rock'])
    expect(fake.requests.map(request => request.url)).toEqual(['/search?q=wooden+chair&t=models', '/search?q=rock&t=all'])
    fake.searchStatus = 503
    expect(await client.search('rock', undefined, signal)).toBeUndefined()
    fake.searchStatus = 429
    await expect(client.search('rock', undefined, signal)).rejects.toThrow('Poly Haven is limiting requests from this computer; try again in 12 seconds.')
  })

  it('reads an asset\'s file tree, and reports a missing asset as HTTP 404', async () => {
    const tree = await api().files('kiara_8_sunset', signal)
    expect([...tree.keys()]).toEqual(['hdri', 'backplates'])
    expect([...tree.get('hdri')?.keys() ?? []]).toEqual(['1k', '2k'])
    await expect(api().files('nothing_here', signal)).rejects.toMatchObject({ status: 404, message: 'Poly Haven answered HTTP 404 for the files of nothing_here.' })
  })

  it('downloads preview images of supported types only', async () => {
    const image = await api().image(`${fake.url}/thumbs/mossy_rock.png?format=jpeg`, signal)
    expect(image).toEqual({ data: PREVIEW, mediaType: 'image/jpeg' })
    fake.previewType = 'text/html; charset=utf-8'
    await expect(api().image(`${fake.url}/thumbs/mossy_rock.png`, signal)).rejects.toThrow('Poly Haven sent the preview image as text/html.')
  })

  it('reports an unreachable Poly Haven and refuses URLs that are not HTTP', async () => {
    const offline = api({ fetch: () => Promise.reject(new TypeError('fetch failed')) })
    await expect(offline.assets(signal)).rejects.toThrow(`Could not reach Poly Haven at ${new URL(fake.url).host} for the asset list: fetch failed`)
    await expect(api().download('file:///etc/passwd', signal)).rejects.toThrow('Poly Haven named the file file:///etc/passwd at a URL that is not HTTP: file:///etc/passwd')
  })

  it('stops a request when cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by the test'))
    await expect(api().assets(controller.signal)).rejects.toThrow('cancelled by the test')
  })
})
