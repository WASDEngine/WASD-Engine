/**
 * Reference searches over a fake web: pages read for their images, images downloaded into the cache, the same picture
 * kept once, failures counted, and the chosen images saved into a game project with their sources.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ReferenceCache, ReferenceFinder, type CachedImage, type FinderLimits, type SearchWeb, type WebSearchHit } from '../src/finder.ts'
import { MAX_ANIMATION_PIXELS } from '../src/images.ts'
import { prepareReference, saveReferences, subjectFolder, type PreparedReference } from '../src/save.ts'
import { animatedGif, FakeWeb, patternImage, previewPage } from './fixtures.ts'

const LIMITS: FinderLimits = {
  resultsPerQuery: 8, maxCandidates: 16, pageTimeoutMs: 5000, imageTimeoutMs: 5000, maxPageBytes: 64 * 1024,
  maxImageBytes: 1024 * 1024, minImageEdge: 24, sheetCell: 96, sheetColumns: 4, concurrency: 3,
}

const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function temporary(name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `dsh-art-references-${name}-`))
  folders.push(folder)
  return folder
}

/** A web search that answers each query from a table and records the queries. */
function searchOf(results: Readonly<Record<string, readonly WebSearchHit[]>>, asked: string[] = []): SearchWeb {
  return (query, maxResults) => {
    asked.push(`${query} (${maxResults})`)
    const hits = results[query]
    return hits === undefined ? Promise.reject(new Error(`search failed for ${query}`)) : Promise.resolve(hits)
  }
}

/** Failures the finders of a spec reported as unexpected. */
const reported: unknown[] = []

afterEach(() => {
  reported.length = 0
})

async function finder(web: FakeWeb, search: SearchWeb, limits: Partial<FinderLimits> = {}): Promise<ReferenceFinder> {
  return new ReferenceFinder(web, search, new ReferenceCache(await temporary('cache'), 24 * 60 * 60 * 1000), { ...LIMITS, ...limits }, (error) => { reported.push(error) })
}

/** A JPEG cut short: its header reads, its pixels do not decode. */
async function cutJpeg(seed: number): Promise<Buffer> {
  const jpeg = await patternImage(400, 300, seed, 'jpeg')
  return jpeg.subarray(0, Math.floor(jpeg.length * 0.6))
}

const FRAMES = { maxFrames: 24, maxEdge: 512, maxPixels: MAX_ANIMATION_PIXELS }

/** Prepare downloaded images for a save. */
async function prepared(images: readonly CachedImage[]): Promise<PreparedReference[]> {
  return await Promise.all(images.map(image => prepareReference(image, FRAMES, new AbortController().signal)))
}

/** Every file under a folder, relative to it, in order. */
async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1)).sort()
}

