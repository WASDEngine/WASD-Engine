/**
 * What the asset library plugins share in the kit: requests that stay on a library's hosts, bounded bodies, a library's
 * client, preview images in a result, the folder of a download, and files written whole or not at all, in folders that
 * the downloads of a plugin remove together. Every failure is the error that the plugin's makers return. The Poly Haven
 * and ambientCG specs run the same code through their tools; these cases pin what each helper does by itself.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  AssetLibraryClient, AssetLibraryHttp, AssetLibraryRequestError, downloadFolders, saveBody, savedCounts, shownPreview, writeAssetFiles,
  WRITTEN_FILES_SCHEMA, type AssetFileWrite, type PreviewImage, type PreviewSurface,
} from '../src/kit.ts'

const signal = new AbortController().signal

/** An error that the test plugin's makers return, with the maker that made it. */
class Refusal extends Error {
  constructor(readonly kind: 'argument' | 'corrupt' | 'disk' | 'exists' | 'request', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** The test plugin's errors, as a plugin passes its own to the kit. */
const errors = {
  request: (failure: AssetLibraryRequestError): Error => new Refusal('request', failure.message, { cause: failure }),
  exists: (message: string): Error => new Refusal('exists', message),
  corrupt: (message: string): Error => new Refusal('corrupt', message),
  disk: (message: string, cause: unknown): Error => new Refusal('disk', message, { cause }),
  argument: (message: string): Error => new Refusal('argument', message),
}

/** What a request failure that the kit raised looks like: the request maker's error with the status in its cause. */
function refusedRequest(status: number, message: string): Record<string, unknown> {
  return { kind: 'request', message, cause: { name: 'AssetLibraryRequestError', status, message } }
}

async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-library-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  return folder
}

function http(library: string, answer: (url: string) => Response): { readonly client: AssetLibraryHttp; readonly fetched: string[] } {
  const fetched: string[] = []
  const client = new AssetLibraryHttp({
    library,
    api: new URL('http://127.0.0.1:8123/api/'),
    domains: ['library.example'],
    userAgent: 'WASD Engine',
    fetch: (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      fetched.push(url)
      return Promise.resolve(answer(url))
    },
    errors,
  })
  return { client, fetched }
}

describe('AssetLibraryHttp', () => {
  it('fetches the configured API\'s host over its protocol and the library\'s domains over HTTPS, and nothing else', async () => {
    const { client, fetched } = http('ambientCG', () => new Response('ok'))
    expect(['http://127.0.0.1:8123/file.zip', 'https://library.example/a', 'https://cdn.library.example/a'].map(url => client.serves(new URL(url)))).toEqual([true, true, true])
    expect(['https://127.0.0.1:8123/file.zip', 'http://library.example/a', 'https://library.example.evil.test/a', 'https://notlibrary.example/a'].map(url => client.serves(new URL(url))))
      .toEqual([false, false, false, false])
    await expect(client.request(new URL('http://library.example/a'), '*/*', 'the file', signal)).rejects.toMatchObject(
      refusedRequest(0, 'ambientCG named the file at http://library.example/a, which is not an ambientCG address, so nothing was downloaded from it.'))
    expect(fetched).toEqual([])
    const other = http('Poly Haven', () => new Response('ok'))
    await expect(other.client.request(new URL('ftp://library.example/a'), '*/*', 'the file', signal)).rejects.toThrow('which is not a Poly Haven address')
  })

  it('follows at most five redirects, each to a host the library serves from', async () => {
    const hops = http('Poly Haven', url => url.endsWith('/5') ? new Response('done') : new Response(null, { status: 302, headers: { location: `/${Number(url.at(-1)) + 1}` } }))
    expect(await (await hops.client.request(new URL('https://library.example/0'), '*/*', 'the file', signal)).text()).toBe('done')
    expect(hops.fetched).toHaveLength(6)
    const loop = http('Poly Haven', () => new Response(null, { status: 302, headers: { location: '/again' } }))
    await expect(loop.client.request(new URL('https://library.example/0'), '*/*', 'the file', signal)).rejects.toMatchObject(
      refusedRequest(302, 'Poly Haven redirected the file more than 5 times.'))
    expect(loop.fetched).toHaveLength(6)
  })

  it('refuses a redirect to an address that is not a URL with a request error that says nothing was saved', async () => {
    const broken = http('Poly Haven', () => new Response(null, { status: 302, headers: { location: 'http://[::1' } }))
    await expect(broken.client.request(new URL('https://library.example/0'), '*/*', 'the file', signal)).rejects.toMatchObject(
      refusedRequest(302, 'Poly Haven redirected the file to "http://[::1", which is not a valid URL; nothing was saved.'))
    expect(broken.fetched).toEqual(['https://library.example/0'])
  })

  it('ends reading a body whose connection breaks off with a request error that says nothing was saved, and passes cancellation on', async () => {
    const terminated = new TypeError('terminated')
    const cut = (): Response => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"a":'))
        stream.error(terminated)
      },
    }))
    const { client } = http('Poly Haven', cut)
    const reading = client.json(new URL('https://library.example/list.json'), 'the list', signal)
    await expect(reading).rejects.toMatchObject(refusedRequest(200, 'The connection to Poly Haven broke off while it sent the list; nothing was saved. Try again.'))
    await expect(reading).rejects.toMatchObject({ cause: { cause: terminated } })
    const folder = await temporaryFolder()
    const response = await client.request(new URL('https://library.example/file.zip'), '*/*', 'the file', signal)
    await expect(saveBody(response, join(folder, 'file.zip'), 'md5', 100, () => new Error('too long'), signal)).rejects.toMatchObject(
      refusedRequest(200, 'The connection to Poly Haven broke off while it sent the file; nothing was saved. Try again.'))
    const controller = new AbortController()
    const cancelled = new Error('cancelled by the test')
    const stalled = http('Poly Haven', () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        controller.signal.addEventListener('abort', () => { stream.error(controller.signal.reason) })
      },
    })))
    const body = (await stalled.client.request(new URL('https://library.example/file.zip'), '*/*', 'the file', controller.signal)).arrayBuffer()
    controller.abort(cancelled)
    await expect(body).rejects.toBe(cancelled)
  })

  it('reads a body up to its limit, and JSON only', async () => {
    const { client } = http('Poly Haven', url => url.endsWith('.json') ? new Response('{"a":1}') : new Response('<html>'))
    expect((await client.bytes(new Response('abc'), 3, 'a list')).toString()).toBe('abc')
    await expect(client.bytes(new Response('abcd'), 3, 'a list')).rejects.toMatchObject(refusedRequest(200, 'Poly Haven sent a list larger than 3 bytes.'))
    await expect(client.bytes(new Response('ab', { headers: { 'content-length': '9' } }), 3, 'a list')).rejects.toThrow('Poly Haven sent a list larger than 3 bytes.')
    expect(await client.json(new URL('https://library.example/list.json'), 'the list', signal)).toEqual({ a: 1 })
    await expect(client.json(new URL('https://library.example/list.html'), 'the list', signal)).rejects.toMatchObject(refusedRequest(200, 'Poly Haven sent the list that is not JSON.'))
  })
})

