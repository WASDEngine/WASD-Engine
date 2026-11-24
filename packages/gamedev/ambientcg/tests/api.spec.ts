/** The ambientCG API client against a fake ambientCG: searches, one asset, the categories, images, and what it keeps in memory. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AmbientCgApi, KINDS, type AmbientCgApiOptions } from '../src/api.ts'
import { archiveBytes, PREVIEW, startFakeAmbientCg, type FakeAmbientCg } from './fixtures.ts'

const signal = new AbortController().signal

let fake: FakeAmbientCg
let now: number

beforeEach(async () => {
  fake = await startFakeAmbientCg()
  now = 1_000_000
})

afterEach(async () => {
  await fake.close()
})

function api(overrides: Partial<AmbientCgApiOptions> = {}): AmbientCgApi {
  return new AmbientCgApi({ apiUrl: fake.url, userAgent: 'WASD Engine', catalogMaxAgeMs: 60_000, fetch: (input, init) => fetch(input, init), now: () => now, ...overrides })
}

/** A failed request as the plugin throws it: its own error, with the kit's request and its HTTP status as the cause. */
function refused(message: string, status: number): Record<string, unknown> {
  return { name: 'AmbientCgError', code: 'AMBIENTCG_REQUEST_FAILED', message, cause: { name: 'AssetLibraryRequestError', status } }
}

