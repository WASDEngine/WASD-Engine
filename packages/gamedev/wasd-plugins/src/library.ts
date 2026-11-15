/**
 * The game library of the Desktop app: games a player installs from the WASD Engine site as the desktop build of this
 * computer's system, keeps up to date, and starts from the app's Play page.
 *
 * The Install button of a game's page in the Play page links to `wasdengine://games/<slug>?install=1`, which the app
 * hands to {@link GameLibrary.install}. The library asks the site's library route (`GET /api/v1/library/games/<slug>`,
 * with `v` for an earlier version of a single-player game) for the version to install and its builds, downloads this
 * system's build through the site's counted download link, checks its size and SHA-256, unpacks it (`ditto` on macOS,
 * `tar` on Windows) into `<root>/<game id>/<version>/`, records it in `<root>/games.json`, and deletes the game's earlier
 * version. The site offers the newest build at or below the release asked for, so the library keeps the newest version
 * whose build this computer can install apart from the game's latest version: it never downloads the build it has
 * again, and Update appears only for a newer build. An online game (`multiplayer`) installs and starts only at its
 * latest version, the one the site's lobbies and servers accept: starting one installs a newer version first, refuses
 * while the latest version has no build for this computer, then hands the game a player token of the signed-in account
 * in `WASD_PLAY_TOKEN`, with `WASD_API_ORIGIN`, `WASD_GAME_ID`, and `WASD_GAME_VERSION`, which the WASD Multiplayer
 * add-on reads. A single-player game starts at the version it has. Each start asks the site about the game first, as
 * does the check that runs when the Play page opens for games it has not asked about for ten minutes: a game WASD
 * Engine took down (410, or `downloads_blocked`) never starts again, and one its creator removed (404) starts only
 * once the player confirms; offline, a single-player game starts as the site's last answer allows. A game runs as a
 * process of its own that outlives the app ({@link LibraryDependencies.start}). Each start counts a play of the game on
 * the site (`POST /api/v1/library/games/<slug>/plays`), as its page counts one there.
 *
 * Files change so that interrupted work never leaves a game without working files: a build that replaces a folder moves
 * the old folder aside and puts it back when the move fails, Uninstall moves the game's folder aside before it forgets
 * the game, renames and deletions that the system refuses for a moment are tried again, and the library's first read
 * deletes what interrupted work left behind. `games.json` is read entry by entry: an entry this version cannot read
 * stays in the file as it is, and a file it cannot read at all is kept beside the new one.
 * @module @deepseek-ai/dsh-wasd-plugins/src/library
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, type Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { MultiplayerApi } from './multiplayer-api.ts'
import type { SiteAccess } from './release.ts'
import type {
  WasdDesktopPlatform, WasdLibraryAvailability, WasdLibraryGame, WasdLibraryOutcome, WasdLibraryRefusal, WasdLibraryTask,
  WasdLibraryView,
} from './types.ts'

/** A game's address on the site: what `/games/<slug>` and the game links name. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u

/** A game's id on the site, which names its folder in the library. */
const GAME_ID = /^[0-9a-f-]{1,64}$/u

/** Largest build the library downloads, in bytes. */
const MAX_BUILD_BYTES = 8 * 1024 ** 3

/** Shortest wait between two progress updates of one download, in milliseconds. */
const PROGRESS_MS = 250

/** How long the site's answer about an installed game stays current for the check that runs when the Play page opens. */
const CHECK_MS = 10 * 60 * 1000

/**
 * Waits in milliseconds between the attempts of a rename or deletion that the system refuses for a moment: on Windows,
 * an antivirus scan, the search indexer, or a game that is still closing holds files for a second or two.
 */
const FILE_RETRY_MS: readonly number[] = [50, 100, 200, 400, 800, 1600]

/** Error codes of a file operation that the system refuses while it holds the file. */
const HELD_FILE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Name of a `games.json` write that did not reach its rename. */
const UNFINISHED_SAVE = /^games\.json\.[0-9a-f-]{36}\.tmp$/u

/** Name of a game folder that an interrupted Uninstall moved aside. */
const TRASH = /^\.trash-[0-9a-f-]{36}$/u

/** A SHA-256 digest as the library records it. */
const SHA256 = /^[0-9a-f]{64}$/u

const NOT_INSTALLED = 'This game is not installed. Install it again from its page.'
const UNINSTALLED = 'The game was uninstalled before it started.'
const BUSY = 'Another version of this game is installing. Try again once that ends.'
const DAMAGED = 'The game\'s files are damaged. Uninstall it, then install it again.'

const Multiplayer = z.enum(['player_hosted', 'dedicated'])

