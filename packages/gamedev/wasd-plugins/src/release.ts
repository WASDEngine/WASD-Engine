/**
 * Releases: a Godot project's Web build, uploaded to the WASD Engine site the app is signed in to as the next
 * numbered version (1, 2, 3, ...) of the project's game, where its share page plays it, offers earlier versions, and
 * holds comments. A game is public, on the site's Explore page, or private, reachable only through its link; a release
 * may change that, and the site applies the change as the version goes live. A release can also build the game for
 * Windows and macOS and upload each build as a download of that version, which the share page offers once the site's
 * malware scan passes it; the site's answer names where the build stands in that scan. Those builds go to
 * `.wasdengine/desktop/<platform>/` and are exported before anything reaches the site, so a failed build publishes
 * nothing. Calls go to the site's games API (`/api/v1/games`) through `site-client.ts`. A project remembers each
 * account's game per site in its game link file (`game-link.ts`), so later releases add versions to the same game;
 * when the site no longer has that game, the release creates a new one, and a release from a folder that shares its
 * game with another folder on this computer asks first (`folders.ts`). The Web build itself goes to
 * `.wasdengine/web/`, which Godot does not import because the folder is hidden.
 *
 * A release also uploads the game's preview, the still and the animated GIF that Explore and the share link show: the
 * files the release names, else the project's recorded preview (`.wasdengine/preview/`). The account's entry in the
 * link file keeps the SHA-256 of the files the project last uploaded for its game, so a later release uploads a
 * preview again only when it changed or the site lost it. A game without a GIF on the site, released from a project
 * with none to upload, gets one recorded from its game first, when the release can run it. Last, the release uploads
 * what the game was made with (`credits.ts`), which the game's page and Explore credit with their logos.
 *
 * A project set up for multiplayer (`res://wasd_multiplayer.cfg`) gets its game's id and the site's origins written
 * into that file before the export once the project is linked, and after its first release, so builds know their game
 * and their site where no URL names them. Before the export, a project's WASD Multiplayer add-on older than this WASD
 * Engine's becomes this one, unless the game changed the add-on's own code, and the result says which happened
 * ({@link addonNote}). In `dedicated` mode, the release then exports the Linux dedicated server
 * build into `.wasdengine/server/`, zips `server.x86_64` with any GDExtension libraries the export wrote next to it,
 * and stores it on the site with the new version's number, which updates the game's servers; a server build that
 * fails leaves the version released and becomes a warning.
 * @module @deepseek-ai/dsh-wasd-plugins/src/release
 */
import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { GodotDesktopExport, GodotDesktopPlatform, GodotServerExport, GodotWebCheck, GodotWebExport } from '@deepseek-ai/dsh-godot'
import { z } from 'zod'
import { creditNames, type GameCredits } from './credits.ts'
import { folderOf, type ReleaseFolders } from './folders.ts'
import { accountGame, copyQuestion, linksTo, projectName, readLinks, rememberGame, siteGames, Visibility, type AccountGame } from './game-link.ts'
import { MultiplayerApi } from './multiplayer-api.ts'
import { readMultiplayerConfig, updateMultiplayerAddon, writeMultiplayerConfig, type AddonUpdate, type MultiplayerConfig } from './multiplayer-project.ts'
import { fileDigest, savedPreview, type PreviewFiles } from './preview.ts'
import { STATE_DIR } from './state.ts'
import type { WasdDownload, WasdMultiplayerMode, WasdRelease, WasdServerBuild, WasdVisibility } from './types.ts'
import { SiteClient, type SiteAccess } from './site-client.ts'
import { formatWebCheck } from './web-check-text.ts'
import { writeZip } from './zip.ts'

export { STATE_DIR }

/** The Web build's folder inside {@link STATE_DIR}. */
export const WEB_BUILD_DIR = 'web'

/** The Web check's screenshot inside {@link STATE_DIR}, beside the Web build's folder, so the build's files stay as exported. */
export const WEB_CHECK_SCREENSHOT = 'web-check.jpg'

/** The desktop builds' folder inside {@link STATE_DIR}, which holds one folder per platform. */
export const DESKTOP_BUILD_DIR = 'desktop'

/** The dedicated server build's folder inside {@link STATE_DIR}. */
export const SERVER_BUILD_DIR = 'server'

/** The desktop platforms a release or an export builds for, in the order they build. */
export const DESKTOP_PLATFORMS: readonly GodotDesktopPlatform[] = ['windows', 'macos']

