/**
 * The game library of the Desktop app: games a player installs from the WASD Engine site as the desktop build of this
 * computer's system, keeps up to date, and starts from the app's Play page.
 *
 * The Install button of a game's page, on the site or in the Play page, links to
 * `wasdengine://games/<slug>?install=1`, which the app hands to {@link GameLibrary.install}. The library asks the site's
 * library route (`GET /api/v1/library/games/<slug>`, with `v` for an earlier version of a single-player game) for the
 * version to install and its builds, downloads this system's build through the site's counted download link, checks
 * its size and SHA-256, unpacks it (`ditto` on macOS, `tar` on Windows) into `<root>/<game id>/<version>/`, records it in
 * `<root>/games.json`, and deletes the game's earlier version. An online game (`multiplayer`) installs and starts only
 * at its latest version, the one the site's lobbies and servers accept: starting one installs a newer version first,
 * then hands the game a player token of the signed-in account in `WASD_PLAY_TOKEN`, with `WASD_API_ORIGIN`,
 * `WASD_GAME_ID`, and `WASD_GAME_VERSION`, which the WASD Multiplayer add-on reads. A single-player game starts at the
 * version it has, and the library notes a newer one, which the Play page offers as Update. A game runs as a process of
 * its own, detached from the app's, so it keeps running after the app quits.
 * @module @deepseek-ai/dsh-wasd-plugins/src/library
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { MultiplayerApi } from './multiplayer-api.ts'
import type { SiteAccess } from './release.ts'
import type { WasdDesktopPlatform, WasdLibraryGame, WasdLibraryOutcome, WasdLibraryTask, WasdLibraryView } from './types.ts'

/** A game's address on the site: what `/games/<slug>` and the game links name. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u

/** Largest build the library downloads, in bytes. */
const MAX_BUILD_BYTES = 8 * 1024 ** 3

/** Shortest wait between two progress updates of one download, in milliseconds. */
const PROGRESS_MS = 250

const Multiplayer = z.enum(['player_hosted', 'dedicated'])

/** The site's answer about the version of a game to install. */
const LibraryJson = z.object({
  game: z.object({
    id: z.string().regex(/^[0-9a-f-]{1,64}$/u),
    slug: z.string(),
    title: z.string(),
    latest_version: z.number().int(),
    cover_url: z.string().nullish(),
    multiplayer: Multiplayer.nullish(),
  }),
  release: z.object({ version: z.number().int().min(1), multiplayer: Multiplayer.nullish() }),
  downloads: z.array(z.object({
    platform: z.string(),
    version: z.number().int(),
    status: z.string(),
    url: z.string(),
    bytes: z.number().int().min(0),
    sha256: z.string().nullish(),
  })),
})
type LibraryJson = z.infer<typeof LibraryJson>

/** A game in `games.json`: the view's fields, where its build lives, and the program that starts it. */
const InstalledGame = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  version: z.number().int(),
  latestVersion: z.number().int(),
  multiplayer: Multiplayer.optional(),
  platform: z.enum(['windows', 'macos']),
  bytes: z.number().int(),
  installedAt: z.string(),
  coverUrl: z.string().optional(),
  origin: z.string(),
  // Relative to the library's root.
  folder: z.string(),
  // Relative to the game's folder: the `.app` bundle on macOS, the `.exe` on Windows.
  program: z.string(),
  startedAt: z.string().optional(),
})
type InstalledGame = z.infer<typeof InstalledGame>
const GamesFile = z.object({ format: z.literal(1), games: z.record(z.string(), InstalledGame) })

/** A failure the library reports to the player; the message says what to do. */
export class LibraryError extends Error {
  override name = 'LibraryError'
}

/** A program the library starts, with the environment entries it adds. */
export interface GameCommand {
  /** Absolute path of the executable. */
  readonly program: string
  /** Absolute working folder: the game's folder. */
  readonly cwd: string
  /** Environment entries on top of the app's. */
  readonly env: Readonly<Record<string, string>>
}

/** What the library needs from its Host. */
export interface LibraryDependencies {
  /** Absolute folder of the library: `games.json` and one folder per game. */
  readonly root: string
  /** @returns the origin of the WASD Engine site the app signs in to. */
  readonly siteOrigin: () => Promise<string>
  /** @returns the signed-in site, or undefined while the app is signed out. */
  readonly access: () => Promise<SiteAccess | undefined>
  /** HTTP client. */
  readonly fetch: typeof fetch
  /** This computer's system, as `process.platform` names it. */
  readonly system: NodeJS.Platform
  /**
   * Unpack a ZIP file into an empty folder, keeping file modes.
   * @param archive - absolute ZIP path.
   * @param folder - absolute folder that exists and is empty.
   * @param signal - cancellation.
   */
  readonly unpack: (archive: string, folder: string, signal: AbortSignal) => Promise<void>
  /**
   * Start a game as a process of its own.
   * @param command - the executable, its folder, and its environment entries.
   * @returns once the process started.
   */
  readonly start: (command: GameCommand) => Promise<void>
  /** @returns the current time. */
  readonly now: () => Date
}

