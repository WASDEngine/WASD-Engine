/**
 * Releases: a Godot project's Web build, uploaded to the WASD Engine site the app is signed in to as the next
 * numbered version (1, 2, 3, ...) of the project's game, where its share page plays it, offers earlier versions, and
 * holds comments. Calls go to the site's games API (`/api/v1/games`) with the signed-in token in `x-dsh-auth-token`
 * and never follow redirects. A project remembers its game per site in `.wasdengine/game.json`, so later releases
 * add versions to the same game; when the site no longer has that game, or another account owns it, the release
 * creates a new one. The Web build itself goes to `.wasdengine/web/`, which Godot does not import because the folder
 * is hidden.
 *
 * A release also uploads the game's preview, the still and the animated GIF that Explore and the share link show: the
 * files the release names, else the project's recorded preview (`.wasdengine/preview/`). The link file keeps the
 * SHA-256 of the files the project last uploaded for its game, so a later release uploads a preview again only when it
 * changed or the site lost it. A game without a GIF on the site, released from a project with none to upload, gets one
 * recorded from its game first, when the release can run it.
 * @module @deepseek-ai/dsh-wasd-plugins/src/release
 */
import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import { z } from 'zod'
import { fileDigest, savedPreview, type PreviewFiles } from './preview.ts'
import { STATE_DIR } from './state.ts'
import type { WasdProjectView, WasdRelease } from './types.ts'
import { writeZip } from './zip.ts'

export { STATE_DIR }

/** The Web build's folder inside {@link STATE_DIR}. */
export const WEB_BUILD_DIR = 'web'

/** The game link file inside {@link STATE_DIR}. */
export const LINK_FILE = 'game.json'

/** Longest release notes the site keeps; they travel in the upload's query string. */
export const MAX_NOTES = 1000

/** Longest game title the site keeps. */
export const MAX_TITLE = 80

/** Image types the site takes as a game's picture, by file extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

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

const GameRecord = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  url: z.string(),
  version: z.number().int().min(0),
  /** SHA-256 of the picture the project last uploaded for the game. */
  image: z.string().optional(),
  /** SHA-256 of the GIF the project last uploaded for the game. */
  gif: z.string().optional(),
})
type GameRecord = z.infer<typeof GameRecord>
const LinkFile = z.object({ format: z.literal(1), games: z.record(z.string(), GameRecord) })
type LinkFile = z.infer<typeof LinkFile>

const GameJson = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  url: z.string(),
  latest_version: z.number().int(),
  cover_url: z.string().nullish(),
  gif_url: z.string().nullish(),
  image_link: z.string().nullish(),
  gif_link: z.string().nullish(),
})
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

  async cover(id: string, image: string): Promise<GameJson> {
    const type = IMAGE_TYPES[extname(image).toLowerCase()] as string
    const response = await this.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/cover`, { data: await openAsBlob(image), type })
    return (await this.json(response, z.object({ game: GameJson }), 'store the preview image')).game
  }

  async gif(id: string, gif: string): Promise<GameJson> {
    const response = await this.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/gif`, { data: await openAsBlob(gif), type: 'image/gif' })
    return (await this.json(response, z.object({ game: GameJson }), 'store the preview GIF')).game
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
  /** Absolute path of a PNG, JPEG, or WebP picture of the game. Default: the still of the project's recorded preview. */
  readonly previewImage?: string
  /** Absolute path of an animated GIF of the game. Default: the GIF of the project's recorded preview. */
  readonly previewGif?: string
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
  /**
   * Record a preview of the project's game, without input, and save it in the project's preview folder; absent where
   * the release cannot run the game.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation.
   * @returns the saved files.
   */
  readonly recordPreview?: (projectDir: string, signal: AbortSignal) => Promise<Required<PreviewFiles>>
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is no file to upload.
    return false
  }
}

/** What a release uploads of its preview. */
interface PreviewUpload {
  /** The game afterwards. */
  readonly game: GameJson
  /** Digests of the files the game holds as far as this project knows. */
  readonly image: string | undefined
  readonly gif: string | undefined
}

/**
 * Upload the preview files that the game lacks or that changed since the project last uploaded them. A failed upload
 * becomes a warning, because the version is released already.
 * @param api - the site.
 * @param game - the released game.
 * @param files - the preview files.
 * @param uploaded - the digests the project last uploaded for this game.
 * @param warnings - collects failures.
 * @param signal - cancellation.
 * @returns the game afterwards and the digests of its preview.
 */