/** The desktop platforms' names as results write them. */
export const PLATFORM_NAMES: Readonly<Record<GodotDesktopPlatform, string>> = { windows: 'Windows', macos: 'macOS' }

/** Longest release notes the site keeps; they travel in the upload's query string. */
export const MAX_NOTES = 1000

/** Longest game title the site keeps. */
export const MAX_TITLE = 80

/** Longest game description the site keeps. */
export const MAX_DESCRIPTION = 2000

/** The format characters the site keeps in a description: the zero-width joiner and non-joiner, and flags' tag characters. */
const KEPT_FORMAT = /[\u200c\u200d\u{E0020}-\u{E007F}]/u

/** Any control, format, surrogate, private-use, or unassigned character. */
const OTHER = /\p{C}/u

/**
 * A description as the site stores it: NFC, line breaks as LF, tabs as spaces, no other control or format character
 * but those {@link KEPT_FORMAT} names, no spaces at line ends, at most one blank line in a row, trimmed. A release
 * compares the site's copy with this, so it sends a description only when it changed.
 * @param text - the description as given.
 * @returns the description as the site keeps it.
 */
export function siteDescription(text: string): string {
  const kept = Array.from(text.normalize('NFC').replace(/\r\n?/gu, '\n'))
    .filter(char => char === '\n' || char === '\t' || !OTHER.test(char) || KEPT_FORMAT.test(char))
    .map(char => char === '\t' ? ' ' : char)
    .join('')
  return kept.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** What a release's result says of a game the site describes with nothing. */
export const NO_DESCRIPTION_NOTE = 'The game has no description, so its page, Explore, and search engines say little about it. Pass description with the next release: two to four sentences on what kind of game it is, its goal, and how to play it.'

/** Image types the site takes as a game's picture, by file extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** A release that could not finish; the message says what the user or the agent can do. */
export class ReleaseError extends Error {
  override name = 'ReleaseError'
}

/**
 * A release that its Web check stopped before anything reached the site, because players could not play the build in a
 * browser ({@link GodotWebCheck.problems}). Its message holds the check's report, the export's notes, and what to do.
 */
export class WebCheckRefusal extends ReleaseError {
  override name = 'WebCheckRefusal'

  /**
   * @param check - the check, with at least one problem.
   * @param notes - the Web export's notes and warnings.
   */
  constructor(readonly check: GodotWebCheck, notes: readonly string[]) {
    super([
      'Nothing was released: the Web check found problems that stop a release, so players could not play this build in a browser.',
      formatWebCheck(check),
      ...notes.length === 0 ? [] : ['Export notes:', ...notes.map(note => `- ${note}`)],
      'Tell the user what the check found. Change the game only when they ask you to; when they ask to publish this build as it is, call wasd_release_game again with check set to false.',
    ].join('\n'))
  }
}

const GameJson = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  // Absent from sites that keep no description of a game.
  description: z.string().optional(),
  url: z.string(),
  latest_version: z.number().int(),
  cover_url: z.string().nullish(),
  gif_url: z.string().nullish(),
  // Absent from sites that play no animation of their own; a site drops a game's animation when its GIF changes.
  webp_url: z.string().nullish(),
  // Absent from sites that keep every game public.
  visibility: Visibility.optional(),
})
type GameJson = z.infer<typeof GameJson>
const ReleaseJson = z.object({
  game: GameJson,
  release: z.object({ version: z.number().int(), url: z.string(), play_url: z.string(), total_bytes: z.number().int() }),
})
const DownloadJson = z.object({
  game: GameJson,
  download: z.object({
    platform: z.enum(['windows', 'macos']),
    version: z.number().int(),
    url: z.string(),
    bytes: z.number().int(),
    // Sites that offer a download as soon as they store it name no status: such a download is clean.
    status: z.enum(['pending', 'clean', 'flagged', 'failed']).default('clean'),
  }),
})

/** The site's games API as one release calls it. */
class SiteApi {
  private readonly site: SiteClient

  constructor(access: SiteAccess, fetchUrl: typeof fetch, signal: AbortSignal) {
    this.site = new SiteClient(access, fetchUrl, signal, { error: message => new ReleaseError(message), again: 'release again' })
  }

  async game(id: string): Promise<GameJson | undefined> {
    const response = await this.site.call('GET', `/api/v1/games/${encodeURIComponent(id)}`)
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return (await this.site.json(response, z.object({ game: GameJson }), 'read the game')).game
  }