describe('AssetLibraryClient', () => {
  /** A library's client with one request of its own, as a plugin's client adds its catalog. */
  class Library extends AssetLibraryClient {
    async list(): Promise<unknown> {
      return await this.http.json(new URL('assets?type=all', this.base), 'the asset list', signal)
    }
  }

  function library(apiUrl: string): { readonly client: Library; readonly fetched: string[] } {
    const fetched: string[] = []
    const client = new Library({
      library: 'Poly Haven',
      apiUrl,
      domains: ['library.example'],
      userAgent: 'WASD Engine',
      downloads: 'the file',
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString()
        fetched.push(`${new Headers(init?.headers).get('user-agent') ?? ''} ${url}`)
        if (url.endsWith('.png')) return Promise.resolve(new Response('png', { headers: { 'content-type': 'image/png' } }))
        if (url.endsWith('/gone.zip')) return Promise.resolve(new Response(null, { status: 404 }))
        return Promise.resolve(new Response(url.endsWith('.zip') ? 'zip' : '{"rock":1}'))
      },
      errors,
    })
    return { client, fetched }
  }

  it('reads the API under its URL with or without a closing slash, naming the software', async () => {
    for (const apiUrl of ['http://127.0.0.1:8123/api', 'http://127.0.0.1:8123/api/']) {
      const { client, fetched } = library(apiUrl)
      expect(await client.list()).toEqual({ rock: 1 })
      expect(fetched).toEqual(['WASD Engine http://127.0.0.1:8123/api/assets?type=all'])
    }
  })

  it('fetches preview images and downloads from the library\'s hosts only, and names a download in its errors', async () => {
    const { client, fetched } = library('http://127.0.0.1:8123/api')
    expect(await client.image('https://cdn.library.example/rock.png', signal)).toEqual({ data: Buffer.from('png'), mediaType: 'image/png' })
    expect(await (await client.download('http://127.0.0.1:8123/files/rock.zip', signal)).text()).toBe('zip')
    await expect(client.download('https://library.example/gone.zip', signal)).rejects.toMatchObject(
      refusedRequest(404, 'Poly Haven answered HTTP 404 for the file https://library.example/gone.zip.'))
    expect(fetched).toHaveLength(3)
    const elsewhere = 'https://elsewhere.test/rock.zip'
    await expect(client.download(elsewhere, signal)).rejects.toMatchObject(
      refusedRequest(0, `Poly Haven named the file ${elsewhere} at ${elsewhere}, which is not a Poly Haven address, so nothing was downloaded from it.`))
    const image = client.image('https://elsewhere.test/rock.png', signal)
    await expect(image).rejects.toMatchObject({ kind: 'request' })
    await expect(image).rejects.toThrow('which is not a Poly Haven address')
    expect(fetched).toHaveLength(3)
  })
})

