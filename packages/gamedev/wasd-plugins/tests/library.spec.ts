/**
 * The game library installs a game's desktop build for this computer from the site, checks and unpacks it, keeps one
 * version per game, updates an online game before it starts and hands it a player token, starts a single-player game
 * at the version it has, counts each start as a play on the site, and deletes games.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findProgram, GameLibrary, type GameCommand, type LibraryDependencies } from '../src/library.ts'
import type { WasdLibraryView } from '../src/types.ts'

const ORIGIN = 'https://site.test'
const GAME_ID = '3f2a0c9e-1111-4222-8333-944455556666'
const signal = new AbortController().signal

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

interface Release { readonly version: number; readonly multiplayer: 'player_hosted' | 'dedicated' | null; readonly bytes: Buffer; readonly status?: string }

/** A site with one game and its releases; each release has a macOS and a Windows build. `plays` holds the token of each
 * play the library counted, or '' for one without a token. */
function site(releases: Release[]) {
  const calls: string[] = []
  const plays: string[] = []
  let latest = () => releases.at(-1) as Release
  let cover: string | null = null
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.pathname === '/api/v1/library/games/sky-keep') {
      const top = latest()
      const wanted = url.searchParams.get('v')
      const release = top.multiplayer !== null || wanted === null ? top : releases.find(entry => String(entry.version) === wanted) ?? top
      return Response.json({
        game: { id: GAME_ID, slug: 'sky-keep', title: 'Sky Keep', url: `${ORIGIN}/games/sky-keep`, latest_version: top.version, cover_url: cover, webp_url: null, multiplayer: top.multiplayer },
        release: { version: release.version, multiplayer: release.multiplayer, url: `${ORIGIN}/games/sky-keep?v=${String(release.version)}` },
        downloads: ['windows', 'macos'].map(platform => ({
          platform, version: release.version, status: release.status ?? 'clean', url: `${ORIGIN}/games/sky-keep/download/${platform}?v=${String(release.version)}`,
          bytes: release.bytes.length, sha256: createHash('sha256').update(release.bytes).digest('hex'), filename: 'Sky Keep.zip',
        })),
      })
    }
    if (url.pathname.startsWith('/games/sky-keep/download/')) {
      const release = releases.find(entry => String(entry.version) === url.searchParams.get('v')) as Release
      return new Response(new Uint8Array(release.bytes))
    }
    if (url.pathname === '/api/v1/play/token' && init?.method === 'POST') {
      const headers = new Headers(init.headers)
      if (headers.get('x-dsh-auth-token') !== 'account-token') return Response.json({ error: { message: 'no' } }, { status: 401 })
      return Response.json({ token: 'wpt1.player', expires_at: '2026-11-14T00:00:00Z', player: { id: 'p', name: 'Ada' }, game_id: GAME_ID, api_origin: ORIGIN })
    }
    if (url.pathname === '/api/v1/library/games/sky-keep/plays' && init?.method === 'POST') {
      plays.push(new Headers(init.headers).get('x-dsh-auth-token') ?? '')
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/v1/library/games/missing') return Response.json({ error: { message: 'No such game.' } }, { status: 404 })
    return new Response('not found', { status: 404 })
  }
  return {
    fetch: fetchSite,
    calls,
    plays,
    setLatest: (next: () => Release) => { latest = next },
    setCover: (next: string | null) => { cover = next },
  }
}

interface LibraryOptions {
  readonly system?: NodeJS.Platform
  readonly releases: Release[]
  readonly signedIn?: boolean
  /** The site the app is signed in to; the game's own by default. */
  readonly accessOrigin?: string
  /** The app's HTTP client in front of the fake site. */
  readonly fetch?: (site: typeof fetch) => typeof fetch
  /** Why starting a game fails; games start by default. */
  readonly startError?: Error
}