  async create(title: string, visibility: WasdVisibility, description: string | undefined): Promise<GameJson> {
    const body = { title, visibility, ...description === undefined ? {} : { description } }
    const response = await this.site.call('POST', '/api/v1/games', { data: JSON.stringify(body), type: 'application/json' })
    return (await this.site.json(response, z.object({ game: GameJson }), 'create the game')).game
  }

  async update(id: string, changes: GameChanges): Promise<GameJson> {
    const response = await this.site.call('PATCH', `/api/v1/games/${encodeURIComponent(id)}`, { data: JSON.stringify(changes), type: 'application/json' })
    return (await this.site.json(response, z.object({ game: GameJson }), 'update the game')).game
  }

  async release(
    id: string, archive: string, notes: string, visibility: WasdVisibility | undefined, multiplayer: WasdMultiplayerMode | undefined,
  ): Promise<z.infer<typeof ReleaseJson> | undefined> {
    const params = new URLSearchParams({
      ...notes === '' ? {} : { notes },
      ...visibility === undefined ? {} : { visibility },
      // An online version plays on the site only while it is the latest, which the site learns here.
      ...multiplayer === undefined ? {} : { multiplayer },
    })
    const query = params.size === 0 ? '' : `?${params.toString()}`
    const response = await this.site.call('POST', `/api/v1/games/${encodeURIComponent(id)}/releases${query}`, { data: await openAsBlob(archive), type: 'application/zip' })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return await this.site.json(response, ReleaseJson, 'store the release')
  }

