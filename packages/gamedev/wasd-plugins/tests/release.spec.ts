/**
 * Releases export the project, create or reuse the signed-in account's game on the site, upload the build, its desktop
 * downloads, and its preview, set whether the game is public or private, and remember the game per account; a copied
 * project folder asks before it adds to the game of its original.
 */
import { mkdtempSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotDesktopExport, GodotDesktopPlatform, GodotWebExport } from '@deepseek-ai/dsh-godot'
import { ReleaseFolders } from '../src/folders.ts'
import { PREVIEW_DIR } from '../src/preview.ts'
import {
  accountKey, copyQuestion, LINK_FILE, linkedGame, projectName, projectView, releaseGame, ReleaseError, STATE_DIR,
  type ReleaseDependencies, type SiteAccess,
} from '../src/release.ts'

const ORIGIN = 'https://site.test'
const ACCESS: SiteAccess = { origin: ORIGIN, token: 'wasd_token', account: 'account-1' }

interface SiteGame {
  id: string
  slug: string
  title: string
  owner: string
  versions: number
  visibility: 'public' | 'private'
  cover?: string
  gif?: string
  webp?: string
  downloads: { platform: string; version: number; bytes: number }[]
  credits?: unknown
}

/** How a test's site differs from the current one. */
interface SiteOptions {
  /** Answer like a site from before private games: no visibility in game answers, and none taken from requests. */
  readonly legacy?: boolean
  /** Refuse the download uploads of these platforms. */
  readonly refuseDownloads?: readonly string[]
  /** Answer each stored download with this status of its malware scan, as a site that scans downloads does. */
  readonly scanStatus?: string
  /** Refuse preview GIFs. */
  readonly refuseGif?: boolean
}

/** An in-memory WASD Engine site: the games API as releases call it, for the accounts of `tokens`. */
function site(...tokens: string[]) {
  return siteWith({}, ...tokens)
}