describe('AmbientCgApi', () => {
  it('lists the assets that have every keyword with the WASD Engine user agent, and skips entries it cannot read', async () => {
    const page = await api().search(['brick', 'wall'], KINDS, 10, 0, signal)
    expect(page.total).toBe(1)
    expect(page.assets).toEqual([{
      id: 'Bricks097',
      title: 'Bricks 097',
      kind: 'material',
      tags: ['97', 'brick', 'bricks', 'red', 'wall', 'bricks097'],
      maps: ['color', 'displacement', 'normal', 'roughness', 'ambient-occlusion'],
      technique: 'surface-photogrammetry',
      downloads: 62_514,
      released: '2026-10-24',
      sizeCm: [240, 120],
      archives: [
        { resolution: '1k', format: 'jpg', attributes: '1K-JPG', url: `${fake.origin}/get?file=Bricks097_1K-JPG.zip`, size: archiveBytes('Bricks097_1K-JPG.zip').byteLength },
        { resolution: '2k', format: 'jpg', attributes: '2K-JPG', url: `${fake.origin}/get?file=Bricks097_2K-JPG.zip`, size: archiveBytes('Bricks097_2K-JPG.zip').byteLength },
        { resolution: '1k', format: 'png', attributes: '1K-PNG', url: `${fake.origin}/get?file=Bricks097_1K-PNG.zip`, size: archiveBytes('Bricks097_1K-PNG.zip').byteLength },
      ],
      thumbnailUrl: `${fake.origin}/thumbs/512/Bricks097.jpg`,
    }])
    expect(fake.requests).toEqual([{
      url: '/api/v3/assets?q=brick+wall&type=material%2Cdecal%2Catlas%2Chdri&limit=10&include=type%2Ctitle%2Ctags%2Cdimensions%2CdownloadStatistics%2Cmaps%2Ctechnique%2CreleaseDate%2Cdownloads%2Cthumbnails',
      userAgent: 'WASD Engine',
    }])
  })

  it('offers only archives named by a resolution: an HDRI\'s exr ones, and no animated or Substance files', async () => {
    const all = await api().search([], KINDS, 10, 0, signal)
    expect(all.total).toBe(5)
    expect(all.assets.map(asset => [asset.id, asset.kind, asset.archives.map(archive => archive.attributes)])).toEqual([
      ['Bricks097', 'material', ['1K-JPG', '2K-JPG', '1K-PNG']],
      ['Leaking019C', 'decal', ['1K-JPG']],
      ['LeafSet030', 'atlas', ['1K-JPG']],
      ['EveningSkyHDRI049B', 'hdri', ['1K', '2K']],
      ['Wood099', 'material', ['1K-JPG', '2K-JPG']],
    ])
    expect(all.assets.find(asset => asset.id === 'EveningSkyHDRI049B')).toMatchObject({ maps: [], archives: [{ format: 'exr', resolution: '1k' }, { format: 'exr', resolution: '2k' }] })
    expect(all.assets.find(asset => asset.id === 'Wood099')?.sizeCm).toBeUndefined()
    expect((await api().search([], ['hdri'], 5, 1, signal)).assets).toEqual([])
  })

  it('answers a page and its assets from memory while they are fresh, reads them again after, and keeps the old answer when that fails', async () => {
    const client = api()
    await client.search(['wood'], ['material'], 10, 0, signal)
    now += 59_999
    await client.search(['wood'], ['material'], 10, 0, signal)
    expect((await client.asset('wood099', signal))?.title).toBe('Wood 099')
    expect(fake.requests).toHaveLength(1)
    now += 1
    fake.listStatus = 503
    expect((await client.search(['wood'], ['material'], 10, 0, signal)).total).toBe(1)
    expect((await client.asset('Wood099', signal))?.id).toBe('Wood099')
    expect(fake.requests).toHaveLength(3)
    await expect(api().search(['wood'], ['material'], 10, 0, signal)).rejects.toMatchObject(refused('ambientCG answered HTTP 503 for the asset list.', 503))
    fake.listStatus = 429
    await expect(api().asset('Wood099', signal)).rejects.toMatchObject(refused('ambientCG is limiting requests from this computer; try again in 12 seconds.', 429))
  })

  it('finds one asset by id in any letter case, reads it again once forgotten, and finds nothing for an id of another kind', async () => {
    const client = api()
    expect(await client.asset('leafset030', signal)).toMatchObject({ id: 'LeafSet030', kind: 'atlas' })
    await client.asset('LeafSet030', signal)
    expect(fake.requests.map(request => request.url.replace(/&include=.*$/u, ''))).toEqual(['/api/v3/assets?id=leafset030&type=material%2Cdecal%2Catlas%2Chdri'])
    client.forget('LEAFSET030')
    await client.asset('LeafSet030', signal)
    expect(fake.requests).toHaveLength(2)
    expect(await client.asset('BricksSubstance008', signal)).toBeUndefined()
    expect(await client.asset('Nothing001', signal)).toBeUndefined()
  })

  it('lists the categories of its kinds that hold assets, most assets first, once while they are fresh', async () => {
    const client = api()
    expect(await client.categories(signal)).toEqual([
      { title: 'Tiles', kind: 'material', count: 164 },
      { title: 'Day Sky HDRI', kind: 'hdri', count: 144 },
      { title: 'Bricks', kind: 'material', count: 132 },
      { title: 'Leaking', kind: 'decal', count: 39 },
      { title: 'Leaf Set', kind: 'atlas', count: 30 },
    ])
    await client.categories(signal)
    expect(fake.requests.map(request => request.url)).toEqual(['/api/v3/categories'])
    fake.categoriesStatus = 500
    await expect(api().categories(signal)).rejects.toMatchObject(refused('ambientCG answered HTTP 500 for the categories.', 500))
    now += 60_000
    expect(await client.categories(signal)).toHaveLength(5)
  })

  it('downloads preview images of supported types only', async () => {
    const image = await api().image(`${fake.origin}/thumbs/512/Wood099.jpg`, signal)
    expect(image).toEqual({ data: PREVIEW, mediaType: 'image/jpeg' })
    fake.previewType = 'text/html; charset=utf-8'
    await expect(api().image(`${fake.origin}/thumbs/512/Wood099.jpg`, signal)).rejects.toMatchObject(refused('ambientCG sent the preview image as text/html.', 200))
  })

  it('follows an archive\'s redirect on the same host, and refuses URLs and redirects that do not lead to ambientCG', async () => {
    const response = await api().download(`${fake.origin}/get?file=Wood099_1K-JPG.zip`, signal)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archiveBytes('Wood099_1K-JPG.zip'))
    expect(fake.requests.map(request => request.url)).toEqual(['/get?file=Wood099_1K-JPG.zip', '/file/download/Wood099_1K-JPG.zip'])
    for (const url of ['file:///etc/passwd', 'https://attacker.example/Wood099.zip', 'http://ambientcg.com/get?file=Wood099_1K-JPG.zip']) {
      await expect(api().download(url, signal)).rejects.toMatchObject(
        refused(`ambientCG named the archive ${url} at ${url}, which is not an ambientCG address, so nothing was downloaded from it.`, 0))
    }
    const fetched: string[] = []
    const redirecting = api({
      fetch: async (input) => {
        fetched.push(input instanceof Request ? input.url : input.toString())
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/stolen' } })
      },
    })
    await expect(redirecting.download('https://acg-download.struffelproductions.com/file/Wood099_1K-JPG.zip', signal)).rejects.toThrow('https://attacker.example/stolen, which is not an ambientCG address')
    expect(fetched).toEqual(['https://acg-download.struffelproductions.com/file/Wood099_1K-JPG.zip'])
  })

  it('reports an unreachable ambientCG and an answer in another format, and stops when cancelled', async () => {
    const offline = api({ fetch: () => Promise.reject(new TypeError('fetch failed')) })
    await expect(offline.search([], KINDS, 10, 0, signal)).rejects.toMatchObject(refused(`Could not reach ambientCG at ${new URL(fake.url).host} for the asset list: fetch failed`, 0))
    const strange = api({ fetch: () => Promise.resolve(Response.json({ assets: 'none' })) })
    await expect(strange.search([], KINDS, 10, 0, signal)).rejects.toMatchObject(
      { name: 'AmbientCgError', code: 'AMBIENTCG_REQUEST_FAILED', message: 'ambientCG sent the asset list in an unknown format.' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled by the test'))
    await expect(api().categories(controller.signal)).rejects.toThrow('cancelled by the test')
  })
})