/** This computer's platform of desktop builds, or undefined where the site has none. */
function platformOf(system: NodeJS.Platform): WasdDesktopPlatform | undefined {
  if (system === 'darwin') return 'macos'
  return system === 'win32' ? 'windows' : undefined
}

/** The platforms' names as messages write them. */
const PLATFORM_NAMES: Readonly<Record<WasdDesktopPlatform, string>> = { windows: 'Windows', macos: 'macOS' }

/** The library of one Desktop app. */
export class GameLibrary {
  private games = new Map<string, InstalledGame>()
  private readonly tasks = new Map<string, WasdLibraryTask>()
  private readonly running = new Map<string, Promise<InstalledGame>>()
  private readonly followers = new Set<() => void>()
  private loaded: Promise<void> | undefined
  private saving: Promise<void> = Promise.resolve()

  /**
   * @param dependencies - files, the site, unpacking, and starting games.
   * @param lifetime - aborts every download when the plugin is disposed.
   */
  constructor(private readonly dependencies: LibraryDependencies, private readonly lifetime: AbortSignal) {}

  /**
   * The installed games, the last started first, and the tasks in progress.
   * @returns the view.
   */
  async view(): Promise<WasdLibraryView> {
    await this.load()
    const games = [...this.games.values()]
      .sort((left, right) => (right.startedAt ?? right.installedAt).localeCompare(left.startedAt ?? left.installedAt))
      .map((game): WasdLibraryGame => ({
        id: game.id,
        slug: game.slug,
        title: game.title,
        version: game.version,
        latestVersion: game.latestVersion,
        ...game.multiplayer === undefined ? {} : { multiplayer: game.multiplayer },
        platform: game.platform,
        bytes: game.bytes,
        installedAt: game.installedAt,
        ...game.coverUrl === undefined ? {} : { coverUrl: game.coverUrl },
      }))
    return { games, tasks: [...this.tasks.values()], supported: platformOf(this.dependencies.system) !== undefined }
  }

