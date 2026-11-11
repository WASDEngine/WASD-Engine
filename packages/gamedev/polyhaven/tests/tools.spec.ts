/**
 * The Poly Haven tools as a Session's agent calls them: the real tool runtime and executor run each call against a
 * fake Poly Haven, previews become attachments for a model that accepts images, and downloads land in the Session's
 * working directory.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as PolyHaven from '../src/index.ts'
import { callTool, compose, text, type Composition } from './composition.ts'
import { fileBytes, PREVIEW } from './fixtures.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(config: Parameters<typeof compose>[0] = {}): Promise<Composition> {
  composition = await compose(config)
  return composition
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()
}

describe('polyhaven_search', () => {
  it('lists the API\'s ranking with each asset\'s facts, and only assets the list holds', async () => {
    const current = await composed()
    const result = await callTool(current, 'polyhaven_search', { query: 'Chair', type: 'models' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'Poly Haven models for "Chair", most relevant first: 1 found.',
      'Showing 1–1. Every Poly Haven asset is CC0: free for any use, also commercial, without attribution.',
      '- WoodenChair_01: Wooden Chair 01 (model; Furniture/Seating/Chairs; up to 2k; 0.688 × 0.658 × 2.27 m; 19,992 polygons). An ornate wooden chair.',
      'polyhaven_asset shows an asset\'s files and preview; polyhaven_download saves it into the project.',
    ].join('\n'))
    expect(current.fake.requests.map(request => [request.url, request.userAgent])).toEqual([
      ['/assets?type=all', 'WASD Engine'],
      ['/search?q=chair&t=models', 'WASD Engine'],
    ])
    // The fake ranks an entry the list cannot read; the result leaves it out.
    expect(await callTool(current, 'polyhaven_search', { query: 'future' })).toMatchObject({ isError: false, value: { total: 0, assets: [] } })
  })

  it('lists the most downloaded assets and their categories without a query, and narrows them by category and type', async () => {
    const current = await composed()
    const browse = await callTool(current, 'polyhaven_search', {})
    expect(browse).toMatchObject({
      isError: false,
      value: {
        query: '',
        total: 3,
        offset: 0,
        categories: [{ path: 'Furniture', count: 1 }, { path: 'Mountains & Hills', count: 1 }, { path: 'Stone', count: 1 }],
      },
    })
    expect(browse.isError ? [] : (browse.value as { assets: Array<{ id: string }> }).assets.map(asset => asset.id)).toEqual(['mossy_rock', 'kiara_8_sunset', 'WoodenChair_01'])
    expect(text(browse)).toContain('Categories: Furniture (1), Mountains & Hills (1), Stone (1).')
    const seating = await callTool(current, 'polyhaven_search', { category: ' furniture / Seating ' })
    expect(seating).toMatchObject({ value: { category: 'furniture / Seating', total: 1, assets: [{ id: 'WoodenChair_01' }], categories: [{ path: 'Furniture/Seating/Chairs', count: 1 }] } })
    expect(text(seating)).toContain('Most downloaded Poly Haven assets in furniture / Seating: 1 in all.')
    expect(await callTool(current, 'polyhaven_search', { type: 'hdris' })).toMatchObject({ value: { total: 1, assets: [{ id: 'kiara_8_sunset', type: 'hdri' }] } })
    expect(current.fake.requests.filter(request => request.url.startsWith('/search'))).toEqual([])
  })

  it('pages with offset and limit, and refuses limits outside 1 to 50', async () => {
    const current = await composed()
    const page = await callTool(current, 'polyhaven_search', { limit: 1, offset: 1 })
    expect(page).toMatchObject({ value: { total: 3, offset: 1, assets: [{ id: 'kiara_8_sunset' }] } })
    expect(text(page)).toContain('Showing 2–2.')
    expect(text(page)).toContain('More: pass offset 2.')
    expect(text(await callTool(current, 'polyhaven_search', { offset: 5 }))).toContain('No results at offset 5; pass a smaller offset.')
    for (const limit of [0, 51]) {
      const refused = await callTool(current, 'polyhaven_search', { limit })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toContain('limit must be an integer from 1 to 50.')
    }
    expect(text(await callTool(current, 'polyhaven_search', { limit: 2.5 }))).toContain('"limit" must be an integer')
  })

  it('ranks by keywords itself when Poly Haven cannot rank the query', async () => {
    const current = await composed()
    current.fake.searchStatus = 503
    const result = await callTool(current, 'polyhaven_search', { query: 'golden sunset' })
    expect(result).toMatchObject({ isError: false, value: { total: 1, assets: [{ id: 'kiara_8_sunset' }] } })
    current.fake.searchStatus = 429
    const limited = await callTool(current, 'polyhaven_search', { query: 'rock' })
    expect(limited.isError).toBe(true)
    expect(text(limited)).toContain('Poly Haven is limiting requests from this computer; try again in 12 seconds.')
  })
})

describe('polyhaven_asset', () => {
  it('lists an asset\'s formats, sizes, and maps, and shows its preview to a model that accepts images', async () => {
    const current = await composed()
    const result = await callTool(current, 'polyhaven_asset', { id: 'mossy_rock' })
    expect(result.isError).toBe(false)
    const shown = text(result)
    expect(shown).toContain('Mossy Rock (mossy_rock): Poly Haven texture, Stone/Rock & Cliffs/Mossy Rock, license CC0-1.0, by Rob Tuytel. https://polyhaven.com/a/mossy_rock')
    expect(shown).toContain('Size: 3 × 3 m. Tags: moss, rock.')
    expect(shown).toContain('Files for polyhaven_download, by format and resolution:\n- jpg maps: 1k 5 KB, 2k 5 KB\n- exr maps: 1k 5 KB, 2k 5 KB\n- gltf: 1k 4 KB\n- blend: 1k 3 KB')
    expect(shown).toContain('Maps of the jpg, png, and exr formats: Diffuse, nor_dx, nor_gl, Rough, AO. Without maps, a download takes all but nor_dx; the sizes above count those.')
    expect(result.content.at(-1)).toMatchObject({ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', name: 'polyhaven-mossy_rock.jpg' } })
    expect(current.saved).toEqual([{ data: PREVIEW, mediaType: 'image/jpeg', name: 'polyhaven-mossy_rock.jpg' }])
    const thumbnail = current.fake.requests.find(request => request.url.startsWith('/thumbs/'))
    expect(new URL(thumbnail?.url ?? '', current.fake.url).searchParams.toString()).toBe('width=512&height=512&format=jpeg&v=1')
  })

  it('shows no preview to a model without image input, or when the call turns it off, and names why a preview failed', async () => {
    const current = await composed()
    const blind = await callTool(current, 'polyhaven_asset', { id: 'kiara_8_sunset' }, current.blind)
    expect(blind.content.map(block => block.type)).toEqual(['text'])
    expect(await callTool(current, 'polyhaven_asset', { id: 'kiara_8_sunset', preview: false })).toMatchObject({ isError: false })
    expect(current.fake.requests.filter(request => request.url.startsWith('/thumbs/'))).toEqual([])
    expect(current.saved).toEqual([])
    current.fake.previewType = 'text/html'
    const failed = await callTool(current, 'polyhaven_asset', { id: 'kiara_8_sunset' })
    expect(failed.isError).toBe(false)
    expect(text(failed)).toContain('- hdr: 1k 1 KB, 2k 1 KB\n- exr: 1k 1 KB, 2k 1 KB')
    expect(text(failed)).toContain('The preview image could not be shown: Poly Haven sent the preview image as text/html.')
  })

  it('finds an id in any letter case, and names a missing or malformed id', async () => {
    const current = await composed()
    expect(await callTool(current, 'polyhaven_asset', { id: 'woodenchair_01', preview: false })).toMatchObject({ value: { id: 'WoodenChair_01', polycount: 19_992 } })
    expect(text(await callTool(current, 'polyhaven_asset', { id: 'nothing' }))).toContain('Poly Haven has no asset with the id "nothing"; find one with polyhaven_search.')
    expect(text(await callTool(current, 'polyhaven_asset', { id: '../etc' }))).toContain('"../etc" is not a Poly Haven asset id')
  })
})

describe('polyhaven_download', () => {
  it('saves a model with its buffer and textures in assets/polyhaven/<id> of the working directory', async () => {
    const current = await composed()
    const result = await callTool(current, 'polyhaven_download', { id: 'WoodenChair_01' })
    expect(result.isError).toBe(false)
    const directory = join(current.work, 'assets', 'polyhaven', 'WoodenChair_01')
    expect(await files(directory)).toEqual(['WoodenChair_01.bin', 'WoodenChair_01_1k.gltf', join('textures', 'WoodenChair_01_diff_1k.jpg')])
    expect(await readFile(join(directory, 'textures', 'WoodenChair_01_diff_1k.jpg'))).toEqual(fileBytes('WoodenChair_01/WoodenChair_01_diffuse_1k.jpg'))
    expect(result).toMatchObject({ value: { directory, format: 'gltf', resolution: '1k', entry: 'WoodenChair_01_1k.gltf', license: 'CC0-1.0', authors: ['Jake Mobley'] } })
    expect(text(result)).toBe([
      `Saved Wooden Chair 01 (Poly Haven model WoodenChair_01, gltf at 1k) in ${directory}: 3 files, 5 KB (3 downloaded).`,
      'Open WoodenChair_01_1k.gltf.',
      'Files: WoodenChair_01_1k.gltf, WoodenChair_01.bin, textures/WoodenChair_01_diff_1k.jpg.',
      'Source: https://polyhaven.com/a/WoodenChair_01, by Jake Mobley; license CC0-1.0, no attribution required. Record the source with the asset.',
      'Godot imports the .gltf file as a scene to instance; in Blender, import it with bpy.ops.import_scene.gltf.',
    ].join('\n'))
    const downloads = current.fake.requests.filter(request => request.url.startsWith('/dl/'))
    expect(downloads.map(request => request.userAgent)).toEqual(['WASD Engine', 'WASD Engine', 'WASD Engine'])
    const again = await callTool(current, 'polyhaven_download', { id: 'WoodenChair_01' })
    expect(text(again)).toContain('(3 already in place)')
  })

  it('saves texture maps and HDRIs into a folder the call names, in the format and resolution it names', async () => {
    const current = await composed()
    const maps = await callTool(current, 'polyhaven_download', { id: 'mossy_rock', format: 'EXR', resolution: '2k', maps: ['Diffuse', 'nor_gl'], directory: 'art/rock' })
    expect(maps.isError).toBe(false)
    expect(await files(join(current.work, 'art', 'rock'))).toEqual(['mossy_rock_diffuse_2k.exr', 'mossy_rock_nor_gl_2k.exr'])
    expect(text(maps)).toContain('nor_gl the OpenGL normal map that Godot and Blender read')
    const sky = await callTool(current, 'polyhaven_download', { id: 'kiara_8_sunset', directory: join(current.work, 'sky') })
    expect(await files(join(current.work, 'sky'))).toEqual(['kiara_8_sunset_1k.hdr'])
    expect(text(sky)).toContain('PanoramaSkyMaterial')
  })

  it('refuses a download over the size limit, and writes nothing when a file arrives damaged', async () => {
    const current = await composed({ maxDownloadBytes: 1000 })
    const large = await callTool(current, 'polyhaven_download', { id: 'WoodenChair_01' })
    expect(large.isError).toBe(true)
    expect(text(large)).toContain('This download of Wooden Chair 01 is 5 KB, more than the 1 KB that one download may be; choose a lower resolution or another format.')
    await current.unload()
    composition = undefined
    await current.cleanup()
    const damaged = await composed()
    damaged.fake.damaged.add('WoodenChair_01/WoodenChair_01.bin')
    const failed = await callTool(damaged, 'polyhaven_download', { id: 'WoodenChair_01' })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('WoodenChair_01.bin arrived damaged: its MD5 digest differs from Poly Haven\'s; the download stopped.')
    expect(await readdir(damaged.work)).toEqual(['assets'])
    expect(await files(damaged.work)).toEqual([])
  })
})

describe('the plugin', () => {
  it('withdraws its tools when it is disposed', async () => {
    const current = await composed()
    expect(['polyhaven_search', 'polyhaven_asset', 'polyhaven_download'].map(name => current.ctx.tools.get(name) !== undefined)).toEqual([true, true, true])
    await current.unload()
    expect(['polyhaven_search', 'polyhaven_asset', 'polyhaven_download'].map(name => current.ctx.tools.get(name))).toEqual([undefined, undefined, undefined])
  })

  it('validates its configuration, and fails to load with an API URL that does not parse', () => {
    expect(PolyHaven.Config({})).toEqual({
      apiUrl: 'https://api.polyhaven.com', userAgent: 'WASD Engine', requestTimeoutMs: 30_000, downloadTimeoutMs: 600_000,
      maxDownloadBytes: 1_073_741_824, catalogMaxAgeMs: 43_200_000,
    })
    for (const invalid of [{ apiUrl: 'ftp://polyhaven.test' }, { userAgent: '' }, { requestTimeoutMs: 0 }, { downloadTimeoutMs: 2_147_483_648 }, { maxDownloadBytes: 0 }]) {
      expect(() => PolyHaven.Config(invalid), JSON.stringify(invalid)).toThrow()
    }
    expect(() => { PolyHaven.apply(new Context(), PolyHaven.Config({ apiUrl: 'http://[' })) }).toThrow('Poly Haven plugin: apiUrl must be an HTTP or HTTPS URL, got "http://[".')
  })
})