  async cover(id: string, image: string): Promise<GameJson> {
    const type = IMAGE_TYPES[extname(image).toLowerCase()] as string
    const response = await this.site.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/cover`, { data: await openAsBlob(image), type })
    return (await this.site.json(response, z.object({ game: GameJson }), 'store the preview image')).game
  }

  async gif(id: string, gif: string): Promise<GameJson> {
    const response = await this.site.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/gif`, { data: await openAsBlob(gif), type: 'image/gif' })
    return (await this.site.json(response, z.object({ game: GameJson }), 'store the preview GIF')).game
  }

  async webp(id: string, webp: string): Promise<GameJson> {
    const response = await this.site.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/webp`, { data: await openAsBlob(webp), type: 'image/webp' })
    return (await this.site.json(response, z.object({ game: GameJson }), 'store the preview animation')).game
  }

  async credits(id: string, credits: GameCredits): Promise<void> {
    const response = await this.site.call('PUT', `/api/v1/games/${encodeURIComponent(id)}/credits`, { data: JSON.stringify(credits), type: 'application/json' })
    await this.site.json(response, z.object({ game: GameJson }), 'store what the game was made with')
  }

  async download(id: string, version: number, platform: GodotDesktopPlatform, file: string): Promise<z.infer<typeof DownloadJson>> {
    const path = `/api/v1/games/${encodeURIComponent(id)}/releases/${version}/downloads/${platform}`
    const response = await this.site.call('PUT', path, { data: await openAsBlob(file), type: 'application/zip' })
    return await this.site.json(response, DownloadJson, `store the ${PLATFORM_NAMES[platform]} download`)
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

/** The title and description a release gives an existing game, each only when it differs from the site's. */
interface GameChanges {
  readonly title?: string
  readonly description?: string
}

/** What a release reads and changes. */
export interface ReleaseRequest {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Release notes for the game page; at most {@link MAX_NOTES} characters. */
  readonly notes?: string
  /** Title for a new game, or a new title for the existing one; at most {@link MAX_TITLE} characters. */
  readonly title?: string
  /**
   * What the game is, for its page, Explore, and search engines; at most {@link MAX_DESCRIPTION} characters. Undefined
   * keeps the game's description.
   */
  readonly description?: string
  /** Absolute path of a PNG, JPEG, or WebP picture of the game. Default: the still of the project's recorded preview. */
  readonly previewImage?: string
  /** Absolute path of an animated GIF of the game. Default: the GIF of the project's recorded preview. */
  readonly previewGif?: string
  /**
   * `true` releases the build as version 1 of a new game, which the project releases to from then on; `false` adds it
   * to the account's game the project released to before, also when another folder on this computer releases that
   * game, as a copy does. Undefined adds it to that game, but refuses such a folder with {@link copyQuestion}, so the
   * user decides.
   */
  readonly newGame?: boolean
  /**
   * Who can find the game from this version on: `public` lists it on the site's Explore page, `private` keeps it off
   * Explore, reachable through its link. Undefined keeps the game's visibility; a new game is then public.
   */
  readonly visibility?: WasdVisibility
  /** Desktop platforms to build the game for and offer as downloads of this version. Default: none. */
  readonly desktop?: readonly GodotDesktopPlatform[]
  /**
   * `false` releases without the Web check of the build. Default: the check runs while the desktop builds export, and a
   * check that finds problems that stop a release ({@link WebCheckRefusal}) stops it before anything reaches the site.
   */
  readonly check?: boolean
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
  /**
   * Export the project for one desktop platform.
   * @param projectDir - absolute project folder.
   * @param platform - the platform.
   * @param outputDir - absolute folder the export fills with the build's ZIP file.
   * @param signal - cancellation.
   * @returns the exported ZIP file.
   */
  readonly exportDesktop: (
    projectDir: string, platform: GodotDesktopPlatform, outputDir: string, signal: AbortSignal,
  ) => Promise<GodotDesktopExport>
  /**
   * Export the project as a Linux dedicated server, for projects in the `dedicated` multiplayer mode; absent, such
   * releases store no server build and say so in a warning.
   * @param projectDir - absolute project folder.
   * @param outputDir - absolute folder the export fills.
   * @param signal - cancellation.
   * @returns the server executable.
   */
  readonly exportServer?: (projectDir: string, outputDir: string, signal: AbortSignal) => Promise<GodotServerExport>
  /**
   * Check a Web build in a browser; absent where Web checks are off.
   * @param outputDir - absolute folder of the Web build.
   * @param signal - cancellation.
   * @returns what the check saw.
   */
  readonly checkWeb?: (outputDir: string, signal: AbortSignal) => Promise<GodotWebCheck>
  /** HTTP client of the site calls. */
  readonly fetch: typeof fetch
  /** Which folders on this computer released each game. */
  readonly folders: ReleaseFolders
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
  /**
   * Collect what the game was made with, which the release uploads after the build; absent, the release credits
   * nothing.
   * @param projectDir - absolute project folder.
   * @returns the models, tools, and add-ons.
   */
  readonly credits?: (projectDir: string) => Promise<GameCredits>
  /**
   * Absolute folder of the WASD Multiplayer add-on that this WASD Engine ships, which a release puts in place of a
   * project's older, unchanged copy ({@link updateMultiplayerAddon}); absent, releases leave the copy as it is.
   */
  readonly addonSource?: string
}

/**
 * What a release's result says of the project's WASD Multiplayer add-on, once the release updated it or found it older
 * and changed by the game.
 * @param update - what the release did.
 * @returns the note.
 */
export function addonNote(update: AddonUpdate): string {
  if (update.outcome === 'updated') {
    const was = update.from === undefined ? 'named no version' : `was ${update.from}`
    const kept = update.kept.length === 0 ? '' : ` The add-on files the game changed or added stayed as they were: ${update.kept.join(', ')}.`
    return `This project's WASD Multiplayer add-on ${was}; the release updated it to ${update.to} before the export.${kept}`
  }
  const is = update.from === undefined ? 'names no version' : `is ${update.from}`
  return `This project's WASD Multiplayer add-on ${is}, older than WASD Engine's ${update.to}, and the game changed the add-on's own code (${update.changed.join(', ')}), so the release built the game with it as it is. Ask the user whether to call wasd_multiplayer_setup, which replaces those files with ${update.to}'s and keeps the example files the game changed; then apply the game's changes again where ${update.to} still needs them.`
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is no file to upload.
    return false
  }
}

/** The preview digests a project last uploaded for a game. */
type PreviewDigests = Pick<AccountGame, 'image' | 'gif' | 'webp'>

/** What a release uploads of its preview. */
interface PreviewUpload extends PreviewDigests {
  /** The game afterwards. */
  readonly game: GameJson
}

/**
 * Upload the preview files that the game lacks or that changed since the project last uploaded them. A failed upload
 * becomes a warning, because the version is released already. The animation goes up after the GIF, because the site
 * drops a game's animation when its GIF changes, and not at all when the GIF failed, which would leave the two
 * showing different recordings.
 * @param api - the site.
 * @param game - the released game.
 * @param files - the preview files.
 * @param uploaded - the digests the project last uploaded for this game.
 * @param warnings - collects failures.
 * @param signal - cancellation.
 * @returns the game afterwards and the digests of its preview.
 */
