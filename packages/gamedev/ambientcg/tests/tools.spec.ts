/**
 * The ambientCG tools as a Session's agent calls them: the real tool runtime and executor run each call against a
 * fake ambientCG, previews become attachments for a model that accepts images, and downloads land in the Session's
 * working directory.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as AmbientCg from '../src/index.ts'
import { callTool, compose, text, type Composition } from './composition.ts'
import { archiveBytes, pictureBytes, PREVIEW } from './fixtures.ts'

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

const TOOLS = ['ambientcg_search', 'ambientcg_asset', 'ambientcg_download']

describe('ambientcg_search', () => {
  it('lists the assets that have every keyword, most popular first, with each asset\'s facts and tags', async () => {
    const current = await composed()
    const result = await callTool(current, 'ambientcg_search', { query: 'Brick, WALL', type: 'materials' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'ambientCG materials for "brick wall", most popular first: 1 found.',
      'Showing 1–1. Every ambientCG asset is CC0: free for any use, also commercial, without attribution.',
      '- Bricks097: Bricks 097 (material; 2.4 × 1.2 m; scanned; up to 2k; maps color, displacement, normal, roughness, ambient-occlusion). Tags: brick, bricks, red, wall.',
      'ambientcg_asset shows an asset\'s file sizes and preview; ambientcg_download saves it into the project.',
    ].join('\n'))
    expect(current.fake.requests.map(request => [request.url.replace(/&include=.*$/u, ''), request.userAgent])).toEqual([
      ['/api/v3/assets?q=brick+wall&type=material&limit=10', 'WASD Engine'],
    ])
  })

  it('ranks the assets that have some of the words when none has them all', async () => {
    const current = await composed()
    const result = await callTool(current, 'ambientcg_search', { query: 'wooden planks leaf' })
    expect(result).toMatchObject({ isError: false, value: { query: 'wooden planks leaf', total: 2, relaxed: true, assets: [{ id: 'LeafSet030' }, { id: 'Wood099' }] } })
    expect(text(result)).toContain('No ambientCG asset has every word of "wooden planks leaf"; these have some of them, most words first: 2 found.')
    expect(text(result)).toContain('- Wood099: Wood 099 (material; from a photo; up to 2k; maps color, displacement, normal, roughness). Tags: pattern, wood, planks.')
    // One request for all the words, then one for each word, the longest first.
    expect(current.fake.requests.map(request => new URL(request.url, current.fake.origin).searchParams.get('q'))).toEqual(['wooden planks leaf', 'wooden', 'planks', 'leaf'])
    // A word that fewer assets have counts for more than one that many have.
    expect(await callTool(current, 'ambientcg_search', { query: 'red sunset food' })).toMatchObject({ value: { relaxed: true, assets: [{ id: 'EveningSkyHDRI049B' }, { id: 'Bricks097' }, { id: 'LeafSet030' }] } })
    const none = await callTool(current, 'ambientcg_search', { query: 'purple dragon', type: 'hdris' })
    expect(none).toMatchObject({ isError: false, value: { total: 0, assets: [] } })
    expect(text(none)).toContain('ambientCG HDRIs for "purple dragon", most popular first: 0 found.\nNothing matches; try fewer or other English keywords in their plain form, such as wood instead of wooden, or another type.')
  })

  it('lists the most popular assets and the kinds to search for without a query, and narrows both by type', async () => {
    const current = await composed()
    const browse = await callTool(current, 'ambientcg_search', {})
    expect(browse).toMatchObject({ isError: false, value: { query: '', total: 5, offset: 0 } })
    expect(browse.isError ? [] : (browse.value as { assets: Array<{ id: string }> }).assets.map(asset => asset.id)).toEqual(['Bricks097', 'Leaking019C', 'LeafSet030', 'EveningSkyHDRI049B', 'Wood099'])
    expect(text(browse)).toContain('Most popular ambientCG assets: 5 in all.')
    expect(text(browse)).toContain('- EveningSkyHDRI049B: Evening Sky HDRI 049 B (HDRI; up to 2k). Tags: evening, hdri, sky, sunset.')
    expect(text(browse)).toContain('Kinds to search for: Tiles (164), Day Sky HDRI (144), Bricks (132), Leaking (39), Leaf Set (30).')
    const decals = await callTool(current, 'ambientcg_search', { type: 'decals' })
    expect(decals).toMatchObject({ value: { type: 'decals', total: 1, assets: [{ id: 'Leaking019C', type: 'decal', made: 'procedural' }], categories: [{ name: 'Leaking', type: 'decal', count: 39 }] } })
    expect(text(decals)).toContain('Most popular ambientCG decals: 1 in all.')
  })

  it('pages with offset and limit, and refuses limits outside 1 to 50', async () => {
    const current = await composed()
    const page = await callTool(current, 'ambientcg_search', { limit: 2, offset: 1 })
    expect(page).toMatchObject({ value: { total: 5, offset: 1, assets: [{ id: 'Leaking019C' }, { id: 'LeafSet030' }] } })
    expect(text(page)).toContain('Showing 2–3.')
    expect(text(page)).toContain('More: pass offset 3.')
    expect(text(await callTool(current, 'ambientcg_search', { offset: 9 }))).toContain('No results at offset 9; pass a smaller offset.')
    for (const limit of [0, 51]) {
      const refused = await callTool(current, 'ambientcg_search', { limit })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toContain('limit must be an integer from 1 to 50.')
    }
    current.fake.listStatus = 429
    const limited = await callTool(current, 'ambientcg_search', { query: 'rust' })
    expect(limited.isError).toBe(true)
    expect(text(limited)).toContain('ambientCG is limiting requests from this computer; try again in 12 seconds.')
  })
})

describe('ambientcg_asset', () => {
  it('lists an asset\'s facts and archives, and shows its preview to a model that accepts images', async () => {
    const current = await composed()
    const result = await callTool(current, 'ambientcg_asset', { id: 'bricks097' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'Bricks 097 (Bricks097): ambientCG material, license CC0-1.0. https://ambientcg.com/a/Bricks097',
      'One repeat covers 2.4 × 1.2 m. Made: scanned. Tags: brick, bricks, red, wall.',
      'Maps: color, displacement, normal, roughness, ambient-occlusion.',
      'Archives for ambientcg_download, by picture format and resolution:',
      '- jpg: 1k 2 KB, 2k 9 KB',
      '- png: 1k 9 KB',
      'A download fetches one archive and writes its map pictures: every map but the DirectX normal map, unless maps names others.',
    ].join('\n'))
    expect(result).toMatchObject({ value: { released: '2026-10-24', maxResolution: '2k', sizeM: [2.4, 1.2] } })
    expect(result.content.at(-1)).toMatchObject({ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', name: 'ambientcg-Bricks097.jpg' } })
    expect(current.saved).toEqual([{ data: PREVIEW, mediaType: 'image/jpeg', name: 'ambientcg-Bricks097.jpg' }])
    expect(current.fake.requests.map(request => request.url.replace(/&include=.*$/u, ''))).toEqual(['/api/v3/assets?id=bricks097&type=material%2Cdecal%2Catlas%2Chdri', '/thumbs/512/Bricks097.jpg'])
  })

  it('shows no preview to a model without image input, or when the call turns it off, and names why a preview failed', async () => {
    const current = await composed()
    const blind = await callTool(current, 'ambientcg_asset', { id: 'EveningSkyHDRI049B' }, current.blind)
    expect(blind.content.map(block => block.type)).toEqual(['text'])
    expect(text(blind)).toContain('- exr: 1k 6 KB, 2k 1 KB\nA download fetches one archive and writes its exr panorama.')
    expect(await callTool(current, 'ambientcg_asset', { id: 'EveningSkyHDRI049B', preview: false })).toMatchObject({ isError: false })
    expect(current.fake.requests.filter(request => request.url.startsWith('/thumbs/'))).toEqual([])
    expect(current.saved).toEqual([])
    current.fake.previewType = 'text/html'
    const failed = await callTool(current, 'ambientcg_asset', { id: 'EveningSkyHDRI049B' })
    expect(failed.isError).toBe(false)
    expect(text(failed)).toContain('The preview image could not be shown: ambientCG sent the preview image as text/html.')
  })

  it('names a missing id, an id of a kind the tools do not offer, and a malformed id', async () => {
    const current = await composed()
    expect(text(await callTool(current, 'ambientcg_asset', { id: 'Nothing001' }))).toContain('ambientCG has no material, decal, atlas, or HDRI with the id "Nothing001"; find one with ambientcg_search.')
    expect(text(await callTool(current, 'ambientcg_asset', { id: 'BricksSubstance008' }))).toContain('ambientCG has no material, decal, atlas, or HDRI with the id "BricksSubstance008"')
    expect(text(await callTool(current, 'ambientcg_asset', { id: '../etc' }))).toContain('"../etc" is not an ambientCG asset id')
  })
})

describe('ambientcg_download', () => {
  it('saves a material\'s maps in assets/ambientcg/<id> of the working directory, and nothing else of its archive', async () => {
    const current = await composed()
    const result = await callTool(current, 'ambientcg_download', { id: 'Bricks097' })
    expect(result.isError).toBe(false)
    const directory = join(current.work, 'assets', 'ambientcg', 'Bricks097')
    const names = ['AmbientOcclusion', 'Color', 'Displacement', 'NormalGL', 'Roughness'].map(map => `Bricks097_1K-JPG_${map}.jpg`)
    expect(await files(directory)).toEqual(names)
    expect(await readFile(join(directory, 'Bricks097_1K-JPG_NormalGL.jpg'))).toEqual(pictureBytes('Bricks097_1K-JPG_NormalGL.jpg'))
    expect(result).toMatchObject({ value: { directory, format: 'jpg', resolution: '1k', license: 'CC0-1.0', sizeM: [2.4, 1.2], downloadedBytes: archiveBytes('Bricks097_1K-JPG.zip').byteLength } })
    expect(text(result)).toBe([
      `Saved Bricks 097 (ambientCG material Bricks097, jpg at 1k) in ${directory}: 5 files, 5 KB (5 downloaded).`,
      // The archive lists Color first; the fake packs the maps in the order of its list.
      `Files: ${['Color', 'Displacement', 'NormalGL', 'Roughness', 'AmbientOcclusion'].map(map => `Bricks097_1K-JPG_${map}.jpg`).join(', ')}.`,
      'Source: https://ambientcg.com/a/Bricks097; license CC0-1.0, no attribution required. Record the source with the asset.',
      'Color is the base color, Displacement the height, NormalGL the OpenGL normal map that Godot and Blender read, Roughness the roughness, '
      + 'and AmbientOcclusion the ambient occlusion. One repeat covers 2.4 × 1.2 m.',
    ].join('\n'))
    const downloads = current.fake.requests.filter(request => request.url.startsWith('/get') || request.url.startsWith('/file/'))
    expect(downloads).toEqual([
      { url: '/get?file=Bricks097_1K-JPG.zip', userAgent: 'WASD Engine' },
      { url: '/file/download/Bricks097_1K-JPG.zip', userAgent: 'WASD Engine' },
    ])
    const again = await callTool(current, 'ambientcg_download', { id: 'Bricks097' })
    expect(text(again)).toContain('(5 already in place)')
    expect(again).toMatchObject({ value: { downloadedBytes: 0 } })
    expect(current.fake.requests.filter(request => request.url.startsWith('/get'))).toHaveLength(1)
  })

  it('saves the maps, format, and resolution a call names into the folder it names, and an HDRI\'s panorama', async () => {
    const current = await composed()
    const maps = await callTool(current, 'ambientcg_download', { id: 'bricks097', format: 'PNG', maps: ['color', 'normal', 'NormalDX'], directory: 'art/bricks' })
    expect(maps.isError).toBe(false)
    expect(await files(join(current.work, 'art', 'bricks'))).toEqual(['Bricks097_1K-PNG_Color.png', 'Bricks097_1K-PNG_NormalDX.png', 'Bricks097_1K-PNG_NormalGL.png'])
    expect(maps).toMatchObject({ value: { format: 'png', maps: ['Color', 'NormalDX', 'NormalGL'] } })
    expect(text(maps)).toContain('Color is the base color, NormalDX the DirectX normal map, which Godot and Blender do not read, and NormalGL the OpenGL normal map')
    const sky = await callTool(current, 'ambientcg_download', { id: 'EveningSkyHDRI049B', resolution: '2K', directory: join(current.work, 'sky') })
    expect(await files(join(current.work, 'sky'))).toEqual(['EveningSkyHDRI049B_2K_HDR.exr'])
    expect(text(sky)).toContain('Saved Evening Sky HDRI 049 B (ambientCG HDRI EveningSkyHDRI049B, exr at 2k)')
    expect(text(sky)).toContain('PanoramaSkyMaterial')
    const leaves = await callTool(current, 'ambientcg_download', { id: 'LeafSet030', maps: ['color', 'opacity'], directory: 'leaves' })
    expect(await files(join(current.work, 'leaves'))).toEqual(['LeafSet030_1K-JPG_Color.jpg', 'LeafSet030_1K-JPG_Opacity.jpg'])
    expect(text(leaves)).toContain('\nColor is the base color and Opacity the transparency, which belongs in the material\'s alpha.')
    expect(text(leaves)).not.toContain('One repeat covers')
  })

  it('refuses what the asset lacks before it downloads, and a download over the size limit', async () => {
    const current = await composed({ maxDownloadBytes: 1000 })
    expect(text(await callTool(current, 'ambientcg_download', { id: 'Wood099', resolution: '8k' }))).toContain('Wood 099 has no 8k in jpg; it offers: 1k, 2k.')
    expect(text(await callTool(current, 'ambientcg_download', { id: 'Wood099', maps: ['metalness'] }))).toContain('Wood 099 has no "metalness" map; its maps are: color, displacement, normal, roughness.')
    const large = await callTool(current, 'ambientcg_download', { id: 'Bricks097', format: 'png' })
    expect(large.isError).toBe(true)
    expect(text(large)).toContain('The 1k png archive of Bricks 097 is 9 KB, more than the 1 KB that one download may be; choose a lower resolution or jpg.')
    expect(current.fake.requests.filter(request => request.url.startsWith('/get'))).toEqual([])
  })

  it('keeps a changed map unless replace is true, and writes nothing when the archive arrives damaged', async () => {
    const current = await composed()
    const directory = join(current.work, 'assets', 'ambientcg', 'Wood099')
    await callTool(current, 'ambientcg_download', { id: 'Wood099' })
    await writeFile(join(directory, 'Wood099_1K-JPG_Color.jpg'), 'edited by the user')
    const kept = await callTool(current, 'ambientcg_download', { id: 'Wood099' })
    expect(kept.isError).toBe(true)
    expect(text(kept)).toContain('already exists with other contents: Wood099_1K-JPG_Color.jpg. Pass replace: true to overwrite it')
    const replaced = await callTool(current, 'ambientcg_download', { id: 'Wood099', replace: true })
    expect(text(replaced)).toContain('(1 replaced, 3 already in place)')
    expect(await readFile(join(directory, 'Wood099_1K-JPG_Color.jpg'))).toEqual(pictureBytes('Wood099_1K-JPG_Color.jpg'))
    current.fake.damaged.add('Leaking019C_1K-JPG.zip')
    const damaged = await callTool(current, 'ambientcg_download', { id: 'Leaking019C' })
    expect(damaged.isError).toBe(true)
    expect(text(damaged)).toContain('The archive of Leaking 019 C arrived damaged: its SHA-1 digest differs from ambientCG\'s; nothing was saved.')
    current.fake.digests = false
    const unchecked = await callTool(current, 'ambientcg_download', { id: 'Leaking019C' })
    expect(text(unchecked)).toContain('Leaking019C_1K-JPG_Color.jpg arrived damaged: its checksum differs from the archive\'s; nothing was saved.')
    // The failed downloads leave no folder of their own beside the earlier download's.
    expect(await readdir(join(current.work, 'assets', 'ambientcg'))).toEqual(['Wood099'])
  })

  it('reads an asset again after its archive no longer fits its listing', async () => {
    const current = await composed()
    current.fake.listedSizeOffset = 7
    const stale = await callTool(current, 'ambientcg_download', { id: 'Wood099' })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('ambientCG\'s files of Wood 099 differ from its listing, as after an update of the asset; nothing was saved. Call again to read the new listing.')
    current.fake.listedSizeOffset = 0
    const fresh = await callTool(current, 'ambientcg_download', { id: 'Wood099' })
    expect(fresh.isError).toBe(false)
    expect(current.fake.requests.filter(request => request.url.startsWith('/api/v3/assets'))).toHaveLength(2)
  })
})

describe('the plugin', () => {
  it('withdraws its tools when it is disposed', async () => {
    const current = await composed()
    expect(TOOLS.map(name => current.ctx.tools.get(name) !== undefined)).toEqual([true, true, true])
    await current.unload()
    expect(TOOLS.map(name => current.ctx.tools.get(name))).toEqual([undefined, undefined, undefined])
  })

  it('validates its configuration, and fails to load with an API URL that does not parse', () => {
    expect(AmbientCg.Config({})).toEqual({
      apiUrl: 'https://ambientcg.com/api/v3', userAgent: 'WASD Engine', requestTimeoutMs: 30_000, downloadTimeoutMs: 600_000,
      maxDownloadBytes: 1_073_741_824, catalogMaxAgeMs: 43_200_000,
    })
    for (const invalid of [{ apiUrl: 'ftp://ambientcg.test' }, { userAgent: '' }, { requestTimeoutMs: 0 }, { downloadTimeoutMs: 2_147_483_648 }, { maxDownloadBytes: 0 }]) {
      expect(() => AmbientCg.Config(invalid), JSON.stringify(invalid)).toThrow()
    }
    expect(() => { AmbientCg.apply(new Context(), AmbientCg.Config({ apiUrl: 'http://[' })) }).toThrow('ambientCG plugin: apiUrl must be an HTTP or HTTPS URL, got "http://[".')
  })
})
