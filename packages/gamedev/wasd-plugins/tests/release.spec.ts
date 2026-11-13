/**
 * Releases export the project, create or reuse the signed-in account's game on the site, upload the build, and
 * remember the game per account; a copied project folder asks before it adds to the game of its original.
 */
import { mkdtempSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import { ReleaseFolders } from '../src/folders.ts'
import {
  accountKey, copyQuestion, LINK_FILE, linkedGame, projectName, projectView, releaseGame, ReleaseError, STATE_DIR,
  type ReleaseDependencies, type SiteAccess,
} from '../src/release.ts'

const ORIGIN = 'https://site.test'
const ACCESS: SiteAccess = { origin: ORIGIN, token: 'wasd_token', account: 'account-1' }

interface SiteGame { id: string; slug: string; title: string; owner: string; versions: number }

/** An in-memory WASD Engine site: the games API as releases call it, for the accounts of `tokens`. */
function site(...tokens: string[]) {
  const accounts = tokens.length === 0 ? ['wasd_token'] : tokens
  const games = new Map<string, SiteGame>()
  const calls: { method: string; path: string; token: string; notes: string | null; files?: string[] }[] = []
  let next = 1
  const gameJson = (game: SiteGame) => ({ id: game.id, slug: game.slug, title: game.title, url: `${ORIGIN}/games/${game.slug}`, latest_version: game.versions })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const token = headers.get('x-dsh-auth-token') ?? ''
    calls.push({ method, path: url.pathname, token, notes: url.searchParams.get('notes') })
    expect(init?.redirect).toBe('error')
    if (!accounts.includes(token)) return json(401, { error: { message: 'Missing, invalid, or expired WASD Engine token.' } })
    const match = /^\/api\/v1\/games(?:\/([^/]+))?(\/releases|\/cover)?$/u.exec(url.pathname)
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
      return headers.get('content-type') === 'image/png' ? json(200, { game: gameJson(game) }) : json(415, { error: { message: 'The cover must be a PNG, JPEG, or WebP image.' } })
    }
    return json(404, { error: { message: 'Not found' } })
  }
  return { games, calls, fetch: fetchSite }
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-release-'))
  folders.push(dir)
  return dir
}

async function project(name = 'Defenders of the Wall', dir?: string): Promise<string> {
  const folder = dir ?? await scratch()
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'project.godot'), `config_version=5\n\n[application]\n\nconfig/name="${name}"\nrun/main_scene="res://main.tscn"\n`)
  return folder
}

/** Release folders of their own, as on a computer of their own. */
function releaseFolders(): ReleaseFolders {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wasd-folders-'))
  folders.push(dir)
  return new ReleaseFolders(join(dir, 'release-folders'))
}

function dependencies(
  fetchSite: typeof fetch, access: SiteAccess | null = ACCESS, releasedFrom = releaseFolders(),
): ReleaseDependencies & { exports: string[]; folders: ReleaseFolders } {
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
    folders: releasedFrom,
    tempDir: tmpdir(),
  }
}

interface Link {
  games: Record<string, { id: string; version: number; account?: string }>
  accounts?: Record<string, { id: string; version: number; account?: string }[]>
}

async function link(dir: string): Promise<Link> {
  return JSON.parse(await readFile(join(dir, STATE_DIR, LINK_FILE), 'utf8')) as Link
}

const signal = new AbortController().signal
const gameUrl = (n: number) => `${ORIGIN}/games/defenders-of-the-wall-${n}`
const game = (n: number, version: number) => ({ title: 'Defenders of the Wall', url: gameUrl(n), version })