function siteWith(options: SiteOptions, ...tokens: string[]) {
  const accounts = tokens.length === 0 ? ['wasd_token'] : tokens
  const games = new Map<string, SiteGame>()
  const calls: { method: string; path: string; token: string; notes: string | null; visibility: string | null; files?: string[] }[] = []
  let next = 1
  const gameJson = (game: SiteGame) => ({
    id: game.id, slug: game.slug, title: game.title, url: `${ORIGIN}/games/${game.slug}`, latest_version: game.versions,
    cover_url: game.cover === undefined ? null : `https://files.test/${game.cover}`,
    gif_url: game.gif === undefined ? null : `https://files.test/${game.gif}`,
    ...options.legacy === true ? {} : { webp_url: game.webp === undefined ? null : `https://files.test/${game.webp}`, visibility: game.visibility },
  })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const token = headers.get('x-dsh-auth-token') ?? ''
    calls.push({ method, path: url.pathname, token, notes: url.searchParams.get('notes'), visibility: url.searchParams.get('visibility') })
    expect(init?.redirect).toBe('error')
    if (!accounts.includes(token)) return json(401, { error: { message: 'Missing, invalid, or expired WASD Engine token.' } })
    const download = /^\/api\/v1\/games\/([^/]+)\/releases\/(\d+)\/downloads\/([a-z]+)$/u.exec(url.pathname)
    if (download !== null && options.legacy !== true) {
      const target = games.get(download[1] as string)
      const version = Number(download[2])
      if (method !== 'PUT' || target === undefined || target.owner !== token || version > target.versions) return json(404, { error: { message: 'No such release.' } })
      const platform = download[3] as string
      if (options.refuseDownloads?.includes(platform)) return json(413, { error: { message: 'A download may be at most 1024 MB.' } })
      expect(headers.get('content-type')).toBe('application/zip')
      const bytes = (await (init?.body as Blob).arrayBuffer()).byteLength
      const others = target.downloads.filter(item => item.platform !== platform || item.version !== version)
      target.downloads = [...others, { platform, version, bytes }]
      return json(200, {
        game: gameJson(target),
        download: {
          platform, version, url: `${ORIGIN}/games/${target.slug}/download/${platform}?v=${version}`, file_url: `https://files.test/${platform}.zip`,
          filename: `${platform}.zip`, bytes, uploaded_at: '2026-11-12T00:00:00Z', ...options.scanStatus === undefined ? {} : { status: options.scanStatus },
        },
      })
    }
    const match = /^\/api\/v1\/games(?:\/([^/]+))?(\/releases|\/cover|\/gif|\/webp|\/credits)?$/u.exec(url.pathname)
    const game = match?.[1] === undefined ? undefined : games.get(match[1])
    if (match?.[1] !== undefined && (game === undefined || game.owner !== token)) return json(404, { error: { message: 'No such game.' } })
    if (method === 'POST' && match?.[1] === undefined) {
      const { title, visibility } = JSON.parse(init?.body as string) as { title: string; visibility?: 'public' | 'private' }
      const created: SiteGame = {
        id: `game-${next}`, slug: `${title.toLowerCase().replaceAll(' ', '-')}-${next}`, title, owner: token, versions: 0,
        visibility: options.legacy === true ? 'public' : visibility ?? 'public', downloads: [],
      }
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
      const visibility = url.searchParams.get('visibility')
      if (options.legacy !== true && (visibility === 'public' || visibility === 'private')) game.visibility = visibility
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
    if (method === 'PUT' && game !== undefined && match?.[2] === '/credits') {
      expect(headers.get('content-type')).toBe('application/json')
      const body = JSON.parse(init?.body as string) as { models: { name?: string }[] }
      if (body.models.some(model => model.name === 'Refused')) return json(400, { error: { message: 'A model name is too long.' } })
      game.credits = body
      return json(200, { game: gameJson(game) })
    }
    if (method === 'PUT' && game !== undefined && match?.[2] === '/gif') {
      expect(headers.get('content-type')).toBe('image/gif')
      if (options.refuseGif === true) return json(413, { error: { message: 'A preview GIF may be at most 10 MB.' } })
      game.gif = `gif-${calls.length}.gif`
      // As the site does: a new GIF drops the animation of the recording before it.
      delete game.webp
      return json(200, { game: gameJson(game) })
    }
    if (method === 'PUT' && game !== undefined && match?.[2] === '/webp' && options.legacy !== true) {
      expect(headers.get('content-type')).toBe('image/webp')
      game.webp = `webp-${calls.length}.webp`
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
): ReleaseDependencies & { exports: string[]; folders: ReleaseFolders; failDesktop?: GodotDesktopPlatform } {
  const exports: string[] = []
  return {
    exports,
    async exportDesktop(projectDir, platform, outputDir): Promise<GodotDesktopExport> {
      exports.push(outputDir)
      if (this.failDesktop === platform) throw new Error(`The Godot ${platform} export ended (exit code 1) without writing Defenders of the Wall.zip.`)
      await mkdir(outputDir, { recursive: true })
      await writeFile(join(outputDir, 'Defenders of the Wall.zip'), `${platform} build`)
      return { projectDir, platform, outputDir, entry: 'Defenders of the Wall.zip', bytes: `${platform} build`.length, warnings: [] }
    },
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
const game = (n: number, version: number, visibility: 'public' | 'private' = 'public') => ({ title: 'Defenders of the Wall', url: gameUrl(n), version, visibility })

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
    expect(linked.accounts?.[ORIGIN]).toEqual([{ account: 'account-1', id: 'game-1', slug: 'defenders-of-the-wall-1', title: 'Defenders of the Wall', url: gameUrl(1), version: 2, visibility: 'public' }])
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 2) })
    expect(await projectView(dir, 'https://other.test', deps.folders, 'account-1')).toEqual({ godot: true })
    expect((await readdir(tmpdir())).filter(name => name.startsWith('wasd-release-'))).toEqual([])
  })

  it('releases a private game, keeps its visibility when a release names none, and makes it public with a release', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    expect(await releaseGame({ projectDir: dir, visibility: 'private' }, deps, signal)).toMatchObject({ version: 1, visibility: 'private', downloads: [] })
    expect(server.games.get('game-1')?.visibility).toBe('private')
    const uploads = () => server.calls.filter(call => call.path.endsWith('/releases'))
    expect(uploads().map(call => call.visibility)).toEqual(['private'])
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 1, 'private') })

    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 2, visibility: 'private' })
    expect(uploads().at(-1)?.visibility).toBeNull()
    expect(await releaseGame({ projectDir: dir, visibility: 'public' }, deps, signal)).toMatchObject({ version: 3, visibility: 'public' })
    expect(server.games.get('game-1')?.visibility).toBe('public')
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true, game: game(1, 3, 'public') })
    expect((await link(dir)).accounts?.[ORIGIN]).toEqual([expect.objectContaining({ id: 'game-1', version: 3, visibility: 'public' })])
  })

  it('builds the desktop downloads before anything reaches the site, then uploads them as downloads of the version', async () => {
    const dir = await project()
    const server = site()
    const deps = dependencies(server.fetch)
    const released = await releaseGame({ projectDir: dir, desktop: ['macos', 'windows'] }, deps, signal)
    expect(deps.exports).toEqual([join(dir, STATE_DIR, 'web'), join(dir, STATE_DIR, 'desktop', 'windows'), join(dir, STATE_DIR, 'desktop', 'macos')])
    // A site that names no scan status offers each download as soon as it stores it.
    expect(released.downloads).toEqual([
      { platform: 'windows', url: `${gameUrl(1)}/download/windows?v=1`, bytes: 'windows build'.length, status: 'clean' },
      { platform: 'macos', url: `${gameUrl(1)}/download/macos?v=1`, bytes: 'macos build'.length, status: 'clean' },
    ])
    const order = server.calls.map(call => `${call.method} ${call.path}`)
    expect(order.indexOf('PUT /api/v1/games/game-1/releases/1/downloads/windows')).toBeGreaterThan(order.indexOf('POST /api/v1/games/game-1/releases'))
    expect(server.games.get('game-1')?.downloads).toEqual([
      { platform: 'windows', version: 1, bytes: 'windows build'.length },
      { platform: 'macos', version: 1, bytes: 'macos build'.length },
    ])

    const other = await project()
    const quiet = site()
    const failing = dependencies(quiet.fetch)
    failing.failDesktop = 'macos'
    await expect(releaseGame({ projectDir: other, desktop: ['windows', 'macos'] }, failing, signal)).rejects.toThrow(/macos export ended/u)
    expect(quiet.calls).toEqual([])
    expect(quiet.games.size).toBe(0)
  })

  it('names where each download stands in the site\'s malware scan', async () => {
    const dir = await project()
    const scanning = siteWith({ scanStatus: 'pending' })
    const released = await releaseGame({ projectDir: dir, desktop: ['windows', 'macos'] }, dependencies(scanning.fetch), signal)
    expect(released.downloads.map(download => [download.platform, download.status])).toEqual([['windows', 'pending'], ['macos', 'pending']])
    expect(released.warnings.some(warning => warning.includes('download'))).toBe(false)
    const flagged = await releaseGame({ projectDir: await project(), desktop: ['windows'] }, dependencies(siteWith({ scanStatus: 'flagged' }).fetch), signal)
    expect(flagged.downloads).toEqual([{ platform: 'windows', url: `${gameUrl(1)}/download/windows?v=1`, bytes: 'windows build'.length, status: 'flagged' }])
  })

  it('keeps a release whose download the site refused, and says which one', async () => {
    const dir = await project()
    const server = siteWith({ refuseDownloads: ['macos'] })
    const released = await releaseGame({ projectDir: dir, desktop: ['windows', 'macos'] }, dependencies(server.fetch), signal)
    expect(released.version).toBe(1)
    expect(released.downloads.map(download => download.platform)).toEqual(['windows'])
    expect(released.warnings).toContain('The version is released, but its macOS download was not stored: WASD Engine could not store the macOS download: A download may be at most 1024 MB.')
  })

  it('refuses a private release before uploading to a site that keeps every game public', async () => {
    const dir = await project()
    const server = siteWith({ legacy: true })
    const deps = dependencies(server.fetch)
    await expect(releaseGame({ projectDir: dir, visibility: 'private' }, deps, signal)).rejects.toThrow(/does not keep games private yet/u)
    expect(server.calls.some(call => call.path.endsWith('/releases'))).toBe(false)
    const released = await releaseGame({ projectDir: dir, desktop: ['windows'] }, deps, signal)
    expect(released).toMatchObject({ version: 1, visibility: 'public', downloads: [] })
    expect(released.warnings).toContain('The version is released, but its Windows download was not stored: WASD Engine could not store the Windows download: Not found')
    const exported = deps.exports.length
    await expect(releaseGame({ projectDir: dir, visibility: 'private' }, deps, signal)).rejects.toThrow(/does not keep games private yet/u)
    expect(deps.exports).toHaveLength(exported)
    expect(server.games.get('game-1')?.versions).toBe(1)
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
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 0, visibility: 'public' })
    // A game without a released version is not one the Export / Share button names.
    expect(await projectView(dir, ORIGIN, deps.folders, 'account-1')).toEqual({ godot: true })

    upload = 'cut off'
    await expect(releaseGame({ projectDir: dir }, deps, cut.signal)).rejects.toThrow()
    expect(server.games.get('game-1')?.versions).toBe(1)
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 0, visibility: 'public' })

    upload = 'store'
    expect(await releaseGame({ projectDir: dir }, deps, signal)).toMatchObject({ version: 2, gameUrl: game.url })
    expect(await linkedGame(dir, ORIGIN, 'account-1')).toEqual({ ...game, account: 'account-1', version: 2, visibility: 'public' })
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
    expect(server.games.get('game-1')?.cover).toBeUndefined()
    expect(released.warnings.at(-1)).toMatch(/released, but its preview image was not stored: .*PNG, JPEG, or WebP/u)
  })

  it('uploads the recorded preview, the animation after the GIF, and again only once it changed or the site lost it', async () => {
    const dir = await project()
    const previews = join(dir, STATE_DIR, PREVIEW_DIR)
    await mkdir(previews, { recursive: true })
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-one')
    await writeFile(join(previews, 'preview.webp'), 'RIFF-one')
    await writeFile(join(previews, 'preview.png'), 'PNG-one')
    const server = site()
    const deps = dependencies(server.fetch)
    const uploads = () => server.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1))
    const first = await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'webp'])
    expect(server.games.get('game-1')).toMatchObject({ cover: expect.any(String) as string, gif: expect.any(String) as string, webp: expect.any(String) as string })
    const link = JSON.parse(await readFile(join(dir, STATE_DIR, LINK_FILE), 'utf8')) as { accounts: Record<string, { image?: string; gif?: string; webp?: string }[]> }
    const digest = expect.stringMatching(/^[0-9a-f]{64}$/u) as string
    expect(link.accounts[ORIGIN]?.[0]).toMatchObject({ image: digest, gif: digest, webp: digest })

    const second = await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'webp'])
    expect(second.gameUrl).toBe(first.gameUrl)
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-two')
    await writeFile(join(previews, 'preview.webp'), 'RIFF-two')
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'webp', 'gif', 'webp'])
    delete server.games.get('game-1')!.cover
    delete server.games.get('game-1')!.webp
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(uploads()).toEqual(['cover', 'gif', 'webp', 'gif', 'webp', 'cover', 'webp'])
  })

  it('plays a GIF the release names on the site in place of the saved animation, and holds the animation back when the GIF fails', async () => {
    const dir = await project()
    const previews = join(dir, STATE_DIR, PREVIEW_DIR)
    await mkdir(previews, { recursive: true })
    await writeFile(join(previews, 'preview.gif'), 'GIF89a-recorded')
    await writeFile(join(previews, 'preview.webp'), 'RIFF-recorded')
    await writeFile(join(dir, 'clip.gif'), 'GIF89a-clip')
    const server = site()
    await releaseGame({ projectDir: dir, previewGif: join(dir, 'clip.gif') }, dependencies(server.fetch), signal)
    expect(server.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1))).toEqual(['gif'])
    expect(server.games.get('game-1')?.webp).toBeUndefined()

    const refusing = siteWith({ refuseGif: true })
    const refused = await releaseGame({ projectDir: await project('Other') }, dependencies(refusing.fetch), signal)
    expect(refusing.calls.filter(call => call.method === 'PUT')).toEqual([])
    const other = await project('Third')
    await mkdir(join(other, STATE_DIR, PREVIEW_DIR), { recursive: true })
    await writeFile(join(other, STATE_DIR, PREVIEW_DIR, 'preview.gif'), 'GIF89a-third')
    await writeFile(join(other, STATE_DIR, PREVIEW_DIR, 'preview.webp'), 'RIFF-third')
    const third = await releaseGame({ projectDir: other }, dependencies(refusing.fetch), signal)
    expect(refusing.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1))).toEqual(['gif'])
    expect(third.warnings.filter(warning => warning.startsWith('The version is released, but its preview'))).toEqual([
      expect.stringMatching(/^The version is released, but its preview GIF was not stored: .*at most 10 MB/u),
    ])
    expect(refused.warnings.some(warning => warning.includes('animation'))).toBe(false)
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
        await writeFile(join(folder, 'preview.webp'), 'RIFF-auto')
        await writeFile(join(folder, 'preview.jpg'), 'JPEG-auto')
        return { gif: join(folder, 'preview.gif'), webp: join(folder, 'preview.webp'), image: join(folder, 'preview.jpg') }
      },
    }
    const first = await releaseGame({ projectDir: dir }, deps, signal)
    expect(recorded).toEqual([dir])
    expect(server.games.get('game-1')).toMatchObject({ gif: expect.any(String) as string, webp: expect.any(String) as string })
    expect(first.warnings).toContain('The project had no preview, so the release recorded the game\'s first seconds without input. For a preview that shows gameplay, record one with wasd_record_preview before the next release.')
    await rm(join(dir, STATE_DIR, PREVIEW_DIR), { recursive: true })
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(recorded).toEqual([dir])

    const other = await project('Other')
    const failing = await releaseGame({ projectDir: other }, { ...deps, recordPreview: () => Promise.reject(new Error('The game did not keep running (crashed).')) }, signal)
    expect([...server.games.values()].find(game => game.title === 'Other')?.gif).toBeUndefined()
    expect(failing.warnings.at(-1)).toBe('The game has no preview GIF: recording one failed: The game did not keep running (crashed).')
  })
})

