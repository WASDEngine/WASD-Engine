/** Releases export the project, create or reuse its game on the site, upload the build and its preview, and remember the game. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import { PREVIEW_DIR } from '../src/preview.ts'
import { LINK_FILE, linkedGame, projectName, projectView, releaseGame, ReleaseError, STATE_DIR, type ReleaseDependencies } from '../src/release.ts'

const ORIGIN = 'https://site.test'

interface SiteGame { id: string; slug: string; title: string; owner: string; versions: number; cover?: string; gif?: string }

/** An in-memory WASD Engine site: the games API as releases call it. */
function site(token = 'wasd_token') {
  const games = new Map<string, SiteGame>()
  const calls: { method: string; path: string; notes: string | null; files?: string[] }[] = []
  let next = 1
  const gameJson = (game: SiteGame) => ({
    id: game.id, slug: game.slug, title: game.title, url: `${ORIGIN}/games/${game.slug}`, latest_version: game.versions,
    cover_url: game.cover === undefined ? null : `https://files.test/${game.cover}`,
    gif_url: game.gif === undefined ? null : `https://files.test/${game.gif}`,
    image_link: game.cover === undefined ? null : `${ORIGIN}/games/${game.slug}.png`,
    gif_link: game.gif === undefined ? null : `${ORIGIN}/games/${game.slug}.gif`,
  })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, path: url.pathname, notes: url.searchParams.get('notes') })
    expect(init?.redirect).toBe('error')
    if (headers.get('x-dsh-auth-token') !== token) return json(401, { error: { message: 'Missing, invalid, or expired WASD Engine token.' } })
    const match = /^\/api\/v1\/games(?:\/([^/]+))?(\/releases|\/cover|\/gif)?$/u.exec(url.pathname)
    const game = match?.[1] === undefined ? undefined : games.get(match[1])
    if (match?.[1] !== undefined && (game === undefined || game.owner !== token)) return json(404, { error: { message: 'No such game.' } })
    if (method === 'POST' && match?.[1] === undefined) {
      const { title } = JSON.parse(init?.body as string) as { title: string }
      const created = { id: `game-${next}`, slug: `${title.toLowerCase().replaceAll(' ', '-')}-${next}`, title, owner: token, versions: 0 }
      next++
      games.set(created.id, created)
      return json(201, { game: gameJson(created) })
    }
    if (method === 'GET' && game !== undefined && match?.[2] === undefined) return json(200, { game: gameJson(game) })
    if (method === 'PATCH' && game !== undefined) {
      game.title = (JSON.parse(init?.body as string) as { title: string }).title
      return json(200, { game: gameJson(game) })
    }
    if (method === 'POST' && game !== undefined && match?.[2] === '/releases') {
      const archive = unzipSync(new Uint8Array(await (init?.body as Blob).arrayBuffer()))
      calls.at(-1)!.files = Object.keys(archive).sort()
      game.versions++
      return json(201, {
        game: gameJson(game),
        release: { version: game.versions, url: `${ORIGIN}/games/${game.slug}?v=${game.versions}`, play_url: `${ORIGIN}/game-files/${game.id}/${game.versions}/index.html`, total_bytes: 12 },
      })
    }
    if (method === 'PUT' && game !== undefined && match?.[2] === '/cover') {
      if (headers.get('content-type') !== 'image/png') return json(415, { error: { message: 'The cover must be a PNG, JPEG, or WebP image.' } })
      game.cover = `cover-${calls.length}.png`
      return json(200, { game: gameJson(game) })
    }
    if (method === 'PUT' && game !== undefined && match?.[2] === '/gif') {
      expect(headers.get('content-type')).toBe('image/gif')
      game.gif = `gif-${calls.length}.gif`
      return json(200, { game: gameJson(game) })
    }
    return json(404, { error: { message: 'Not found' } })
  }
  return { games, calls, fetch: fetchSite }
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function project(name = 'Defenders of the Wall'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-release-'))
  folders.push(dir)
  await writeFile(join(dir, 'project.godot'), `config_version=5\n\n[application]\n\nconfig/name="${name}"\nrun/main_scene="res://main.tscn"\n`)
  return dir
}

