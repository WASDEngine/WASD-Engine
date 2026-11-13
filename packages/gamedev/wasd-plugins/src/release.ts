/**
 * Releases: a Godot project's Web build, uploaded to the WASD Engine site the app is signed in to as the next
 * numbered version (1, 2, 3, ...) of the project's game, where its share page plays it, offers earlier versions, and
 * holds comments. Calls go to the site's games API (`/api/v1/games`) with the signed-in token in `x-dsh-auth-token`
 * and never follow redirects. A project remembers each account's game per site in `.wasdengine/game.json` from the
 * moment the site creates the game, before the upload, so later releases add versions to the same game, also after a
 * release whose upload failed; when the site no longer has that game, the release creates a new one, and another
 * account signed in to the same site gets a game of its own. A copy of a project folder carries that link, so a
 * release from a folder that shares its game with another folder on this computer asks first (`folders.ts`). The Web
 * build itself goes to `.wasdengine/web/`, which Godot does not import because the folder is hidden.
 * @module @deepseek-ai/dsh-wasd-plugins/src/release
 */
import { createHash, randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import { z } from 'zod'
import { folderOf, type ReleaseFolders } from './folders.ts'
import type { WasdProjectView, WasdRelease } from './types.ts'
import { writeZip } from './zip.ts'

/** Folder, inside a project, of the state WASD Engine keeps for it; hidden, so Godot ignores it. */
export const STATE_DIR = '.wasdengine'

/** The Web build's folder inside {@link STATE_DIR}. */
export const WEB_BUILD_DIR = 'web'

/** The game link file inside {@link STATE_DIR}. */
export const LINK_FILE = 'game.json'

/** Longest release notes the site keeps; they travel in the upload's query string. */
export const MAX_NOTES = 1000

/** Longest game title the site keeps. */
export const MAX_TITLE = 80

/** Image types the site takes as a cover, by file extension. */
const COVER_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** The signed-in site: its origin and the account's token. */
export interface SiteAccess {
  /** Origin of the WASD Engine site, such as `https://app.wasdengine.com`. */
  readonly origin: string
  /** The signed-in account's token. */
  readonly token: string
  /** {@link accountKey} of the signed-in account, when the app knows the account's ID. */
  readonly account?: string
}

/** A release that could not finish; the message says what the user or the agent can do. */
export class ReleaseError extends Error {
  override name = 'ReleaseError'
}

const GameRecord = z.object({ id: z.string(), slug: z.string(), title: z.string(), url: z.string(), version: z.number().int().min(0) })
type GameRecord = z.infer<typeof GameRecord>
// One account's game on one site; `account` is absent when the release did not know its account.
const AccountGame = GameRecord.extend({ account: z.string().optional() })
type AccountGame = z.infer<typeof AccountGame>
const LinkFile = z.object({
  format: z.literal(1),
  // The game of each site's latest release: what versions before per-account links read and write.
  games: z.record(z.string(), GameRecord),
  // Each account's game on each site, the latest release first.
  accounts: z.record(z.string(), z.array(AccountGame)).optional(),
})
type LinkFile = z.infer<typeof LinkFile>

const GameJson = z.object({ id: z.string(), slug: z.string(), title: z.string(), url: z.string(), latest_version: z.number().int() })
type GameJson = z.infer<typeof GameJson>
const ReleaseJson = z.object({
  game: GameJson,
  release: z.object({ version: z.number().int(), url: z.string(), play_url: z.string(), total_bytes: z.number().int() }),
})
const ErrorJson = z.object({ error: z.object({ message: z.string() }) })

function linkPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, LINK_FILE)
}

async function readLinks(projectDir: string): Promise<LinkFile> {
  let text: string
  try {
    text = await readFile(linkPath(projectDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 1, games: {} }
    throw error
  }
  try {
    const parsed = LinkFile.safeParse(JSON.parse(text))
    // A damaged link file only means the next release creates a new game.
    return parsed.success ? parsed.data : { format: 1, games: {} }
  } catch {
    // Not JSON: as damaged.
    return { format: 1, games: {} }
  }
}

/**
 * The fingerprint of an account in the link file, which a project may share through version control, so the file
 * holds no account ID.
 * @param userId - the account's ID on the site.
 * @returns the first 24 hexadecimal digits of the ID's SHA-256 digest.
 */
export function accountKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 24)
}

// A link file written before per-account links holds one game per site, without its account.
function siteGames(links: LinkFile, origin: string): AccountGame[] {
  const latest = links.games[origin]
  return links.accounts?.[origin] ?? (latest === undefined ? [] : [latest])
}

