/**
 * Release folders: which folders on this computer released each game, kept in the plugin's data folder rather than in
 * the projects, so a project committed to version control carries no local paths. A copied project folder carries the
 * game link of the folder it was copied from (`.wasdengine/game.json`); this record tells the two apart, so a release
 * from a folder that shares its game with another folder asks whether to add its version to that game or to start a new
 * one. A folder is known by its real path and by its file-system ID, which a rename or a move within one volume keeps
 * and a copy does not.
 * @module @deepseek-ai/dsh-wasd-plugins/src/folders
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** One project folder on this computer. */
export interface ReleaseFolder {
  /** Absolute path with symbolic links resolved. */
  readonly path: string
  /** The folder's file-system ID (inode or file index), in decimal. */
  readonly inode: string
}

const FolderFile = z.object({ format: z.literal(1), folders: z.array(z.object({ path: z.string(), inode: z.string() })) })

/**
 * Identify a project folder.
 * @param projectDir - absolute folder that exists.
 * @returns its real path and file-system ID.
 */
export async function folderOf(projectDir: string): Promise<ReleaseFolder> {
  const path = await realpath(projectDir)
  return { path, inode: (await stat(path, { bigint: true })).ino.toString() }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // A folder that is gone, or that this process may not read, shares no game.
    return false
  }
}

/** The release folders of every game, one file per game in one data folder. */
export class ReleaseFolders {
  /**
   * @param dir - absolute folder of the files; created on the first record.
   */
  constructor(private readonly dir: string) {}

  private file(origin: string, gameId: string): string {
    // A digest names the file, because origins and game IDs are not file names.
    return join(this.dir, `${createHash('sha256').update(`${origin}\n${gameId}`).digest('hex').slice(0, 32)}.json`)
  }

  /**
   * The folders on this computer that released a game.
   * @param origin - site origin.
   * @param gameId - the game's ID on the site.
   * @returns the folders, the latest first; none before this computer's first release of the game.
   */
  async list(origin: string, gameId: string): Promise<ReleaseFolder[]> {
    let text: string
    try {
      text = await readFile(this.file(origin, gameId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed = FolderFile.safeParse(JSON.parse(text))
      // A damaged record only means that the next copy check knows no folder of the game.
      return parsed.success ? parsed.data.folders : []
    } catch {
      // Not JSON: as damaged.
      return []
    }
  }

  /**
   * Record that a folder releases a game. A folder already recorded by its path or its file-system ID, such as one
   * renamed since, keeps one record, with the current path and ID.
   * @param origin - site origin.
   * @param gameId - the game's ID on the site.
   * @param folder - the folder, from {@link folderOf}.
   */
  async add(origin: string, gameId: string, folder: ReleaseFolder): Promise<void> {
    const others = (await this.list(origin, gameId)).filter(known => known.path !== folder.path && known.inode !== folder.inode)
    const file = this.file(origin, gameId)
    await mkdir(dirname(file), { recursive: true })
    // Written whole, then renamed into place, so a reader never sees part of a record.
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ format: 1, folders: [folder, ...others] }, null, 2)}\n`)
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * The folder that a project folder shares its game with, as a copy shares the game of its original: another folder
   * on this computer that released the game and still links to it, while this folder never released it.
   * @param origin - site origin.
   * @param gameId - the game's ID on the site.
   * @param here - the project folder, from {@link folderOf}.
   * @param linked - whether a folder's game link still names the game.
   * @returns that folder's path; undefined when `here` released the game before, when this computer has no other folder
   * of the game, and when the other folders are gone or link to other games, as after a move.
   */
  async sharedWith(
    origin: string, gameId: string, here: ReleaseFolder, linked: (dir: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const folders = await this.list(origin, gameId)
    if (folders.some(folder => folder.path === here.path || folder.inode === here.inode)) return undefined
    for (const folder of folders) {
      if (await isDirectory(folder.path) && await linked(folder.path)) return folder.path
    }
    return undefined
  }
}