/** The site's answer about the version of a game to install. */
const LibraryJson = z.object({
  game: z.object({
    id: z.string().regex(GAME_ID),
    slug: z.string(),
    title: z.string(),
    latest_version: z.number().int(),
    cover_url: z.string().nullish(),
    multiplayer: Multiplayer.nullish(),
    // True while WASD Engine blocks the game's downloads; the answer then lists none.
    downloads_blocked: z.boolean().optional(),
  }),
  release: z.object({ version: z.number().int().min(1), multiplayer: Multiplayer.nullish() }),
  downloads: z.array(z.object({
    platform: z.string(),
    version: z.number().int().min(1),
    status: z.string(),
    url: z.string(),
    bytes: z.number().int().min(0),
    sha256: z.string().nullish(),
  })),
})
type LibraryJson = z.infer<typeof LibraryJson>

/** Whether a name is a file name alone, without folders. */
function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/]/u.test(name)
}

/** Whether a string is the origin of an HTTP site. */
function isSiteOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
}

/** A game in `games.json`: the view's fields, where its build lives, the program that starts it, and the site's answer. */
const InstalledGame = z.object({
  id: z.string().regex(GAME_ID),
  slug: z.string().regex(SLUG),
  title: z.string(),
  version: z.number().int().min(1),
  latestVersion: z.number().int(),
  // The newest version whose build for this computer the site offered at `checkedAt`; absent when it offered none.
  installable: z.number().int().min(1).optional(),
  // Set while the site no longer offers the game, as it answered at `checkedAt`.
  availability: z.enum(['taken_down', 'removed']).optional(),
  // When the site last answered about the game's latest version; absent until it did, as after installing an earlier one.
  checkedAt: z.string().optional(),
  multiplayer: Multiplayer.optional(),
  platform: z.enum(['windows', 'macos']),
  bytes: z.number().int().min(0),
  // The SHA-256 the site named for the installed build.
  sha256: z.string().regex(SHA256).optional(),
  installedAt: z.string(),
  coverUrl: z.string().optional(),
  origin: z.string().refine(isSiteOrigin, 'must be the origin of a site'),
  // Relative to the library's root: `<id>/<version>`.
  folder: z.string(),
  // Relative to the game's folder: the `.app` bundle on macOS, the `.exe` on Windows.
  program: z.string().refine(isPlainName, 'must be a file name'),
  startedAt: z.string().optional(),
}).refine(game => game.folder === join(game.id, String(game.version)), 'folder must be the game\'s version folder')
type InstalledGame = z.infer<typeof InstalledGame>

/** `games.json`: one entry per game id, each read on its own. */
const GamesFile = z.object({ format: z.literal(1), games: z.record(z.string(), z.unknown()) })

/** What the site answered about a game: its release and builds, that it no longer offers the game, or nothing usable. */
type SiteAnswer =
  | { readonly kind: 'found'; readonly entry: LibraryJson }
  | { readonly kind: 'taken_down' }
  | { readonly kind: 'removed' }
  | { readonly kind: 'unreachable'; readonly message: string }

/** A failure the library reports to the player; the message says what to do. */
export class LibraryError extends Error {
  override name = 'LibraryError'
}

/** The library's refusal to start a game, which the Play page words from `refusal`. */
class LibraryRefusal extends LibraryError {
  override name = 'LibraryRefusal'

  /**
   * @param message - the refusal in English.
   * @param refusal - why the game does not start.
   */
  constructor(message: string, readonly refusal: WasdLibraryRefusal) {
    super(message)
  }
}

/** A game the library starts, with the environment entries it adds. */
export interface GameCommand {
  /** The platform of the game's build, which decides how it starts. */
  readonly platform: WasdDesktopPlatform
  /** Absolute path of what starts the game: the `.app` bundle of a macOS build, the `.exe` of a Windows build. */
  readonly program: string
  /** Absolute folder of the game's build: a Windows game's working folder. */
  readonly cwd: string
  /** The game's own environment entries, each named `WASD_*`: what the library hands an online game. */
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
   * Start a game as a process of its own that outlives the app, with the user's own environment and permissions rather
   * than the app's, plus the command's `WASD_*` entries.
   * @param command - what starts the game, its folder, and its environment entries.
   * @returns once the game started.
   */
  readonly start: (command: GameCommand) => Promise<void>
  /** @returns the current time. */
  readonly now: () => Date
  /**
   * Waits in milliseconds between the attempts of a file operation that the system refuses for a moment;
   * {@link FILE_RETRY_MS} without it.
   */
  readonly retryDelaysMs?: readonly number[]
}

/** This computer's platform of desktop builds, or undefined where the site has none. */
function platformOf(system: NodeJS.Platform): WasdDesktopPlatform | undefined {
  if (system === 'darwin') return 'macos'
  return system === 'win32' ? 'windows' : undefined
}