describe('releaseGame', () => {
  it('creates the game on the first release, numbers later releases, and remembers the game', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    const first = await releaseGame({ projectDir: dir, notes: 'First playable' }, deps, signal)
    expect(first).toMatchObject({ title: 'Defenders of the Wall', version: 1, gameUrl: gameUrl(1), url: `${gameUrl(1)}?v=1` })
    expect(first.warnings).toEqual(['Renders with the Compatibility renderer.'])
    expect(deps.exports).toEqual([join(dir, STATE_DIR, 'web')])
    const upload = server.calls.find(call => call.path.endsWith('/releases'))
    expect(upload?.notes).toBe('First playable')
    expect(upload?.files).toEqual(['index.html', 'index.js', 'index.pck', 'index.wasm'])

    const second = await releaseGame({ projectDir: dir }, deps, signal)
    expect(second.version).toBe(2)
    expect(server.games.size).toBe(1)
    expect(server.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/games')).toHaveLength(1)
    const linked = await link(dir)
    expect(linked.games[ORIGIN]).toEqual({ id: 'game-1', slug: 'defenders-of-the-wall-1', title: 'Defenders of the Wall', url: gameUrl(1), version: 2 })
    expect(linked.accounts?.[ORIGIN]).toEqual([{ account: 'account-1', id: 'game-1', slug: 'defenders-of-the-wall-1', title: 'Defenders of the Wall', url: gameUrl(1), version: 2 }])
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 2) })
    expect(await projectView(dir, 'https://other.test', deps.folders, 'account-1')).toEqual({ godot: true })
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
    expect((await link(dir)).accounts?.[ORIGIN]?.map(entry => entry.id)).toEqual(['game-2'])
  })

  it('keeps one game per account on a site: each account adds to its own game and never reads the other\'s', async () => {
    const dir = await project()
    const server = site('token-a', 'token-b')
    const asA = dependencies(server.fetch, { origin: ORIGIN, token: 'token-a', account: 'account-a' })
    const asB = dependencies(server.fetch, { origin: ORIGIN, token: 'token-b', account: 'account-b' }, asA.folders)
    expect(await releaseGame({ projectDir: dir }, asA, signal)).toMatchObject({ version: 1, gameUrl: gameUrl(1) })
    expect(await releaseGame({ projectDir: dir }, asB, signal)).toMatchObject({ version: 1, gameUrl: gameUrl(2) })
    expect(await releaseGame({ projectDir: dir }, asA, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(1) })
    expect(await releaseGame({ projectDir: dir }, asB, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(2) })
    expect(server.games.size).toBe(2)
    expect(server.calls.filter(call => call.method === 'GET' && call.token === 'token-a').map(call => call.path)).toEqual(['/api/v1/games/game-1'])
    expect(server.calls.filter(call => call.method === 'GET' && call.token === 'token-b').map(call => call.path)).toEqual(['/api/v1/games/game-2'])
    expect(await projectView(dir, ORIGIN, asA.folders, 'account-a')).toEqual({ godot: true, game: game(1, 2) })
    expect(await projectView(dir, ORIGIN, asA.folders, 'account-b')).toEqual({ godot: true, game: game(2, 2) })
    // Versions before per-account links read the site's latest release.
    expect((await link(dir)).games[ORIGIN]?.id).toBe('game-2')
  })

  it('finds the account\'s game by asking the site when the app does not know the account', async () => {
    const dir = await project()
    const server = site('token-a', 'token-b')
    const asA = dependencies(server.fetch, { origin: ORIGIN, token: 'token-a' })
    const asB = dependencies(server.fetch, { origin: ORIGIN, token: 'token-b' }, asA.folders)
    await releaseGame({ projectDir: dir }, asA, signal)
    expect(await releaseGame({ projectDir: dir }, asB, signal)).toMatchObject({ version: 1, gameUrl: gameUrl(2) })
    expect(await releaseGame({ projectDir: dir }, asA, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(1) })
    expect(server.games.size).toBe(2)
    expect((await link(dir)).accounts?.[ORIGIN]?.map(entry => entry.id)).toEqual(['game-1', 'game-2'])
  })

  it('continues a link file written before per-account links', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    await writeFile(join(dir, STATE_DIR, LINK_FILE), JSON.stringify({
      format: 1, games: { [ORIGIN]: { id: 'game-1', slug: 'defenders-of-the-wall-1', title: 'Defenders of the Wall', url: gameUrl(1), version: 1 } },
    }))
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 1) })
    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(1) })
    expect(server.games.size).toBe(1)
    expect((await link(dir)).accounts?.[ORIGIN]).toEqual([expect.objectContaining({ account: 'account-1', id: 'game-1', version: 2 })])
  })

  it('asks before a copied folder adds to the game of the folder it was copied from, and new_game answers', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    const parent = await scratch()
    const copy = join(parent, 'copy')
    await cp(dir, copy, { recursive: true })
    const original = await realpath(dir)

    await expect(releaseGame({ projectDir: copy }, deps, signal)).rejects.toThrow(new ReleaseError(copyQuestion(original, { title: 'Defenders of the Wall', url: gameUrl(1) })))
    expect(deps.exports).toEqual([join(dir, STATE_DIR, 'web')])
    expect(await projectView(copy, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 1), sharedWith: original })
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 1) })

    expect(await releaseGame({ projectDir: copy, newGame: false }, deps, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(1) })
    // Having released the game, the copy is one of its folders and asks no more.
    expect(await releaseGame({ projectDir: copy }, deps, signal)).toMatchObject({ version: 3, gameUrl: gameUrl(1) })
    expect(await projectView(copy, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 3) })

    const second = join(parent, 'second copy')
    await cp(dir, second, { recursive: true })
    expect(await releaseGame({ projectDir: second, newGame: true }, deps, signal)).toMatchObject({ version: 1, gameUrl: gameUrl(2) })
    expect(await releaseGame({ projectDir: second }, deps, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(2) })
    expect(await projectView(second, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(2, 2) })
    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 4, gameUrl: gameUrl(1) })
    expect(server.games.size).toBe(2)
  })

  it('continues without asking from a renamed folder, and from a copy whose original is gone or links elsewhere', async () => {
    const parent = await scratch()
    const server = site()
    const deps = dependencies(server.fetch)
    const dir = await project('Defenders of the Wall', join(parent, 'game'))
    await releaseGame({ projectDir: dir }, deps, signal)
    const renamed = join(parent, 'renamed')
    await rename(dir, renamed)
    expect(await releaseGame({ projectDir: renamed }, deps, signal)).toMatchObject({ version: 2, gameUrl: gameUrl(1) })

    const copy = join(parent, 'copy')
    await cp(renamed, copy, { recursive: true })
    await rm(renamed, { recursive: true })
    expect(await releaseGame({ projectDir: copy }, deps, signal)).toMatchObject({ version: 3, gameUrl: gameUrl(1) })

    const another = join(parent, 'another')
    await cp(copy, another, { recursive: true })
    // The original now releases another game, so the copy is the only folder of the first one.
    await releaseGame({ projectDir: copy, newGame: true }, deps, signal)
    expect(await releaseGame({ projectDir: another }, deps, signal)).toMatchObject({ version: 4, gameUrl: gameUrl(1) })
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
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 0 })
    // A game without a released version is not one the Release button names.
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true })

    upload = 'cut off'
    await expect(releaseGame({ projectDir: dir }, deps, cut.signal)).rejects.toThrow()
    expect(server.games.get('game-1')?.versions).toBe(1)
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 0 })

    upload = 'store'
    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 2, gameUrl: game.url })
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 2 })
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

  it('checks notes, title, and cover before exporting, and keeps a release whose cover the site refused', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    await expect(releaseGame({ projectDir: dir, notes: 'x'.repeat(1001) }, deps, signal)).rejects.toThrow(/notes must be at most 1000/u)
    await expect(releaseGame({ projectDir: dir, title: ' ' }, deps, signal)).rejects.toThrow(/title must be 1 to 80/u)
    await expect(releaseGame({ projectDir: dir, coverImage: join(dir, 'cover.gif') }, deps, signal)).rejects.toThrow(/PNG, JPEG, or WebP/u)
    expect(deps.exports).toEqual([])
    await writeFile(join(dir, 'cover.jpg'), 'jpeg')
    const released = await releaseGame({ projectDir: dir, coverImage: join(dir, 'cover.jpg') }, deps, signal)
    expect(released.version).toBe(1)
    expect(released.warnings.at(-1)).toMatch(/released, but its cover image was not stored: .*PNG, JPEG, or WebP/u)
  })
})

