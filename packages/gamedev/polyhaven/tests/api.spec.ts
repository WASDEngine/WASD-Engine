/** The Poly Haven API client against a fake Poly Haven: the cached asset list, the search, file trees, and images. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolyHavenApi, type PolyHavenApiOptions } from '../src/api.ts'
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

/** A failed request as the plugin throws it: its own error, with the kit's request and its HTTP status as the cause. */
function refused(message: string, status: number): Record<string, unknown> {
  return { name: 'PolyHavenError', code: 'POLYHAVEN_REQUEST_FAILED', message, cause: { name: 'AssetLibraryRequestError', status } }
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
    await expect(api().assets(signal)).rejects.toMatchObject(refused('Poly Haven answered HTTP 503 for the asset list.', 503))
  })

  it('searches with the trimmed, lowercased query and the kind\'s filter, and leaves ranking to the caller when the API cannot', async () => {
    const client = api()
    expect(await client.search('  Wooden CHAIR ', 'model', signal)).toEqual(['WoodenChair_01'])
    expect(await client.search('rock', undefined, signal)).toEqual(['mossy_rock'])
    expect(fake.requests.map(request => request.url)).toEqual(['/search?q=wooden+chair&t=models', '/search?q=rock&t=all'])
    fake.searchStatus = 503
    expect(await client.search('rock', undefined, signal)).toBeUndefined()
    fake.searchStatus = 429
    await expect(client.search('rock', undefined, signal)).rejects.toMatchObject(refused('Poly Haven is limiting requests from this computer; try again in 12 seconds.', 429))
  })

  it('reads an asset\'s file tree, and reports a missing asset as HTTP 404', async () => {
    const tree = await api().files('kiara_8_sunset', signal)
    expect([...tree.keys()]).toEqual(['hdri', 'backplates'])
    expect([...tree.get('hdri')?.keys() ?? []]).toEqual(['1k', '2k'])
    await expect(api().files('nothing_here', signal)).rejects.toMatchObject(refused('Poly Haven answered HTTP 404 for the files of nothing_here.', 404))
  })

  it('downloads preview images of supported types only', async () => {
    const image = await api().image(`${fake.url}/thumbs/mossy_rock.png?format=jpeg`, signal)
    expect(image).toEqual({ data: PREVIEW, mediaType: 'image/jpeg' })
    fake.previewType = 'text/html; charset=utf-8'
    await expect(api().image(`${fake.url}/thumbs/mossy_rock.png`, signal)).rejects.toMatchObject(refused('Poly Haven sent the preview image as text/html.', 200))
  })

  it('reports an unreachable Poly Haven and refuses URLs and redirects that do not lead to Poly Haven', async () => {
    const offline = api({ fetch: () => Promise.reject(new TypeError('fetch failed')) })
    await expect(offline.assets(signal)).rejects.toMatchObject(refused(`Could not reach Poly Haven at ${new URL(fake.url).host} for the asset list: fetch failed`, 0))
    for (const url of ['file:///etc/passwd', 'https://attacker.example/mossy_rock.zip', 'http://dl.polyhaven.org/file.zip']) {
      await expect(api().download(url, signal)).rejects.toMatchObject(
        refused(`Poly Haven named the file ${url} at ${url}, which is not a Poly Haven address, so nothing was downloaded from it.`, 0))
    }
    const strange = api({ fetch: () => Promise.resolve(Response.json(['not', 'a', 'list'])) })
    await expect(strange.assets(signal)).rejects.toMatchObject({ name: 'PolyHavenError', code: 'POLYHAVEN_REQUEST_FAILED', message: 'Poly Haven sent an asset list in an unknown format.' })
    const fetched: string[] = []
    const redirecting = api({
      fetch: async (input) => {
        fetched.push(input instanceof Request ? input.url : input.toString())
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/stolen' } })
      },
    })
    await expect(redirecting.download(`${fake.url}/dl/mossy_rock.zip`, signal)).rejects.toThrow('https://attacker.example/stolen, which is not a Poly Haven address')
    expect(fetched).toEqual([`${fake.url}/dl/mossy_rock.zip`])
  })

  it('stops a request when cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by the test'))
    await expect(api().assets(controller.signal)).rejects.toThrow('cancelled by the test')
  })
})