function dependencies(fetchSite: typeof fetch, access: { origin: string; token: string } | null = { origin: ORIGIN, token: 'wasd_token' }): ReleaseDependencies & { exports: string[] } {
  const exports: string[] = []
  return {
    exports,
    access: () => Promise.resolve(access ?? undefined),
    async exportWeb(projectDir, outputDir): Promise<GodotWebExport> {
      exports.push(outputDir)
      await mkdir(outputDir, { recursive: true })
      for (const name of ['index.html', 'index.js', 'index.wasm', 'index.pck']) await writeFile(join(outputDir, name), name)
      return {
        projectDir, outputDir, entry: 'index.html', totalBytes: 12, warnings: ['Renders with the Compatibility renderer.'],
        files: ['index.html', 'index.js', 'index.pck', 'index.wasm'].map(path => ({ path, bytes: 3 })),
      }
    },
    fetch: fetchSite,
    tempDir: tmpdir(),
  }
}

const signal = new AbortController().signal

describe('releaseGame', () => {
  it('creates the game on the first release, numbers later releases, and remembers the game', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    const first = await releaseGame({ projectDir: dir, notes: 'First playable' }, deps, signal)
    expect(first).toMatchObject({ title: 'Defenders of the Wall', version: 1, gameUrl: `${ORIGIN}/games/defenders-of-the-wall-1`, url: `${ORIGIN}/games/defenders-of-the-wall-1?v=1` })
    expect(first.warnings).toEqual(['Renders with the Compatibility renderer.'])
    expect(deps.exports).toEqual([join(dir, STATE_DIR, 'web')])
    const upload = server.calls.find(call => call.path.endsWith('/releases'))
    expect(upload?.notes).toBe('First playable')
    expect(upload?.files).toEqual(['index.html', 'index.js', 'index.pck', 'index.wasm'])

    const second = await releaseGame({ projectDir: dir }, deps, signal)
    expect(second.version).toBe(2)
    expect(server.games.size).toBe(1)
    expect(server.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/games')).toHaveLength(1)
    const link = JSON.parse(await readFile(join(dir, STATE_DIR, LINK_FILE), 'utf8')) as { games: Record<string, { version: number }> }
    expect(link.games[ORIGIN]?.version).toBe(2)
    expect(await projectView(dir, ORIGIN)).toEqual({ godot: true, game: { title: 'Defenders of the Wall', url: `${ORIGIN}/games/defenders-of-the-wall-1`, version: 2 } })
    expect(await projectView(dir, 'https://other.test')).toEqual({ godot: true })
    expect((await readdir(tmpdir())).filter(name => name.startsWith('wasd-release-'))).toEqual([])
  })

  it('renames the game when a title is given, and creates a new game when the site no longer has the old one', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    const renamed = await releaseGame({ projectDir: dir, title: 'Defenders II' }, deps, signal)
    expect(renamed).toMatchObject({ title: 'Defenders II', version: 2 })
    server.games.clear()
    const fresh = await releaseGame({ projectDir: dir }, deps, signal)
    expect(fresh).toMatchObject({ title: 'Defenders of the Wall', version: 1 })
    expect(fresh.gameUrl).toContain('-2')
  })

  it('remembers a new game before the upload, so releases after a refused or cut-off upload add versions to it', async () => {
    const dir = await project()
    const server = site()
    let upload: 'refuse' | 'cut off' | 'store' = 'refuse'
    const cut = new AbortController()
    const deps = dependencies(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (!url.pathname.endsWith('/releases') || upload === 'store') return server.fetch(input, init)
      if (upload === 'refuse') {
        return new Response(JSON.stringify({ error: { message: 'A release may be at most 512 MB zipped.' } }), { status: 413, headers: { 'content-type': 'application/json' } })
      }
      // The site stores the build, but the call ends before the site's answer arrives.
      await server.fetch(input, init)
      cut.abort()
      throw cut.signal.reason
    })
    const game = { id: 'game-1', slug: 'defenders-of-the-wall-1', title: 'Defenders of the Wall', url: `${ORIGIN}/games/defenders-of-the-wall-1` }

    await expect(releaseGame({ projectDir: dir }, deps, signal)).rejects.toThrow('WASD Engine could not store the release: A release may be at most 512 MB zipped.')
    expect(await linkedGame(dir, ORIGIN)).toEqual({ ...game, version: 0 })
    expect(await projectView(dir, ORIGIN)).toEqual({ godot: true })

    upload = 'cut off'
    await expect(releaseGame({ projectDir: dir }, deps, cut.signal)).rejects.toThrow()
    expect(server.games.get('game-1')?.versions).toBe(1)
    expect(await linkedGame(dir, ORIGIN)).toEqual({ ...game, version: 0 })

    upload = 'store'
    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 2, gameUrl: game.url })
    expect(await linkedGame(dir, ORIGIN)).toEqual({ ...game, version: 2 })
    expect(server.games.size).toBe(1)
    expect(server.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/games')).toHaveLength(1)
  })

  it('refuses while signed out, and explains an expired sign-in', async () => {
    const dir = await project()
    await expect(releaseGame({ projectDir: dir }, dependencies(site().fetch, null), signal)).rejects.toThrow(/signed out/u)
    const expired = releaseGame({ projectDir: dir }, dependencies(site('another-token').fetch), signal)
    await expect(expired).rejects.toBeInstanceOf(ReleaseError)
    await expect(expired).rejects.toThrow(/sign-in has expired/u)
  })

  it('checks notes, title, and preview files before exporting, and keeps a release whose picture the site refused', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    await expect(releaseGame({ projectDir: dir, notes: 'x'.repeat(1001) }, deps, signal)).rejects.toThrow(/notes must be at most 1000/u)
    await expect(releaseGame({ projectDir: dir, title: ' ' }, deps, signal)).rejects.toThrow(/title must be 1 to 80/u)
    await expect(releaseGame({ projectDir: dir, previewImage: join(dir, 'cover.gif') }, deps, signal)).rejects.toThrow(/preview_image must be a PNG, JPEG, or WebP/u)
    await expect(releaseGame({ projectDir: dir, previewGif: join(dir, 'clip.mp4') }, deps, signal)).rejects.toThrow(/preview_gif must be a GIF/u)
    await expect(releaseGame({ projectDir: dir, previewGif: join(dir, 'missing.gif') }, deps, signal)).rejects.toThrow(/preview_gif .*missing\.gif is not a file/u)
    await mkdir(join(dir, 'shot.png'))
    await expect(releaseGame({ projectDir: dir, previewImage: join(dir, 'shot.png') }, deps, signal)).rejects.toThrow(/preview_image .*shot\.png is not a file/u)
    expect(deps.exports).toEqual([])
    await writeFile(join(dir, 'cover.jpg'), 'jpeg')
    const released = await releaseGame({ projectDir: dir, previewImage: join(dir, 'cover.jpg') }, deps, signal)
    expect(released.version).toBe(1)
    expect(released.imageLink).toBeUndefined()
    expect(released.warnings.at(-1)).toMatch(/released, but its preview image was not stored: .*PNG, JPEG, or WebP/u)
  })

  it('uploads the recorded preview, and again only once it changed or the site lost it', async () => {
    const dir = await project()
    const previews = join(dir, STATE_DIR, PREVIEW_DIR)
    await mkdir(previews, { recursive: true })
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-one')
    await writeFile(join(previews, 'preview.png'), 'PNG-one')
    const server = site()
    const deps = dependencies(server.fetch)
    const uploads = () => server.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1))
    const first = await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif'])
    expect(first).toMatchObject({ imageLink: `${ORIGIN}/games/defenders-of-the-wall-1.png`, gifLink: `${ORIGIN}/games/defenders-of-the-wall-1.gif` })
    const link = JSON.parse(await readFile(join(dir, STATE_DIR, LINK_FILE), 'utf8')) as { games: Record<string, { image?: string; gif?: string }> }
    const digest = expect.stringMatching(/^[0-9a-f]{64}$/u) as string
    expect(link.games[ORIGIN]).toMatchObject({ image: digest, gif: digest })

    const second = await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif'])
    expect(second.gifLink).toBe(first.gifLink)
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-two')
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'gif'])
    delete server.games.get('game-1')!.cover
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'gif', 'cover'])
  })

  it('uploads the files a release names instead of the recorded preview, and all of them to a new game', async () => {
    const dir = await project()
    const previews = join(dir, STATE_DIR, PREVIEW_DIR)
    await mkdir(previews, { recursive: true })
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-recorded')
    await writeFile(join(dir, 'art.png'), 'PNG-art')
    await writeFile(join(dir, 'clip.gif'), 'GIF89a-clip')
    const server = site()
    const deps = dependencies(server.fetch)
    await releaseGame({ projectDir: dir, previewImage: join(dir, 'art.png'), previewGif: join(dir, 'clip.gif') }, deps, signal)
    await releaseGame({ projectDir: dir, previewGif: join(dir, 'clip.gif') }, deps, signal)
    expect(server.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1))).toEqual(['cover', 'gif'])
    server.games.clear()
    await releaseGame({ projectDir: dir, previewGif: join(dir, 'clip.gif') }, deps, signal)
    expect(server.calls.filter(call => call.method === 'PUT').map(call => call.path)).toEqual([
      '/api/v1/games/game-1/cover', '/api/v1/games/game-1/gif', '/api/v1/games/game-2/gif',
    ])
  })

  it('records a preview for a game without one when the project has none, and says so', async () => {
    const dir = await project()
    const server = site()
    const recorded: string[] = []
    const deps: ReleaseDependencies = {
      ...dependencies(server.fetch),
      async recordPreview(projectDir) {
        recorded.push(projectDir)
        const folder = join(projectDir, STATE_DIR, PREVIEW_DIR)
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'preview.gif'), 'GIF89a-auto')
        await writeFile(join(folder, 'preview.jpg'), 'JPEG-auto')
        return { gif: join(folder, 'preview.gif'), image: join(folder, 'preview.jpg') }
      },
    }
    const first = await releaseGame({ projectDir: dir }, deps, signal)
    expect(recorded).toEqual([dir])
    expect(first.gifLink).toBe(`${ORIGIN}/games/defenders-of-the-wall-1.gif`)
    expect(first.warnings).toContain('The project had no preview, so the release recorded the game\'s first seconds without input. For a preview that shows gameplay, record one with wasd_record_preview before the next release.')
    await rm(join(dir, STATE_DIR, PREVIEW_DIR), { recursive: true })
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(recorded).toEqual([dir])

    const other = await project('Other')
    const failing = await releaseGame({ projectDir: other }, { ...deps, recordPreview: () => Promise.reject(new Error('The game did not keep running (crashed).')) }, signal)
    expect(failing.gifLink).toBeUndefined()
    expect(failing.warnings.at(-1)).toBe('The game has no preview GIF: recording one failed: The game did not keep running (crashed).')
  })
})

describe('projectName', () => {
  it('reads application/config/name only from the application section', () => {
    expect(projectName('[application]\nconfig/name="Neon \\"Drift\\""\n')).toBe('Neon "Drift"')
    expect(projectName('[other]\nconfig/name="Wrong"\n[application]\nrun/main_scene="x"\n')).toBeUndefined()
  })
})

describe('projectView', () => {
  it('reports a folder without project.godot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-empty-'))
    folders.push(dir)
    expect(await projectView(dir, ORIGIN)).toEqual({ godot: false })
  })
})
