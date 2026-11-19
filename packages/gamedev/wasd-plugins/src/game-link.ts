/**
 * The link from a Godot project to its game on WASD Engine sites: `.wasdengine/game.json` keeps each account's game per
 * site from the moment the site creates the game, before the upload, so later releases add versions to the same game,
 * also after a release whose upload failed or was cut off, and another account signed in to the same site gets a game
 * of its own. A copy of a project folder carries that link, so a release from a folder that shares its game with
 * another folder on this computer asks first ({@link copyQuestion}).
 * @module @deepseek-ai/dsh-wasd-plugins/src/game-link
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { folderOf, type ReleaseFolders } from './folders.ts'
import { STATE_DIR, writeWhole } from './state.ts'
import type { WasdProjectView } from './types.ts'

/** The game link file inside {@link STATE_DIR}. */
export const LINK_FILE = 'game.json'

const GameRecord = z.object({ id: z.string(), slug: z.string(), title: z.string(), url: z.string(), version: z.number().int().min(0) })
/** A game the site holds for a project, as the link file keeps it. */
export type GameRecord = z.infer<typeof GameRecord>
// One account's game on one site; `account` is absent when the release did not know its account, `image`, `gif`, and
// `webp` are the SHA-256 digests of the preview files the project last uploaded for the game, and `visibility` is the
// game's as the site answered the project's latest release; absent before releases knew visibility, which made every
// game public.
/** Whether a game is listed on Explore or reachable through its link only. */
export const Visibility = z.enum(['public', 'private'])
/** One account's game on one site, as the link file keeps it. */
export const AccountGame = GameRecord.extend({
  account: z.string().optional(),
  image: z.string().optional(),
  gif: z.string().optional(),
  webp: z.string().optional(),
  visibility: Visibility.optional(),
})
/** One account's game on one site. */
export type AccountGame = z.infer<typeof AccountGame>
const LinkFile = z.object({
  format: z.literal(1),
  // The game of each site's latest release: what versions before per-account links read and write.
  games: z.record(z.string(), GameRecord),
  // Each account's game on each site, the latest release first.
  accounts: z.record(z.string(), z.array(AccountGame)).optional(),
})
/** A project's link file. */
export type LinkFile = z.infer<typeof LinkFile>

function linkPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, LINK_FILE)
}

/**
 * A project's link file, or an empty one when the project has none.
 * @param projectDir - absolute project folder.
 * @returns the link file.
 * @throws {Error} when the file holds no link file.
 */
export async function readLinks(projectDir: string): Promise<LinkFile> {
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

/**
 * The games a link file keeps for one site, the latest release's first. A link file written before per-account links
 * holds one game per site, without its account.
 * @param links - the link file.
 * @param origin - the site's origin.
 * @returns the games.
 */
export function siteGames(links: LinkFile, origin: string): AccountGame[] {
  const latest = links.games[origin]
  return links.accounts?.[origin] ?? (latest === undefined ? [] : [latest])
}

/**
 * One account's game without asking the site: its own, else one whose release did not know its account; the latest
 * release's game when the account is unknown.
 * @param games - the site's games ({@link siteGames}).
 * @param account - {@link accountKey} of the account.
 * @returns the game, if any.
 */
export function accountGame(games: readonly AccountGame[], account: string | undefined): AccountGame | undefined {
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

/**
 * Whether a project's link file names a game on a site.
 * @param projectDir - absolute project folder.
 * @param origin - the site's origin.
 * @param gameId - the game.
 * @returns true when it does; false also when the file cannot be read.
 */
export async function linksTo(projectDir: string, origin: string, gameId: string): Promise<boolean> {
  try {
    return siteGames(await readLinks(projectDir), origin).some(game => game.id === gameId)
  } catch {
    // An unreadable link file links to no game.
    return false
  }
}

/**
 * Keep an account's game in the project's link file: it becomes the site's latest and replaces the account's earlier
 * game and the game's earlier entry. The file is replaced whole, so an interrupted write leaves the earlier link, never
 * a damaged one.
 * @param projectDir - absolute project folder.
 * @param origin - the site's origin.
 * @param record - the account's game.
 */
export async function rememberGame(projectDir: string, origin: string, record: AccountGame): Promise<void> {
  const links = await readLinks(projectDir)
  const replaces = (game: AccountGame) => game.id === record.id || (record.account !== undefined && game.account === record.account)
  const others = siteGames(links, origin).filter(game => !replaces(game))
  const latest: GameRecord = { id: record.id, slug: record.slug, title: record.title, url: record.url, version: record.version }
  await mkdir(join(projectDir, STATE_DIR), { recursive: true })
  await writeWhole(linkPath(projectDir), `${JSON.stringify({
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
 * What the Export / Share button shows for a project folder.
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
  const game = accountGame(siteGames(await readLinks(projectDir), origin), account)
  if (game === undefined || game.version === 0) return { godot }
  const other = await folders.sharedWith(origin, game.id, await folderOf(projectDir), dir => linksTo(dir, origin, game.id))
  return {
    godot,
    game: { title: game.title, url: game.url, version: game.version, visibility: game.visibility ?? 'public' },
    ...other === undefined ? {} : { sharedWith: other },
  }
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
