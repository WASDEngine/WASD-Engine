/** Saving an archive's map pictures: the archive checked, only the maps written, nothing written on failure, and changed files kept. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AmbientCgArchiveChanged, writeDownload, type DownloadOptions } from '../src/download.ts'
import type { AmbientCgArchive, AmbientCgArchiveListing, AmbientCgAsset } from '../src/types.ts'

const FILES: Readonly<Record<string, string>> = {
  'Wood099_1K-JPG.usdc': 'usd material',
  'Wood099_1K-JPG_Color.jpg': 'color picture',
  'Wood099_1K-JPG_NormalDX.jpg': 'directx normals',
  'Wood099_1K-JPG_NormalGL.jpg': 'opengl normals',
  'Wood099_1K-JPG_Roughness.jpg': 'roughness picture',
  'Wood099_1K-JPG.blend': 'blender file',
  'Wood099.png': 'preview',
}

function zipped(files: Readonly<Record<string, string>> = FILES, level: 0 | 6 = 6): Buffer {
  const encoded = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, new TextEncoder().encode(body)]))
  return Buffer.from(zipSync(encoded, { level }))
}

const ZIP = zipped()

const ARCHIVE: AmbientCgArchive = { resolution: '1k', format: 'jpg', attributes: '1K-JPG', url: 'https://ambientcg.com/get?file=Wood099_1K-JPG.zip', size: ZIP.byteLength }

const WOOD: AmbientCgAsset = {
  id: 'Wood099', title: 'Wood 099', kind: 'material', tags: ['wood'], maps: ['color', 'normal', 'roughness'], technique: 'surface-approximated',
  downloads: 116, released: '2026-10-24', archives: [ARCHIVE],
}

let root: string
let temporary: string
let opened: string[]
let known: Map<string, AmbientCgArchiveListing>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-ambientcg-download-'))
  // The download's own temporary folder goes below this one, where the spec can see whether it was removed.
  temporary = join(root, 'tmp')
  await mkdir(temporary)
  process.env.TMPDIR = temporary
  opened = []
  known = new Map()
})

const TMPDIR = process.env.TMPDIR

afterEach(async () => {
  if (TMPDIR === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = TMPDIR
  await rm(root, { recursive: true, force: true })
})

function options(
  overrides: Partial<DownloadOptions> & { readonly body?: Buffer; readonly headers?: Readonly<Record<string, string>> } = {},
): DownloadOptions {
  const body = overrides.body ?? ZIP
  return {
    replace: false,
    maps: undefined,
    maxUnpackedBytes: 1_000_000,
    known,
    signal: new AbortController().signal,
    open: (url) => {
      opened.push(url)
      return Promise.resolve(new Response(new Uint8Array(body), { headers: overrides.headers ?? { 'x-bz-content-sha1': createHash('sha1').update(ZIP).digest('hex') } }))
    },
    ...overrides,
  }
}

/** Every file below the folder, with temporary files. */
async function listing(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()
}