async function uploadPreview(
  api: SiteApi, game: GameJson, files: PreviewFiles, uploaded: PreviewDigests, warnings: string[], signal: AbortSignal,
): Promise<PreviewUpload> {
  let current = game
  const digests = { image: uploaded.image, gif: uploaded.gif, webp: uploaded.webp }
  const parts = [
    { kind: 'image', file: files.image, stored: () => current.cover_url, put: (path: string) => api.cover(current.id, path), what: 'preview image' },
    { kind: 'gif', file: files.gif, stored: () => current.gif_url, put: (path: string) => api.gif(current.id, path), what: 'preview GIF' },
    { kind: 'webp', file: files.webp, stored: () => current.webp_url, put: (path: string) => api.webp(current.id, path), what: 'preview animation' },
  ] as const
  let gifFailed = false
  for (const part of parts) {
    if (part.file === undefined || (part.kind === 'webp' && gifFailed)) continue
    try {
      const digest = await fileDigest(part.file, signal)
      if (digest === digests[part.kind] && (part.stored() ?? null) !== null) continue
      current = await part.put(part.file)
      digests[part.kind] = digest
    } catch (error) {
      signal.throwIfAborted()
      gifFailed ||= part.kind === 'gif'
      warnings.push(`The version is released, but its ${part.what} was not stored: ${(error as Error).message}`)
    }
  }
  return { game: current, ...digests }
}

/**
 * Upload what a released game was made with, which replaces what the game's page credited before.
 * @param api - the site.
 * @param id - the game.
 * @param collected - the credits, once collected.
 * @param warnings - collects failures.
 * @param signal - cancellation.
 * @returns the credits the site stored, or undefined when collecting or storing them failed.
 */
