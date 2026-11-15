/**
 * The game library installs a game's desktop build for this computer from the site, checks and unpacks it, keeps one
 * version per game and the newest build this computer can install apart from the latest version, updates an online
 * game before it starts and hands it a player token, refuses games the site no longer offers, starts a single-player
 * game at the version it has, counts each start as a play on the site, replaces and deletes files so that a failure
 * leaves working files, sweeps what interrupted work left, and deletes games.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findProgram, GameLibrary, type GameCommand, type LibraryDependencies } from '../src/library.ts'
import type { WasdLibraryView } from '../src/types.ts'

/** The renames a spec refuses: an error for a move the system holds, undefined to let the move happen. */
const refuse = vi.hoisted(() => ({ rename: (_from: string, _to: string): Error | undefined => undefined }))
/** A wait before each deletion of a path, such as a slow disk's. */
const slow = vi.hoisted(() => ({ rm: (_path: string): Promise<void> => Promise.resolve() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const error = refuse.rename(from, to)
      if (error !== undefined) throw error
      await actual.rename(from, to)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await slow.rm(String(args[0]))
      await actual.rm(...args)
    },
  }
})

const ORIGIN = 'https://site.test'
const GAME_ID = '3f2a0c9e-1111-4222-8333-944455556666'
const signal = new AbortController().signal

const folders: string[] = []
const lifetimes: AbortController[] = []
afterEach(async () => {
  refuse.rename = () => undefined
  slow.rm = () => Promise.resolve()
  // Disposal stops the libraries' background checks; a games.json write already under way may still land while its
  // folder goes, which the retries of the removal take care of.
  for (const lifetime of lifetimes.splice(0)) lifetime.abort()
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })))
})

/** A library's lifetime, which ends when the test does, as a disposed plugin's does. */
function lifetime(): AbortSignal {
  const controller = new AbortController()
  lifetimes.push(controller)
  return controller.signal
}

/** The error the system gives a move of a file it holds. */
function held(code: string, from: string, to: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code })
}