async function library(options: LibraryOptions) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wasd-library-'))
  folders.push(root)
  const fake = site(options.releases)
  const started: GameCommand[] = []
  const system = options.system ?? 'darwin'
  const dependencies: LibraryDependencies = {
    root,
    siteOrigin: () => Promise.resolve(ORIGIN),
    access: () => Promise.resolve(options.signedIn === false ? undefined : { origin: options.accessOrigin ?? ORIGIN, token: 'account-token' }),
    fetch: options.fetch?.(fake.fetch) ?? fake.fetch,
    system,
    // Unpacking writes what the platform's build holds, with the ZIP's bytes as the program.
    async unpack(archive, folder) {
      const bytes = await readFile(archive)
      if (system === 'darwin') {
        await mkdir(join(folder, 'Sky Keep.app', 'Contents', 'MacOS'), { recursive: true })
        await writeFile(join(folder, 'Sky Keep.app', 'Contents', 'MacOS', 'Sky Keep'), bytes)
      } else {
        await writeFile(join(folder, 'Sky Keep.exe'), bytes)
      }
    },
    start: (command) => {
      if (options.startError !== undefined) return Promise.reject(options.startError)
      started.push(command)
      return Promise.resolve()
    },
    now: () => new Date('2026-11-13T12:00:00Z'),
  }
  const games = new GameLibrary(dependencies, new AbortController().signal)
  return { games, root, started, site: fake }
}

