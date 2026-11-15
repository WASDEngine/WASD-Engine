// @vitest-environment jsdom
/**
 * Reading the viewed asset and its first bytes through the Host's project file route, and naming the files a model
 * refers to: inside the project folder only, never from the web.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetFileUrl, readablePath, readAsset, readHead, relatedPath, relatedUrl } from '../src/client/read.ts'

afterEach(() => { vi.unstubAllGlobals() })

const BASE = 'dsh-app://app/'

/** The route's URL for a file, as the Host serves it. */
function routeUrl(root: string, path: string, options: { max?: number; length?: number } = {}): string {
  const params = new URLSearchParams({ root, path })
  if (options.max !== undefined) params.set('max', String(options.max))
  if (options.length !== undefined) params.set('length', String(options.length))
  return `${BASE}api/game-assets.file?${params.toString()}`
}

/** A route that answers each request from a function of its URL. */
function route(answer: (url: URL) => Response) {
  const fetched: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    fetched.push(url)
    init?.signal?.throwIfAborted()
    return answer(new URL(url))
  }))
  return fetched
}

const bytes = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, index) => index)

function refusal(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('assetFileUrl', () => {
  it('names the project folder, the file, and the caps, under the page\'s base URI', () => {
    expect(assetFileUrl(BASE, '/p', 'models/hero.glb', { max: 100 })).toBe(routeUrl('/p', 'models/hero.glb', { max: 100 }))
    expect(assetFileUrl('https://example.test/deploy/', '/p', 'a.png', { length: 16 })).toBe(`https://example.test/deploy/api/game-assets.file?${new URLSearchParams({ root: '/p', path: 'a.png', length: '16' }).toString()}`)
    expect(assetFileUrl(BASE, 'C:\\Games\\Knight', 'art\\hero.png')).toBe(routeUrl('C:\\Games\\Knight', 'art\\hero.png'))
    // A folder named `~` inside the project, which the Host would read in the home folder.
    expect(readablePath('~/hero.png')).toBe('./~/hero.png')
    expect(assetFileUrl(BASE, '/p', '~/hero.png')).toBe(routeUrl('/p', './~/hero.png'))
  })

  it('names nothing for a page the route does not serve, a relative or UNC folder, or a path with a control character', () => {
    expect(assetFileUrl('file:///index.html', '/p', 'a.png')).toBeUndefined()
    expect(assetFileUrl(BASE, 'p', 'a.png')).toBeUndefined()
    expect(assetFileUrl(BASE, '\\\\nas\\share\\Knight', 'a.png')).toBeUndefined()
    expect(assetFileUrl(BASE, '/p', '//nas/share/a.png')).toBeUndefined()
    expect(assetFileUrl(BASE, '/p', 'a\n.png')).toBeUndefined()
    expect(assetFileUrl(BASE, '/p', '')).toBeUndefined()
  })
})

describe('readAsset', () => {
  it('reads a complete file through the route with its version', async () => {
    const fetched = route(() => new Response(bytes(5), { headers: { 'X-Asset-Version': 'v1' } }))
    const result = await readAsset(BASE, '/p', 'a.png', 100, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: { data: bytes(5), version: 'v1' } })
    expect(fetched).toEqual([routeUrl('/p', 'a.png', { max: 100 })])
  })

  it('names the route\'s refusals: no file, a file over the cap, a link out of the project, and other failures', async () => {
    const answers: Record<string, Response> = {
      'gone.png': refusal(404, { code: 'not-found', message: 'No file at gone.png.' }),
      'big.glb': refusal(413, { code: 'too-large', message: 'big.glb is larger than 4 bytes.', limit: 4 }),
      'linked/secret.png': refusal(403, { code: 'outside-project', message: 'linked/secret.png leads outside the project folder /p.' }),
      'folder': refusal(403, { code: 'not-a-file', message: 'folder is not a file.' }),
      'plain.png': new Response('nope', { status: 500 }),
    }
    route(url => answers[url.searchParams.get('path') ?? ''] ?? new Response(null, { status: 500 }))
    const read = async (path: string) => {
      const result = await readAsset(BASE, '/p', path, 4, new AbortController().signal)
      return result.ok ? undefined : { code: result.error.code, details: result.error.details }
    }
    expect(await read('gone.png')).toEqual({ code: 'workspace-file/not-found', details: { path: 'gone.png' } })
    expect(await read('big.glb')).toEqual({ code: 'workspace-file/too-large', details: { path: 'big.glb', limit: 4 } })
    expect(await read('linked/secret.png')).toEqual({ code: 'game-assets/outside', details: { path: 'linked/secret.png' } })
    expect(await read('folder')).toEqual({ code: 'game-assets/unreadable', details: { path: 'folder' } })
    expect(await read('plain.png')).toEqual({ code: 'game-assets/unreadable', details: { path: 'plain.png' } })
  })

  it('refuses a body larger than the cap, a stream that breaks off, a failed request, and a page the route does not serve', async () => {
    route(() => new Response(bytes(10)))
    const over = await readAsset(BASE, '/p', 'a.png', 4, new AbortController().signal)
    expect(!over.ok && over.error.code).toBe('workspace-file/too-large')
    route(() => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('the file changed while it was read')) } })))
    const broken = await readAsset(BASE, '/p', 'a.png', 100, new AbortController().signal)
    expect(!broken.ok && broken.error.message).toContain('the file changed while it was read')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const offline = await readAsset(BASE, '/p', 'a.png', 100, new AbortController().signal)
    expect(!offline.ok && offline.error.code).toBe('game-assets/unreadable')
    const page = await readAsset('file:///index.html', '/p', 'a.png', 100, new AbortController().signal)
    expect(!page.ok && page.error.code).toBe('game-assets/unreadable')
  })

  it('rejects with the reason once cancelled', async () => {
    route(() => new Response(bytes(5)))
    const controller = new AbortController()
    controller.abort(new Error('closed'))
    await expect(readAsset(BASE, '/p', 'a.png', 100, controller.signal)).rejects.toThrow('closed')
  })
})