  /**
   * Follow the library.
   * @param signal - ends the stream.
   * @returns the view, then again after each change, until `signal` aborts or the plugin is disposed.
   */
  async * follow(signal: AbortSignal): AsyncIterable<WasdLibraryView> {
    const stop = AbortSignal.any([signal, this.lifetime])
    let changed = true
    let wake: (() => void) | undefined
    const follower = (): void => {
      changed = true
      wake?.()
    }
    const onStop = (): void => { wake?.() }
    this.followers.add(follower)
    stop.addEventListener('abort', onStop, { once: true })
    try {
      while (!stop.aborted) {
        if (changed) {
          changed = false
          yield await this.view()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.followers.delete(follower)
      stop.removeEventListener('abort', onStop)
    }
  }

  /**
   * Start installing a game, or its newer version; the download goes on in the background, and the view follows it.
   * A game that is installing already keeps that download.
   * @param slug - the game's address on the site.
   * @param version - an earlier version of a single-player game; undefined installs the latest.
   * @returns whether the install started, or why not.
   */
  install(slug: string, version?: number): Promise<WasdLibraryOutcome> {
    if (!SLUG.test(slug)) return Promise.resolve({ ok: false, message: 'That is not a WASD Engine game link.' })
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      return Promise.resolve({ ok: false, message: 'The version must be a release number.' })
    }
    if (platformOf(this.dependencies.system) === undefined) {
      return Promise.resolve({ ok: false, message: 'Games from WASD Engine install on Windows and macOS only.' })
    }
    void this.installing(slug, version).catch(() => {
      // The failed task in the view reports it.
    })
    return Promise.resolve({ ok: true })
  }

  /**
   * Forget a failed task.
   * @param slug - the task's game.
   */
  dismiss(slug: string): void {
    if (this.tasks.get(slug)?.state !== 'failed') return
    this.tasks.delete(slug)
    this.notify()
  }

  /**
   * Start an installed game. An online game first installs the site's newer version, if there is one; a single-player
   * game starts at its version and notes a newer one.
   * @param id - the game's id.
   * @param signal - stops waiting; an update the start began goes on.
   * @returns once the game started, or why it did not.
   */
  async launch(id: string, signal: AbortSignal): Promise<WasdLibraryOutcome> {
    await this.load()
    let game = this.games.get(id)
    if (game === undefined) return { ok: false, message: 'This game is not installed. Install it again from its page.' }
    try {
      game = await this.current(game, signal)
      const env = game.multiplayer === undefined ? {} : await this.playEnvironment(game, signal)
      const folder = join(this.dependencies.root, game.folder)
      await this.dependencies.start({ program: await this.executable(game, folder), cwd: folder, env })
      await this.record({ ...game, startedAt: this.dependencies.now().toISOString() })
      return { ok: true }
    } catch (error) {
      signal.throwIfAborted()
      return { ok: false, message: error instanceof LibraryError ? error.message : `The game did not start: ${(error as Error).message}` }
    }
  }

  /**
   * Delete an installed game and its files.
   * @param id - the game's id.
   * @returns whether it was deleted, or why not.
   */
  async remove(id: string): Promise<WasdLibraryOutcome> {
    await this.load()
    const game = this.games.get(id)
    if (game === undefined) return { ok: true }
    if (this.running.has(game.slug)) return { ok: false, message: 'The game is installing; remove it once that ends.' }
    this.games.delete(id)
    await this.save()
    this.notify()
    await rm(join(this.dependencies.root, id), { recursive: true, force: true })
    return { ok: true }
  }

  /** The installed game at the version it may start at: an online game's latest, installed first when it is newer. */
  private async current(game: InstalledGame, signal: AbortSignal): Promise<InstalledGame> {
    let latest: LibraryJson
    try {
      latest = await this.lookup(game.origin, game.slug, undefined, signal)
    } catch (error) {
      signal.throwIfAborted()
      // A single-player game plays offline; an online game needs the site anyway.
      if (game.multiplayer === undefined) return game
      throw error
    }
    const multiplayer = latest.release.multiplayer ?? undefined
    if (latest.release.version > game.version && (multiplayer !== undefined || game.multiplayer !== undefined)) {
      return await withSignal(this.installing(game.slug, undefined), signal)
    }
    // The site's picture replaces the noted one, and a game whose picture the site removed loses it.
    const noted: InstalledGame = {
      ...game, latestVersion: latest.game.latest_version, title: latest.game.title, coverUrl: latest.game.cover_url ?? undefined,
    }
    const changed = noted.latestVersion !== game.latestVersion || noted.title !== game.title || noted.coverUrl !== game.coverUrl
    if (changed) await this.record(noted)
    return noted
  }

  /** The player token and site of an online game, for its process's environment. */
  private async playEnvironment(game: InstalledGame, signal: AbortSignal): Promise<Record<string, string>> {
    const access = await this.dependencies.access()
    if (access?.origin !== game.origin) {
      throw new LibraryError('Online games need a WASD Engine account: sign in to WASD Engine, then play again.')
    }
    let token: string
    try {
      token = await new MultiplayerApi(access, this.dependencies.fetch, signal).playToken(game.id)
    } catch (error) {
      signal.throwIfAborted()
      throw new LibraryError(`WASD Engine could not sign you in to play this game online: ${(error as Error).message}`)
    }
    return { WASD_PLAY_TOKEN: token, WASD_API_ORIGIN: game.origin, WASD_GAME_ID: game.id, WASD_GAME_VERSION: String(game.version) }
  }

  /** The executable a game starts with: the `.exe`, or the program inside the `.app` bundle. */
  private async executable(game: InstalledGame, folder: string): Promise<string> {
    const program = join(folder, game.program)
    if (game.platform === 'windows') return program
    const programs = join(program, 'Contents', 'MacOS')
    const names = (await readdir(programs, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name)
    const name = names.length === 1 ? names[0] : names.find(candidate => `${candidate}.app` === game.program)
    if (name === undefined) throw new LibraryError('The game\'s files are damaged. Remove it, then install it again.')
    return join(programs, name)
  }

  /**
   * One install of a game at a time; a second request joins the first. The task leaves the view once the install has
   * ended and cleaned up, so a game the view lists is no longer installing.
   */
  private installing(slug: string, version: number | undefined): Promise<InstalledGame> {
    const pending = this.running.get(slug)
    if (pending !== undefined) return pending
    const task = this.download(slug, version).then((installed) => {
      this.running.delete(slug)
      this.tasks.delete(slug)
      this.notify()
      return installed
    }, (error: unknown) => {
      this.running.delete(slug)
      throw error
    })
    this.running.set(slug, task)
    return task
  }

  private async download(slug: string, version: number | undefined): Promise<InstalledGame> {
    const signal = this.lifetime
    this.setTask({ slug, title: slug, version: 0, state: 'downloading', receivedBytes: 0, totalBytes: 0 })
    const platform = platformOf(this.dependencies.system) as WasdDesktopPlatform
    let staging: string | undefined
    let unpacked: string | undefined
    try {
      await this.load()
      const origin = await this.dependencies.siteOrigin()
      const found = await this.lookup(origin, slug, version, signal)
      const { game, release } = found
      // Named as soon as the site answers, so a download that fails on its build still shows the game.
      const named = {
        slug, title: game.title, version: release.version,
        ...game.cover_url === undefined || game.cover_url === null ? {} : { coverUrl: game.cover_url },
      }
      this.setTask({ ...named, state: 'downloading', receivedBytes: 0, totalBytes: 0 })
      const build = found.downloads.find(download => download.platform === platform)
      if (build === undefined) throw new LibraryError(`${game.title} has no ${PLATFORM_NAMES[platform]} download.`)
      if (build.status === 'pending') {
        throw new LibraryError(`The ${PLATFORM_NAMES[platform]} build of ${game.title} is still being scanned for malware. Try again in a few minutes.`)
      }
      if (build.status !== 'clean') throw new LibraryError(`${game.title} has no ${PLATFORM_NAMES[platform]} download.`)
      if (build.bytes > MAX_BUILD_BYTES) throw new LibraryError(`The ${PLATFORM_NAMES[platform]} build of ${game.title} is too large to install.`)
      const progress = { ...named, version: build.version, totalBytes: build.bytes }
      this.setTask({ ...progress, state: 'downloading', receivedBytes: 0 })
      const gameRoot = join(this.dependencies.root, game.id)
      await mkdir(gameRoot, { recursive: true })
      staging = join(gameRoot, `.download-${randomUUID()}.zip`)
      await this.fetchBuild(new URL(build.url, origin).href, build.bytes, build.sha256 ?? undefined, staging, progress, signal)
      this.setTask({ ...progress, state: 'installing', receivedBytes: build.bytes })
      unpacked = join(gameRoot, `.unpack-${randomUUID()}`)
      await mkdir(unpacked)
      try {
        await this.dependencies.unpack(staging, unpacked, signal)
      } catch (error) {
        signal.throwIfAborted()
        throw new LibraryError(`The download of ${game.title} could not be unpacked: ${(error as Error).message}`)
      }
      const program = await findProgram(unpacked, platform)
      if (program === undefined) throw new LibraryError(`The ${PLATFORM_NAMES[platform]} build of ${game.title} holds no game to start.`)
      const folder = join(gameRoot, String(build.version))
      await rm(folder, { recursive: true, force: true })
      await rename(unpacked, folder)
      unpacked = undefined
      const earlier = this.games.get(game.id)
      const multiplayer = release.multiplayer ?? undefined
      const installed: InstalledGame = {
        id: game.id,
        slug: game.slug,
        title: game.title,
        version: build.version,
        latestVersion: game.latest_version,
        ...multiplayer === undefined ? {} : { multiplayer },
        platform,
        bytes: build.bytes,
        installedAt: this.dependencies.now().toISOString(),
        ...game.cover_url === undefined || game.cover_url === null ? {} : { coverUrl: game.cover_url },
        origin,
        folder: join(game.id, String(build.version)),
        program,
        ...earlier?.startedAt === undefined ? {} : { startedAt: earlier.startedAt },
      }
      await this.record(installed)
      // The earlier version's folder goes once the new one is recorded.
      for (const entry of await readdir(gameRoot)) {
        if (entry !== String(build.version) && !entry.startsWith('.')) await rm(join(gameRoot, entry), { recursive: true, force: true })
      }
      return installed
    } catch (error) {
      const message = error instanceof LibraryError ? error.message : `${slug} could not be installed: ${(error as Error).message}`
      const failed = this.tasks.get(slug)
      this.setTask({
        slug, title: failed?.title ?? slug, version: failed?.version ?? 0, state: 'failed', receivedBytes: 0, totalBytes: 0, message,
        ...failed?.coverUrl === undefined ? {} : { coverUrl: failed.coverUrl },
      })
      throw error instanceof LibraryError ? error : new LibraryError(message, { cause: error })
    } finally {
      if (staging !== undefined) await rm(staging, { force: true })
      if (unpacked !== undefined) await rm(unpacked, { recursive: true, force: true })
    }
  }

  /** The site's library answer for a game. */
  private async lookup(origin: string, slug: string, version: number | undefined, signal: AbortSignal): Promise<LibraryJson> {
    const url = new URL(`/api/v1/library/games/${slug}`, origin)
    if (version !== undefined) url.searchParams.set('v', String(version))
    let response: Response
    try {
      response = await this.dependencies.fetch(url, { redirect: 'error', signal })
    } catch (error) {
      signal.throwIfAborted()
      throw new LibraryError(`Cannot reach WASD Engine at ${origin}: ${(error as Error).message}`, { cause: error })
    }
    if (response.status === 404) throw new LibraryError('WASD Engine has no such game, or it was removed.')
    if (!response.ok) throw new LibraryError(`WASD Engine could not find the game's downloads (HTTP ${String(response.status)}). Try again later.`)
    const parsed = LibraryJson.safeParse(await response.json())
    if (!parsed.success) throw new LibraryError('WASD Engine answered in an unexpected way about the game\'s downloads.')
    return parsed.data
  }

  /** Download a build into `staging`, reporting progress and checking its size and SHA-256. */
  private async fetchBuild(
    url: string, bytes: number, sha256: string | undefined, staging: string,
    progress: Omit<WasdLibraryTask, 'state' | 'receivedBytes'>, signal: AbortSignal,
  ): Promise<void> {
    let response: Response
    try {
      response = await this.dependencies.fetch(url, { signal })
    } catch (error) {
      signal.throwIfAborted()
      throw new LibraryError(`The download of ${progress.title} failed: ${(error as Error).message}`, { cause: error })
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new LibraryError(`The download of ${progress.title} failed (HTTP ${String(response.status)}). Try again later.`)
    }
    const digest = createHash('sha256')
    let received = 0
    let reported = 0
    const count = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        if (received > bytes) {
          callback(new LibraryError(`The download of ${progress.title} is larger than the site said.`))
          return
        }
        digest.update(chunk)
        const now = Date.now()
        if (now - reported >= PROGRESS_MS) {
          reported = now
          this.setTask({ ...progress, state: 'downloading', receivedBytes: received })
        }
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), count, createWriteStream(staging, { flags: 'wx' }), { signal })
    if (received !== bytes) throw new LibraryError(`The download of ${progress.title} ended early. Try again.`)
    if (sha256 !== undefined && digest.digest('hex') !== sha256.toLowerCase()) {
      throw new LibraryError(`The download of ${progress.title} is damaged. Try again.`)
    }
  }