describe('releaseGame credits', () => {
  it('uploads what the game was made with after the build, and lists it by name', async () => {
    const dir = await project()
    const fake = site()
    const credits = {
      models: [{ builtin: true as const }, { name: 'Claude Opus 5.5' }],
      tools: ['godot' as const, 'blender' as const],
      addons: [{ id: 'mpfb', title: 'MPFB (MakeHuman)', host: 'blender' as const }],
    }
    const deps = { ...dependencies(fake.fetch), credits: () => Promise.resolve(credits) }
    const released = await releaseGame({ projectDir: dir }, deps, new AbortController().signal)
    expect(released.credits).toEqual(['WASD Engine\'s built-in AI', 'Claude Opus 5.5', 'Godot', 'Blender with MPFB (MakeHuman)'])
    expect([...fake.games.values()][0]?.credits).toEqual(credits)
    const paths = fake.calls.map(call => `${call.method} ${call.path}`)
    expect(paths.indexOf('PUT /api/v1/games/game-1/credits')).toBeGreaterThan(paths.indexOf('POST /api/v1/games/game-1/releases'))
  })

  it('keeps the release when the credits cannot be collected or stored, and says so', async () => {
    const dir = await project()
    const fake = site()
    const refused = await releaseGame({ projectDir: dir }, {
      ...dependencies(fake.fetch),
      credits: () => Promise.resolve({ models: [{ name: 'Refused' }], tools: [], addons: [] }),
    }, new AbortController().signal)
    expect(refused.version).toBe(1)
    expect(refused.credits).toBeUndefined()
    expect(refused.warnings).toContain('The version is released, but what the game was made with was not stored: WASD Engine could not store what the game was made with: A model name is too long.')
    const failed = await releaseGame({ projectDir: dir }, {
      ...dependencies(fake.fetch),
      credits: () => Promise.reject(new Error('credits.json is locked')),
    }, new AbortController().signal)
    expect(failed.version).toBe(2)
    expect(failed.warnings).toContain('The version is released, but what the game was made with was not stored: credits.json is locked')
    const without = await releaseGame({ projectDir: dir }, dependencies(fake.fetch), new AbortController().signal)
    expect(without.credits).toBeUndefined()
    expect(fake.calls.filter(call => call.path.endsWith('/credits'))).toHaveLength(1)
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