// One account's game without asking the site: its own, else one whose release did not know its account; the latest
// release's game when the account is unknown.
function accountGame(games: readonly AccountGame[], account: string | undefined): AccountGame | undefined {
  return account === undefined ? games[0] : games.find(game => game.account === account) ?? games.find(game => game.account === undefined)
}

/**
 * The game a project released to on one site.
 * @param projectDir - absolute project folder.
 * @param origin - site origin.
 * @param account - {@link accountKey} of the account; undefined picks the game of the latest release.
 * @returns the remembered game, or undefined before the account's first release there.
 */
export async function linkedGame(projectDir: string, origin: string, account?: string): Promise<GameRecord | undefined> {
  return accountGame(siteGames(await readLinks(projectDir), origin), account)
}

async function linksTo(projectDir: string, origin: string, gameId: string): Promise<boolean> {
  try {
    return siteGames(await readLinks(projectDir), origin).some(game => game.id === gameId)
  } catch {
    // An unreadable link file links to no game.
    return false
  }
}

// The account's game becomes the site's latest and replaces the account's earlier game and the game's earlier entry.
async function rememberGame(projectDir: string, origin: string, record: AccountGame): Promise<void> {
  const links = await readLinks(projectDir)
  const replaces = (game: AccountGame) => game.id === record.id || (record.account !== undefined && game.account === record.account)
  const others = siteGames(links, origin).filter(game => !replaces(game))
  const latest: GameRecord = { id: record.id, slug: record.slug, title: record.title, url: record.url, version: record.version }
  await mkdir(join(projectDir, STATE_DIR), { recursive: true })
  await writeFile(linkPath(projectDir), `${JSON.stringify({
    format: 1,
    games: { ...links.games, [origin]: latest },
    accounts: { ...links.accounts, [origin]: [record, ...others] },
  }, null, 2)}\n`)
}

/**
 * Read `application/config/name` from `project.godot` text.
 * @param text - complete file content.
 * @returns the project name, or undefined when it is not a plain quoted string.
 */
export function projectName(text: string): string | undefined {
  let section = ''
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    const value = section === 'application' ? /^config\/name="((?:[^"\\]|\\.)*)"\s*$/u.exec(line)?.[1] : undefined
    if (value !== undefined) return value.replace(/\\(.)/gu, '$1').trim() || undefined
  }
  return undefined
}

/**
 * What the Release button shows for a project folder.
 * @param projectDir - absolute folder.
 * @param origin - site origin the app is signed in to, or would sign in to.
 * @param folders - which folders on this computer released each game.
 * @param account - {@link accountKey} of the signed-in account; undefined shows the game of the latest release.
 * @returns whether it is a Godot project, the account's game on that site, and the folder this one shares it with.
 */
export async function projectView(projectDir: string, origin: string, folders: ReleaseFolders, account?: string): Promise<WasdProjectView> {
  let godot = false
  try {
    godot = (await stat(join(projectDir, 'project.godot'))).isFile()
  } catch {
    // A folder without project.godot is not a Godot project.
  }
  const game = await linkedGame(projectDir, origin, account)
  if (game === undefined || game.version === 0) return { godot }
  const other = await folders.sharedWith(origin, game.id, await folderOf(projectDir), dir => linksTo(dir, origin, game.id))
  return { godot, game: { title: game.title, url: game.url, version: game.version }, ...other === undefined ? {} : { sharedWith: other } }
}

/**
 * The failure of a release from a project folder that shares its game with another folder, as a copy does, and has not
 * said which game it releases.
 * @param other - the other folder.
 * @param game - the game both folders link to.
 * @returns the question for the model to ask the user, and how to answer it.
 */
export function copyQuestion(other: string, game: { readonly title: string; readonly url: string }): string {
  return `This project folder and ${other} release the same game, "${game.title}" (${game.url}), as happens when one is a copy of the other. Ask the user whether this folder should release the next version of that game or start a new game, then call wasd_release_game again with new_game false for the next version of that game, or new_game true for a new game.`
}

/** The site's games API as one release calls it. */
class SiteApi {
  constructor(private readonly access: SiteAccess, private readonly fetchUrl: typeof fetch, private readonly signal: AbortSignal) {}

  private async call(method: string, path: string, body?: { readonly data: BodyInit; readonly type: string }): Promise<Response> {
    const url = new URL(path, this.access.origin)
    try {
      return await this.fetchUrl(url, {
        method,
        redirect: 'error',
        signal: this.signal,
        headers: { 'x-dsh-auth-token': this.access.token, ...body === undefined ? {} : { 'content-type': body.type } },
        ...body === undefined ? {} : { body: body.data },
      })
    } catch (error) {
      if (this.signal.aborted) throw error
      throw new ReleaseError(`Cannot reach WASD Engine at ${this.access.origin}: ${(error as Error).message}`, { cause: error })
    }
  }