async function uploadPreview(
  api: SiteApi, game: GameJson, files: PreviewFiles, uploaded: Pick<GameRecord, 'image' | 'gif'>, warnings: string[], signal: AbortSignal,
): Promise<PreviewUpload> {
  let current = game
  const digests = { image: uploaded.image, gif: uploaded.gif }
  const parts = [
    { kind: 'image', file: files.image, stored: () => current.cover_url, put: (path: string) => api.cover(current.id, path), what: 'preview image' },
    { kind: 'gif', file: files.gif, stored: () => current.gif_url, put: (path: string) => api.gif(current.id, path), what: 'preview GIF' },
  ] as const
  for (const part of parts) {
    if (part.file === undefined) continue
    try {
      const digest = await fileDigest(part.file, signal)
      if (digest === digests[part.kind] && (part.stored() ?? null) !== null) continue
      current = await part.put(part.file)
      digests[part.kind] = digest
    } catch (error) {
      signal.throwIfAborted()
      warnings.push(`The version is released, but its ${part.what} was not stored: ${(error as Error).message}`)
    }
  }
  return { game: current, ...digests }
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
  if (request.previewImage !== undefined && IMAGE_TYPES[extname(request.previewImage).toLowerCase()] === undefined) {
    throw new ReleaseError('preview_image must be a PNG, JPEG, or WebP file.')
  }
  if (request.previewGif !== undefined && extname(request.previewGif).toLowerCase() !== '.gif') {
    throw new ReleaseError('preview_gif must be a GIF file.')
  }
  for (const [name, path] of [['preview_image', request.previewImage], ['preview_gif', request.previewGif]] as const) {
    if (path !== undefined && !await isFile(path)) throw new ReleaseError(`${name} ${path} is not a file.`)
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
    const warnings = [...exported.warnings]
    const saved = await savedPreview(request.projectDir)
    let files: PreviewFiles = {
      ...saved,
      ...request.previewImage === undefined ? {} : { image: request.previewImage },
      ...request.previewGif === undefined ? {} : { gif: request.previewGif },
    }
    if (files.gif === undefined && (game.gif_url ?? null) === null && dependencies.recordPreview !== undefined) {
      try {
        const recorded = await dependencies.recordPreview(request.projectDir, signal)
        files = { gif: recorded.gif, image: request.previewImage ?? recorded.image }
        warnings.push('The project had no preview, so the release recorded the game\'s first seconds without input. For a preview that shows gameplay, record one with wasd_record_preview before the next release.')
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`The game has no preview GIF: recording one failed: ${(error as Error).message}`)
      }
    }
    let released = await api.release(game.id, archive, notes)
    if (released === undefined) {
      // The game was removed between the lookup and the upload: release to a new one.
      game = await api.create(name.slice(0, MAX_TITLE))
      released = await api.release(game.id, archive, notes)
      if (released === undefined) throw new ReleaseError('WASD Engine could not store the release: the new game disappeared. Try again.')
    }
    // Digests describe what this project uploaded to the game it names; a different game has none of its files.
    const uploaded = linked?.id === released.game.id ? { image: linked.image, gif: linked.gif } : {}
    const record = {
      id: released.game.id, slug: released.game.slug, title: released.game.title, url: released.game.url, version: released.release.version,
    }
    await rememberGame(request.projectDir, access.origin, { ...record, ...uploaded })
    const preview = await uploadPreview(api, released.game, files, uploaded, warnings, signal)
    if (preview.image !== uploaded.image || preview.gif !== uploaded.gif) {
      await rememberGame(request.projectDir, access.origin, {
        ...record, ...preview.image === undefined ? {} : { image: preview.image }, ...preview.gif === undefined ? {} : { gif: preview.gif },
      })
    }
    return {
      title: released.game.title,
      version: released.release.version,
      url: released.release.url,
      gameUrl: released.game.url,
      playUrl: released.release.play_url,
      totalBytes: released.release.total_bytes,
      ...preview.game.image_link === undefined || preview.game.image_link === null ? {} : { imageLink: preview.game.image_link },
      ...preview.game.gif_link === undefined || preview.game.gif_link === null ? {} : { gifLink: preview.game.gif_link },
      warnings,
    }
  } finally {
    await rm(archive, { force: true })
  }
}