/** The library once no download is running. */
async function settled(games: GameLibrary): Promise<WasdLibraryView> {
  for (;;) {
    const view = await games.view()
    if (view.tasks.every(task => task.state === 'failed')) return view
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('GameLibrary', () => {
  it('installs this computer\'s build, starts a single-player game without a token, and keeps one version', async () => {
    const v1 = { version: 1, multiplayer: null, bytes: Buffer.from('first build') }
    const v2 = { version: 2, multiplayer: null, bytes: Buffer.from('second build') }
    const { games, root, started, site: fake } = await library({ releases: [v1, v2] })
    expect(await games.install('sky-keep', 1)).toEqual({ ok: true })
    let view = await settled(games)
    expect(view.tasks).toEqual([])
    expect(view.games).toEqual([{
      id: GAME_ID, slug: 'sky-keep', title: 'Sky Keep', version: 1, latestVersion: 2, platform: 'macos', bytes: v1.bytes.length,
      installedAt: '2026-11-13T12:00:00.000Z',
    }])
    expect(fake.calls).toContain('GET /games/sky-keep/download/macos?v=1')
    // A single-player game starts at its own version and notes the newer one; the site counts the play.
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(started).toEqual([{ program: join(root, GAME_ID, '1', 'Sky Keep.app', 'Contents', 'MacOS', 'Sky Keep'), cwd: join(root, GAME_ID, '1'), env: {} }])
    await vi.waitFor(() => { expect(fake.plays).toEqual(['account-token']) })
    // Update installs the newer version and deletes the earlier one.
    await games.install('sky-keep')
    view = await settled(games)
    expect(view.games.map(game => [game.version, game.latestVersion])).toEqual([[2, 2]])
    expect((await readdir(join(root, GAME_ID))).filter(entry => !entry.startsWith('.'))).toEqual(['2'])
    const saved = JSON.parse(await readFile(join(root, 'games.json'), 'utf8')) as { games: Record<string, { startedAt?: string; program: string }> }
    expect(saved.games[GAME_ID]).toMatchObject({ program: 'Sky Keep.app', startedAt: '2026-11-13T12:00:00.000Z' })
  })

  it('updates an online game before it starts and hands it a player token of the signed-in account', async () => {
    const v1 = { version: 1, multiplayer: 'player_hosted' as const, bytes: Buffer.from('online one') }
    const v2 = { version: 2, multiplayer: 'player_hosted' as const, bytes: Buffer.from('online two') }
    const releases: Release[] = [v1]
    const { games, root, started, site: fake } = await library({ system: 'win32', releases })
    await games.install('sky-keep')
    expect((await settled(games)).games.map(game => [game.version, game.multiplayer])).toEqual([[1, 'player_hosted']])
    releases.push(v2)
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(started).toEqual([{
      program: join(root, GAME_ID, '2', 'Sky Keep.exe'),
      cwd: join(root, GAME_ID, '2'),
      env: { WASD_PLAY_TOKEN: 'wpt1.player', WASD_API_ORIGIN: ORIGIN, WASD_GAME_ID: GAME_ID, WASD_GAME_VERSION: '2' },
    }])
    expect(fake.calls).toContain('GET /games/sky-keep/download/windows?v=2')
    expect(fake.calls).toContain('POST /api/v1/play/token')
    await vi.waitFor(() => { expect(fake.plays).toEqual(['account-token']) })
  })

  it('counts each start as a play, with the account\'s token only on its own site, and starts the game whatever the count does', async () => {
    const releases: Release[] = [{ version: 1, multiplayer: null, bytes: Buffer.from('counted') }]
    const signedOut = await library({ releases, signedIn: false })
    await signedOut.games.install('sky-keep')
    await settled(signedOut.games)
    expect(await signedOut.games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(await signedOut.games.launch(GAME_ID, signal)).toEqual({ ok: true })
    await vi.waitFor(() => { expect(signedOut.site.plays).toEqual(['', '']) })

    // Signed in to another site, the app sends this one no token.
    const elsewhere = await library({ releases, accessOrigin: 'https://other.test' })
    await elsewhere.games.install('sky-keep')
    await settled(elsewhere.games)
    expect(await elsewhere.games.launch(GAME_ID, signal)).toEqual({ ok: true })
    await vi.waitFor(() => { expect(elsewhere.site.plays).toEqual(['']) })

    // A count that cannot reach the site is lost, and the game runs.
    const attempts: string[] = []
    const offline = await library({
      releases,
      fetch: fetchSite => async (input, init) => {
        const url = String(input instanceof Request ? input.url : input)
        if (!url.endsWith('/plays')) return await fetchSite(input, init)
        attempts.push(url)
        throw new TypeError('fetch failed')
      },
    })
    await offline.games.install('sky-keep')
    await settled(offline.games)
    expect(await offline.games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(offline.started).toHaveLength(1)
    await vi.waitFor(() => { expect(attempts).toEqual([`${ORIGIN}/api/v1/library/games/sky-keep/plays`]) })

    // A game that does not start counts no play.
    const broken = await library({ releases, startError: new Error('spawn EACCES') })
    await broken.games.install('sky-keep')
    await settled(broken.games)
    expect(await broken.games.launch(GAME_ID, signal)).toEqual({ ok: false, message: 'The game did not start: spawn EACCES' })
    expect(broken.site.calls.filter(call => call.endsWith('/plays'))).toEqual([])
  })

  it('asks for a sign-in before an online game starts', async () => {
    const { games } = await library({ releases: [{ version: 1, multiplayer: 'dedicated', bytes: Buffer.from('server game') }], signedIn: false })
    await games.install('sky-keep')
    await settled(games)
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: false, message: 'Online games need a WASD Engine account: sign in to WASD Engine, then play again.' })
  })

  it('reports a build that waits on the malware scan, a damaged download, and an unknown game as failed tasks', async () => {
    const pending = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('x'), status: 'pending' }] })
    await pending.games.install('sky-keep')
    // The task is named after the game as soon as the site answers, before its build is checked.
    expect((await settled(pending.games)).tasks).toEqual([expect.objectContaining({
      slug: 'sky-keep', title: 'Sky Keep', version: 1, state: 'failed',
      message: 'The macOS build of Sky Keep is still being scanned for malware. Try again in a few minutes.',
    })])
    pending.games.dismiss('sky-keep')
    expect((await pending.games.view()).tasks).toEqual([])

    const damaged = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('good bytes') }] })
    const fetchSite = damaged.site.fetch
    // The download arrives with other bytes of the same length.
    Object.assign(damaged.games, {})
    const tampered: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.includes('/download/') ? new Response(new Uint8Array(Buffer.from('evil bytes'))) : await fetchSite(input, init)
    }
    const other = new GameLibrary({
      root: damaged.root, siteOrigin: () => Promise.resolve(ORIGIN), access: () => Promise.resolve(undefined), fetch: tampered,
      system: 'darwin', unpack: () => Promise.resolve(), start: () => Promise.resolve(), now: () => new Date(),
    }, new AbortController().signal)
    await other.install('sky-keep')
    expect((await settled(other)).tasks[0]).toMatchObject({ state: 'failed', message: 'The download of Sky Keep is damaged. Try again.' })

    await damaged.games.install('missing')
    expect((await settled(damaged.games)).tasks[0]).toMatchObject({ slug: 'missing', state: 'failed', message: 'WASD Engine has no such game, or it was removed.' })
  })

  it('keeps the site\'s picture of a game on its failed download and its installed game, and follows a changed one', async () => {
    const first = `${ORIGIN}/game-files/covers/first.jpg`
    const { games, root, site: fake } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('pictured') }] })
    fake.setCover(first)
    // The download arrives with other bytes, so the task fails after the site named the game and its picture.
    const tampered: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.includes('/download/') ? new Response(new Uint8Array(Buffer.from('tampered'))) : await fake.fetch(input, init)
    }
    const failing = new GameLibrary({
      root, siteOrigin: () => Promise.resolve(ORIGIN), access: () => Promise.resolve(undefined), fetch: tampered,
      system: 'darwin', unpack: () => Promise.resolve(), start: () => Promise.resolve(), now: () => new Date(),
    }, new AbortController().signal)
    await failing.install('sky-keep')
    expect((await settled(failing)).tasks).toEqual([expect.objectContaining({ state: 'failed', title: 'Sky Keep', coverUrl: first })])

    await games.install('sky-keep')
    expect((await settled(games)).games[0]?.coverUrl).toBe(first)
    // A single-player game notes the site's new picture when it starts, and drops one the site removed.
    fake.setCover(`${ORIGIN}/game-files/covers/second.jpg`)
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect((await games.view()).games[0]?.coverUrl).toBe(`${ORIGIN}/game-files/covers/second.jpg`)
    fake.setCover(null)
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect((await games.view()).games[0]).not.toHaveProperty('coverUrl')
  })

  it('refuses links that are no game, systems without builds, and removes games with their files', async () => {
    const linux = await library({ system: 'linux', releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('x') }] })
    expect(await linux.games.install('Not A Slug')).toEqual({ ok: false, message: 'That is not a WASD Engine game link.' })
    expect(await linux.games.install('sky-keep')).toEqual({ ok: false, message: 'Games from WASD Engine install on Windows and macOS only.' })
    expect((await linux.games.view()).supported).toBe(false)

    const { games, root } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('bytes') }] })
    await games.install('sky-keep')
    await settled(games)
    expect(await games.remove(GAME_ID)).toEqual({ ok: true })
    expect((await games.view()).games).toEqual([])
    expect(await readdir(root)).toEqual(['games.json'])
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: false, message: 'This game is not installed. Install it again from its page.' })
  })

  it('streams the library after each change until the stream ends', async () => {
    const { games } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('streamed') }] })
    const following = new AbortController()
    const seen: string[] = []
    const done = (async () => {
      for await (const view of games.follow(following.signal)) {
        seen.push(view.games.length > 0 ? 'installed' : view.tasks.map(task => task.state).join(',') || 'empty')
        if (view.games.length > 0) following.abort()
      }
    })()
    await games.install('sky-keep')
    await done
    // The stream yields the download as it goes, and ends with the installed game.
    expect(seen.at(-1)).toBe('installed')
    expect(seen.slice(0, -1).every(state => state === 'empty' || state.startsWith('downloading') || state.startsWith('installing'))).toBe(true)
  })
})

describe('findProgram', () => {
  it('finds the application bundle of a macOS build and the game executable of a Windows build', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dsh-wasd-program-'))
    folders.push(folder)
    await mkdir(join(folder, 'Sky Keep.app'))
    await writeFile(join(folder, 'Sky Keep.console.exe'), '')
    await writeFile(join(folder, 'Sky Keep.exe'), '')
    expect(await findProgram(folder, 'macos')).toBe('Sky Keep.app')
    expect(await findProgram(folder, 'windows')).toBe('Sky Keep.exe')
  })
})