  private async failure(response: Response, doing: string): Promise<ReleaseError> {
    let message: string | undefined
    try {
      const parsed = ErrorJson.safeParse(await response.json())
      if (parsed.success) message = parsed.data.error.message
    } catch {
      // Not a JSON error body: the status alone explains it.
    }
    if (response.status === 401) return new ReleaseError('The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then release again.')
    if (response.status >= 500 || message === undefined) return new ReleaseError(`WASD Engine could not ${doing} (HTTP ${response.status}). Try again later.`)
    return new ReleaseError(`WASD Engine could not ${doing}: ${message}`)
  }

  private async json<T>(response: Response, schema: z.ZodType<T>, doing: string): Promise<T> {
    if (!response.ok) throw await this.failure(response, doing)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new ReleaseError(`WASD Engine answered in an unexpected way while trying to ${doing}.`)
    return parsed.data
  }

  async game(id: string): Promise<GameJson | undefined> {
    const response = await this.call('GET', `/api/v1/games/${encodeURIComponent(id)}`)
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return (await this.json(response, z.object({ game: GameJson }), 'read the game')).game
  }

  async create(title: string): Promise<GameJson> {
    const response = await this.call('POST', '/api/v1/games', { data: JSON.stringify({ title }), type: 'application/json' })
    return (await this.json(response, z.object({ game: GameJson }), 'create the game')).game
  }

  async rename(id: string, title: string): Promise<GameJson> {
    const response = await this.call('PATCH', `/api/v1/games/${encodeURIComponent(id)}`, { data: JSON.stringify({ title }), type: 'application/json' })
    return (await this.json(response, z.object({ game: GameJson }), 'rename the game')).game
  }

  async release(id: string, archive: string, notes: string): Promise<z.infer<typeof ReleaseJson> | undefined> {
    const query = notes === '' ? '' : `?${new URLSearchParams({ notes }).toString()}`
    const response = await this.call('POST', `/api/v1/games/${encodeURIComponent(id)}/releases${query}`, { data: await openAsBlob(archive), type: 'application/zip' })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return await this.json(response, ReleaseJson, 'store the release')
  }