describe('shownPreview', () => {
  const image: PreviewImage = { data: Buffer.from('png'), mediaType: 'image/png' }
  const load = (): Promise<PreviewImage> => Promise.resolve(image)

  function call(controller = new AbortController()): ToolRunContext {
    return { signal: controller.signal } as ToolRunContext
  }

  it('carries the image the surface stored, and nothing when the surface keeps none for the result', async () => {
    const named: string[] = []
    const storing: PreviewSurface<string> = {
      async preview(exec, loadImage, name) {
        named.push(name)
        return `stored ${(await loadImage(exec.signal)).mediaType}`
      },
    }
    expect(await shownPreview(storing, call(), load, 'rock.jpg')).toEqual({ preview: 'stored image/png' })
    expect(named).toEqual(['rock.jpg'])
    expect(await shownPreview<string>({ preview: () => Promise.resolve(undefined) }, call(), load, 'rock.jpg')).toEqual({})
  })

  it('reports why the image could not be shown instead of failing the call, unless the call was cancelled', async () => {
    const failing: PreviewSurface<string> = { preview: () => Promise.reject(new Error('Poly Haven answered HTTP 500 for the preview image.')) }
    expect(await shownPreview(failing, call(), load, 'rock.jpg')).toEqual({ previewError: 'Poly Haven answered HTTP 500 for the preview image.' })
    const controller = new AbortController()
    controller.abort(new Error('the call was cancelled'))
    await expect(shownPreview(failing, call(controller), load, 'rock.jpg')).rejects.toThrow('the call was cancelled')
  })
})

describe('savedCounts', () => {
  it('says how many files a download wrote, replaced, and found in place, leaving out what happened to none', () => {
    expect(savedCounts([{ status: 'unchanged' }, { status: 'downloaded' }, { status: 'downloaded' }])).toEqual(['2 downloaded', '1 already in place'])
    expect(savedCounts([{ status: 'replaced' }, { status: 'unchanged' }, { status: 'downloaded' }])).toEqual([
      '1 downloaded', '1 replaced', '1 already in place',
    ])
    expect(savedCounts([{ status: 'replaced' }])).toEqual(['1 replaced'])
    expect(savedCounts([])).toEqual([])
  })

  it('counts the statuses the result schema of a download allows', () => {
    expect(WRITTEN_FILES_SCHEMA.items.properties.status.enum.map(status => savedCounts([{ status }]))).toEqual([
      ['1 downloaded'], ['1 replaced'], ['1 already in place'],
    ])
  })
})