describe('accountKey', () => {
  it('fingerprints an account ID without holding it', () => {
    expect(accountKey('8a6239be-127d-42f1-807e-a8ff79bd8564')).toMatch(/^[0-9a-f]{24}$/u)
    expect(accountKey('8a6239be-127d-42f1-807e-a8ff79bd8564')).toBe(accountKey('8a6239be-127d-42f1-807e-a8ff79bd8564'))
    expect(accountKey('8a6239be-127d-42f1-807e-a8ff79bd8564')).not.toBe(accountKey('4da6adc2-87b2-439a-8273-79a6abdb3b56'))
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
    const dir = await scratch()
    expect(await projectView(dir, ORIGIN, releaseFolders())).toEqual({ godot: false })
  })

  it('shows the latest release\'s game when the account is unknown', async () => {
    const dir = await project()
    const server = site('token-a', 'token-b')
    const asA = dependencies(server.fetch, { origin: ORIGIN, token: 'token-a', account: 'account-a' })
    await releaseGame({ projectDir: dir }, asA, signal)
    await releaseGame({ projectDir: dir }, dependencies(server.fetch, { origin: ORIGIN, token: 'token-b', account: 'account-b' }, asA.folders), signal)
    expect(await projectView(dir, ORIGIN, asA.folders)).toEqual({ godot: true, game: game(2, 1) })
    expect(await projectView(dir, ORIGIN, asA.folders, 'account-c')).toEqual({ godot: true })
  })
})