  async cover(id: string, image: string): Promise<void> {
    const type = COVER_TYPES[extname(image).toLowerCase()]
    if (type === undefined) throw new ReleaseError('cover_image must be a PNG, JPEG, or WebP file.')
    const response = await this.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/cover`, { data: await openAsBlob(image), type })
    await this.json(response, z.object({ game: GameJson }), 'store the cover image')
  }
}

/**
 * The game the signed-in account released a project to, as the site has it. The site answers only for the account's
 * own games, so the first linked game it answers for is the account's.
 */
async function ownedGame(api: SiteApi, games: readonly AccountGame[], account: string | undefined): Promise<GameJson | undefined> {
  // The account's own game first, then games whose release did not know their account; another account's would 404.
  const candidates = account === undefined
    ? games
    : [...games.filter(game => game.account === account), ...games.filter(game => game.account === undefined)]
  for (const linked of candidates) {
    const game = await api.game(linked.id)
    if (game !== undefined) return game
  }
  return undefined
}

/** What a release reads and changes. */
export interface ReleaseRequest {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Release notes for the game page; at most {@link MAX_NOTES} characters. */
  readonly notes?: string
  /** Title for a new game, or a new title for the existing one; at most {@link MAX_TITLE} characters. */
  readonly title?: string
  /** Absolute path of a PNG, JPEG, or WebP cover image. */
  readonly coverImage?: string
  /**
   * `true` releases the build as version 1 of a new game, which the project releases to from then on; `false` adds it
   * to the account's game the project released to before, also when another folder on this computer releases that
   * game, as a copy does. Undefined adds it to that game, but refuses such a folder with {@link copyQuestion}, so the
   * user decides.
   */
  readonly newGame?: boolean
}

/** What a release needs from its Host. */
export interface ReleaseDependencies {
  /** @returns the signed-in site, or undefined while the app is signed out. */
  readonly access: () => Promise<SiteAccess | undefined>
  /**
   * Export the project for the Web.
   * @param projectDir - absolute project folder.
   * @param outputDir - absolute folder the export fills.
   * @param signal - cancellation.
   * @returns the exported files.
   */
  readonly exportWeb: (projectDir: string, outputDir: string, signal: AbortSignal) => Promise<GodotWebExport>
  /** HTTP client of the site calls. */
  readonly fetch: typeof fetch
  /** Which folders on this computer released each game. */
  readonly folders: ReleaseFolders
  /** Absolute folder for the temporary upload archive. */
  readonly tempDir: string
}

/**
 * Export a project for the Web and release the build as the next version of the signed-in account's game, or as the
 * first version of a new game.
 * @param request - project, notes, title, cover, and whether to start a new game.
 * @param dependencies - sign-in, export, HTTP, release folders, and temporary files.
 * @param signal - cancellation; a version the site already stored stays released.
 * @returns the release and its share links.
 * @throws {ReleaseError} while signed out, for unusable arguments, for a folder that shares its game with another one
 * and has not said which game it releases ({@link copyQuestion}, before the export), and when the site refuses or fails.
 */
export async function releaseGame(request: ReleaseRequest, dependencies: ReleaseDependencies, signal: AbortSignal): Promise<WasdRelease> {
  const notes = (request.notes ?? '').trim()
  if (notes.length > MAX_NOTES) throw new ReleaseError(`notes must be at most ${MAX_NOTES} characters.`)
  const title = request.title?.trim()
  if (title !== undefined && (title === '' || title.length > MAX_TITLE)) throw new ReleaseError(`title must be 1 to ${MAX_TITLE} characters.`)
  if (request.coverImage !== undefined && COVER_TYPES[extname(request.coverImage).toLowerCase()] === undefined) {
    throw new ReleaseError('cover_image must be a PNG, JPEG, or WebP file.')
  }
  const access = await dependencies.access()
  if (access === undefined) throw new ReleaseError('WASD Engine is signed out, and releasing a game needs a signed-in account. Ask the user to sign in to WASD Engine, then release again.')
  const api = new SiteApi(access, dependencies.fetch, signal)
  const here = await folderOf(request.projectDir)
  const siteLinks = siteGames(await readLinks(request.projectDir), access.origin)
  let game = request.newGame === true ? undefined : await ownedGame(api, siteLinks, access.account)
  if (game !== undefined) {
    const id = game.id
    const other = request.newGame === false
      ? undefined
      : await dependencies.folders.sharedWith(access.origin, id, here, dir => linksTo(dir, access.origin, id))
    if (other !== undefined) throw new ReleaseError(copyQuestion(other, game))
    await dependencies.folders.add(access.origin, id, here)
  }
  const exported = await dependencies.exportWeb(request.projectDir, join(request.projectDir, STATE_DIR, WEB_BUILD_DIR), signal)
  const archive = join(dependencies.tempDir, `wasd-release-${randomUUID()}.zip`)
  try {
    await writeZip(exported.outputDir, exported.files.map(file => file.path), archive, signal)
    const name = title ?? projectName(await readFile(join(request.projectDir, 'project.godot'), 'utf8')) ?? basename(request.projectDir)
    const remember = (linked: GameJson, version: number): Promise<void> => rememberGame(request.projectDir, access.origin, {
      ...access.account === undefined ? {} : { account: access.account },
      id: linked.id, slug: linked.slug, title: linked.title, url: linked.url, version,
    })
    const create = async (): Promise<GameJson> => {
      const created = await api.create(name.slice(0, MAX_TITLE))
      // Linked before the upload: when the upload fails, or the call ends while the site still stores the build, the
      // next release adds its version to this game instead of creating another.
      await remember(created, created.latest_version)
      await dependencies.folders.add(access.origin, created.id, here)
      return created
    }
    if (game !== undefined && title !== undefined && game.title !== title) game = await api.rename(game.id, title)
    game ??= await create()
    let released = await api.release(game.id, archive, notes)
    if (released === undefined) {
      // The game was removed between the lookup and the upload: release to a new one.
      game = await create()
      released = await api.release(game.id, archive, notes)
      if (released === undefined) throw new ReleaseError('WASD Engine could not store the release: the new game disappeared. Try again.')
    }
    await remember(released.game, released.release.version)
    const warnings = [...exported.warnings]
    if (request.coverImage !== undefined) {
      try {
        await api.cover(released.game.id, request.coverImage)
      } catch (error) {
        if (!(error instanceof ReleaseError)) throw error
        warnings.push(`The version is released, but its cover image was not stored: ${error.message}`)
      }
    }
    return {
      title: released.game.title,
      version: released.release.version,
      url: released.release.url,
      gameUrl: released.game.url,
      playUrl: released.release.play_url,
      totalBytes: released.release.total_bytes,
      warnings,
    }
  } finally {
    await rm(archive, { force: true })
  }
}