describe('saveBody', () => {
  it('writes a body into a new file with its size and digest, and stops past the limit', async () => {
    const folder = await temporaryFolder()
    const tooLong = (): Error => new Error('longer than listed')
    expect(await saveBody(new Response('hello'), join(folder, 'a.bin'), 'sha1', 5, tooLong, signal)).toEqual({ bytes: 5, digest: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d' })
    expect(await readFile(join(folder, 'a.bin'), 'utf8')).toBe('hello')
    await expect(saveBody(new Response('hello!'), join(folder, 'b.bin'), 'md5', 5, tooLong, signal)).rejects.toThrow('longer than listed')
    await expect(saveBody(new Response('hello'), join(folder, 'a.bin'), 'md5', 5, tooLong, signal)).rejects.toThrow('EEXIST')
  })
})

describe('downloadFolders', () => {
  it('takes an absolute folder as it is and a relative one, or the default, in the working directory', async () => {
    const work = resolve('/projects/game')
    const folder = downloadFolders({ workingDirectory: { ensure: (agent: string) => Promise.resolve(join(work, agent)) } }, errors)
    const absolute = resolve('/elsewhere/textures')
    expect(await folder(absolute, 'assets/library/rock', { signal })).toBe(absolute)
    expect(await folder('art/rock', 'assets/library/rock', { agent: 'a', signal })).toBe(join(work, 'a', 'art', 'rock'))
    expect(await folder(undefined, join('assets', 'library', 'rock'), { agent: 'a', signal })).toBe(join(work, 'a', 'assets', 'library', 'rock'))
    await expect(folder(undefined, 'assets/library/rock', { signal })).rejects.toMatchObject({ kind: 'argument', message: 'Pass directory as an absolute path.' })
    await expect(folder('//host/share/textures', 'assets/library/rock', { agent: 'a', signal })).rejects.toMatchObject(
      { kind: 'argument', message: '//host/share/textures is a network path; pass a folder on this computer.' })
  })
})

describe('writeAssetFiles', () => {
  function file(path: string, body: string, log: string[] = []): AssetFileWrite {
    return {
      path,
      bytes: Buffer.byteLength(body),
      same: async target => await readFile(target, 'utf8') === body,
      write: async (temporary) => {
        log.push(path)
        await writeFile(temporary, body, { flag: 'wx' })
      },
    }
  }

  /** The options of one download of a plugin whose held folders are `folders`. */
  function writing(folders = new Map<string, number>(), overrides: { readonly replace?: boolean; readonly signal?: AbortSignal } = {}) {
    return { replace: false, signal, folders, errors, ...overrides }
  }

  function gate(): { readonly open: () => void; readonly passed: Promise<void> } {
    let open = (): void => {}
    const passed = new Promise<void>((resolve) => { open = resolve })
    return { open, passed }
  }

  /** A file whose write starts, then waits for `release` and fails, as a damaged file does. */
  function failingAfter(path: string, started: { readonly open: () => void }, release: Promise<void>): AssetFileWrite {
    return {
      ...file(path, path),
      write: async () => {
        started.open()
        await release
        throw new Error(`${path} arrived damaged`)
      },
    }
  }

  it('writes new files, leaves equal ones alone, and replaces changed ones only when allowed', async () => {
    const folder = await temporaryFolder()
    const log: string[] = []
    const files = [file('a.txt', 'alpha', log), file('maps/b.txt', 'beta', log)]
    expect(await writeAssetFiles(files, folder, writing())).toEqual([
      { path: 'a.txt', bytes: 5, status: 'downloaded' }, { path: 'maps/b.txt', bytes: 4, status: 'downloaded' },
    ])
    expect((await writeAssetFiles(files, folder, writing())).map(written => written.status)).toEqual(['unchanged', 'unchanged'])
    expect(log).toEqual(['a.txt', 'maps/b.txt'])
    await writeFile(join(folder, 'a.txt'), 'ALPHA')
    await expect(writeAssetFiles(files, folder, writing())).rejects.toMatchObject({
      kind: 'exists',
      message: `A file in ${folder} already exists with other contents: a.txt. Pass replace: true to overwrite it, or download into another directory.`,
    })
    expect((await writeAssetFiles(files, folder, writing(undefined, { replace: true }))).map(written => written.status)).toEqual(['replaced', 'unchanged'])
    expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('alpha')
    await mkdir(join(folder, 'c.txt'))
    await expect(writeAssetFiles([file('c.txt', 'gamma')], folder, writing())).rejects.toMatchObject({
      kind: 'exists', message: `${join(folder, 'c.txt')} exists and is not a file; move it or download into another directory.`,
    })
  })

  it('writes none of the files when one fails or a path would leave the folder, and leaves no temporary file', async () => {
    const folder = await temporaryFolder()
    const failing: AssetFileWrite = { ...file('b.txt', 'beta'), write: () => Promise.reject(new Error('b.txt arrived damaged')) }
    await expect(writeAssetFiles([file('a.txt', 'alpha'), failing], folder, writing())).rejects.toThrow('b.txt arrived damaged')
    expect(await readdir(folder)).toEqual([])
    await expect(writeAssetFiles([file('../outside.txt', 'x')], folder, writing())).rejects.toMatchObject(
      { kind: 'corrupt', message: 'The file ../outside.txt would leave the download folder; the download stopped.' })
  })

  it('removes the folders it created when a file fails, keeping a folder that something else wrote into', async () => {
    const folder = await temporaryFolder()
    const folders = new Map<string, number>()
    const failing: AssetFileWrite = { ...file('textures/b.txt', 'beta'), write: () => Promise.reject(new Error('b.txt arrived damaged')) }
    const files = [file('a.txt', 'alpha'), file('maps/c.txt', 'gamma'), failing]
    await expect(writeAssetFiles(files, join(folder, 'assets', 'library', 'rock'), writing(folders))).rejects.toThrow('b.txt arrived damaged')
    expect(await readdir(folder)).toEqual([])
    // A file that another program writes into a new folder keeps that folder and the folders above it.
    const meanwhile: AssetFileWrite = {
      ...file('maps/a.txt', 'alpha'),
      write: async (temporary) => {
        await writeFile(join(dirname(temporary), 'notes.txt'), 'the user\'s notes')
        throw new Error('a.txt arrived damaged')
      },
    }
    await expect(writeAssetFiles([meanwhile, file('textures/b.txt', 'beta')], join(folder, 'rock'), writing(folders))).rejects.toThrow('a.txt arrived damaged')
    expect(await readdir(join(folder, 'rock'))).toEqual(['maps'])
    expect(await readdir(join(folder, 'rock', 'maps'))).toEqual(['notes.txt'])
    expect(folders.size).toBe(0)
  })

  it('removes the folders it created when cancelled, and keeps the folders that were there before', async () => {
    const folder = await temporaryFolder()
    await mkdir(join(folder, 'assets'))
    const controller = new AbortController()
    const waiting: AssetFileWrite = {
      ...file('maps/a.txt', 'alpha'),
      write: (_temporary, linked) => new Promise((_resolve, reject) => {
        linked.addEventListener('abort', () => { reject(linked.reason as Error) })
        controller.abort()
      }),
    }
    await expect(writeAssetFiles([waiting], join(folder, 'assets', 'library', 'rock'), writing(undefined, { signal: controller.signal }))).rejects.toThrow()
    expect(await readdir(folder)).toEqual(['assets'])
    expect(await readdir(join(folder, 'assets'))).toEqual([])
  })

  it('keeps a folder that another download into it still uses when a download that created it fails', async () => {
    const folder = await temporaryFolder()
    const target = join(folder, 'assets', 'textures')
    const folders = new Map<string, number>()
    const [aWriting, aFails, bWriting, bArrives] = [gate(), gate(), gate(), gate()]
    // The first download makes the folders and fails while the second, which found them in place, still waits for its file.
    const first = writeAssetFiles([failingAfter('wood/a.jpg', aWriting, aFails.passed)], target, writing(folders))
    await aWriting.passed
    const second = writeAssetFiles([{
      ...file('wood/b.jpg', 'bbb'),
      write: async (temporary) => {
        bWriting.open()
        await bArrives.passed
        await writeFile(temporary, 'bbb', { flag: 'wx' })
      },
    }], target, writing(folders))
    await bWriting.passed
    aFails.open()
    await expect(first).rejects.toThrow('wood/a.jpg arrived damaged')
    bArrives.open()
    expect(await second).toEqual([{ path: 'wood/b.jpg', bytes: 3, status: 'downloaded' }])
    expect(await readdir(join(target, 'wood'))).toEqual(['b.jpg'])
    expect(folders.size).toBe(0)
  })

  it('removes every folder that failed downloads of one plugin created, whichever of them ends last', async () => {
    for (const lastToFail of ['first', 'second'] as const) {
      const folder = await temporaryFolder()
      const folders = new Map<string, number>()
      const [aWriting, aFails, bWriting, bFails] = [gate(), gate(), gate(), gate()]
      // The first download makes assets/ambientcg; the second, into a sibling folder, finds it in place.
      const first = writeAssetFiles([failingAfter('Wood099_1K-JPG_Color.jpg', aWriting, aFails.passed)], join(folder, 'assets', 'ambientcg', 'Wood099'), writing(folders))
      await aWriting.passed
      const second = writeAssetFiles([failingAfter('Bricks097_1K-JPG_Color.jpg', bWriting, bFails.passed)], join(folder, 'assets', 'ambientcg', 'Bricks097'), writing(folders))
      await bWriting.passed
      const [early, late] = lastToFail === 'second' ? [aFails, bFails] : [bFails, aFails]
      early.open()
      await expect(lastToFail === 'second' ? first : second).rejects.toThrow('arrived damaged')
      // The folder that the first download made stays while the other download still uses it.
      expect(await readdir(join(folder, 'assets', 'ambientcg'))).toEqual([lastToFail === 'second' ? 'Bricks097' : 'Wood099'])
      late.open()
      await expect(lastToFail === 'second' ? second : first).rejects.toThrow('arrived damaged')
      expect(await readdir(folder), lastToFail).toEqual([])
      expect(folders.size).toBe(0)
    }
  })

  it('removes every folder that failed downloads made into one new tree, however their steps interleave', async () => {
    const failing = (name: string): AssetFileWrite => ({ ...file(name, name), write: () => Promise.reject(new Error(`${name} arrived damaged`)) })
    const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
    for (let round = 0; round < 20; round += 1) {
      const folder = await temporaryFolder()
      const folders = new Map<string, number>()
      // Each download makes a different part of one deep tree and fails as soon as it can, a few steps after the others.
      const downloads = Array.from({ length: 10 }, async (_, index) => {
        for (let wait = (index * 7 + round) % 4; wait > 0; wait -= 1) await tick()
        return await writeAssetFiles([failing(`${index}.jpg`)], join(folder, 'a', 'b', 'c', `d${index % 3}`, `e${index % 2}`), writing(folders))
      })
      expect((await Promise.allSettled(downloads)).map(result => result.status)).toEqual(Array.from({ length: 10 }, () => 'rejected'))
      expect(await readdir(folder), `round ${round}`).toEqual([])
      expect(folders.size).toBe(0)
    }
  })

  it('lets downloads that start together share the new folders they make', async () => {
    const folder = await temporaryFolder()
    const folders = new Map<string, number>()
    const target = join(folder, 'assets', 'library', 'rock')
    const written = await Promise.all([1, 2].map(index => writeAssetFiles([file(`maps/${index}.jpg`, 'x')], target, writing(folders))))
    expect(written.flat().map(result => result.status)).toEqual(['downloaded', 'downloaded'])
    expect((await readdir(join(target, 'maps'))).sort()).toEqual(['1.jpg', '2.jpg'])
    expect(folders.size).toBe(0)
  })

  it('keeps what a successful download wrote and removes only what failed downloads left empty', async () => {
    const folder = await temporaryFolder()
    const folders = new Map<string, number>()
    const [aWriting, aFails, bWriting, bArrives] = [gate(), gate(), gate(), gate()]
    const first = writeAssetFiles([failingAfter('Color.jpg', aWriting, aFails.passed)], join(folder, 'assets', 'library', 'wood'), writing(folders))
    await aWriting.passed
    const second = writeAssetFiles([{
      ...file('Color.jpg', 'bricks'),
      write: async (temporary) => {
        bWriting.open()
        await bArrives.passed
        await writeFile(temporary, 'bricks', { flag: 'wx' })
      },
    }], join(folder, 'assets', 'library', 'bricks'), writing(folders))
    await bWriting.passed
    bArrives.open()
    expect(await second).toEqual([{ path: 'Color.jpg', bytes: 6, status: 'downloaded' }])
    aFails.open()
    await expect(first).rejects.toThrow('Color.jpg arrived damaged')
    expect(await readdir(folder, { recursive: true })).toEqual(['assets', join('assets', 'library'), join('assets', 'library', 'bricks'), join('assets', 'library', 'bricks', 'Color.jpg')])
    expect(folders.size).toBe(0)
  })

  it('turns a failure on the disk into the plugin\'s disk error, naming the file, the error code, and what is in place', async () => {
    const folder = await temporaryFolder()
    // A file where a folder of the download goes: making that folder fails.
    await writeFile(join(folder, 'assets'), 'not a folder')
    const blocked = writeAssetFiles([file('maps/a.jpg', 'a')], join(folder, 'assets', 'library', 'rock'), writing())
    await expect(blocked).rejects.toMatchObject({ kind: 'disk', cause: { code: expect.any(String) as string } })
    const advice = /^The download failed on the disk while it .+: E[A-Z]+: .+; nothing was saved\. Check that the folder can be written/u
    await expect(blocked).rejects.toThrow(advice)
    // A temporary file that cannot be written.
    const unwritable: AssetFileWrite = { ...file('a.jpg', 'a'), write: temporary => writeFile(join(temporary, 'inside'), 'a') }
    const target = join(folder, 'rock')
    await expect(writeAssetFiles([unwritable], target, writing())).rejects.toMatchObject({ kind: 'disk', message: expect.stringMatching(/^The download failed on the disk while it wrote a\.jpg: ENOENT: .+; nothing was saved\./u) as string })
    // A file that cannot take its place after the ones before it did.
    const occupied: AssetFileWrite = {
      ...file('b.txt', 'b'),
      write: async (temporary) => {
        await writeFile(temporary, 'b', { flag: 'wx' })
        await mkdir(join(dirname(temporary), 'b.txt'))
      },
    }
    await expect(writeAssetFiles([file('a.txt', 'a'), occupied], target, writing())).rejects.toMatchObject({
      kind: 'disk', message: expect.stringMatching(/^The download failed on the disk while it moved b\.txt into place: E[A-Z]+: .+; of its files, a\.txt is in place\./u) as string,
    })
    expect((await readdir(target)).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('passes a cancellation on as it is, also when a file then fails on the disk', async () => {
    const folder = await temporaryFolder()
    const controller = new AbortController()
    const cancelled = new Error('cancelled by the test')
    const cancelling: AssetFileWrite = {
      ...file('a.jpg', 'a'),
      write: async (temporary) => {
        controller.abort(cancelled)
        await writeFile(join(temporary, 'inside'), 'a')
      },
    }
    await expect(writeAssetFiles([cancelling], join(folder, 'rock'), writing(undefined, { signal: controller.signal }))).rejects.toBe(cancelled)
    expect(await readdir(folder)).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps a failure its own when its temporary files cannot be removed afterwards', async () => {
    const folder = await temporaryFolder()
    const target = join(folder, 'rock')
    const locking: AssetFileWrite = {
      ...file('a.jpg', 'a'),
      write: async (temporary) => {
        await writeFile(temporary, 'a', { flag: 'wx' })
        // Nothing can be removed from the folder now.
        await chmod(dirname(temporary), 0o555)
        throw new Error('a.jpg arrived damaged')
      },
    }
    try {
      await expect(writeAssetFiles([locking], target, writing())).rejects.toThrow('a.jpg arrived damaged')
    } finally {
      await chmod(target, 0o755)
    }
  })

  it('refuses two paths that name one file, such as two that differ only in letter case, before anything is written', async () => {
    const folder = await temporaryFolder()
    const log: string[] = []
    const target = join(folder, 'rock')
    await expect(writeAssetFiles([file('maps/Color.jpg', 'a', log), file('MAPS/color.JPG', 'b', log)], target, writing())).rejects.toMatchObject({
      kind: 'corrupt',
      message: 'The files maps/Color.jpg and MAPS/color.JPG would be one file in the download folder, since macOS and Windows ignore letter case in file names; the download stopped.',
    })
    await expect(writeAssetFiles([file('a.txt', 'a', log), file('a.txt', 'b', log)], target, writing())).rejects.toMatchObject(
      { kind: 'corrupt', message: 'The files a.txt and a.txt would be one file in the download folder; the download stopped.' })
    expect(log).toEqual([])
    expect(await readdir(folder)).toEqual([])
  })
})