/** A promise a spec opens when it wants. */
function gate() {
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

type Platform = 'windows' | 'macos'

interface Release {
  readonly version: number
  readonly multiplayer: 'player_hosted' | 'dedicated' | null
  bytes: Buffer
  readonly status?: string
  /** The platforms with a build of this release; both without it. */
  platforms?: readonly Platform[]
}

/**
 * A site with one game and its releases. As the real site, its library answer offers each platform's newest build at
 * or below the release asked for. `plays` holds the token of each play the library counted, or '' for one without.
 */
function site(releases: Release[]) {
  const calls: string[] = []
  const plays: string[] = []
  let cover: string | null = null
  let gone: 404 | 410 | undefined
  let blocked = false
  let offline = false
  let hold: Promise<void> | undefined
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (offline) throw new TypeError('fetch failed')
    if (url.pathname === '/api/v1/library/games/sky-keep') {
      if (hold !== undefined) await hold
      if (gone !== undefined) {
        const type = gone === 410 ? 'taken_down' : 'not_found'
        return Response.json({ type: 'error', error: { type, code: type, message: 'No such game.' } }, { status: gone })
      }
      const top = releases.at(-1) as Release
      const wanted = url.searchParams.get('v')
      const release = top.multiplayer !== null || wanted === null ? top : releases.find(entry => String(entry.version) === wanted) ?? top
      const downloads = blocked ? [] : (['windows', 'macos'] as const).flatMap((platform) => {
        const build = releases.filter(entry => entry.version <= release.version && (entry.platforms ?? ['windows', 'macos']).includes(platform)).at(-1)
        return build === undefined ? [] : [{
          platform, version: build.version, status: build.status ?? 'clean', url: `${ORIGIN}/games/sky-keep/download/${platform}?v=${String(build.version)}`,
          bytes: build.bytes.length, sha256: createHash('sha256').update(build.bytes).digest('hex'), filename: 'Sky Keep.zip',
        }]
      })
      return Response.json({
        game: {
          id: GAME_ID, slug: 'sky-keep', title: 'Sky Keep', url: `${ORIGIN}/games/sky-keep`, latest_version: top.version, cover_url: cover,
          webp_url: null, multiplayer: top.multiplayer, downloads_blocked: blocked,
        },
        release: { version: release.version, multiplayer: release.multiplayer, url: `${ORIGIN}/games/sky-keep?v=${String(release.version)}` },
        downloads,
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
    /** The build downloads, in order. */
    downloads: () => calls.filter(call => call.startsWith('GET /games/sky-keep/download/')),
    /** How often the library asked about the game. */
    lookups: () => calls.filter(call => call.startsWith('GET /api/v1/library/games/sky-keep') && !call.endsWith('/plays')).length,
    setCover: (next: string | null) => { cover = next },
    setGone: (next: 404 | 410 | undefined) => { gone = next },
    setBlocked: (next: boolean) => { blocked = next },
    setOffline: (next: boolean) => { offline = next },
    setHold: (next: Promise<void> | undefined) => { hold = next },
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
  /** What a start waits for after the game started, as a slow system does; nothing by default. */
  readonly startWait?: () => Promise<void>

  /** A library folder the spec prepared; a new one by default. */
  readonly root?: string
}

async function library(options: LibraryOptions) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-wasd-library-'))
  folders.push(root)
  const fake = site(options.releases)
  const started: GameCommand[] = []
  const system = options.system ?? 'darwin'
  const clock = { now: new Date('2026-11-13T12:00:00Z'), advance(ms: number) { this.now = new Date(this.now.getTime() + ms) } }
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
    start: async (command) => {
      if (options.startError !== undefined) throw options.startError
      started.push(command)
      await options.startWait?.()
    },
    now: () => clock.now,
    retryDelaysMs: [0, 0, 0],
  }
  const games = new GameLibrary(dependencies, lifetime())
  return { games, root, started, site: fake, clock }
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
    await settled(games)
    // The answer about version 1 did not say what this computer can install of the latest; the library asks next.
    await vi.waitFor(async () => { expect((await games.view()).games[0]?.updateVersion).toBe(2) })
    expect((await games.view()).games).toEqual([{
      id: GAME_ID, slug: 'sky-keep', title: 'Sky Keep', version: 1, latestVersion: 2, updateVersion: 2, platform: 'macos', bytes: v1.bytes.length,
      installedAt: '2026-11-13T12:00:00.000Z',
    }])
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1'])
    // A single-player game starts at its own version, from its bundle; the site counts the play.
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(started).toEqual([{ platform: 'macos', program: join(root, GAME_ID, '1', 'Sky Keep.app'), cwd: join(root, GAME_ID, '1'), env: {} }])
    await vi.waitFor(() => { expect(fake.plays).toEqual(['account-token']) })
    // Update installs the newer version and deletes the earlier one.
    await games.install('sky-keep')
    const view = await settled(games)
    expect(view.games.map(game => [game.version, game.latestVersion, game.updateVersion])).toEqual([[2, 2, undefined]])
    expect(await readdir(join(root, GAME_ID))).toEqual(['2'])
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
      platform: 'windows',
      program: join(root, GAME_ID, '2', 'Sky Keep.exe'),
      cwd: join(root, GAME_ID, '2'),
      env: { WASD_PLAY_TOKEN: 'wpt1.player', WASD_API_ORIGIN: ORIGIN, WASD_GAME_ID: GAME_ID, WASD_GAME_VERSION: '2' },
    }])
    expect(fake.calls).toContain('GET /games/sky-keep/download/windows?v=2')
    expect(fake.calls).toContain('POST /api/v1/play/token')
    await vi.waitFor(() => { expect(fake.plays).toEqual(['account-token']) })
  })

  it('keeps the newest build this computer can install apart from the latest version, and never downloads the installed build again', async () => {
    const releases: Release[] = [{ version: 1, multiplayer: null, bytes: Buffer.from('desktop one') }]
    const { games, started, site: fake } = await library({ releases })
    await games.install('sky-keep')
    await settled(games)
    // Version 2 is released for the Web only, so the site offers version 1's build again.
    releases.push({ version: 2, multiplayer: null, bytes: Buffer.from('web two'), platforms: [] })
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    let game = (await games.view()).games[0]
    expect(game).toMatchObject({ version: 1, latestVersion: 2, unavailableVersion: 2 })
    expect(game).not.toHaveProperty('updateVersion')
    // Installing again, from the site's Install button or at the installed version, keeps the build that is there.
    expect(await games.install('sky-keep')).toEqual({ ok: true })
    await settled(games)
    expect(await games.install('sky-keep', 1)).toEqual({ ok: true })
    await settled(games)
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1'])
    // Version 3 has a build for this computer: Update installs it.
    releases.push({ version: 3, multiplayer: null, bytes: Buffer.from('desktop three') })
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    game = (await games.view()).games[0]
    expect(game).toMatchObject({ version: 1, latestVersion: 3, updateVersion: 3 })
    expect(game).not.toHaveProperty('unavailableVersion')
    await games.install('sky-keep')
    await settled(games)
    expect((await games.view()).games[0]).toMatchObject({ version: 3, latestVersion: 3 })
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1', 'GET /games/sky-keep/download/macos?v=3'])
    expect(started).toHaveLength(2)
  })

  it('refuses to start an online game whose latest version has no build here, and downloads nothing for it', async () => {
    const releases: Release[] = [{ version: 1, multiplayer: 'player_hosted', bytes: Buffer.from('online one') }]
    const { games, started, site: fake } = await library({ releases })
    await games.install('sky-keep')
    await settled(games)
    const second: Release = { version: 2, multiplayer: 'player_hosted', bytes: Buffer.from('online two'), platforms: ['windows'] }
    releases.push(second)
    const message = 'Version 2 of Sky Keep has no macOS download yet, and online play needs the latest version.'
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await games.launch(GAME_ID, signal)).toEqual({ ok: false, message, refusal: { reason: 'unavailable', version: 2 } })
    }
    expect(started).toEqual([])
    expect((await games.view()).games[0]).toMatchObject({ version: 1, unavailableVersion: 2 })
    // The site's Install button does not install version 1's build either.
    await games.install('sky-keep')
    expect((await settled(games)).tasks).toEqual([expect.objectContaining({ state: 'failed', message })])
    games.dismiss('sky-keep')
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1'])
    // Once version 2 has a macOS build, Play installs it and starts it.
    second.platforms = ['windows', 'macos']
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(started.map(command => command.env.WASD_GAME_VERSION)).toEqual(['2'])
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1', 'GET /games/sky-keep/download/macos?v=2'])
  })

  it('never starts a game WASD Engine took down, and starts one its creator removed only once the player confirms', async () => {
    const { games, started, site: fake } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('soon gone') }] })
    await games.install('sky-keep')
    await settled(games)
    const takenDown = {
      ok: false, message: 'WASD Engine took Sky Keep down, so it no longer starts. You can uninstall it.', refusal: { reason: 'taken_down' },
    }
    fake.setGone(410)
    expect(await games.launch(GAME_ID, signal)).toEqual(takenDown)
    expect(await games.launch(GAME_ID, signal, true)).toEqual(takenDown)
    expect((await games.view()).games[0]?.availability).toBe('taken_down')
    // Offline, the site's last answer holds.
    fake.setOffline(true)
    expect(await games.launch(GAME_ID, signal)).toEqual(takenDown)
    fake.setOffline(false)
    // A game whose downloads WASD Engine blocks is taken down too.
    fake.setGone(undefined)
    fake.setBlocked(true)
    expect(await games.launch(GAME_ID, signal)).toEqual(takenDown)
    expect(started).toEqual([])
    // Offered again, it starts again.
    fake.setBlocked(false)
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect((await games.view()).games[0]).not.toHaveProperty('availability')
    // Its creator removed it: it starts only with Play anyway, offline too.
    fake.setGone(404)
    const removed = {
      ok: false, message: 'The creator of Sky Keep removed it from WASD Engine. Choose Play anyway to start it, or uninstall it.', refusal: { reason: 'removed' },
    }
    expect(await games.launch(GAME_ID, signal)).toEqual(removed)
    expect((await games.view()).games[0]?.availability).toBe('removed')
    fake.setOffline(true)
    expect(await games.launch(GAME_ID, signal)).toEqual(removed)
    expect(await games.launch(GAME_ID, signal, true)).toEqual({ ok: true })
    fake.setOffline(false)
    expect(await games.launch(GAME_ID, signal, true)).toEqual({ ok: true })
    expect(started).toHaveLength(3)
  })

  it('starts a removed online game on Play anyway without online play', async () => {
    const { games, started, site: fake } = await library({ releases: [{ version: 1, multiplayer: 'dedicated', bytes: Buffer.from('server game') }] })
    await games.install('sky-keep')
    await settled(games)
    fake.setGone(404)
    expect(await games.launch(GAME_ID, signal, true)).toEqual({ ok: true })
    expect(started.map(command => command.env)).toEqual([{}])
    expect(fake.calls).not.toContain('POST /api/v1/play/token')
  })

  it('asks the site about installed games when the library is followed, at most every ten minutes', async () => {
    const { games, clock, site: fake } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('checked') }] })
    await games.install('sky-keep')
    await settled(games)
    const follow = async (until: (view: WasdLibraryView) => boolean): Promise<WasdLibraryView | undefined> => {
      const following = new AbortController()
      for await (const view of games.follow(following.signal)) {
        if (until(view)) {
          following.abort()
          return view
        }
      }
      return undefined
    }
    const asked = fake.lookups()
    // The install's answer is current, so following asks nothing.
    await follow(() => true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.lookups()).toBe(asked)
    // Eleven minutes later, following asks again, and the view shows what the site answered.
    clock.advance(11 * 60_000)
    fake.setGone(410)
    expect((await follow(view => view.games[0]?.availability === 'taken_down'))?.games[0]).toMatchObject({ availability: 'taken_down' })
    expect(fake.lookups()).toBe(asked + 1)
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
    const tampered: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.includes('/download/') ? new Response(new Uint8Array(Buffer.from('evil bytes'))) : await fetchSite(input, init)
    }
    const other = new GameLibrary({
      root: damaged.root, siteOrigin: () => Promise.resolve(ORIGIN), access: () => Promise.resolve(undefined), fetch: tampered,
      system: 'darwin', unpack: () => Promise.resolve(), start: () => Promise.resolve(), now: () => new Date(),
    }, lifetime())
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
    }, lifetime())
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

  it('keeps a game\'s working files when its new build cannot replace them, and tries a held move again', async () => {
    const release: Release = { version: 1, multiplayer: null, bytes: Buffer.from('first upload') }
    const { games, root, started } = await library({ system: 'win32', releases: [release] })
    await games.install('sky-keep')
    await settled(games)
    const program = join(root, GAME_ID, '1', 'Sky Keep.exe')
    // Another build of version 1 arrives while the system holds every move of the new files, and its unpacked files take
    // a while to delete, which the failure waits for.
    release.bytes = Buffer.from('second upload')
    refuse.rename = (from, to) => from.includes('.unpack-') ? held('EPERM', from, to) : undefined
    slow.rm = path => path.includes('.unpack-') ? new Promise(resolve => setTimeout(resolve, 200)) : Promise.resolve()
    await games.install('sky-keep')
    expect((await settled(games)).tasks).toEqual([expect.objectContaining({
      state: 'failed',
      message: 'The new files of Sky Keep could not replace its old ones, because the system is using them. Quit the game if it is running, then try again.',
    })])
    expect(await readFile(program, 'utf8')).toBe('first upload')
    expect(await readdir(join(root, GAME_ID))).toEqual(['1'])
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    // A hold that ends lets the move through.
    let holds = 2
    refuse.rename = (from, to) => from.includes('.unpack-') && holds-- > 0 ? held('EBUSY', from, to) : undefined
    games.dismiss('sky-keep')
    await games.install('sky-keep')
    expect((await settled(games)).tasks).toEqual([])
    expect(await readFile(program, 'utf8')).toBe('second upload')
    expect(await readdir(join(root, GAME_ID))).toEqual(['1'])
    expect(started).toHaveLength(1)
  })

  it('uninstalls by moving the game\'s files away before it forgets the game, and keeps a game whose files the system holds', async () => {
    const { games, root } = await library({ system: 'win32', releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('running') }] })
    await games.install('sky-keep')
    await settled(games)
    refuse.rename = (from, to) => to.includes('.trash-') ? held('EBUSY', from, to) : undefined
    expect(await games.remove(GAME_ID)).toEqual({
      ok: false, message: 'WASD Engine could not delete the files of Sky Keep, because the system is using them. Quit the game if it is running, then try again.',
    })
    expect((await games.view()).games.map(game => game.id)).toEqual([GAME_ID])
    expect(await readdir(join(root, GAME_ID, '1'))).toEqual(['Sky Keep.exe'])
    refuse.rename = () => undefined
    expect(await games.remove(GAME_ID)).toEqual({ ok: true })
    expect(await readdir(root)).toEqual(['games.json'])
    expect(JSON.parse(await readFile(join(root, 'games.json'), 'utf8'))).toEqual({ format: 1, games: {} })
  })

  it('lets an Uninstall that begins while a game starts win: the game neither starts nor comes back', async () => {
    const { games, root, started, site: fake } = await library({ releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('raced') }] })
    await games.install('sky-keep')
    await settled(games)
    const asked = fake.lookups()
    const answer = gate()
    fake.setHold(answer.opened)
    const launching = games.launch(GAME_ID, signal)
    await vi.waitFor(() => { expect(fake.lookups()).toBe(asked + 1) })
    expect(await games.remove(GAME_ID)).toEqual({ ok: true })
    answer.open()
    expect(await launching).toEqual({ ok: false, message: 'The game was uninstalled before it started.' })
    expect(started).toEqual([])
    expect((await games.view()).games).toEqual([])
    expect(await readdir(root)).toEqual(['games.json'])
  })

  it('does not list a game again that was uninstalled while the system started it', async () => {
    const starting = gate()
    const { games, root, started } = await library({
      releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('raced') }], startWait: () => starting.opened,
    })
    await games.install('sky-keep')
    await settled(games)
    const launching = games.launch(GAME_ID, signal)
    await vi.waitFor(() => { expect(started).toHaveLength(1) })
    expect(await games.remove(GAME_ID)).toEqual({ ok: true })
    starting.open()
    expect(await launching).toEqual({ ok: true })
    expect((await games.view()).games).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'games.json'), 'utf8'))).toEqual({ format: 1, games: {} })
  })

  it('refuses an install of another version while one installs, and joins one of the same version', async () => {
    const releases: Release[] = [
      { version: 1, multiplayer: null, bytes: Buffer.from('first') },
      { version: 2, multiplayer: null, bytes: Buffer.from('second') },
    ]
    const { games, site: fake } = await library({ releases })
    const answer = gate()
    fake.setHold(answer.opened)
    expect(await games.install('sky-keep', 1)).toEqual({ ok: true })
    expect(await games.install('sky-keep')).toEqual({ ok: false, message: 'Another version of this game is installing. Try again once that ends.' })
    expect(await games.install('sky-keep', 1)).toEqual({ ok: true })
    fake.setHold(undefined)
    answer.open()
    expect((await settled(games)).games.map(game => game.version)).toEqual([1])
    expect(fake.downloads()).toEqual(['GET /games/sky-keep/download/macos?v=1'])
  })

  it('sweeps what interrupted work left at its first read, and keeps the entries and folders it cannot read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wasd-library-'))
    const unreadable = '11111111-1111-4111-8111-111111111111'
    const leftover = '22222222-2222-4222-8222-222222222222'
    const strange = { id: unreadable, version: 'two', from: 'a later version' }
    const installed = {
      id: GAME_ID, slug: 'sky-keep', title: 'Sky Keep', version: 2, latestVersion: 2, platform: 'macos', bytes: 4,
      installedAt: '2026-11-01T00:00:00.000Z', origin: ORIGIN, folder: join(GAME_ID, '2'), program: 'Sky Keep.app',
    }
    await writeFile(join(root, 'games.json'), JSON.stringify({ format: 1, games: { [GAME_ID]: installed, [unreadable]: strange } }))
    const make = (...parts: string[]) => mkdir(join(root, ...parts), { recursive: true })
    await make(GAME_ID, '2', 'Sky Keep.app', 'Contents', 'MacOS')
    await writeFile(join(root, GAME_ID, '2', 'Sky Keep.app', 'Contents', 'MacOS', 'Sky Keep'), 'game')
    // An install that stopped midway, an earlier version, and a folder a swap moved aside.
    await writeFile(join(root, GAME_ID, `.download-${randomUUID()}.zip`), 'partial')
    await make(GAME_ID, `.unpack-${randomUUID()}`, 'Sky Keep.app')
    await make(GAME_ID, `.old-${randomUUID()}`)
    await make(GAME_ID, '1')
    // The folder of the entry it cannot read, a game no entry names, an Uninstall and a save that stopped midway.
    await make(unreadable, '2')
    await make(leftover, '1')
    await make(`.trash-${randomUUID()}`, 'Sky Keep.app')
    await writeFile(join(root, `games.json.${randomUUID()}.tmp`), '{')
    const { games, started } = await library({ root, releases: [{ version: 2, multiplayer: null, bytes: Buffer.from('game') }] })
    expect((await games.view()).games.map(game => [game.id, game.version])).toEqual([[GAME_ID, 2]])
    expect((await readdir(root)).sort()).toEqual([GAME_ID, unreadable, 'games.json'].sort())
    expect(await readdir(join(root, GAME_ID))).toEqual(['2'])
    expect(await readdir(join(root, unreadable))).toEqual(['2'])
    // A save keeps the entry it cannot read as it was.
    expect(await games.launch(GAME_ID, signal)).toEqual({ ok: true })
    expect(started).toHaveLength(1)
    const saved = JSON.parse(await readFile(join(root, 'games.json'), 'utf8')) as { games: Record<string, unknown> }
    expect(saved.games[unreadable]).toEqual(strange)
    expect(saved.games[GAME_ID]).toMatchObject({ version: 2, startedAt: '2026-11-13T12:00:00.000Z' })
  })

  it('keeps a games.json it cannot read beside the new one, and keeps the game folders while it cannot tell them apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wasd-library-'))
    await writeFile(join(root, 'games.json'), 'not json')
    await mkdir(join(root, GAME_ID, '1'), { recursive: true })
    await writeFile(join(root, GAME_ID, `.download-${randomUUID()}.zip`), 'partial')
    const { games } = await library({ root, releases: [{ version: 1, multiplayer: null, bytes: Buffer.from('game') }] })
    expect((await games.view()).games).toEqual([])
    const names = await readdir(root)
    const kept = names.find(name => name.startsWith('games.json.unreadable-'))
    expect(kept).toBeDefined()
    expect(await readFile(join(root, kept as string), 'utf8')).toBe('not json')
    expect(await readdir(join(root, GAME_ID))).toEqual(['1'])
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
