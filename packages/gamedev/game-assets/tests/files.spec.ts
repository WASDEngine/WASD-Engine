/**
 * The `GET /api/game-assets.file` route over a real project folder: a file inside the project, its first bytes, and its
 * size and version alone; refusals of a file whose real path leads out of the project through a link, of a missing
 * file, a folder, a file over the cap, and a malformed request; and a file that changes while it streams.
 */
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSET_FILE_ROUTE, serveAssetFile, SIZE_HEADER, VERSION_HEADER } from '../src/files.ts'

/** A filesystem error as the composed filesystem throws it, recognized by its code. */
function fsError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function target(path: string): FsTarget {
  return { targetKey: path as FsTargetKey, displayPath: path }
}

/**
 * The parts of the composed filesystem the route uses, over the local disk: targets by real path, every link followed,
 * as the local backend resolves them.
 */
function localFs(): Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readByteRange'> {
  return {
    async resolve(path, opts) {
      const absolute = resolve(opts?.cwd ?? '/', path)
      try {
        return target(await realpath(absolute))
      } catch (error) {
        // ENOENT: an absent file keeps its path, which `stat` reports as absent.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target(absolute)
        throw fsError('FS_PERMISSION_DENIED')
      }
    },
    contains(parent, child) {
      const inside = relative(parent.targetKey, child.targetKey)
      return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    },
    async stat(file): Promise<FsInfo | undefined> {
      try {
        const info = await stat(file.targetKey)
        return { version: `${String(info.mtimeMs)}:${String(info.size)}` as FsVersion, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
      } catch {
        // ENOENT: absent.
        return undefined
      }
    },
    async readByteRange(file, range) {
      const handle = await open(file.targetKey)
      try {
        const buffer = Buffer.alloc(range.length)
        const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
        return new Uint8Array(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    },
  }
}

let base: string
let project: string
let outside: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-assets-files-')))
  project = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(join(project, 'art'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(project, 'art', 'hero.png'), 'hero image')
  await writeFile(join(outside, 'secret.png'), 'secret')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** One request of the route. */
async function get(params: Record<string, string>, options: { method?: string; maxBytes?: number; fs?: Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readByteRange'> } = {}): Promise<Response> {
  const request = new Request(`http://host${ASSET_FILE_ROUTE}?${new URLSearchParams(params).toString()}`, { method: options.method ?? 'GET' })
  return await serveAssetFile(request, { fs: (options.fs ?? localFs()) as FileSystem, maxBytes: options.maxBytes ?? 1024 })
}

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() }
}

describe('the project file route', () => {
  it('serves a file inside the project with its version and size, its first bytes, or its headers alone', async () => {
    const whole = await get({ root: project, path: 'art/hero.png' })
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe('hero image')
    const info = await stat(join(project, 'art', 'hero.png'))
    expect(whole.headers.get(VERSION_HEADER)).toBe(`${String(info.mtimeMs)}:10`)
    expect(whole.headers.get(SIZE_HEADER)).toBe('10')
    expect(whole.headers.get('Cache-Control')).toBe('private, no-store')
    // An absolute path inside the project reads the same file.
    expect(await (await get({ root: project, path: join(project, 'art', 'hero.png') })).text()).toBe('hero image')
    const head = await get({ root: project, path: 'art/hero.png', length: '4' })
    expect(await head.text()).toBe('hero')
    expect(head.headers.get(SIZE_HEADER)).toBe('10')
    const sized = await get({ root: project, path: 'art/hero.png' }, { method: 'HEAD' })
    expect([sized.status, sized.headers.get(SIZE_HEADER), await sized.text()]).toEqual([200, '10', ''])
  })

  it('refuses a file whose real path leads out of the project, through a file link or a folder link', async () => {
    await symlink(join(outside, 'secret.png'), join(project, 'art', 'linked.png'))
    await symlink(outside, join(project, 'elsewhere'))
    for (const path of ['art/linked.png', 'elsewhere/secret.png', '../outside/secret.png', join(outside, 'secret.png')]) {
      expect(await refusal(await get({ root: project, path })), path).toMatchObject({ status: 403, body: { code: 'outside-project' } })
    }
    // A link that stays inside the project is followed.
    await symlink(join(project, 'art', 'hero.png'), join(project, 'hero-link.png'))
    expect(await (await get({ root: project, path: 'hero-link.png' })).text()).toBe('hero image')
    // A project folder reached through a link holds its own files.
    await symlink(project, join(base, 'project-link'))
    expect(await (await get({ root: join(base, 'project-link'), path: 'art/hero.png' })).text()).toBe('hero image')
  })

  it('refuses a missing file, a folder, a file over the cap, and a malformed request', async () => {
    expect(await refusal(await get({ root: project, path: 'art/gone.png' }))).toMatchObject({ status: 404, body: { code: 'not-found' } })
    expect(await refusal(await get({ root: project, path: 'art' }))).toMatchObject({ status: 403, body: { code: 'not-a-file' } })
    expect(await refusal(await get({ root: project, path: 'art/hero.png', max: '4' }))).toEqual({
      status: 413, body: { code: 'too-large', message: 'art/hero.png is larger than 4 bytes.', limit: 4 },
    })
    // The request's cap never raises the route's own.
    expect(await refusal(await get({ root: project, path: 'art/hero.png', max: '100' }, { maxBytes: 8 }))).toMatchObject({ status: 413, body: { limit: 8 } })
    for (const params of [{ root: 'project', path: 'a.png' }, { root: project, path: '' }, { path: 'a.png' }, { root: project, path: 'a.png', max: '-1' }, { root: project, path: 'a.png', length: 'all' }]) {
      expect((await get(params)).status, JSON.stringify(params)).toBe(400)
    }
  })

  it('ends a response with an error when the file changes while it streams', async () => {
    const big = join(project, 'art', 'big.bin')
    await writeFile(big, Buffer.alloc(5 * 1024 * 1024, 1))
    const fs = localFs()
    let versions = 0
    const changing = { ...fs, stat: vi.fn(async (file: FsTarget) => { versions += 1; const info = await fs.stat(file); return info === undefined ? undefined : { ...info, version: `v${String(versions)}` as FsVersion } }) }
    const response = await get({ root: project, path: 'art/big.bin' }, { maxBytes: 10 * 1024 * 1024, fs: changing })
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow()
    // A file that keeps its version streams whole.
    const steady = await get({ root: project, path: 'art/big.bin' }, { maxBytes: 10 * 1024 * 1024 })
    expect(Buffer.from(await steady.arrayBuffer()).equals(await readFile(big))).toBe(true)
  })
})