describe('ReferenceFinder.find', () => {
  it('takes each search result\'s preview image, its video, and direct image results, numbered in search order', async () => {
    const web = new FakeWeb()
      .page('https://itch.example/knight', previewPage('Pixel Knight Pack', '/cover.png'))
      .image('https://itch.example/cover.png', await patternImage(320, 256, 1))
      .page('https://video.example/watch?v=1', previewPage('Knight walk cycle', 'https://img.video.example/1.jpg', 'https://video.example/embed/1'))
      .image('https://img.video.example/1.jpg', await patternImage(480, 360, 2, 'jpeg'), 'image/jpeg')
      .image('https://gifs.example/slash.gif', await animatedGif(64, 64, [80, 80, 160], 3), 'image/gif')
      .page('https://forum.example/thread', '<title>Forum thread</title><body><img src="/banner.png" width="600" height="200"></body>')
      .image('https://forum.example/banner.png', await patternImage(600, 200, 4))
    const asked: string[] = []
    const search = searchOf({
      'knight pixel art': [{ url: 'https://itch.example/knight', title: 'Knight — itch' }, { url: 'https://gifs.example/slash.gif', title: 'Slash' }],
      'knight walk cycle': [{ url: 'https://video.example/watch?v=1' }, { url: 'https://forum.example/thread' }],
    }, asked)
    const references = await finder(web, search)
    const found = await references.find({ queries: ['knight pixel art', 'knight walk cycle'], pages: [] }, new AbortController().signal)
    expect(asked).toEqual(['knight pixel art (8)', 'knight walk cycle (8)'])
    const listed = found.candidates.map(({ number, title, site, format, width, height, frames, video }) =>
      ({ number, title, site, format, width, height, frames, video }))
    expect(listed).toEqual([
      { number: 1, title: 'Pixel Knight Pack', site: 'itch.example', format: 'png', width: 320, height: 256, frames: 1, video: undefined },
      { number: 2, title: 'Knight walk cycle', site: 'video.example', format: 'jpeg', width: 480, height: 360, frames: 1, video: 'https://video.example/embed/1' },
      { number: 3, title: 'Slash', site: 'gifs.example', format: 'gif', width: 64, height: 64, frames: 3, video: undefined },
      { number: 4, title: 'Forum thread', site: 'forum.example', format: 'png', width: 600, height: 200, frames: 1, video: undefined },
    ])
    expect(found.candidates[2]?.delays).toEqual([80, 80, 160])
    expect(found.candidates[0]?.page).toBe('https://itch.example/knight')
    expect(found.candidates[2]?.page).toBe('https://gifs.example/slash.gif')
    expect([found.pages, found.unusable, found.duplicates]).toEqual([3, 0, 0])
    const sheet = found.sheet
    expect(sheet?.path.startsWith(join(references.cache.folder, 'sheets'))).toBe(true)
    expect((await sharp(await readFile(sheet?.path as string)).metadata()).format).toBe('jpeg')
    expect([sheet?.width, sheet?.height]).toEqual([8 + 4 * 104, 8 + 104])
  })

  it('keeps the same picture once, counts pages and images without a usable image, and drops tiny images', async () => {
    const web = new FakeWeb()
      .page('https://a.example/', previewPage('Original', 'https://a.example/big.png'))
      .image('https://a.example/big.png', await patternImage(800, 600, 9))
      .page('https://b.example/', previewPage('Repost', 'https://b.example/small.jpg'))
      .image('https://b.example/small.jpg', await patternImage(400, 300, 9, 'jpeg'), 'image/jpeg')
      .page('https://c.example/', '<title>No images</title><p>Text only</p>')
      .page('https://d.example/', previewPage('Broken image', '/missing.png'))
      .page('https://e.example/', previewPage('Icon', '/tiny.png'))
      .image('https://e.example/tiny.png', await patternImage(16, 16, 10))
      .page('https://f.example/', previewPage('Local', 'http://router.lan/cam.jpg'))
      .serve('https://g.example/', { type: 'application/pdf', body: '%PDF' })
    const search = searchOf({ q: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'missing'].map(host => ({ url: `https://${host}.example/` })) })
    const found = await (await finder(web, search)).find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect(found.candidates.map(candidate => candidate.title)).toEqual(['Original'])
    expect([found.pages, found.unusable, found.duplicates]).toEqual([8, 6, 1])
    expect(web.requests).not.toContain('http://router.lan/cam.jpg')
  })

  it('follows an image address that is a web page, such as a wiki file page, to the page\'s main image', async () => {
    const web = new FakeWeb()
      .page('https://wiki.example/wiki/File:Horse_gallop.gif', previewPage('File:Horse gallop.gif', 'https://upload.example/horse.gif'))
      .image('https://upload.example/horse.gif', await animatedGif(64, 48, [60, 60, 60, 60], 15), 'image/gif')
      .page('https://wiki.example/wiki/File:Empty.png', '<title>Empty</title>')
    const references = await finder(web, searchOf({ horse: [{ url: 'https://wiki.example/wiki/File:Horse_gallop.gif' }, { url: 'https://wiki.example/wiki/File:Empty.png' }] }))
    const found = await references.find({ queries: ['horse'], pages: [] }, new AbortController().signal)
    expect(found.candidates.map(candidate => [candidate.image, candidate.page, candidate.title, candidate.frames])).toEqual([
      ['https://upload.example/horse.gif', 'https://wiki.example/wiki/File:Horse_gallop.gif', 'File:Horse gallop.gif', 4],
    ])
    expect([found.pages, found.unusable]).toEqual([0, 1])
    const saved = await references.download('https://wiki.example/wiki/File:Horse_gallop.gif', { page: 'https://wiki.example/wiki/File:Horse_gallop.gif', title: '', site: 'wiki.example' }, new AbortController().signal)
    expect(saved.image).toBe('https://upload.example/horse.gif')
  })

  it('takes every image of a page the call names, before the search results', async () => {
    const web = new FakeWeb()
      .page('https://gallery.example/set', `<meta property="og:image" content="/a.png"><meta property="og:title" content="Tile set">
        <img src="/b.png"><a href="/c.gif">full size</a>`)
      .image('https://gallery.example/a.png', await patternImage(256, 256, 11))
      .image('https://gallery.example/b.png', await patternImage(256, 256, 12))
      .image('https://gallery.example/c.gif', await animatedGif(48, 48, [100, 100], 13), 'image/gif')
      .page('https://result.example/', previewPage('Result', '/r.png'))
      .image('https://result.example/r.png', await patternImage(256, 256, 14))
    const found = await (await finder(web, searchOf({ tiles: [{ url: 'https://result.example/' }] })))
      .find({ queries: ['tiles'], pages: ['https://gallery.example/set'] }, new AbortController().signal)
    expect(found.candidates.map(candidate => [candidate.number, candidate.image, candidate.title])).toEqual([
      [1, 'https://gallery.example/a.png', 'Tile set'],
      [2, 'https://gallery.example/b.png', 'Tile set'],
      [3, 'https://gallery.example/c.gif', 'Tile set'],
      [4, 'https://result.example/r.png', 'Result'],
    ])
  })

  it('fills the sheet up to its limit, keeps going when one query\'s search fails, and fails when every search does', async () => {
    const web = new FakeWeb()
    const hits: WebSearchHit[] = []
    for (let index = 0; index < 6; index++) {
      web.page(`https://site${index}.example/`, previewPage(`Page ${index}`, '/p.png')).image(`https://site${index}.example/p.png`, await patternImage(200, 200, 20 + index))
      hits.push({ url: `https://site${index}.example/` })
    }
    const limited = await (await finder(web, searchOf({ ok: hits }), { maxCandidates: 4 })).find({ queries: ['ok', 'broken'], pages: [] }, new AbortController().signal)
    expect(limited.candidates.map(candidate => candidate.number)).toEqual([1, 2, 3, 4])
    await expect((await finder(web, searchOf({}))).find({ queries: ['broken'], pages: [] }, new AbortController().signal)).rejects.toThrow('search failed for broken')
  })

  it('reports no sheet when nothing usable is found', async () => {
    const found = await (await finder(new FakeWeb(), searchOf({ q: [{ url: 'https://gone.example/' }] }))).find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect(found.sheet).toBeUndefined()
    expect([found.candidates.length, found.pages, found.unusable]).toEqual([0, 1, 1])
  })

  it('counts an image that does not decode as unusable, never caches it, and keeps the rest of the search', async () => {
    const web = new FakeWeb()
      .image('https://good.example/a.png', await patternImage(300, 300, 60))
      .image('https://bad.example/b.jpg', await cutJpeg(61), 'image/jpeg')
    const references = await finder(web, searchOf({ q: [{ url: 'https://good.example/a.png', title: 'good' }, { url: 'https://bad.example/b.jpg', title: 'bad' }] }))
    const found = await references.find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect(found.candidates.map(candidate => candidate.title)).toEqual(['good'])
    expect([found.unusable, found.sheet === undefined]).toEqual([1, false])
    expect(reported).toEqual([])
    // Only the good image is cached, so the next search tries the damaged one again.
    expect(await references.cache.find('https://bad.example/b.jpg')).toBeUndefined()
    expect((await readdir(join(references.cache.folder, 'images'))).filter(name => !name.endsWith('.json'))).toHaveLength(1)
    await references.find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect(web.requests.filter(request => request === 'https://bad.example/b.jpg')).toHaveLength(2)
    expect(web.requests.filter(request => request === 'https://good.example/a.png')).toHaveLength(1)
  })

  it('drops a cached file that no longer decodes and downloads it again', async () => {
    const folder = await temporary('cache')
    const web = new FakeWeb().image('https://a.example/z.png', await patternImage(200, 200, 62))
    const search = searchOf({ q: [{ url: 'https://a.example/z.png', title: 'z' }] })
    const report = (error: unknown): void => { reported.push(error) }
    const first = new ReferenceFinder(web, search, new ReferenceCache(folder, 60_000), LIMITS, report)
    const cached = await first.download('https://a.example/z.png', { page: 'https://a.example/z.png', title: 'z', site: 'a.example' }, new AbortController().signal)
    // An earlier version cached it without decoding it, or the file changed on disk; its header still reads.
    await writeFile(cached.path, (await readFile(cached.path)).subarray(0, 100))
    const later = new ReferenceFinder(web, search, new ReferenceCache(folder, 60_000), LIMITS, report)
    const found = await later.find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect([found.candidates.map(candidate => candidate.title), found.unusable]).toEqual([['z'], 0])
    expect(web.requests).toEqual(['https://a.example/z.png', 'https://a.example/z.png'])
    expect((await sharp(await readFile(cached.path)).metadata()).width).toBe(200)
  })

  it('counts any other failure of one image as unusable and reports it, without failing the search', async () => {
    const web = new FakeWeb()
      .image('https://a.example/one.png', await patternImage(300, 300, 63))
      .image('https://b.example/two.png', await patternImage(300, 300, 64))
    // The cache folder is a file, so keeping a download fails.
    const blocked = join(await temporary('cache'), 'not-a-folder')
    await writeFile(blocked, '')
    const references = new ReferenceFinder(web, searchOf({ q: [{ url: 'https://a.example/one.png' }, { url: 'https://b.example/two.png' }] }),
      new ReferenceCache(blocked, 60_000), LIMITS, (error) => { reported.push(error) })
    const found = await references.find({ queries: ['q'], pages: [] }, new AbortController().signal)
    expect([found.candidates.length, found.unusable, found.sheet]).toEqual([0, 2, undefined])
    expect(reported).toHaveLength(2)
    expect((reported[0] as NodeJS.ErrnoException).code).toMatch(/^(?:ENOTDIR|EEXIST)$/u)
  })

  it('still rejects with the caller\'s cancellation', async () => {
    const web = new FakeWeb().image('https://a.example/x.png', await patternImage(64, 64, 65))
    const controller = new AbortController()
    const stopping = Object.assign(Object.create(web) as FakeWeb, {
      request: () => {
        controller.abort(new Error('stopped by the user'))
        return Promise.reject(controller.signal.reason as Error)
      },
    })
    await expect((await finder(stopping, searchOf({ q: [{ url: 'https://a.example/x.png' }] }))).find({ queries: ['q'], pages: [] }, controller.signal))
      .rejects.toThrow('stopped by the user')
  })
})

