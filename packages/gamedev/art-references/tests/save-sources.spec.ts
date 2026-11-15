/**
 * `SOURCES.md` under saves that run at once: the save that creates the file and the saves that find it keep every
 * line, while the first creation of the file is held back, and on a file system without hard links.
 */
import type { PathLike } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReferenceCache, ReferenceFinder, type CachedImage, type FinderLimits } from '../src/finder.ts'
import { MAX_ANIMATION_PIXELS } from '../src/images.ts'
import { prepareReference, saveReferences, type PreparedReference } from '../src/save.ts'
import { FakeWeb, patternImage } from './fixtures.ts'

/** How the mocked file system creates `SOURCES.md` and hard links. */
const files = vi.hoisted(() => ({
  /** While set, the first creation of `SOURCES.md` waits for it. */
  hold: undefined as Promise<void> | undefined,
  /** Creations of `SOURCES.md` asked for so far: hard links to it, and exclusive writes of it. */
  creations: 0,
  /** Whether every hard link fails, as on a file system without them. */
  noLinks: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  /** Whether this creation of `SOURCES.md` is the first, which waits while a hold is set. */
  const held = (path: PathLike | FileHandle): boolean =>
    typeof path === 'string' && path.endsWith('SOURCES.md') && files.creations++ === 0 && files.hold !== undefined
  return {
    ...actual,
    async link(existing: PathLike, path: PathLike): Promise<void> {
      if (files.noLinks) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
      if (held(path)) await files.hold
      await actual.link(existing, path)
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>): Promise<void> {
      const [path, data, options] = args
      const flag = typeof options === 'object' && options !== null ? options.flag : undefined
      if (typeof data !== 'string' || (flag !== 'wx' && flag !== 'ax') || !held(path)) {
        await actual.writeFile(...args)
        return
      }
      // An exclusive open makes the file at once, empty; its content arrives once the hold ends.
      const handle = await actual.open(path as PathLike, flag)
      try {
        await files.hold
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
    },
  }
})

const LIMITS: FinderLimits = {
  resultsPerQuery: 8, maxCandidates: 16, pageTimeoutMs: 5000, imageTimeoutMs: 5000, maxPageBytes: 64 * 1024,
  maxImageBytes: 1024 * 1024, minImageEdge: 24, sheetCell: 96, sheetColumns: 4, concurrency: 3,
}

const FRAMES = { maxFrames: 24, maxEdge: 512, maxPixels: MAX_ANIMATION_PIXELS }

const folders: string[] = []

/** Failures the finders reported as unexpected. */
const reported: unknown[] = []

afterEach(async () => {
  files.hold = undefined
  files.creations = 0
  files.noLinks = false
  expect(reported.splice(0)).toEqual([])
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function temporary(name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `dsh-art-references-${name}-`))
  folders.push(folder)
  return folder
}

/** `count` different images, downloaded and prepared for a save, titled `Tile 0`, `Tile 1`, and so on. */
async function images(count: number): Promise<PreparedReference[]> {
  const web = new FakeWeb()
  for (let index = 0; index < count; index++) web.image(`https://a.example/${index}.png`, await patternImage(64, 64, 90 + index))
  const cache = new ReferenceCache(await temporary('cache'), 24 * 60 * 60 * 1000)
  const finder = new ReferenceFinder(web, () => Promise.resolve([]), cache, LIMITS, (error) => { reported.push(error) })
  const signal = new AbortController().signal
  const downloaded: CachedImage[] = await Promise.all(Array.from({ length: count }, async (_, index) => await finder.download(
    `https://a.example/${index}.png`, { page: 'https://a.example/', title: `Tile ${index}`, site: 'a.example' }, signal,
  )))
  return await Promise.all(downloaded.map(image => prepareReference(image, FRAMES, signal)))
}

/** Save one prepared image as a reference of `tiles`. */
async function save(project: string, image: PreparedReference): Promise<void> {
  await saveReferences(project, 'tiles', [image], new Date('2026-11-14T08:00:00Z'), new AbortController().signal)
}

/** `SOURCES.md` of `tiles`. */
async function sources(project: string): Promise<string> {
  return await readFile(join(project, 'references', 'tiles', 'SOURCES.md'), 'utf8')
}

/** The file names that `SOURCES.md` lists, in order. */
async function listed(project: string): Promise<string[]> {
  return [...(await sources(project)).matchAll(/^- `([^`]+)`/gmu)].map(match => match[1] ?? '')
}

describe('SOURCES.md of saves that run at once', () => {
  it('keeps the lines of a save that finds the file while another save is creating it', async () => {
    const project = await temporary('project')
    const [first, second] = await images(2)
    if (first === undefined || second === undefined) throw new Error('two images expected')
    let release = (): void => {}
    files.hold = new Promise((resolve) => { release = resolve })
    const creating = save(project, first)
    await vi.waitFor(() => { expect(files.creations).toBe(1) })
    await save(project, second)
    release()
    await creating
    expect((await sources(project)).match(/^# References: tiles$/gmu)).toHaveLength(1)
    expect((await sources(project)).startsWith('# References: tiles\n')).toBe(true)
    expect(await listed(project)).toEqual(['02-tile-1.png', '01-tile-0.png'])
  })

  it('keeps every line on a file system without hard links', async () => {
    files.noLinks = true
    const project = await temporary('project')
    const prepared = await images(5)
    await Promise.all(prepared.slice(0, 4).map(async (image) => { await save(project, image) }))
    const saved = (await readdir(join(project, 'references', 'tiles'))).filter(name => name.endsWith('.png')).sort()
    expect(saved).toHaveLength(4)
    expect([...await listed(project)].sort()).toEqual(saved)
    const last = prepared[4]
    if (last === undefined) throw new Error('a fifth image expected')
    await save(project, last)
    expect(await listed(project)).toHaveLength(5)
    expect((await sources(project)).match(/^# References: tiles$/gmu)).toHaveLength(1)
  })
})
