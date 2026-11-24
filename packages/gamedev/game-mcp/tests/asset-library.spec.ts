/**
 * What the asset library plugins share in the kit: requests that stay on a library's hosts, bounded bodies, a library's
 * client, preview images in a result, the folder of a download, and files written whole or not at all. The Poly Haven
 * and ambientCG specs run the same code through their tools; these cases pin what each helper does by itself.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  AssetLibraryClient, AssetLibraryHttp, AssetLibraryRequestError, downloadFolders, saveBody, savedCounts, shownPreview, writeAssetFiles,
  WRITTEN_FILES_SCHEMA, type AssetFileWrite, type PreviewImage, type PreviewSurface,
} from '../src/kit.ts'

const signal = new AbortController().signal

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
  })
  return { client, fetched }
}

describe('AssetLibraryHttp', () => {
  it('fetches the configured API\'s host over its protocol and the library\'s domains over HTTPS, and nothing else', async () => {
    const { client, fetched } = http('ambientCG', () => new Response('ok'))
    expect(['http://127.0.0.1:8123/file.zip', 'https://library.example/a', 'https://cdn.library.example/a'].map(url => client.serves(new URL(url)))).toEqual([true, true, true])
    expect(['https://127.0.0.1:8123/file.zip', 'http://library.example/a', 'https://library.example.evil.test/a', 'https://notlibrary.example/a'].map(url => client.serves(new URL(url))))
      .toEqual([false, false, false, false])
    await expect(client.request(new URL('http://library.example/a'), '*/*', 'the file', signal)).rejects.toThrow(
      new AssetLibraryRequestError(0, 'ambientCG named the file at http://library.example/a, which is not an ambientCG address, so nothing was downloaded from it.'))
    expect(fetched).toEqual([])
    const other = http('Poly Haven', () => new Response('ok'))
    await expect(other.client.request(new URL('ftp://library.example/a'), '*/*', 'the file', signal)).rejects.toThrow('which is not a Poly Haven address')
  })

  it('follows at most five redirects, each to a host the library serves from', async () => {
    const hops = http('Poly Haven', url => url.endsWith('/5') ? new Response('done') : new Response(null, { status: 302, headers: { location: `/${Number(url.at(-1)) + 1}` } }))
    expect(await (await hops.client.request(new URL('https://library.example/0'), '*/*', 'the file', signal)).text()).toBe('done')
    expect(hops.fetched).toHaveLength(6)
    const loop = http('Poly Haven', () => new Response(null, { status: 302, headers: { location: '/again' } }))
    await expect(loop.client.request(new URL('https://library.example/0'), '*/*', 'the file', signal)).rejects.toThrow('Poly Haven redirected the file more than 5 times.')
    expect(loop.fetched).toHaveLength(6)
  })

  it('reads a body up to its limit, and JSON only', async () => {
    const { client } = http('Poly Haven', url => url.endsWith('.json') ? new Response('{"a":1}') : new Response('<html>'))
    expect((await client.bytes(new Response('abc'), 3, 'a list')).toString()).toBe('abc')
    await expect(client.bytes(new Response('abcd'), 3, 'a list')).rejects.toThrow('Poly Haven sent a list larger than 3 bytes.')
    await expect(client.bytes(new Response('ab', { headers: { 'content-length': '9' } }), 3, 'a list')).rejects.toThrow('Poly Haven sent a list larger than 3 bytes.')
    expect(await client.json(new URL('https://library.example/list.json'), 'the list', signal)).toEqual({ a: 1 })
    await expect(client.json(new URL('https://library.example/list.html'), 'the list', signal)).rejects.toThrow('Poly Haven sent the list that is not JSON.')
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
    await expect(client.download('https://library.example/gone.zip', signal)).rejects.toThrow(
      new AssetLibraryRequestError(404, 'Poly Haven answered HTTP 404 for the file https://library.example/gone.zip.'))
    expect(fetched).toHaveLength(3)
    const elsewhere = 'https://elsewhere.test/rock.zip'
    await expect(client.download(elsewhere, signal)).rejects.toThrow(
      `Poly Haven named the file ${elsewhere} at ${elsewhere}, which is not a Poly Haven address, so nothing was downloaded from it.`)
    await expect(client.image('https://elsewhere.test/rock.png', signal)).rejects.toThrow('which is not a Poly Haven address')
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
    const folder = downloadFolders({ workingDirectory: { ensure: (agent: string) => Promise.resolve(join(work, agent)) } })
    const absolute = resolve('/elsewhere/textures')
    expect(await folder(absolute, 'assets/library/rock', { signal })).toBe(absolute)
    expect(await folder('art/rock', 'assets/library/rock', { agent: 'a', signal })).toBe(join(work, 'a', 'art', 'rock'))
    expect(await folder(undefined, join('assets', 'library', 'rock'), { agent: 'a', signal })).toBe(join(work, 'a', 'assets', 'library', 'rock'))
    await expect(folder(undefined, 'assets/library/rock', { signal })).rejects.toThrow('Pass directory as an absolute path.')
    await expect(folder('//host/share/textures', 'assets/library/rock', { agent: 'a', signal })).rejects.toThrow('//host/share/textures is a network path; pass a folder on this computer.')
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

  it('writes new files, leaves equal ones alone, and replaces changed ones only when allowed', async () => {
    const folder = await temporaryFolder()
    const log: string[] = []
    const files = [file('a.txt', 'alpha', log), file('maps/b.txt', 'beta', log)]
    expect(await writeAssetFiles(files, folder, { replace: false, signal })).toEqual([
      { path: 'a.txt', bytes: 5, status: 'downloaded' }, { path: 'maps/b.txt', bytes: 4, status: 'downloaded' },
    ])
    expect((await writeAssetFiles(files, folder, { replace: false, signal })).map(written => written.status)).toEqual(['unchanged', 'unchanged'])
    expect(log).toEqual(['a.txt', 'maps/b.txt'])
    await writeFile(join(folder, 'a.txt'), 'ALPHA')
    await expect(writeAssetFiles(files, folder, { replace: false, signal })).rejects.toThrow(
      `A file in ${folder} already exists with other contents: a.txt. Pass replace: true to overwrite it, or download into another directory.`)
    expect((await writeAssetFiles(files, folder, { replace: true, signal })).map(written => written.status)).toEqual(['replaced', 'unchanged'])
    expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('alpha')
  })

  it('writes none of the files when one fails or a path would leave the folder, and leaves no temporary file', async () => {
    const folder = await temporaryFolder()
    const failing: AssetFileWrite = { ...file('b.txt', 'beta'), write: () => Promise.reject(new Error('b.txt arrived damaged')) }
    await expect(writeAssetFiles([file('a.txt', 'alpha'), failing], folder, { replace: false, signal })).rejects.toThrow('b.txt arrived damaged')
    expect(await readdir(folder)).toEqual([])
    await expect(writeAssetFiles([file('../outside.txt', 'x')], folder, { replace: false, signal })).rejects.toThrow('The file ../outside.txt would leave the download folder; the download stopped.')
  })
})