describe('writeDownload', () => {
  it('writes the map pictures without the DirectX normal map and the other files, then fetches nothing when they are in place', async () => {
    const directory = join(root, 'assets', 'ambientcg', 'Wood099')
    expect(await writeDownload(WOOD, ARCHIVE, directory, options())).toEqual({
      files: [
        { path: 'Wood099_1K-JPG_Color.jpg', bytes: 13, status: 'downloaded' },
        { path: 'Wood099_1K-JPG_NormalGL.jpg', bytes: 14, status: 'downloaded' },
        { path: 'Wood099_1K-JPG_Roughness.jpg', bytes: 17, status: 'downloaded' },
      ],
      maps: ['Color', 'NormalGL', 'Roughness'],
      fetchedBytes: ZIP.byteLength,
    })
    expect(await listing(directory)).toEqual(['Wood099_1K-JPG_Color.jpg', 'Wood099_1K-JPG_NormalGL.jpg', 'Wood099_1K-JPG_Roughness.jpg'])
    expect(await readFile(join(directory, 'Wood099_1K-JPG_NormalGL.jpg'), 'utf8')).toBe('opengl normals')
    expect(await listing(temporary)).toEqual([])
    expect(opened).toEqual([ARCHIVE.url])
    const again = await writeDownload(WOOD, ARCHIVE, directory, options())
    expect(again.files.map(file => file.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(again.fetchedBytes).toBe(0)
    expect(opened).toEqual([ARCHIVE.url])
  })

  it('compares with the archive after a restart, and writes the maps a call names', async () => {
    await writeDownload(WOOD, ARCHIVE, root, options())
    known.clear()
    const restarted = await writeDownload(WOOD, ARCHIVE, root, options({ maps: ['color', 'NormalDX'] }))
    expect(restarted.files).toEqual([
      { path: 'Wood099_1K-JPG_Color.jpg', bytes: 13, status: 'unchanged' },
      { path: 'Wood099_1K-JPG_NormalDX.jpg', bytes: 15, status: 'downloaded' },
    ])
    expect(restarted.fetchedBytes).toBe(ZIP.byteLength)
    expect(opened).toHaveLength(2)
    await expect(writeDownload(WOOD, ARCHIVE, root, options({ maps: ['metalness'] }))).rejects.toThrow(
      'The archive of Wood 099 has no "metalness" map; it holds: Color, NormalDX, NormalGL, Roughness.')
  })

  it('keeps a changed picture and writes nothing unless replace is true', async () => {
    await writeFile(join(root, 'Wood099_1K-JPG_Color.jpg'), 'edited by the user')
    await expect(writeDownload(WOOD, ARCHIVE, root, options())).rejects.toThrow(
      `A file in ${root} already exists with other contents: Wood099_1K-JPG_Color.jpg. Pass replace: true to overwrite it, or download into another directory.`)
    expect((await listing(root)).filter(name => !name.startsWith('tmp'))).toEqual(['Wood099_1K-JPG_Color.jpg'])
    // The refusal reads the remembered directory: the archive is not fetched again to refuse a second time.
    await expect(writeDownload(WOOD, ARCHIVE, root, options())).rejects.toThrow('already exists with other contents')
    expect(opened).toHaveLength(1)
    const written = await writeDownload(WOOD, ARCHIVE, root, options({ replace: true }))
    expect(written.files.map(file => file.status)).toEqual(['replaced', 'downloaded', 'downloaded'])
    expect(await readFile(join(root, 'Wood099_1K-JPG_Color.jpg'), 'utf8')).toBe('color picture')
  })

  it('writes nothing when the archive\'s digest differs, or a picture differs from the archive\'s directory', async () => {
    const stored = zipped(FILES, 0)
    const damaged = Buffer.from(stored)
    const at = damaged.indexOf('opengl normals')
    damaged[at] = 0x4f
    const archive = { ...ARCHIVE, size: stored.byteLength }
    const digest = createHash('sha1').update(stored).digest('hex')
    await expect(writeDownload(WOOD, archive, join(root, 'a'), options({ body: damaged, headers: { 'x-bz-content-sha1': `unverified:${digest}` } }))).rejects.toThrow(
      'The archive of Wood 099 arrived damaged: its SHA-1 digest differs from ambientCG\'s; nothing was saved.')
    known.clear()
    await expect(writeDownload(WOOD, archive, join(root, 'b'), options({ body: damaged, headers: { 'x-bz-content-sha1': 'none' } }))).rejects.toThrow(
      'Wood099_1K-JPG_NormalGL.jpg arrived damaged: its checksum differs from the archive\'s; nothing was saved.')
    expect(await listing(join(root, 'a'))).toEqual([])
    expect(await listing(join(root, 'b'))).toEqual([])
    expect(await listing(temporary)).toEqual([])
    // A large file's digest arrives in another header.
    known.clear()
    const large = await writeDownload(WOOD, archive, join(root, 'c'), options({ body: stored, headers: { 'x-bz-content-sha1': 'none', 'x-bz-info-large_file_sha1': digest } }))
    expect(large.files).toHaveLength(3)
  })

  it('reports an archive whose size differs from its listing, and forgets its directory', async () => {
    await writeDownload(WOOD, ARCHIVE, join(root, 'first'), options())
    for (const body of [ZIP.subarray(0, ZIP.byteLength - 1), Buffer.concat([ZIP, Buffer.from('x')])]) {
      known.clear()
      const failed = writeDownload(WOOD, ARCHIVE, join(root, 'second'), options({ body }))
      await expect(failed).rejects.toThrow('ambientCG\'s files of Wood 099 differ from its listing, as after an update of the asset; nothing was saved. Call again to read the new listing.')
      await expect(failed).rejects.toBeInstanceOf(AmbientCgArchiveChanged)
    }
    // A remembered directory that no longer fits the archive is dropped, so the next call reads the archive's own.
    known.set('Wood099/1K-JPG', { size: ZIP.byteLength, pictures: [{ name: 'Wood099_1K-JPG_Color.jpg', map: 'Color', bytes: 13, crc32: 1 }] })
    await expect(writeDownload(WOOD, ARCHIVE, join(root, 'third'), options())).rejects.toBeInstanceOf(AmbientCgArchiveChanged)
    expect(known.has('Wood099/1K-JPG')).toBe(false)
    expect(await listing(join(root, 'third'))).toEqual([])
  })

  it('refuses a file that is not a ZIP archive, an archive without maps, and maps larger than the limit', async () => {
    const text = Buffer.from('<html>not an archive</html>')
    await expect(writeDownload(WOOD, { ...ARCHIVE, size: text.byteLength }, root, options({ body: text, headers: {} }))).rejects.toThrow(
      /^The archive of Wood 099 is not a readable ZIP file: .+; nothing was saved\.$/u,
    )
    known.clear()
    const other = zipped({ 'Other_1K-JPG_Color.jpg': 'not this asset', 'Wood099.png': 'preview' })
    await expect(writeDownload(WOOD, { ...ARCHIVE, size: other.byteLength }, root, options({ body: other, headers: {} }))).rejects.toThrow('The archive of Wood 099 holds no map pictures; nothing was saved.')
    known.clear()
    const heavy = zipped({ 'Wood099_1K-JPG_Color.jpg': 'c'.repeat(3000), 'Wood099_1K-JPG_Roughness.jpg': 'r'.repeat(1200) })
    const small = options({ body: heavy, headers: {}, maxUnpackedBytes: 2048 })
    await expect(writeDownload(WOOD, { ...ARCHIVE, size: heavy.byteLength }, root, small)).rejects.toThrow(
      'The maps of this download are 4 KB unpacked, more than the 2 KB that one download may be; choose a lower resolution or fewer maps.')
    expect((await listing(root)).filter(name => !name.startsWith('tmp'))).toEqual([])
    expect(await listing(temporary)).toEqual([])
  })

  it('reports why the request failed, stops when cancelled, and writes nothing', async () => {
    const failing = options({ open: () => Promise.reject(new Error('ambientCG answered HTTP 500 for the archive.')) })
    await expect(writeDownload(WOOD, ARCHIVE, root, failing)).rejects.toThrow('ambientCG answered HTTP 500 for the archive.')
    const controller = new AbortController()
    const stalled = options({
      signal: controller.signal,
      open: (_url, signal) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(ZIP.subarray(0, 20)))
            signal.addEventListener('abort', () => { stream.error(signal.reason) })
            setTimeout(() => { controller.abort() }, 20)
          },
        })
        return Promise.resolve(new Response(body))
      },
    })
    await expect(writeDownload(WOOD, ARCHIVE, root, stalled)).rejects.toThrow()
    expect((await listing(root)).filter(name => !name.startsWith('tmp'))).toEqual([])
    expect(await listing(temporary)).toEqual([])
  })

  it('leaves no folder behind when a download into a new folder fails or is cancelled', async () => {
    // A remembered directory lets the pictures' folder be made before the archive is fetched, as on a second download.
    await writeDownload(WOOD, ARCHIVE, join(root, 'first'), options())
    const failing = options({ open: () => Promise.reject(new Error('Could not reach ambientCG at ambientcg.com for the archive: fetch failed')) })
    await expect(writeDownload(WOOD, ARCHIVE, join(root, 'assets', 'ambientcg', 'Wood099'), failing)).rejects.toThrow('fetch failed')
    const controller = new AbortController()
    const cancelled = options({ signal: controller.signal, open: () => { controller.abort(); return Promise.reject(new Error('cancelled')) } })
    await expect(writeDownload(WOOD, ARCHIVE, join(root, 'assets', 'ambientcg', 'Wood099'), cancelled)).rejects.toThrow()
    expect((await readdir(root)).sort()).toEqual(['first', 'tmp'])
  })

  it('refuses an archive whose pictures differ only in letter case before anything is written', async () => {
    const colliding = zipped({ 'Wood099_1K-JPG_Color.jpg': 'upper', 'wood099_1k-jpg_color.jpg': 'lower' })
    const archive = { ...ARCHIVE, size: colliding.byteLength }
    await expect(writeDownload(WOOD, archive, join(root, 'wood'), options({ body: colliding, headers: {} }))).rejects.toThrow(
      'The files Wood099_1K-JPG_Color.jpg and wood099_1k-jpg_color.jpg would be one file in the download folder, since macOS and Windows ignore letter case in file names; the download stopped.')
    expect((await readdir(root)).sort()).toEqual(['tmp'])
    expect(await listing(temporary)).toEqual([])
  })
})
