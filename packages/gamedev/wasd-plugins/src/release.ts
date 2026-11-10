/**
 * Releases: a Godot project's Web build, uploaded to the WASD Engine site the app is signed in to as the next
 * numbered version (1, 2, 3, ...) of the project's game, where its share page plays it, offers earlier versions, and
 * holds comments. Calls go to the site's games API (`/api/v1/games`) with the signed-in token in `x-dsh-auth-token`
 * and never follow redirects. A project remembers its game per site in `.wasdengine/game.json`, so later releases
 * add versions to the same game; when the site no longer has that game, or another account owns it, the release
 * creates a new one. The Web build itself goes to `.wasdengine/web/`, which Godot does not import because the folder
 * is hidden.
 * @module @deepseek-ai/dsh-wasd-plugins/src/release
 */
import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import { z } from 'zod'
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
}

/** A release that could not finish; the message says what the user or the agent can do. */
export class ReleaseError extends Error {
  override name = 'ReleaseError'
}

const GameRecord = z.object({ id: z.string(), slug: z.string(), title: z.string(), url: z.string(), version: z.number().int().min(0) })
type GameRecord = z.infer<typeof GameRecord>
const LinkFile = z.object({ format: z.literal(1), games: z.record(z.string(), GameRecord) })
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
 * The game a project released to on one site.
 * @param projectDir - absolute project folder.
 * @param origin - site origin.
 * @returns the remembered game, or undefined before the project's first release there.
 */
export async function linkedGame(projectDir: string, origin: string): Promise<GameRecord | undefined> {
  return (await readLinks(projectDir)).games[origin]
}

async function rememberGame(projectDir: string, origin: string, record: GameRecord): Promise<void> {
  const links = await readLinks(projectDir)
  await mkdir(join(projectDir, STATE_DIR), { recursive: true })
  await writeFile(linkPath(projectDir), `${JSON.stringify({ format: 1, games: { ...links.games, [origin]: record } }, null, 2)}\n`)
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
 * @returns whether it is a Godot project, and its game on that site.
 */
export async function projectView(projectDir: string, origin: string): Promise<WasdProjectView> {
  let godot = false
  try {
    godot = (await stat(join(projectDir, 'project.godot'))).isFile()
  } catch {
    // A folder without project.godot is not a Godot project.
  }
  const game = await linkedGame(projectDir, origin)
  return { godot, ...game === undefined || game.version === 0 ? {} : { game: { title: game.title, url: game.url, version: game.version } } }
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
  /** Absolute folder for the temporary upload archive. */
  readonly tempDir: string
}

/**
 * Export a project for the Web and release the build as the next version of its game.
 * @param request - project, notes, title, and cover.
 * @param dependencies - sign-in, export, HTTP, and temporary files.
 * @param signal - cancellation; a version the site already stored stays released.
 * @returns the release and its share links.
 * @throws {ReleaseError} while signed out, for unusable arguments, and when the site refuses or fails.
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
  const exported = await dependencies.exportWeb(request.projectDir, join(request.projectDir, STATE_DIR, WEB_BUILD_DIR), signal)
  const archive = join(dependencies.tempDir, `wasd-release-${randomUUID()}.zip`)
  try {
    await writeZip(exported.outputDir, exported.files.map(file => file.path), archive, signal)
    const api = new SiteApi(access, dependencies.fetch, signal)
    const name = title ?? projectName(await readFile(join(request.projectDir, 'project.godot'), 'utf8')) ?? basename(request.projectDir)
    const linked = await linkedGame(request.projectDir, access.origin)
    let game = linked === undefined ? undefined : await api.game(linked.id)
    if (game !== undefined && title !== undefined && game.title !== title) game = await api.rename(game.id, title)
    game ??= await api.create(name.slice(0, MAX_TITLE))
    let released = await api.release(game.id, archive, notes)
    if (released === undefined) {
      // The game was removed between the lookup and the upload: release to a new one.
      game = await api.create(name.slice(0, MAX_TITLE))
      released = await api.release(game.id, archive, notes)
      if (released === undefined) throw new ReleaseError('WASD Engine could not store the release: the new game disappeared. Try again.')
    }
    await rememberGame(request.projectDir, access.origin, {
      id: released.game.id, slug: released.game.slug, title: released.game.title, url: released.game.url, version: released.release.version,
    })
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