describe('ReferenceCache', () => {
  it('reuses a download across finders sharing the folder, and prunes files past the age limit', async () => {
    const folder = await temporary('cache')
    const web = new FakeWeb().image('https://a.example/x.png', await patternImage(64, 64, 30))
    const first = new ReferenceFinder(web, searchOf({}), new ReferenceCache(folder, 60_000), LIMITS, (error) => { reported.push(error) })
    const origin = { page: 'https://a.example/', title: 'X', site: 'a.example' }
    const downloaded = await first.download('https://a.example/x.png', origin, new AbortController().signal)
    const second = new ReferenceFinder(web, searchOf({}), new ReferenceCache(folder, 60_000), LIMITS, (error) => { reported.push(error) })
    const again = await second.download('https://a.example/x.png', { ...origin, title: 'Other' }, new AbortController().signal)
    expect(again).toEqual(downloaded)
    expect(web.requests).toEqual(['https://a.example/x.png'])
    const old = new Date(Date.now() - 120_000)
    for (const name of await readdir(join(folder, 'images'))) await utimes(join(folder, 'images', name), old, old)
    await new ReferenceCache(folder, 60_000).prune()
    expect(await readdir(join(folder, 'images'))).toEqual([])
  })

  it('ignores a damaged cache record and downloads again', async () => {
    const folder = await temporary('cache')
    const web = new FakeWeb().image('https://a.example/y.png', await patternImage(64, 64, 31))
    const cache = new ReferenceCache(folder, 60_000)
    await new ReferenceFinder(web, searchOf({}), cache, LIMITS, (error) => { reported.push(error) }).download('https://a.example/y.png', { page: 'p', title: '', site: 'a.example' }, new AbortController().signal)
    const [record] = (await readdir(join(folder, 'images'))).filter(name => name.endsWith('.json'))
    await writeFile(join(folder, 'images', record as string), '{ not json')
    await new ReferenceFinder(web, searchOf({}), new ReferenceCache(folder, 60_000), LIMITS, (error) => { reported.push(error) }).download('https://a.example/y.png', { page: 'p', title: '', site: 'a.example' }, new AbortController().signal)
    expect(web.requests).toHaveLength(2)
  })
})