async function uploadCredits(
  api: SiteApi, id: string, collected: Promise<GameCredits>, warnings: string[], signal: AbortSignal,
): Promise<GameCredits | undefined> {
  try {
    const credits = await collected
    await api.credits(id, credits)
    return credits
  } catch (error) {
    signal.throwIfAborted()
    warnings.push(`The version is released, but what the game was made with was not stored: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * Upload the desktop builds as downloads of a released version. A failed upload becomes a warning, because the version
 * is released already.
 * @param api - the site.
 * @param game - the released game.
 * @param version - the released version.
 * @param builds - the builds, in platform order.
 * @param warnings - collects failures.
 * @param signal - cancellation.
 * @returns the stored downloads with their scan status.
 */
async function uploadDownloads(
  api: SiteApi, game: GameJson, version: number, builds: readonly GodotDesktopExport[], warnings: string[], signal: AbortSignal,
): Promise<WasdDownload[]> {
  const stored: WasdDownload[] = []
  for (const build of builds) {
    try {
      const { download } = await api.download(game.id, version, build.platform, join(build.outputDir, build.entry))
      stored.push({ platform: download.platform, url: download.url, bytes: download.bytes, status: download.status })
    } catch (error) {
      signal.throwIfAborted()
      warnings.push(`The version is released, but its ${PLATFORM_NAMES[build.platform]} download was not stored: ${(error as Error).message}`)
    }
  }
  return stored
}

/**
 * The refusal of a private release on a site that keeps every game public, before anything is uploaded.
 * @param game - the game the release would go to, as the site answered.
 * @param visibility - the requested visibility.
 * @throws {ReleaseError} when the release asks for a private game and the site's answer names no visibility.
 */
function requireVisibility(game: GameJson, visibility: WasdVisibility | undefined): void {
  if (visibility === 'private' && game.visibility === undefined) {
    throw new ReleaseError('This WASD Engine site does not keep games private yet, so a private release would be public. Release it with visibility "public", or try again once the site supports private links.')
  }
}

/**
 * Point a multiplayer project's configuration at a game and the site, when it names another.
 * @param projectDir - absolute project folder.
 * @param config - the project's configuration.
 * @param gameId - the game's id.
 * @param origin - the site's origin.
 * @returns the configuration in effect.
 */
async function pointConfig(projectDir: string, config: MultiplayerConfig, gameId: string, origin: string): Promise<MultiplayerConfig> {
  if (config.gameId === gameId && config.apiOrigin === origin && config.appOrigin === origin) return config
  const updated = { ...config, gameId, apiOrigin: origin, appOrigin: origin }
  await writeMultiplayerConfig(projectDir, updated)
  return updated
}

/** A dedicated server build zipped for upload, and the game its configuration named when it was exported. */
interface ServerArchive {
  readonly path: string
  readonly bytes: number
  readonly gameId: string
}

/**
 * Export and zip the dedicated server build of the project as its configuration stands.
 * @param request - the release's project.
 * @param dependencies - the server export and temporary files.
 * @param gameId - the game the configuration names.
 * @param signal - cancellation.
 * @returns the zipped build, which the caller removes.
 * @throws {ReleaseError} when this WASD Engine cannot export server builds.
 */
async function exportServerArchive(
  request: ReleaseRequest, dependencies: ReleaseDependencies, gameId: string, signal: AbortSignal,
): Promise<ServerArchive> {
  const exportServer = dependencies.exportServer
  if (exportServer === undefined) throw new ReleaseError('this WASD Engine cannot export dedicated server builds.')
  const exported = await exportServer(request.projectDir, join(request.projectDir, STATE_DIR, SERVER_BUILD_DIR), signal)
  const path = join(dependencies.tempDir, `wasd-server-${randomUUID()}.zip`)
  try {
    return { path, bytes: await writeZip(exported.outputDir, exported.files.map(file => file.path), path, signal), gameId }
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
}

/**
 * Export a project for the Web, and for the desktop platforms the request names, check the Web build in a browser,
 * unless the request turns the check off, and release the build as the next version of the signed-in account's game,
 * or as the first version of a new game, with the desktop builds as its downloads and what the game was made with.
 * The check runs while the desktop builds export and ends before anything reaches the site; a check that could not run
 * stops nothing. A dedicated game's server build exports with the desktop builds, and its first release creates the
 * game before the exports, so that both builds name it.
 * @param request - project, notes, title, preview files, whether to start a new game, visibility, desktop platforms,
 *   and whether to check the Web build.
 * @param dependencies - sign-in, exports, the Web check, HTTP, release folders, temporary files, the preview recording,
 *   and the credits.
 * @param signal - cancellation; a version the site already stored stays released.
 * @returns the release, its share links, its downloads, its credits, and its Web check.
 * @throws {ReleaseError} while signed out, for unusable arguments, for a folder that shares its game with another one
 * and has not said which game it releases ({@link copyQuestion}, before the export), for a private release to a site
 * without private games (before the upload), for a dedicated game whose server build cannot be exported (before the
 * upload), and when the site refuses or fails.
 * @throws {WebCheckRefusal} when the Web check found problems that stop a release, before anything reaches the site.
 */
export async function releaseGame(request: ReleaseRequest, dependencies: ReleaseDependencies, signal: AbortSignal): Promise<WasdRelease> {
  const notes = (request.notes ?? '').trim()
  if (notes.length > MAX_NOTES) throw new ReleaseError(`notes must be at most ${MAX_NOTES} characters.`)
  const title = request.title?.trim()
  if (title !== undefined && (title === '' || title.length > MAX_TITLE)) throw new ReleaseError(`title must be 1 to ${MAX_TITLE} characters.`)
  const description = request.description === undefined ? undefined : siteDescription(request.description)
  if (description !== undefined && (description === '' || Array.from(description).length > MAX_DESCRIPTION)) {
    throw new ReleaseError(`description must be 1 to ${MAX_DESCRIPTION} characters.`)
  }
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
  const api = new SiteApi(access, dependencies.fetch, signal)
  const here = await folderOf(request.projectDir)
  const siteLinks = siteGames(await readLinks(request.projectDir), access.origin)
  let game = request.newGame === true ? undefined : await ownedGame(api, siteLinks, access.account)
  if (game !== undefined) {
    requireVisibility(game, request.visibility)
    const id = game.id
    const other = request.newGame === false
      ? undefined
      : await dependencies.folders.sharedWith(access.origin, id, here, dir => linksTo(dir, access.origin, id))
    if (other !== undefined) throw new ReleaseError(copyQuestion(other, game))
    await dependencies.folders.add(access.origin, id, here)
  }
  let multiplayer = await readMultiplayerConfig(request.projectDir)
  // The builds carry their game's id where no URL names it; a first release learns the id only from the site, but its
  // builds already talk to the site they are released to, whatever site the setup named.
  if (multiplayer !== undefined) {
    multiplayer = await pointConfig(request.projectDir, multiplayer, game?.id ?? multiplayer.gameId, access.origin)
  }
  // The builds get the fixes of this WASD Engine's add-on, unless the game changed the add-on's own code.
  const addonSource = dependencies.addonSource
  const addon = addonSource === undefined ? undefined : await updateMultiplayerAddon(request.projectDir, addonSource)
  const addonNotes = addon === undefined ? [] : [addonNote(addon)]
  const remember = (linked: GameJson, version: number, digests: PreviewDigests = {}): Promise<void> => {
    return rememberGame(request.projectDir, access.origin, {
      ...access.account === undefined ? {} : { account: access.account },
      id: linked.id, slug: linked.slug, title: linked.title, url: linked.url, version,
      ...digests.image === undefined ? {} : { image: digests.image },
      ...digests.gif === undefined ? {} : { gif: digests.gif },
      ...digests.webp === undefined ? {} : { webp: digests.webp },
      ...linked.visibility === undefined ? {} : { visibility: linked.visibility },
    })
  }
  // A game made in place of the one the project released to, which was removed, or as a new game of the project,
  // keeps that game's visibility unless the request names one, so a private game never comes back public.
  const inherited = game?.visibility ?? accountGame(siteLinks, access.account)?.visibility ?? 'public'
  const create = async (): Promise<GameJson> => {
    const name = title ?? projectName(await readFile(join(request.projectDir, 'project.godot'), 'utf8')) ?? basename(request.projectDir)
    const created = await api.create(name.slice(0, MAX_TITLE), request.visibility ?? inherited, description)
    // Linked before the upload: when the upload fails, or the call ends while the site still stores the build, the
    // next release adds its version to this game instead of creating another.
    await remember(created, created.latest_version)
    await dependencies.folders.add(access.origin, created.id, here)
    requireVisibility(created, request.visibility)
    return created
  }
  // A dedicated game's server build names its game, so its first release makes the game before the builds export.
  if (multiplayer?.mode === 'dedicated' && game === undefined) {
    game = await create()
    multiplayer = await pointConfig(request.projectDir, multiplayer, game.id, access.origin)
  }
  const exported = await dependencies.exportWeb(request.projectDir, join(request.projectDir, STATE_DIR, WEB_BUILD_DIR), signal)
  // The Web check watches the build while the desktop builds export, and ends before anything reaches the site; a
  // release that fails before then stops it.
  const stopCheck = new AbortController()
  const checking = request.check === false || dependencies.checkWeb === undefined
    ? undefined
    : webCheckOutcome(dependencies.checkWeb(exported.outputDir, AbortSignal.any([signal, stopCheck.signal])))
  const archive = join(dependencies.tempDir, `wasd-release-${randomUUID()}.zip`)
  let serverArchive: ServerArchive | undefined
  try {
    // Desktop builds come before anything reaches the site, so a build that fails publishes nothing.
    const builds: GodotDesktopExport[] = []
    for (const platform of DESKTOP_PLATFORMS.filter(platform => request.desktop?.includes(platform) === true)) {
      const outputDir = join(request.projectDir, STATE_DIR, DESKTOP_BUILD_DIR, platform)
      builds.push(await dependencies.exportDesktop(request.projectDir, platform, outputDir, signal))
    }
    // So does a dedicated game's server build: online play needs the latest version, which no player could join
    // without its server build.
    if (multiplayer?.mode === 'dedicated' && game !== undefined) {
      try {
        serverArchive = await exportServerArchive(request, dependencies, game.id, signal)
      } catch (error) {
        if (signal.aborted) throw error
        throw new ReleaseError(`Nothing was released: the game's dedicated server build failed, and no player could join a version without one: ${(error as Error).message}`, { cause: error })
      }
    }
    await writeZip(exported.outputDir, exported.files.map(file => file.path), archive, signal)
    // A check that could not run stops nothing; one that found the game broken in browsers stops the release here.
    const checked = checking === undefined ? undefined : await checking
    if (checked !== undefined && 'webCheck' in checked && checked.webCheck.problems.length > 0) {
      throw new WebCheckRefusal(checked.webCheck, [...exported.warnings, ...addonNotes])
    }
    if (game !== undefined) {
      const changes: GameChanges = {
        ...title === undefined || game.title === title ? {} : { title },
        ...description === undefined || game.description === description ? {} : { description },
      }
      if (Object.keys(changes).length > 0) game = await api.update(game.id, changes)
    }
    game ??= await create()
    const warnings = [...exported.warnings, ...addonNotes]
    const saved = await savedPreview(request.projectDir)
    // The saved animation plays the saved GIF's recording; with a GIF of the caller's, the site plays that GIF instead.
    let files: PreviewFiles = {
      ...saved.image === undefined ? {} : { image: saved.image },
      ...saved.gif === undefined ? {} : { gif: saved.gif },
      ...saved.webp === undefined || request.previewGif !== undefined ? {} : { webp: saved.webp },
      ...request.previewImage === undefined ? {} : { image: request.previewImage },
      ...request.previewGif === undefined ? {} : { gif: request.previewGif },
    }
    if (files.gif === undefined && (game.gif_url ?? null) === null && dependencies.recordPreview !== undefined) {
      try {
        const recorded = await dependencies.recordPreview(request.projectDir, signal)
        files = { gif: recorded.gif, webp: recorded.webp, image: request.previewImage ?? recorded.image }
        warnings.push('The project had no preview, so the release recorded the game\'s first seconds without input. For a preview that shows gameplay, record one with wasd_record_preview before the next release.')
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`The game has no preview GIF: recording one failed: ${(error as Error).message}`)
      }
    }
    let released = await api.release(game.id, archive, notes, request.visibility, multiplayer?.mode)
    if (released === undefined) {
      // The game was removed between the lookup and the upload: release to a new one.
      game = await create()
      released = await api.release(game.id, archive, notes, request.visibility, multiplayer?.mode)
      if (released === undefined) throw new ReleaseError('WASD Engine could not store the release: the new game disappeared. Try again.')
    }
    // Digests describe what this project uploaded to the game they name; a different game has none of its files.
    const prior = siteLinks.find(entry => entry.id === released.game.id)
    const uploaded: PreviewDigests = prior === undefined ? {} : { image: prior.image, gif: prior.gif, webp: prior.webp }
    await remember(released.game, released.release.version, uploaded)
    if (released.game.description === '') warnings.push(NO_DESCRIPTION_NOTE)
    if (multiplayer !== undefined) multiplayer = await pointConfig(request.projectDir, multiplayer, released.game.id, access.origin)
    let serverBuild: WasdServerBuild | undefined
    if (multiplayer?.mode === 'dedicated') {
      try {
        // A game made in place of one removed during the release has another id than the build names.
        if (serverArchive?.gameId !== released.game.id) {
          if (serverArchive !== undefined) await rm(serverArchive.path, { force: true })
          serverArchive = await exportServerArchive(request, dependencies, released.game.id, signal)
        }
        const builds = new MultiplayerApi(access, dependencies.fetch, signal)
        const build = await builds.uploadBuild(released.game.id, released.release.version, serverArchive.path)
        serverBuild = { version: build.version, bytes: serverArchive.bytes }
      } catch (error) {
        if (signal.aborted) throw error
        warnings.push(`The version is released, but its dedicated server build was not stored, so the game's servers keep their earlier build: ${(error as Error).message}`)
      }
    }
    const downloads = await uploadDownloads(api, released.game, released.release.version, builds, warnings, signal)
    const preview = await uploadPreview(api, released.game, files, uploaded, warnings, signal)
    if (preview.image !== uploaded.image || preview.gif !== uploaded.gif || preview.webp !== uploaded.webp) {
      await remember(released.game, released.release.version, preview)
    }
    const credited = dependencies.credits === undefined
      ? undefined
      : await uploadCredits(api, released.game.id, dependencies.credits(request.projectDir), warnings, signal)
    return {
      title: released.game.title,
      version: released.release.version,
      url: released.release.url,
      gameUrl: released.game.url,
      playUrl: released.release.play_url,
      totalBytes: released.release.total_bytes,
      visibility: released.game.visibility ?? 'public',
      downloads,
      ...credited === undefined ? {} : { credits: creditNames(credited) },
      ...serverBuild === undefined ? {} : { serverBuild },
      warnings,
      ...checked,
    }
  } finally {
    stopCheck.abort()
    await rm(archive, { force: true })
    if (serverArchive !== undefined) await rm(serverArchive.path, { force: true })
  }
}

/** A Web check's report, or why it could not run. */
type WebCheckOutcome = { readonly webCheck: GodotWebCheck } | { readonly webCheckError: string }

/**
 * Settle a Web check into its report or its failure, so a check that fails never fails the release.
 * @param check - the running check.
 * @returns the outcome.
 */
async function webCheckOutcome(check: Promise<GodotWebCheck>): Promise<WebCheckOutcome> {
  try {
    return { webCheck: await check }
  } catch (error) {
    return { webCheckError: (error as Error).message }
  }
}