/** The platforms' names as messages write them. */
const PLATFORM_NAMES: Readonly<Record<WasdDesktopPlatform, string>> = { windows: 'Windows', macos: 'macOS' }

/** The error code of a failed file operation, or '' for another failure. */
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? ''
}

/** A JSON text's value, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    // Not JSON: no value.
    return undefined
  }
}

/** An installed game as the view shows it. */
function present(game: InstalledGame): WasdLibraryGame {
  const offered = game.checkedAt !== undefined && game.availability === undefined
  const update = offered && game.installable !== undefined && game.installable > game.version ? game.installable : undefined
  const missing = game.latestVersion > game.version && game.installable !== game.latestVersion
  const unavailable = offered && missing ? game.latestVersion : undefined
  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    version: game.version,
    latestVersion: game.latestVersion,
    ...update === undefined ? {} : { updateVersion: update },
    ...unavailable === undefined ? {} : { unavailableVersion: unavailable },
    ...game.availability === undefined ? {} : { availability: game.availability },
    ...game.multiplayer === undefined ? {} : { multiplayer: game.multiplayer },
    platform: game.platform,
    bytes: game.bytes,
    installedAt: game.installedAt,
    ...game.coverUrl === undefined ? {} : { coverUrl: game.coverUrl },
  }
}

/** An installed game with the site's answer about its latest version, which says the site offers it. */
function noted(game: InstalledGame, entry: LibraryJson, checkedAt: string): InstalledGame {
  const build = entry.downloads.find(download => download.platform === game.platform)
  return {
    ...game,
    slug: SLUG.test(entry.game.slug) ? entry.game.slug : game.slug,
    title: entry.game.title,
    coverUrl: entry.game.cover_url ?? undefined,
    latestVersion: entry.game.latest_version,
    installable: build?.status === 'clean' ? build.version : undefined,
    availability: undefined,
    checkedAt,
  }
}

/** The library of one Desktop app. */
export class GameLibrary {
  private readonly games = new Map<string, InstalledGame>()
  /** Entries of `games.json` this version cannot read, which every save keeps as they are. */
  private readonly unreadable = new Map<string, unknown>()
  /** Whether `games.json` could be read, so that a game folder no entry names is a leftover. */
  private listed = true
  private readonly tasks = new Map<string, WasdLibraryTask>()
  /** The install of each game address under way, with the version it asked for; undefined asked for the latest. */
  private readonly running = new Map<string, { readonly version: number | undefined; readonly done: Promise<InstalledGame> }>()
  /** The Uninstall of each game id under way. */
  private readonly removing = new Map<string, Promise<WasdLibraryOutcome>>()
  private readonly followers = new Set<() => void>()
  private loaded: Promise<void> | undefined
  private saving: Promise<void> = Promise.resolve()
  private checking: Promise<void> | undefined