  private setTask(task: WasdLibraryTask): void {
    this.tasks.set(task.slug, task)
    this.notify()
  }

  /** Record a game and save the file; the view follows. */
  private async record(game: InstalledGame): Promise<void> {
    this.games.set(game.id, game)
    await this.save()
    this.notify()
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string
      try {
        text = await readFile(join(this.dependencies.root, 'games.json'), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      try {
        const parsed = GamesFile.safeParse(JSON.parse(text))
        // A damaged file lists nothing; the folders stay until the games are installed again.
        if (parsed.success) this.games = new Map(Object.entries(parsed.data.games))
      } catch {
        // Not JSON: as damaged.
      }
    })()
    return this.loaded
  }

  /** Write `games.json` whole and rename it into place, one write at a time. */
  private save(): Promise<void> {
    const games = Object.fromEntries(this.games)
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await mkdir(this.dependencies.root, { recursive: true })
      const file = join(this.dependencies.root, 'games.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify({ format: 1, games }, null, 2)}\n`)
      await rename(temporary, file)
    })
    return this.saving
  }

  private notify(): void {
    for (const follower of [...this.followers]) follower()
  }
}

/**
 * The program an unpacked build starts with: the `.app` bundle of a macOS build, or the `.exe` of a Windows build, at
 * the top of the folder.
 * @param folder - the unpacked build.
 * @param platform - its platform.
 * @returns the program's name, or undefined when the build holds none.
 */
export async function findProgram(folder: string, platform: WasdDesktopPlatform): Promise<string | undefined> {
  const entries = await readdir(folder, { withFileTypes: true })
  if (platform === 'macos') return entries.find(entry => entry.isDirectory() && entry.name.endsWith('.app'))?.name
  const programs = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe')).map(entry => entry.name)
  return programs.find(name => !name.toLowerCase().endsWith('.console.exe')) ?? programs[0]
}

/** A promise whose wait `signal` can end, while the work goes on. */
async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(signal.reason as Error) }
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