describe('saveReferences', () => {
  it('saves numbered files with a frames sheet for animations, SOURCES.md, and references/.gdignore', async () => {
    const project = await temporary('project')
    const web = new FakeWeb()
      .image('https://a.example/knight.png', await patternImage(128, 128, 40))
      .image('https://b.example/slash.gif', await animatedGif(32, 32, [100, 50], 41), 'image/gif')
    const references = await finder(web, searchOf({}))
    const signal = new AbortController().signal
    const images = [
      await references.download('https://a.example/knight.png', { page: 'https://a.example/post (1)', title: 'Knight [front] `view`', site: 'a.example' }, signal),
      await references.download('https://b.example/slash.gif', { page: 'https://b.example/slash.gif', title: '', site: 'b.example', video: 'https://v.example/1' }, signal),
    ]
    const saved = await saveReferences(project, 'Hero Knight!', await prepared(images), new Date('2026-11-14T08:00:00Z'), new AbortController().signal)
    expect(saved.map(entry => [entry.file, entry.framesFile])).toEqual([
      ['references/hero-knight/01-knight-front-view.png', undefined],
      ['references/hero-knight/02-slash.gif', 'references/hero-knight/02-slash.frames.png'],
    ])
    expect(await readFile(join(project, 'references', 'hero-knight', '01-knight-front-view.png'))).toEqual(await readFile(images[0]?.path as string))
    expect((await sharp(await readFile(join(project, 'references', 'hero-knight', '02-slash.frames.png'))).metadata()).format).toBe('png')
    expect(await readFile(join(project, 'references', '.gdignore'), 'utf8')).toBe('')
    expect(await readFile(join(project, 'references', 'hero-knight', 'SOURCES.md'), 'utf8')).toBe(
      '# References: Hero Knight!\n\n'
      + 'Reference images the agent saved to study shape, style, colors, and motion. They are not game assets: Godot leaves '
      + 'the references folder out of the game (references/.gdignore). Each image belongs to its creator; check its source\'s '
      + 'license before using any of it in the game.\n\n'
      + '- `01-knight-front-view.png` — [Knight front view](https://a.example/post%20%281%29) · [image](https://a.example/knight.png) — saved 2026-11-14\n'
      + '- `02-slash.gif` — [https://b.example/slash.gif](https://b.example/slash.gif) · [video](https://v.example/1) — saved 2026-11-14\n',
    )
  })

  it('numbers later saves after the files already there and appends to SOURCES.md', async () => {
    const project = await temporary('project')
    const web = new FakeWeb().image('https://a.example/one.png', await patternImage(64, 64, 50)).image('https://a.example/two.png', await patternImage(64, 64, 51))
    const references = await finder(web, searchOf({}))
    const signal = new AbortController().signal
    const one = await references.download('https://a.example/one.png', { page: 'https://a.example/', title: 'One', site: 'a.example' }, signal)
    const two = await references.download('https://a.example/two.png', { page: 'https://a.example/', title: 'Two', site: 'a.example' }, signal)
    await saveReferences(project, 'tiles', await prepared([one]), new Date('2026-11-14T08:00:00Z'), new AbortController().signal)
    await writeFile(join(project, 'references', 'tiles', 'SOURCES.md'), '# References: tiles\n\nEdited by hand')
    const [later] = await saveReferences(project, 'tiles', await prepared([two]), new Date('2026-11-15T08:00:00Z'), new AbortController().signal)
    expect(later?.file).toBe('references/tiles/02-two.png')
    expect(await readFile(join(project, 'references', 'tiles', 'SOURCES.md'), 'utf8')).toBe(
      '# References: tiles\n\nEdited by hand\n- `02-two.png` — [Two](https://a.example/) · [image](https://a.example/two.png) — saved 2026-11-15\n',
    )
  })

  it('gives parallel saves of one subject different numbers, never overwriting a file', async () => {
    const project = await temporary('project')
    const web = new FakeWeb()
    for (let index = 0; index < 6; index++) web.image(`https://a.example/${index}.png`, await patternImage(64, 64, 70 + index))
    const references = await finder(web, searchOf({}))
    const signal = new AbortController().signal
    const images = await Promise.all([0, 1, 2, 3, 4, 5].map(index => references.download(`https://a.example/${index}.png`, { page: 'https://a.example/', title: `Tile ${index}`, site: 'a.example' }, signal)))
    const batches = await Promise.all([[0, 1, 2], [3, 4, 5]].map(async indexes => await saveReferences(project, 'tiles', await prepared(indexes.map(index => images[index] as CachedImage)), new Date('2026-11-14T08:00:00Z'), signal)))
    const files = batches.flat().map(entry => entry.file)
    expect(new Set(files).size).toBe(6)
    const folder = join(project, 'references', 'tiles')
    expect((await readdir(folder)).filter(name => name.endsWith('.png')).sort()).toEqual(files.map(file => file.split('/').at(-1)).sort())
    for (const entry of batches.flat()) {
      const index = Number(/tile-(\d)/u.exec(entry.file)?.[1])
      expect(await readFile(entry.path), entry.file).toEqual(await readFile((images[index] as CachedImage).path))
    }
    const sources = await readFile(join(folder, 'SOURCES.md'), 'utf8')
    expect(sources.match(/^- `/gmu)).toHaveLength(6)
  })

  it('does not save an image that is already in the folder again, so a repeated save adds nothing', async () => {
    const project = await temporary('project')
    const web = new FakeWeb()
      .image('https://a.example/one.png', await patternImage(64, 64, 80))
      .image('https://b.example/walk.gif', await animatedGif(32, 32, [100, 50], 81), 'image/gif')
    const references = await finder(web, searchOf({}))
    const signal = new AbortController().signal
    const images = [
      await references.download('https://a.example/one.png', { page: 'https://a.example/', title: 'One', site: 'a.example' }, signal),
      await references.download('https://b.example/walk.gif', { page: 'https://b.example/', title: 'Walk', site: 'b.example' }, signal),
    ]
    const first = await saveReferences(project, 'hero', await prepared(images), new Date('2026-11-14T08:00:00Z'), signal)
    const folder = join(project, 'references', 'hero')
    const before = await filesIn(folder)
    const sourcesBefore = await readFile(join(folder, 'SOURCES.md'), 'utf8')
    const again = await saveReferences(project, 'hero', await prepared(images), new Date('2026-11-15T08:00:00Z'), signal)
    expect(again.map(entry => [entry.file, entry.framesFile, entry.savedEarlier])).toEqual([
      [first[0]?.file, undefined, true],
      [first[1]?.file, first[1]?.framesFile, true],
    ])
    expect(await filesIn(folder)).toEqual(before)
    expect(await readFile(join(folder, 'SOURCES.md'), 'utf8')).toBe(sourcesBefore)
  })

  it('removes the files a save wrote when it fails or is cancelled before it finishes', async () => {
    const project = await temporary('project')
    const web = new FakeWeb()
      .image('https://a.example/one.png', await patternImage(64, 64, 90))
      .image('https://a.example/two.png', await patternImage(64, 64, 91))
    const references = await finder(web, searchOf({}))
    const signal = new AbortController().signal
    const images = await prepared([
      await references.download('https://a.example/one.png', { page: 'https://a.example/', title: 'One', site: 'a.example' }, signal),
      await references.download('https://a.example/two.png', { page: 'https://a.example/', title: 'Two', site: 'a.example' }, signal),
    ])
    const folder = join(project, 'references', 'hero')
    // SOURCES.md is a folder, so writing it fails after both images were written.
    await mkdir(join(folder, 'SOURCES.md'), { recursive: true })
    await expect(saveReferences(project, 'hero', images, new Date(), signal)).rejects.toThrow()
    expect(await filesIn(folder)).toEqual([])
    await rm(join(folder, 'SOURCES.md'), { recursive: true })

    // Cancelled after the first image was written: its file goes, and nothing else is written.
    const controller = new AbortController()
    let checks = 0
    const stopping = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'throwIfAborted') {
          return () => {
            checks += 1
            if (checks === 3) controller.abort(new Error('the save timed out'))
            target.throwIfAborted()
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    await expect(saveReferences(project, 'hero', images, new Date(), stopping)).rejects.toThrow('the save timed out')
    expect(await filesIn(folder)).toEqual([])
    // A cancelled signal writes nothing at all.
    await expect(saveReferences(await temporary('project'), 'hero', images, new Date(), AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped')
  })

  it('names subject folders with letters, digits, and hyphens, refusing a subject without any', () => {
    expect(subjectFolder('  Forest Tiles (Autumn)  ')).toBe('forest-tiles-autumn')
    expect(subjectFolder('Épée longue')).toBe('epee-longue')
    expect(subjectFolder('骑士')).toBe('骑士')
    expect(() => subjectFolder('../..')).toThrow('subject must name what the references are for')
  })
})