  /**
   * @param dependencies - files, the site, unpacking, and starting games.
   * @param lifetime - aborts every download and check when the plugin is disposed.
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
      .map(present)
    return { games, tasks: [...this.tasks.values()], supported: platformOf(this.dependencies.system) !== undefined }
  }

  /**
   * Follow the library. Following starts a check of the installed games that the site has not answered about for ten
   * minutes, so the view shows updates and games the site no longer offers.
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
    this.checkAll()
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
   * A request for the version that is installing already joins that install; one for another version is refused.
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
    const running = this.running.get(slug)
    if (running !== undefined && running.version !== version) return Promise.resolve({ ok: false, message: BUSY })
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
   * Start an installed game. The library asks the site about the game first: a game WASD Engine took down never
   * starts, one its creator removed starts only with `anyway`, and offline the site's last answer decides. An online
   * game installs the site's newer version first, and refuses while that version has no build for this computer; a
   * single-player game starts at its version. Once the game started, the site counts a play of it, in the background.
   * An Uninstall that begins before the game starts wins: the game does not start.
   * @param id - the game's id.
   * @param signal - stops waiting; an update the start began goes on.
   * @param anyway - the player confirmed starting a game its creator removed, which then starts without online play.
   * @returns once the game started, or why it did not.
   */
  async launch(id: string, signal: AbortSignal, anyway = false): Promise<WasdLibraryOutcome> {
    await this.load()
    const installed = this.games.get(id)
    if (installed === undefined || this.removing.has(id)) return { ok: false, message: NOT_INSTALLED }
    try {
      const { game, online } = await this.startable(installed, anyway, signal)
      const env = online ? await this.playEnvironment(game, signal) : {}
      const folder = join(this.dependencies.root, game.folder)
      const kept = (): boolean => this.games.get(id)?.folder === game.folder && !this.removing.has(id)
      if (!kept()) return { ok: false, message: UNINSTALLED }
      const program = await this.program(game, folder)
      if (!kept()) return { ok: false, message: UNINSTALLED }
      await this.dependencies.start({ platform: game.platform, program, cwd: folder, env })
      this.countPlay(game)
      // A game uninstalled while it started is not listed again.
      await this.update(id, entry => ({ ...entry, startedAt: this.dependencies.now().toISOString() }))
      return { ok: true }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof LibraryRefusal) return { ok: false, message: error.message, refusal: error.refusal }
      return { ok: false, message: error instanceof LibraryError ? error.message : `The game did not start: ${(error as Error).message}` }
    }
  }

  /**
   * Delete an installed game and its files. The game's folder moves aside first, so a game whose files the system
   * holds, such as one that is running on Windows, stays installed and whole; the library forgets the game once its
   * files are gone.
   * @param id - the game's id.
   * @returns whether it was deleted, or why not.
   */
  async remove(id: string): Promise<WasdLibraryOutcome> {
    await this.load()
    const game = this.games.get(id)
    if (game === undefined) return { ok: true }
    if (this.running.has(game.slug)) return { ok: false, message: 'The game is installing; uninstall it once that ends.' }
    const pending = this.removing.get(id)
    if (pending !== undefined) return await pending
    const removal = this.uninstall(game)
    this.removing.set(id, removal)
    try {
      return await removal
    } finally {
      this.removing.delete(id)
    }
  }

  /**
   * The installed game as it may start, and whether it plays online, from the site's answer about its latest version:
   * an online game installs that version first.
   * @throws LibraryRefusal when the game may not start; LibraryError when an online game cannot reach the site.
   */
  private async startable(
    game: InstalledGame, anyway: boolean, signal: AbortSignal,
  ): Promise<{ readonly game: InstalledGame; readonly online: boolean }> {
    const answer = await this.check(game, signal)
    const current = this.games.get(game.id) ?? game
    switch (answer.kind) {
      case 'taken_down':
        throw this.refuse(current, { reason: 'taken_down' })
      case 'removed':
        if (!anyway) throw this.refuse(current, { reason: 'removed' })
        // Confirmed: it starts as it is, and a removed game has no online play left.
        return { game: current, online: false }
      case 'unreachable':
        // Offline, the site's last answer decides.
        if (current.availability === 'taken_down') throw this.refuse(current, { reason: 'taken_down' })
        if (current.availability === 'removed') {
          if (!anyway) throw this.refuse(current, { reason: 'removed' })
          return { game: current, online: false }
        }
        // A single-player game plays offline; an online game needs the site anyway.
        if (current.multiplayer === undefined) return { game: current, online: false }
        throw new LibraryError(answer.message)
      case 'found': {
        const { release, downloads } = answer.entry
        const online = (release.multiplayer ?? undefined) !== undefined || current.multiplayer !== undefined
        if (!online || release.version <= current.version) return { game: current, online: current.multiplayer !== undefined }
        // An online game plays only at its latest version, the one lobbies and servers accept.
        const build = downloads.find(download => download.platform === current.platform)
        if (build?.version === release.version && build.status === 'clean') {
          const updated = await withSignal(this.installing(current.slug, undefined), signal)
          return { game: updated, online: updated.multiplayer !== undefined }
        }
        if (build?.version === release.version && build.status === 'pending') {
          throw new LibraryError(`The ${PLATFORM_NAMES[current.platform]} build of version ${String(release.version)} of ${current.title} is still being scanned for malware. Try again in a few minutes.`)
        }
        throw this.refuse(current, { reason: 'unavailable', version: release.version })
      }
      default:
        throw new Error(`unexpected site answer ${JSON.stringify(answer satisfies never)}`)
    }
  }

  /** The refusal to start a game, in English. */
  private refuse(game: InstalledGame, refusal: WasdLibraryRefusal): LibraryRefusal {
    switch (refusal.reason) {
      case 'taken_down':
        return new LibraryRefusal(`WASD Engine took ${game.title} down, so it no longer starts. You can uninstall it.`, refusal)
      case 'removed':
        return new LibraryRefusal(`The creator of ${game.title} removed it from WASD Engine. Choose Play anyway to start it, or uninstall it.`, refusal)
      case 'unavailable':
        return new LibraryRefusal(`Version ${String(refusal.version)} of ${game.title} has no ${PLATFORM_NAMES[game.platform]} download yet, and online play needs the latest version.`, refusal)
      default:
        throw new Error(`unexpected refusal ${JSON.stringify(refusal satisfies never)}`)
    }
  }

  /**
   * Ask the site about an installed game's latest version and note its answer: what it offers this computer, or that
   * it no longer offers the game. An answer about another game at the game's address means the game is gone.
   */
  private async check(game: InstalledGame, signal: AbortSignal): Promise<SiteAnswer> {
    const asked = await this.lookup(game.origin, game.slug, undefined, signal)
    const answer: SiteAnswer = asked.kind === 'found' && asked.entry.game.id !== game.id ? { kind: 'removed' } : asked
    const checkedAt = this.dependencies.now().toISOString()
    if (answer.kind === 'found') await this.update(game.id, entry => noted(entry, answer.entry, checkedAt))
    else if (answer.kind !== 'unreachable') await this.update(game.id, entry => ({ ...entry, availability: answer.kind, checkedAt }))
    return answer
  }

  /**
   * Ask the site, one game at a time and in the background, about each installed game it has not answered about for
   * {@link CHECK_MS}, games installed meanwhile included; the run stops at the first game the site does not answer.
   */
  private checkAll(): void {
    if (this.checking !== undefined || platformOf(this.dependencies.system) === undefined) return
    this.checking = (async () => {
      await this.load()
      const asked = new Set<string>()
      for (;;) {
        if (this.lifetime.aborted) return
        const game = [...this.games.values()].find(entry => !asked.has(entry.id) && !this.running.has(entry.slug)
          && !this.removing.has(entry.id) && !this.recentlyChecked(entry))
        if (game === undefined) return
        asked.add(game.id)
        if ((await this.check(game, this.lifetime)).kind === 'unreachable') return
      }
    })().catch(() => {
      // Disposal aborted the check, or games.json could not be written: the next check asks again.
    }).finally(() => {
      this.checking = undefined
    })
  }

  /** Whether the site answered about a game's latest version within {@link CHECK_MS}. */
  private recentlyChecked(game: InstalledGame): boolean {
    if (game.checkedAt === undefined) return false
    const age = this.dependencies.now().getTime() - Date.parse(game.checkedAt)
    return age >= 0 && age < CHECK_MS
  }

  /**
   * Tell the game's site that the game started, which counts a play of it there. The request carries the signed-in
   * account's token when the app is signed in to that site, so the site leaves out the creator's own plays. It runs in
   * the background and its failures are dropped: the game is running already, and a play the site never hears of,
   * such as one offline, stays uncounted.
   */
  private countPlay(game: InstalledGame): void {
    void (async () => {
      const access = await this.dependencies.access()
      const token = access?.origin === game.origin ? access.token : ''
      const response = await this.dependencies.fetch(new URL(`/api/v1/library/games/${game.slug}/plays`, game.origin), {
        method: 'POST',
        redirect: 'error',
        signal: this.lifetime,
        headers: token === '' ? {} : { 'x-dsh-auth-token': token },
      })
      await response.body?.cancel()
    })().catch(() => {
      // A failed request, such as one to an unreachable site or one the plugin's disposal aborts, costs one play in
      // the site's figures; the game is running already.
    })
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

  /** What starts a game: its `.app` bundle, which holds a program, or its `.exe`. */
  private async program(game: InstalledGame, folder: string): Promise<string> {
    const program = join(folder, game.program)
    const found = game.platform === 'macos'
      ? await readdir(join(program, 'Contents', 'MacOS'), { withFileTypes: true })
        .then(entries => entries.some(entry => entry.isFile() || entry.isSymbolicLink()), () => false)
      : await stat(program).then(info => info.isFile(), () => false)
    if (!found) throw new LibraryError(DAMAGED)
    return program
  }

  /**
   * One install of a game at a time: a second request for the same version joins the first, and one for another
   * version is refused. The task leaves the view once the install has ended and cleaned up, so a game the view lists
   * is no longer installing.
   */
  private installing(slug: string, version: number | undefined): Promise<InstalledGame> {
    const pending = this.running.get(slug)
    if (pending !== undefined) return pending.version === version ? pending.done : Promise.reject(new LibraryError(BUSY))
    const done = this.download(slug, version).then((installed) => {
      this.running.delete(slug)
      this.tasks.delete(slug)
      this.notify()
      // An earlier version's answer did not say what this computer can install of the latest one.
      if (installed.checkedAt === undefined) this.checkAll()
      return installed
    }, (error: unknown) => {
      this.running.delete(slug)
      throw error
    })
    this.running.set(slug, { version, done })
    return done
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
      const answer = await this.lookup(origin, slug, version, signal)
      if (answer.kind === 'unreachable') throw new LibraryError(answer.message)
      if (answer.kind === 'removed') {
        await this.gone(origin, slug, 'removed')
        throw new LibraryError('WASD Engine has no such game, or it was removed.')
      }
      if (answer.kind === 'taken_down') {
        await this.gone(origin, slug, 'taken_down')
        throw new LibraryError('WASD Engine took this game down, so it no longer installs.')
      }
      const { game, release, downloads } = answer.entry
      // Named as soon as the site answers, so a download that fails on its build still shows the game.
      const named = {
        slug, title: game.title, version: release.version,
        ...game.cover_url === undefined || game.cover_url === null ? {} : { coverUrl: game.cover_url },
      }
      this.setTask({ ...named, state: 'downloading', receivedBytes: 0, totalBytes: 0 })
      // An Uninstall of the game that is under way ends first.
      await this.removing.get(game.id)
      const where = PLATFORM_NAMES[platform]
      const build = downloads.find(download => download.platform === platform)
      // An online game plays only at its latest version, so an earlier version's build is no use to it.
      if ((release.multiplayer ?? undefined) !== undefined && build?.version !== release.version) {
        throw new LibraryError(`Version ${String(release.version)} of ${game.title} has no ${where} download yet, and online play needs the latest version.`)
      }
      if (build?.status === 'pending') {
        throw new LibraryError(`The ${where} build of ${game.title} is still being scanned for malware. Try again in a few minutes.`)
      }
      if (build?.status !== 'clean') throw new LibraryError(`${game.title} has no ${where} download.`)
      if (build.bytes > MAX_BUILD_BYTES) throw new LibraryError(`The ${where} build of ${game.title} is too large to install.`)
      // The download is checked against the digest as the site names it; only a well-formed one is recorded.
      const digest = build.sha256?.toLowerCase()
      const sha256 = digest !== undefined && SHA256.test(digest) ? digest : undefined
      const checkedAt = this.dependencies.now().toISOString()
      // An answer about the latest version also says what this computer can install now.
      const latest = release.version === game.latest_version
      const known = latest ? { installable: build.version, checkedAt } : {}
      const earlier = this.games.get(game.id)
      // A digest either side lacks cannot tell two builds of one version apart, so the version decides.
      const sameDigest = earlier?.sha256 === undefined || sha256 === undefined || earlier.sha256 === sha256
      if (earlier !== undefined && earlier.version === build.version && sameDigest && await this.intact(earlier)) {
        // The build is installed already: nothing downloads again, and the site offers the game again.
        const kept: InstalledGame = {
          ...earlier, title: game.title, coverUrl: game.cover_url ?? undefined, latestVersion: game.latest_version,
          availability: undefined, ...known,
        }
        await this.record(kept)
        return kept
      }
      const progress = { ...named, version: build.version, totalBytes: build.bytes }
      this.setTask({ ...progress, state: 'downloading', receivedBytes: 0 })
      const gameRoot = join(this.dependencies.root, game.id)
      await mkdir(gameRoot, { recursive: true })
      staging = join(gameRoot, `.download-${randomUUID()}.zip`)
      await this.fetchBuild(new URL(build.url, origin).href, build.bytes, digest, staging, progress, signal)
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
      if (program === undefined) throw new LibraryError(`The ${where} build of ${game.title} holds no game to start.`)
      const folder = join(gameRoot, String(build.version))
      const swap = await this.swapIn(unpacked, folder).catch((error: unknown) => {
        const message = HELD_FILE_CODES.has(errorCode(error))
          ? `The new files of ${game.title} could not replace its old ones, because the system is using them. Quit the game if it is running, then try again.`
          : `The new files of ${game.title} could not replace its old ones: ${(error as Error).message}`
        throw new LibraryError(message, { cause: error })
      })
      unpacked = undefined
      const multiplayer = release.multiplayer ?? undefined
      const previous = this.games.get(game.id)
      const installed: InstalledGame = {
        id: game.id,
        slug: SLUG.test(game.slug) ? game.slug : slug,
        title: game.title,
        version: build.version,
        latestVersion: game.latest_version,
        ...latest ? { installable: build.version, checkedAt } : {},
        ...multiplayer === undefined ? {} : { multiplayer },
        platform,
        bytes: build.bytes,
        ...sha256 === undefined ? {} : { sha256 },
        installedAt: this.dependencies.now().toISOString(),
        ...game.cover_url === undefined || game.cover_url === null ? {} : { coverUrl: game.cover_url },
        origin,
        folder: join(game.id, String(build.version)),
        program,
        ...previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt },
      }
      try {
        await this.record(installed)
      } catch (error) {
        // The file still lists the game as it was, so its files go back too.
        if (previous === undefined) this.games.delete(game.id)
        else this.games.set(game.id, previous)
        await swap.rollback()
        throw error
      }
      await swap.commit()
      // The earlier version's folder goes once the new one is recorded; one the system holds goes at the next start.
      await this.clear(gameRoot, String(build.version))
      return installed
    } catch (error) {
      const message = error instanceof LibraryError ? error.message : `${slug} could not be installed: ${(error as Error).message}`
      // The failure shows once this install's download and unpacked files are gone.
      if (staging !== undefined) await this.discard(staging)
      if (unpacked !== undefined) await this.discard(unpacked)
      staging = undefined
      unpacked = undefined
      const failed = this.tasks.get(slug)
      this.setTask({
        slug, title: failed?.title ?? slug, version: failed?.version ?? 0, state: 'failed', receivedBytes: 0, totalBytes: 0, message,
        ...failed?.coverUrl === undefined ? {} : { coverUrl: failed.coverUrl },
      })
      throw error instanceof LibraryError ? error : new LibraryError(message, { cause: error })
    } finally {
      if (staging !== undefined) await this.discard(staging)
      if (unpacked !== undefined) await this.discard(unpacked)
    }
  }

  /** Note on the installed game at an address of a site that the site no longer offers it. */
  private async gone(origin: string, slug: string, availability: WasdLibraryAvailability): Promise<void> {
    const game = [...this.games.values()].find(entry => entry.slug === slug && entry.origin === origin)
    const checkedAt = this.dependencies.now().toISOString()
    if (game !== undefined) await this.update(game.id, entry => ({ ...entry, availability, checkedAt }))
  }

  /** Whether an installed game's program is still in its folder. */
  private intact(game: InstalledGame): Promise<boolean> {
    return stat(join(this.dependencies.root, game.folder, game.program)).then(() => true, () => false)
  }

  /** The site's library answer for a game. */
  private async lookup(origin: string, slug: string, version: number | undefined, signal: AbortSignal): Promise<SiteAnswer> {
    const url = new URL(`/api/v1/library/games/${slug}`, origin)
    if (version !== undefined) url.searchParams.set('v', String(version))
    let response: Response
    try {
      response = await this.dependencies.fetch(url, { redirect: 'error', signal })
    } catch (error) {
      signal.throwIfAborted()
      return { kind: 'unreachable', message: `Cannot reach WASD Engine at ${origin}: ${(error as Error).message}` }
    }
    // 404: its creator removed the game, or it never existed; 410: WASD Engine took it down.
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel()
      return { kind: response.status === 404 ? 'removed' : 'taken_down' }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { kind: 'unreachable', message: `WASD Engine could not find the game's downloads (HTTP ${String(response.status)}). Try again later.` }
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      signal.throwIfAborted()
      return { kind: 'unreachable', message: `Cannot reach WASD Engine at ${origin}: ${(error as Error).message}` }
    }
    const parsed = LibraryJson.safeParse(parseJson(text))
    if (!parsed.success) return { kind: 'unreachable', message: 'WASD Engine answered in an unexpected way about the game\'s downloads.' }
    if (parsed.data.game.downloads_blocked === true) return { kind: 'taken_down' }
    return { kind: 'found', entry: parsed.data }
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
    if (sha256 !== undefined && digest.digest('hex') !== sha256) {
      throw new LibraryError(`The download of ${progress.title} is damaged. Try again.`)
    }
  }

  /**
   * Put the folder `staged` at `target`. A folder at `target` moves aside first and comes back when the move fails, so
   * the game keeps the files it had; the returned swap then deletes the folder that moved aside, or puts it back.
   */
  private async swapIn(staged: string, target: string): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
    const aside = join(dirname(target), `.old-${randomUUID()}`)
    const moved = await this.retrying(() => rename(target, aside)).then(() => true, (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    })
    try {
      await this.retrying(() => rename(staged, target))
    } catch (error) {
      if (moved) await this.restore(aside, target)
      throw error
    }
    return {
      commit: () => moved ? this.discard(aside) : Promise.resolve(),
      rollback: async () => {
        await this.discard(target)
        if (moved) await this.restore(aside, target)
      },
    }
  }

  /** Move a folder that moved aside back to `target`; one the system still holds stays aside for the next start's sweep. */
  private async restore(aside: string, target: string): Promise<void> {
    try {
      await this.retrying(() => rename(aside, target))
    } catch {
      // Held by the system still: the game reports damaged files until it is installed again.
    }
  }

  /** Delete the earlier versions' folders of a game; the folders of work under way, which start with `.`, stay. */
  private async clear(gameRoot: string, keep: string): Promise<void> {
    for (const entry of await readdir(gameRoot).catch(() => [] as string[])) {
      if (entry !== keep && !entry.startsWith('.')) await this.discard(join(gameRoot, entry))
    }
  }

  /** Delete a file or folder of the library; one the system still holds stays for the sweep at the library's next start. */
  private async discard(path: string): Promise<void> {
    try {
      await this.retrying(() => rm(path, { recursive: true, force: true }))
    } catch {
      // Held by the system still: the next start's sweep deletes it.
    }
  }

  /** Run a rename or deletion, again after short waits while the system holds the file. */
  private async retrying<T>(operation: () => Promise<T>): Promise<T> {
    const delays = this.dependencies.retryDelaysMs ?? FILE_RETRY_MS
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation()
      } catch (error) {
        const delay = delays[attempt]
        if (delay === undefined || !HELD_FILE_CODES.has(errorCode(error))) throw error
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  /** Move a game's folder aside, delete it, then forget the game. */
  private async uninstall(game: InstalledGame): Promise<WasdLibraryOutcome> {
    const folder = join(this.dependencies.root, game.id)
    const trash = join(this.dependencies.root, `.trash-${randomUUID()}`)
    try {
      await this.retrying(() => rename(folder, trash))
    } catch (error) {
      const code = errorCode(error)
      if (HELD_FILE_CODES.has(code)) {
        return { ok: false, message: `WASD Engine could not delete the files of ${game.title}, because the system is using them. Quit the game if it is running, then try again.` }
      }
      // ENOENT: the files are gone already.
      if (code !== 'ENOENT') return { ok: false, message: `WASD Engine could not delete the files of ${game.title}: ${(error as Error).message}` }
    }
    await this.discard(trash)
    this.games.delete(game.id)
    await this.save()
    this.notify()
    return { ok: true }
  }

  private setTask(task: WasdLibraryTask): void {
    this.tasks.set(task.slug, task)
    this.notify()
  }

  /** Record a game and save the file; the view follows. */
  private async record(game: InstalledGame): Promise<void> {
    this.games.set(game.id, game)
    this.unreadable.delete(game.id)
    await this.save()
    this.notify()
  }

  /** Change an installed game's entry while the game is installed, and save the file when the entry changed. */
  private async update(id: string, change: (game: InstalledGame) => InstalledGame): Promise<void> {
    const current = this.games.get(id)
    if (current === undefined) return
    const next = change(current)
    if (JSON.stringify(next) !== JSON.stringify(current)) await this.record(next)
  }

  /** Read `games.json`, then delete what interrupted work left in the library's folder; a failed read runs again next time. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await this.read()
      await this.sweep()
    })().catch((error: unknown) => {
      this.loaded = undefined
      throw error
    })
    return this.loaded
  }

  /**
   * Read `games.json` entry by entry. An entry this version cannot read stays in the file as it is, and its game's
   * folder stays; a file it cannot read at all moves to `games.json.unreadable-<time>`, so the next save does not
   * erase it, and the library starts empty.
   */
  private async read(): Promise<void> {
    const file = join(this.dependencies.root, 'games.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    const parsed = GamesFile.safeParse(parseJson(text))
    if (!parsed.success) {
      this.listed = false
      const stamp = this.dependencies.now().toISOString().replace(/[:.]/gu, '-')
      await this.retrying(() => rename(file, `${file}.unreadable-${stamp}`))
      return
    }
    for (const [id, value] of Object.entries(parsed.data.games)) {
      const game = InstalledGame.safeParse(value)
      if (game.success && game.data.id === id) this.games.set(id, game.data)
      else this.unreadable.set(id, value)
    }
  }

  /**
   * Delete what interrupted work left in the library's folder: unfinished saves of `games.json`, game folders an
   * Uninstall moved aside, downloads, unpacked builds, and folders a swap moved aside, the earlier versions of installed
   * games, and the folders of games the library does not list. Folders of entries it cannot read stay, and so do the
   * game folders while `games.json` could not be read.
   */
  private async sweep(): Promise<void> {
    const root = this.dependencies.root
    for (const entry of await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])) {
      const path = join(root, entry.name)
      if (TRASH.test(entry.name) || UNFINISHED_SAVE.test(entry.name)) {
        await this.discard(path)
        continue
      }
      if (!entry.isDirectory() || !GAME_ID.test(entry.name) || this.unreadable.has(entry.name)) continue
      const game = this.games.get(entry.name)
      if (game === undefined && this.listed) {
        await this.discard(path)
        continue
      }
      const keep = game === undefined ? undefined : basename(game.folder)
      for (const inner of await readdir(path).catch(() => [] as string[])) {
        // A game the library does not know of keeps its folders while games.json could not be read; its temporaries go.
        if (inner !== keep && (game !== undefined || inner.startsWith('.'))) await this.discard(join(path, inner))
      }
    }
  }

  /** Write `games.json` whole and rename it into place, one write at a time, with the entries it could not read. */
  private save(): Promise<void> {
    const games = { ...Object.fromEntries(this.unreadable), ...Object.fromEntries(this.games) }
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await mkdir(this.dependencies.root, { recursive: true })
      const file = join(this.dependencies.root, 'games.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify({ format: 1, games }, null, 2)}\n`)
      await this.retrying(() => rename(temporary, file))
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
