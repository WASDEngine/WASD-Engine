/** Writing a download plan's files: digests checked, nothing written on failure, changed files kept, and coded failures. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeDownload, type WriteOptions } from '../src/download.ts'
import type { PolyHavenDownloadPlan } from '../src/types.ts'

const CONTENTS: Readonly<Record<string, string>> = {
  'https://dl.test/chair_1k.gltf': '{"asset":{"version":"2.0"}}',
  'https://dl.test/chair.bin': 'binary buffer',
  'https://dl.test/chair_diff_1k.jpg': 'jpeg bytes',
}

function planned(path: string, url: string, body = CONTENTS[url] ?? '') {
  return { path, file: { url, size: Buffer.byteLength(body), md5: createHash('md5').update(body).digest('hex') } }
}

const PLAN: PolyHavenDownloadPlan = {
  format: 'gltf',
  resolution: '1k',
  entry: 'chair_1k.gltf',
  maps: [],
  files: [
    planned('chair_1k.gltf', 'https://dl.test/chair_1k.gltf'),
    planned('chair.bin', 'https://dl.test/chair.bin'),
    planned('textures/chair_diff_1k.jpg', 'https://dl.test/chair_diff_1k.jpg'),
  ],
}

let root: string
let opened: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-polyhaven-download-'))
  opened = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function options(overrides: Partial<WriteOptions> & { readonly bodies?: Readonly<Record<string, string>> } = {}): WriteOptions {
  const bodies = { ...CONTENTS, ...overrides.bodies }
  return {
    replace: false,
    folders: new Map(),
    signal: new AbortController().signal,
    open: (url) => {
      opened.push(url)
      return Promise.resolve(new Response(bodies[url] ?? ''))
    },
    ...overrides,
  }
}

/** Every file below the folder, with temporary files. */
async function listing(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()
}