describe('readHead', () => {
  it('reads a file\'s first bytes, and nothing for a file the route refuses', async () => {
    const fetched = route(url => (url.searchParams.get('path') === 'a.png' ? new Response(bytes(3)) : refusal(404, { code: 'not-found' })))
    expect(await readHead(BASE, '/p', 'a.png', 3, new AbortController().signal)).toEqual(bytes(3))
    expect(fetched).toEqual([routeUrl('/p', 'a.png', { length: 3 })])
    expect(await readHead(BASE, '/p', 'gone.png', 3, new AbortController().signal)).toBeUndefined()
  })
})

describe('related files', () => {
  it('resolves names against the viewed file\'s folder inside the project, absolute names by their file name', () => {
    expect(relatedPath('/p', 'models/hero.gltf', 'hero.bin')).toBe('models/hero.bin')
    expect(relatedPath('/p', 'models/hero.gltf', './tex/skin.png')).toBe('models/tex/skin.png')
    expect(relatedPath('/p', 'models/hero.obj', '../materials/hero.mtl')).toBe('materials/hero.mtl')
    expect(relatedPath('/p', 'models/hero.fbx', 'C:\\Users\\artist\\textures\\skin.png')).toBe('models/skin.png')
    expect(relatedPath('/p', '/p/models/hero.gltf', 'tex/skin.png')).toBe('models/tex/skin.png')
    expect(relatedPath('C:\\game', 'C:\\Game\\models\\hero.gltf', '..\\skin.png')).toBe('skin.png')
    // `..` never leads out of the project folder, and a viewed file outside it names nothing.
    expect(relatedPath('/p', 'a.obj', '../../../../x.png')).toBeUndefined()
    expect(relatedPath('/p', 'models/hero.gltf', '../../p/models/hero.bin')).toBeUndefined()
    expect(relatedPath('/p', '/elsewhere/hero.gltf', 'hero.bin')).toBeUndefined()
  })

  it('serves related files from the project file route and passes data and blob URLs through', () => {
    expect(relatedUrl(BASE, '/p', 'models/hero.gltf', 'my%20skin.png', 100)).toBe(routeUrl('/p', 'models/my skin.png', { max: 100 }))
    expect(relatedUrl(BASE, '/p', 'models/hero.gltf', '100%.png', 100)).toBe(routeUrl('/p', 'models/100%.png', { max: 100 }))
    expect(relatedUrl(BASE, '/p', 'models/hero.gltf', '../textures/skin.png', 100)).toBe(routeUrl('/p', 'textures/skin.png', { max: 100 }))
    expect(relatedUrl(BASE, '/p', 'hero.gltf', 'data:image/png;base64,AAAA', 100)).toBe('data:image/png;base64,AAAA')
    expect(relatedUrl(BASE, '/p', 'hero.gltf', 'blob:dsh-app://app/123', 100)).toBe('blob:dsh-app://app/123')
  })

  it('loads nothing from the web, from outside the project, or from a path the route does not serve', () => {
    const refused = [
      'https://tracker.example/t.png',
      // A control character makes the route refuse the path; the name is not fetched from the web instead.
      'https://tracker.example/t%0A.png',
      'https%3A%2F%2Ftracker.example%2Ft.png',
      'file:///Users/me/Pictures/private.png',
      '../../../../../Users/me/Pictures/private.png',
      'textures/body%0A.png',
    ]
    for (const reference of refused) expect(relatedUrl(BASE, '/Users/me/Knight', 'models/knight.gltf', reference, 100), reference).toBeUndefined()
    // An absolute name loads by its file name from the model's folder.
    expect(relatedUrl(BASE, '/Users/me/Knight', 'models/knight.gltf', '/Users/me/Pictures/private.png', 100)).toBe(routeUrl('/Users/me/Knight', 'models/private.png', { max: 100 }))
    // A project on a UNC share, which the route does not serve, loads none of its model's files.
    expect(relatedUrl(BASE, '\\\\nas\\share\\Knight', 'knight.gltf', 'textures/body.png', 100)).toBeUndefined()
    // A page the route does not serve, such as one opened from a file, loads none either.
    expect(relatedUrl('file:///index.html', '/p', 'hero.gltf', 'skin.png', 100)).toBeUndefined()
  })
})