describe('writeDownload', () => {
  it('writes every file into the folder and its subfolders, then finds them in place on the next call', async () => {
    const directory = join(root, 'assets', 'chair')
    expect(await writeDownload(PLAN, directory, options())).toEqual([
      { path: 'chair_1k.gltf', bytes: 27, status: 'downloaded' },
      { path: 'chair.bin', bytes: 13, status: 'downloaded' },
      { path: 'textures/chair_diff_1k.jpg', bytes: 10, status: 'downloaded' },
    ])
    expect(await listing(directory)).toEqual(['chair.bin', 'chair_1k.gltf', join('textures', 'chair_diff_1k.jpg')])
    expect(await readFile(join(directory, 'textures', 'chair_diff_1k.jpg'), 'utf8')).toBe('jpeg bytes')
    opened = []
    expect((await writeDownload(PLAN, directory, options())).map(file => file.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(opened).toEqual([])
  })

  it('keeps a changed file and writes nothing unless replace is true', async () => {
    await mkdir(join(root, 'textures'), { recursive: true })
    await writeFile(join(root, 'chair.bin'), 'edited by the user')
    await expect(writeDownload(PLAN, root, options())).rejects.toMatchObject({
      name: 'PolyHavenError',
      code: 'POLYHAVEN_ALREADY_EXISTS',
      message: `A file in ${root} already exists with other contents: chair.bin. Pass replace: true to overwrite it, or download into another directory.`,
    })
    expect(await listing(root)).toEqual(['chair.bin'])
    expect(opened).toEqual([])
    const written = await writeDownload(PLAN, root, options({ replace: true }))
    expect(written.map(file => file.status)).toEqual(['downloaded', 'replaced', 'downloaded'])
    expect(await readFile(join(root, 'chair.bin'), 'utf8')).toBe('binary buffer')
  })

  it('names every changed file in one refusal', async () => {
    await writeFile(join(root, 'chair.bin'), 'edited')
    await writeFile(join(root, 'chair_1k.gltf'), '{}')
    await expect(writeDownload(PLAN, root, options())).rejects.toThrow(
      `2 files in ${root} already exist with other contents: chair_1k.gltf, chair.bin. Pass replace: true to overwrite them, or download into another directory.`)
  })

  it('writes none of the files when one arrives damaged, short, or long, and leaves no temporary file', async () => {
    for (const body of ['binary BUFFER', 'binary', 'binary buffer and more']) {
      const directory = join(root, body.replaceAll(' ', '-'))
      const failed = writeDownload(PLAN, directory, options({ bodies: { 'https://dl.test/chair.bin': body } }))
      await expect(failed).rejects.toMatchObject({ name: 'PolyHavenError', code: 'POLYHAVEN_DOWNLOAD_CORRUPT' })
      await expect(failed).rejects.toThrow(/chair\.bin/u)
      expect(await listing(directory).catch(() => [])).toEqual([])
    }
  })

  it('reports why a request failed and writes nothing', async () => {
    const failing = options({
      open: url => url.endsWith('.bin') ? Promise.reject(new Error('Poly Haven answered HTTP 500 for the file.')) : Promise.resolve(new Response(CONTENTS[url] ?? '')),
    })
    await expect(writeDownload(PLAN, root, failing)).rejects.toThrow('Poly Haven answered HTTP 500 for the file.')
    expect(await listing(root)).toEqual([])
  })

  it('stops when cancelled and writes nothing', async () => {
    const controller = new AbortController()
    const stalled = options({
      signal: controller.signal,
      open: (url, signal) => {
        if (!url.endsWith('.bin')) return Promise.resolve(new Response(CONTENTS[url] ?? ''))
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('binary'))
            signal.addEventListener('abort', () => { stream.error(signal.reason) })
            setTimeout(() => { controller.abort() }, 20)
          },
        })
        return Promise.resolve(new Response(body))
      },
    })
    await expect(writeDownload(PLAN, root, stalled)).rejects.toThrow()
    expect(await listing(root)).toEqual([])
  })

  it('reports a file it cannot write as a failure on the disk, and writes nothing', async () => {
    // The textures folder goes away before its file arrives, so the file cannot be written there.
    const vanishing = options({
      open: async (url) => {
        if (url.endsWith('chair_diff_1k.jpg')) await rm(join(root, 'textures'), { recursive: true, force: true })
        return new Response(CONTENTS[url] ?? '')
      },
    })
    const failed = writeDownload(PLAN, root, vanishing)
    await expect(failed).rejects.toMatchObject({ name: 'PolyHavenError', code: 'POLYHAVEN_DISK_FAILED', cause: { code: 'ENOENT' } })
    const message = /^The download failed on the disk while it wrote textures\/chair_diff_1k\.jpg: ENOENT: .+; nothing was saved\./u
    await expect(failed).rejects.toThrow(message)
    expect(await listing(root)).toEqual([])
  })

  it('refuses a plan whose paths would be one file before anything is written', async () => {
    const plan = { ...PLAN, files: [planned('textures/chair_diff_1k.jpg', 'https://dl.test/chair_diff_1k.jpg'), planned('TEXTURES/chair_diff_1k.jpg', 'https://dl.test/chair.bin')] }
    await expect(writeDownload(plan, root, options())).rejects.toMatchObject({
      name: 'PolyHavenError',
      code: 'POLYHAVEN_DOWNLOAD_CORRUPT',
      message: 'The files textures/chair_diff_1k.jpg and TEXTURES/chair_diff_1k.jpg would be one file in the download folder, since macOS and Windows ignore letter case in file names; the download stopped.',
    })
    expect(opened).toEqual([])
    expect(await listing(root)).toEqual([])
  })

  it('refuses to write over a folder', async () => {
    await mkdir(join(root, 'chair.bin'))
    await expect(writeDownload(PLAN, root, options())).rejects.toMatchObject(
      { code: 'POLYHAVEN_ALREADY_EXISTS', message: `${join(root, 'chair.bin')} exists and is not a file; move it or download into another directory.` })
  })
})
