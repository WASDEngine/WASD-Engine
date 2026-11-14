/**
 * Installation and removal of catalog add-ons, and what a project has. A Godot add-on downloads and unpacks from its
 * checked archive into a staging folder inside the project and gains the files of its catalog overlay folders, or, when
 * WASD Engine wrote it, consists of those files alone; then,
 * holding the record's lock, the installer checks the project again, moves the folder into `res://addons/<folder>/`,
 * enables it in `project.godot` the way the editor's plugin switch does, writes its license into the project's
 * notices, and records it in `.wasdengine/addons.json`, and afterwards imports the project so the add-on's errors show
 * at once. `project.godot` and the notices are read and written at the moment each changes, and a step that fails puts
 * back only what the change itself did, keeping what others changed meanwhile; what it cannot put back, it names. A
 * removal scans the project for files that use the add-on first, then, holding the record's lock, takes out only paths
 * in the add-on's own folder in the same way. Every folder that a removal or a replacement takes out moves to a new
 * backup folder of the add-on, `.wasdengine/backups/<id>/<time>/`, and stays there. Every change stays inside the
 * project, whatever symbolic links lie on its way (`paths.ts`). A Blender extension unpacks once into the shared add-on
 * store, or is copied there from its catalog files when WASD Engine wrote it, and every Blender worker enables it by id;
 * its asset pack, if it has one, unpacks into the asset folder beside the store; its project keeps only the record.
 * Their archives then leave the cache. The store's index names setup scripts by their copies in the store, never by a
 * catalog file, which a worker's Python cannot read inside the Desktop app's `app.asar`.
 * @module @deepseek-ai/dsh-game-addons/src/manager
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { cachedArchive, readArchiveFile, unpackFolder, type ArchiveDownloads } from './archive.ts'
import { searchCatalog, type CatalogQuery, type GameAddonCatalog } from './catalog.ts'
import { standardLicenseText } from './licenses.ts'
import { NOTICES_FILE, noticeSection, readNotice, removeNotice, writeNotice } from './notices.ts'
import { projectEntry, projectFolder } from './paths.ts'
import { ProjectFile, revertEdit } from './project-file.ts'
import { lockRecord, readRecord, RECORD_FILE, STATE_DIR, type HeldRecord } from './record.ts'
import type {
  GameAddon,
  GameAddonInstallResult,
  GameAddonPresence,
  GameAddonRemoveResult,
  GameAddonView,
  InstalledGameAddon,
} from './types.ts'

/** Most import problems or references a result lists. */
export const LISTED_ISSUES = 20

/** File names of a license inside an add-on folder, compared without case. */
const LICENSE_NAMES = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/iu

/** Project files that can name an add-on's folder or its autoloads. */
const REFERENCE_FILES = /\.(?:tscn|tres|gd|gdshader|gdshaderinc|cfg|import|json|cs)$/iu

/** Folders the reference scan skips. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['.godot', '.git', STATE_DIR, 'node_modules', '.import'])

/** Most files the reference scan reads. */
const REFERENCE_SCAN_FILES = 5000

/** Marker file of an add-on in the Blender store, naming the archive it came from. */
export const STORE_MARKER = '.wasd-addon.json'

/** Index of the catalog's Blender add-ons in the store, which Blender workers read to enable an add-on by id. */
export const STORE_INDEX = 'catalog.json'

/**
 * Folder of the store that holds a copy of each Blender add-on's setup script, in a folder per add-on id, which the
 * index names. Blender skips folders whose names start with `.` when it lists the modules of an extensions repository.
 */
export const STORE_SETUP_DIR = '.wasd-setup'

/**
 * Project-relative folder that keeps, in a folder per add-on id, one folder per removal or replacement with what it
 * took out of the project.
 */
export const BACKUPS_DIR = `${STATE_DIR}/backups`

/** Content of the `.gitignore` in {@link BACKUPS_DIR}, which keeps the backups out of version control. */
const BACKUPS_IGNORE = '*\n'

/** The note of a reinstallation that wrote lost `project.godot` entries again. */
const REPAIR_NOTE = 'project.godot had lost some of the add-on\'s settings; they were written again.'

/** One edit of `project.godot`: its text before and after. */
interface ProjectEdit {
  readonly before: string
  readonly after: string
}

/** An entry that a change takes out of the project. */
interface TakenEntry {
  /** Project-relative path it had, with `/` separators. */
  readonly path: string
  /** Its current location. */
  readonly location: string
}

/** A folder of one installation in the project's staging folder, which other installations may share. */
interface StagingFolder {
  /** The project's staging folder, `.wasdengine/staging`. */
  readonly root: string
  /** This installation's folder inside it. */
  readonly dir: string
}

/** A Godot add-on unpacked into its installation's staging folder, ready to take its place. */
interface StagedAddon extends StagingFolder {
  /** The unpacked add-on folder inside {@link StagingFolder.dir}. */
  readonly folder: string
  /** The license text for the add-on's notice. */
  readonly licenseText: string | undefined
}

/** What the locked step of an installation recorded. */
interface CommittedInstall {
  /** The add-on as the record lists it. */
  readonly addon: InstalledGameAddon
  /** Whether the project already had the catalog's version in place. */
  readonly unchanged: boolean
  /** Notes about the step, such as where a replaced folder is kept. */
  readonly notes: readonly string[]
}

/** What the locked step of a removal took out. */
interface CommittedRemoval {
  /** Project-relative paths that were taken out. */
  readonly removed: string[]
  /** Project-relative backup folder that keeps them; absent when nothing was taken out. */
  readonly backup?: string
}

/** A request that the manager refuses, with a message for the model or the user. */
export class GameAddonError extends Error {
  override name = 'GameAddonError'
}

/** Problems that one import of a project reported. */
export interface ImportReport {
  /** Error and warning lines, at most {@link LISTED_ISSUES}. */
  readonly issues: readonly string[]
}

/** What the manager needs from the Host. */
export interface GameAddonManagerOptions {
  /** The loaded catalog. */
  readonly catalog: GameAddonCatalog
  /** Archive cache and fetch. */
  readonly downloads: ArchiveDownloads
  /** Absolute folder of the Blender add-on store. */
  readonly blenderStore: string
  /** Absolute folder that holds the asset packs of Blender add-ons, in a folder per add-on id. */
  readonly assetsDir: string
  /**
   * Import a Godot project with the editor's import step, which also loads its enabled editor plugins.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation.
   * @returns the problems it reported, or undefined when no Godot runtime is installed.
   */
  readonly importProject: (projectDir: string, signal: AbortSignal) => Promise<ImportReport | undefined>
  /** Current time. */
  readonly now: () => Date
  /**
   * Called after a project's add-ons changed, so their guides can be listed again.
   * @param projectDir - absolute project folder.
   */
  readonly changed: (projectDir: string) => void
}

/** Options of one installation. */
export interface InstallOptions {
  /** Replace an add-on folder that is in the project without a record, such as one copied in by hand. */
  readonly replace?: boolean
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Remove a folder when it is empty; a missing or non-empty folder stays as it is. */
async function removeEmpty(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

/** Remove a folder's empty subfolders, deepest first, and then the folder when it is empty; no file is deleted. */
async function removeEmptyFolders(path: string): Promise<void> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyFolders(join(path, entry.name))
  }
  await removeEmpty(path)
}

/** What a store folder is filled from: the SHA-256 that its marker records, and the step that writes its files. */
interface StoreSource {
  readonly sha256: string
  /** Write the files into `staging`, a folder that does not exist yet; returns their paths, `/`-separated. */
  readonly write: (staging: string) => Promise<string[]>
  /** Runs once the store folder holds the files. */
  readonly placed?: () => Promise<void>
}

/** The files of a catalog folder without Finder metadata and Python bytecode, `/`-separated and sorted. */
async function catalogFiles(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name !== '.DS_Store' && !entry.parentPath.split(sep).includes('__pycache__'))
    .map(entry => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

/**
 * Files of a catalog folder as the source of a store folder: its SHA-256 covers every file's path and bytes, so the
 * store copy is replaced whenever a file changes.
 * @param folder - absolute catalog folder.
 * @param files - the files to copy, relative to `folder`, `/`-separated and sorted.
 * @returns the source.
 */
async function catalogFilesSource(folder: string, files: readonly string[]): Promise<StoreSource> {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\0`)
    hash.update(await readFile(join(folder, ...file.split('/'))))
    hash.update('\0')
  }
  return {
    sha256: hash.digest('hex'),
    write: async (staging) => {
      for (const file of files) {
        const target = join(staging, ...file.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(folder, ...file.split('/')), target, constants.COPYFILE_EXCL)
      }
      return [...files]
    },
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** The `version` of a `plugin.cfg`, if it names one. */
function pluginVersion(text: string): string | undefined {
  const match = /^\s*version\s*=\s*"((?:[^"\\]|\\.)*)"/mu.exec(text)
  return match?.[1]
}

/** The project-relative folder of a Godot add-on, with `/` separators. */
function addonFolder(addon: GameAddon): string {
  return `addons/${(addon.godot as NonNullable<GameAddon['godot']>).addonDir}`
}

/** The distinct paths of a list that no other path of the list contains. */
function outermost(paths: readonly string[]): string[] {
  const distinct = [...new Set(paths)]
  return distinct.filter(path => !distinct.some(other => path.startsWith(`${other}/`)))
}

/** A location inside the project as a project-relative path with `/` separators. */
function projectRelative(root: string, location: string): string {
  return relative(root, location).split(sep).join('/')
}

/**
 * Edit `project.godot` as it is now: read it, apply the edit, and write it when its text changed.
 * @param projectDir - absolute project folder.
 * @param edit - the edit.
 * @returns the text before and after the edit, or undefined when the project has no `project.godot`.
 */
async function editProject(projectDir: string, edit: (project: ProjectFile) => void): Promise<ProjectEdit | undefined> {
  const path = join(projectDir, 'project.godot')
  const before = await readText(path)
  if (before === undefined) return undefined
  const project = new ProjectFile(before)
  edit(project)
  const after = project.toString()
  if (after !== before) await writeFileAtomic(path, after, { mode: 0o644 })
  return { before, after }
}

/**
 * Undo an edit of `project.godot` in the file as it is now, keeping what others changed since (`revertEdit`).
 * @param projectDir - absolute project folder.
 * @param edit - the edit that {@link editProject} made.
 */
async function revertProject(projectDir: string, edit: ProjectEdit): Promise<void> {
  if (edit.after === edit.before) return
  const path = join(projectDir, 'project.godot')
  const current = await readText(path)
  if (current === undefined) return
  const next = revertEdit(current, edit.before, edit.after)
  if (next !== current) await writeFileAtomic(path, next, { mode: 0o644 })
}

/**
 * A new folder of one installation in the project's staging folder. Another installation removes the staging folder
 * when it is empty, so a staging folder that disappears before this one's folder is in it is created again.
 * @param projectDir - absolute project folder.
 * @returns the staging folder and the new folder inside it.
 * @throws {GameAddonPathError} when the staging folder leads outside the project.
 */
async function stagingFolder(projectDir: string): Promise<StagingFolder> {
  for (;;) {
    const root = await projectFolder(projectDir, `${STATE_DIR}/staging`)
    const dir = join(root, randomUUID())
    try {
      await mkdir(dir)
      return { root, dir }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

/**
 * Create the folder of one backup inside an add-on's backups, named by the time of the change, with `-2`, `-3`, and so
 * on added when an earlier change took the name.
 * @param parent - the add-on's backups folder.
 * @param time - the time of the change.
 * @returns the new folder's name.
 */
async function newBackupFolder(parent: string, time: Date): Promise<string> {
  const stamp = time.toISOString().replaceAll(':', '-')
  for (let count = 1; ; count += 1) {
    const name = count === 1 ? stamp : `${stamp}-${count}`
    try {
      await mkdir(join(parent, name))
      return name
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** The steps that undo a change of a project which failed part way, each with what stays when it cannot be undone. */
class Rollback {
  private readonly steps: { readonly undo: () => Promise<void>; readonly stays: string }[] = []

  /**
   * Add the undo of one step that succeeded.
   * @param undo - puts back what the step changed.
   * @param stays - what stays in the project when the undo fails.
   */
  add(undo: () => Promise<void>, stays: string): void {
    this.steps.push({ undo, stays })
  }

  /**
   * Undo every step, the last one first, going on past an undo that fails.
   * @param error - the failure of the change.
   * @param change - the change's name for the message, such as `installation`.
   * @returns `error` when every step was undone, else a {@link GameAddonError} that adds what stays in the project.
   */
  async undo(error: unknown, change: string): Promise<unknown> {
    const stays: string[] = []
    for (const step of [...this.steps].reverse()) {
      try {
        await step.undo()
      } catch (failure) {
        stays.push(`${step.stays} (${(failure as Error).message})`)
      }
    }
    if (stays.length === 0) return error
    return new GameAddonError(`${(error as Error).message} The ${change} could not be undone completely: ${stays.join('; ')}.`, { cause: error })
  }
}

/**
 * A one-line view of a catalog entry for the tools and the dialog.
 * @param addon - the catalog entry.
 * @param presence - whether a project has the add-on (installed, found without a record, or absent) and its version;
 *   omitted outside a project.
 * @returns the view.
 */
export function addonView(addon: GameAddon, presence?: GameAddonPresence): GameAddonView {
  return {
    id: addon.id,
    title: addon.title,
    host: addon.host,
    version: addon.version,
    summary: addon.summary,
    useWhen: addon.useWhen,
    ...addon.avoidWhen === undefined ? {} : { avoidWhen: addon.avoidWhen },
    tags: addon.tags,
    stages: addon.stages,
    license: addon.license,
    ...addon.credit === undefined ? {} : { credit: addon.credit },
    homepage: addon.homepage,
    ...addon.archive === undefined ? {} : { bytes: addon.archive.bytes + (addon.assets?.bytes ?? 0) },
    ...addon.assets === undefined
      ? {}
      : { assets: { license: addon.assets.license, bytes: addon.assets.bytes, homepage: addon.assets.homepage } },
    conflicts: addon.conflicts ?? [],
    ...presence === undefined ? {} : { presence },
  }
}

/** Installs, removes, and reports catalog add-ons in game projects. */
export class GameAddonManager {
  /**
   * @param options - catalog, downloads, Blender store, import step, clock, and change listener.
   */
  constructor(private readonly options: GameAddonManagerOptions) {}

  /** The loaded catalog. */
  get catalog(): GameAddonCatalog {
    return this.options.catalog
  }

  /**
   * How a project uses each catalog add-on.
   * @param projectDir - absolute project folder.
   * @returns the presence of every catalog add-on, by id.
   */
  async presence(projectDir: string): Promise<Map<string, GameAddonPresence>> {
    return await this.presenceOf(projectDir, await readRecord(projectDir))
  }

  /**
   * Search the catalog, with each add-on's presence in a project when one is given.
   * @param query - words and filters.
   * @param projectDir - absolute project folder, or undefined.
   * @returns matching add-ons, best first.
   */
  async search(query: CatalogQuery, projectDir: string | undefined): Promise<GameAddonView[]> {
    const presence = projectDir === undefined ? undefined : await this.presence(projectDir)
    return searchCatalog(this.catalog.entries, query).map(addon => addonView(addon, presence?.get(addon.id)))
  }

  /**
   * The add-ons whose guides apply to a project: installed ones and catalog add-ons found in its `addons` folder.
   * @param projectDir - absolute project folder.
   * @returns catalog ids in catalog order.
   */
  async guided(projectDir: string): Promise<string[]> {
    const presence = await this.presence(projectDir)
    return this.catalog.entries.filter(addon => presence.get(addon.id)?.state !== 'absent').map(addon => addon.id)
  }

  /**
   * The catalog entry of an id.
   * @param id - catalog id.
   * @returns the entry.
   * @throws {GameAddonError} for an unknown id.
   */
  entry(id: string): GameAddon {
    const addon = this.catalog.get(id)
    if (addon === undefined) throw new GameAddonError(`No catalog add-on has the id ${JSON.stringify(id)}; search the catalog for its id.`)
    return addon
  }

  /**
   * Install one catalog add-on into a project. Installations and removals of one project take turns while they change
   * its files.
   * @param projectDir - absolute folder that holds `project.godot`.
   * @param id - catalog id.
   * @param options - whether to replace a folder copied in by hand.
   * @param signal - cancellation; until the add-on takes its place it leaves the project as it was, afterwards it stops
   *   only the import of the project.
   * @returns the recorded add-on, the import's problems, and notes.
   * @throws {GameAddonError} for an unknown id, a conflicting add-on, an occupied folder or autoload name, or a failed
   *   step; a failed step is undone, and the message names what could not be put back.
   */
  async install(projectDir: string, id: string, options: InstallOptions, signal: AbortSignal): Promise<GameAddonInstallResult> {
    const addon = this.entry(id)
    return addon.host === 'godot'
      ? await this.installGodot(projectDir, addon, options, signal)
      : await this.installBlender(projectDir, addon, signal)
  }

  /**
   * Remove one add-on from a project: an installed one by its record, or a catalog add-on found in `res://addons/`. The
   * add-on's folder moves to a new backup folder of the add-on, `.wasdengine/backups/<id>/<time>/`, beside the backups
   * of earlier changes.
   * @param projectDir - absolute folder that holds `project.godot`.
   * @param id - catalog id.
   * @param signal - cancellation before the removal changes the project.
   * @returns the paths taken out, their backup folder, and the project files that still name the add-on.
   * @throws {GameAddonError} when the project does not have the add-on, or when its record lists a path outside the
   *   add-on's folder; nothing changes then. A failed step is undone, and the message names what could not be put back.
   * @throws {GameAddonPathError} when a folder on the way to the add-on leads outside the project; nothing changes then.
   */
  async remove(projectDir: string, id: string, signal: AbortSignal): Promise<GameAddonRemoveResult> {
    const addon = this.entry(id)
    // A project without the add-on is refused before the scan.
    await this.removalPlan(projectDir, addon, await readRecord(projectDir))
    // The scan reads only files outside the add-on's folder, which the removal leaves as they are, so it runs before
    // the removal, where a Stop changes nothing.
    const references = addon.godot === undefined ? [] : await this.references(projectDir, addon, signal)
    const removal = await lockRecord(projectDir, async record => await this.commitRemoval(projectDir, addon, record), signal)
    this.options.changed(projectDir)
    return { id, projectDir, removed: removal.removed, ...removal.backup === undefined ? {} : { backup: removal.backup }, references }
  }

  /**
   * Move entries that a removal or a replacement takes out of a project into a new backup folder of the add-on,
   * `.wasdengine/backups/<id>/<time>/`, each at its project-relative path; no earlier backup is changed. The backups
   * folder holds a `.gitignore` that keeps it out of version control.
   * @param projectDir - absolute project folder.
   * @param id - catalog id.
   * @param taken - each entry's project-relative path and current location.
   * @param rollback - receives the undo of each move.
   * @returns the project-relative backup folder.
   * @throws {GameAddonPathError} when the backups folder leads outside the project.
   */
  private async keepBackup(projectDir: string, id: string, taken: readonly TakenEntry[], rollback: Rollback): Promise<string> {
    const backups = await projectFolder(projectDir, BACKUPS_DIR)
    try {
      // Exclusive creation never writes through a link that the project put there.
      await writeFile(join(backups, '.gitignore'), BACKUPS_IGNORE, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const parent = await projectFolder(projectDir, `${BACKUPS_DIR}/${id}`)
    const name = await newBackupFolder(parent, this.options.now())
    const folder = join(parent, name)
    const backup = `${BACKUPS_DIR}/${id}/${name}`
    rollback.add(async () => {
      await removeEmptyFolders(folder)
      await removeEmpty(parent)
    }, `the empty folders of ${backup}`)
    for (const entry of taken) {
      const target = join(folder, ...entry.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await rename(entry.location, target)
      rollback.add(async () => { await rename(target, entry.location) }, `${entry.path} is in ${backup}/${entry.path}`)
    }
    return backup
  }

  /**
   * Move the add-on folder that an installation replaced from the installation's trash to a new backup of the add-on.
   * @param projectDir - absolute project folder.
   * @param id - catalog id.
   * @param replaced - the folder's project-relative path and its place in the trash.
   * @returns a note that says where the replaced folder is, also when it could not move and stays in the trash.
   */
  private async keepReplaced(projectDir: string, id: string, replaced: TakenEntry): Promise<string> {
    const rollback = new Rollback()
    let backup: string
    try {
      backup = await this.keepBackup(projectDir, id, [replaced], rollback)
    } catch (error) {
      // The installation is complete, so a failed move only leaves the replaced folder in the trash, which the note names.
      await rollback.undo(error, 'move to the backup')
      return `The ${replaced.path} folder it replaced stays in ${STATE_DIR}/trash/${basename(replaced.location)}, because it could not move to the add-on's backup: ${(error as Error).message}`
    }
    await removeEmpty(dirname(replaced.location)).catch((error: unknown) => {
      // An empty trash folder that cannot be removed holds nothing; the installation is complete.
      void error
    })
    return `The ${replaced.path} folder it replaced is kept in ${backup}/${replaced.path}.`
  }

  private async installGodot(
    projectDir: string,
    addon: GameAddon,
    options: InstallOptions,
    signal: AbortSignal,
  ): Promise<GameAddonInstallResult> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    let staged: StagedAddon | undefined
    let commit: CommittedInstall | undefined
    try {
      // The check before the download refuses an installation without downloading anything; the check under the
      // record's lock decides.
      if (await this.checkGodotInstall(projectDir, addon, options, await readRecord(projectDir)) === undefined) {
        staged = await this.stage(projectDir, addon, signal)
      }
      for (;;) {
        const current = staged
        commit = await lockRecord(projectDir, async record => await this.commitGodot(projectDir, addon, options, record, current), signal)
        if (commit !== undefined) break
        // Another change took the add-on out after the first check found it in place.
        staged = await this.stage(projectDir, addon, signal)
      }
    } finally {
      if (staged !== undefined) await this.unstage(staged)
    }
    this.options.changed(projectDir)
    const notes = [...commit.notes]
    const importIssues: string[] = []
    const passes = godot.importTwice === true ? 2 : 1
    for (let pass = 0; pass < passes; pass += 1) {
      const report = await this.options.importProject(projectDir, signal)
      if (report === undefined) {
        notes.push('No Godot runtime is installed, so the project was not imported; godot_run imports it once Godot is installed.')
        break
      }
      if (pass === passes - 1) importIssues.push(...report.issues.slice(0, LISTED_ISSUES))
    }
    if (addon.credit !== undefined) notes.push(`Its license requires this credit in the game: ${addon.credit}`)
    return { addon: commit.addon, projectDir, unchanged: commit.unchanged, importIssues, notes }
  }

  /**
   * Check that a Godot installation may change the project as it is now.
   * @returns the add-on's record entry when the project has the catalog's version with its folder in place, else
   *   undefined.
   * @throws {GameAddonError} for a conflicting add-on, a project without `project.godot`, a copy without a record when
   *   `replace` is not set, or an autoload name that another script holds.
   */
  private async checkGodotInstall(
    projectDir: string,
    addon: GameAddon,
    options: InstallOptions,
    entries: readonly InstalledGameAddon[],
  ): Promise<InstalledGameAddon | undefined> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const folderPath = addonFolder(addon)
    const presence = await this.presenceOf(projectDir, entries)
    this.checkConflicts(addon, presence)
    const projectText = await readText(join(projectDir, 'project.godot'))
    if (projectText === undefined) throw new GameAddonError(`No project.godot in ${projectDir}.`)
    const own = presence.get(addon.id) ?? { state: 'absent' }
    if (own.state === 'found' && options.replace !== true) {
      const version = own.version === undefined ? '' : ` (version ${own.version})`
      throw new GameAddonError(`${folderPath}${version} is already in the project without a WASD Engine record. Install with replace: true to replace it with ${addon.title} ${addon.version}, or keep it: its guide is listed either way.`)
    }
    const project = new ProjectFile(projectText)
    for (const autoload of godot.autoloads ?? []) {
      const current = project.autoload(autoload.name)
      if (current !== undefined && current !== autoload.path) {
        throw new GameAddonError(`The autoload ${autoload.name} already points to ${current}; ${addon.title} needs that name for ${autoload.path}. Rename or remove that autoload first.`)
      }
    }
    // A recorded add-on whose folder was deleted installs again.
    if (own.state !== 'installed' || own.version !== addon.version || await projectEntry(projectDir, folderPath) === undefined) return undefined
    return entries.find(item => item.id === addon.id)
  }

  /**
   * Download a Godot add-on's archive and unpack its folder into a new staging folder of the project, with its license
   * file and the files of its overlay folders; an add-on without an archive is its overlay folders' files alone.
   * @returns the staged folder; on failure nothing of it is left.
   */
  private async stage(projectDir: string, addon: GameAddon, signal: AbortSignal): Promise<StagedAddon> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const archive = addon.archive
    const archivePath = archive === undefined ? undefined : await cachedArchive(archive, this.options.downloads, signal)
    const staging = await stagingFolder(projectDir)
    const folder = join(staging.dir, godot.addonDir)
    try {
      let licenseText = standardLicenseText(addon.license, addon.copyright)
      if (archive === undefined || archivePath === undefined) {
        await mkdir(folder, { recursive: true })
      } else {
        const files = await unpackFolder(archivePath, archive.root, folder, signal)
        licenseText = await this.licenseText(addon, archivePath, folder, files)
        const rootPrefix = archive.root === '' ? '' : `${archive.root}/`
        const licenseOutside = archive.license !== undefined && !archive.license.startsWith(rootPrefix)
        if (licenseOutside && licenseText !== undefined && !files.some(file => LICENSE_NAMES.test(file))) {
          await writeFile(join(folder, 'LICENSE'), licenseText, { flag: 'wx' })
        }
      }
      for (const overlay of godot.overlay ?? []) await this.addOverlay(addon, overlay, folder, signal)
      signal.throwIfAborted()
      return { ...staging, folder, licenseText }
    } catch (error) {
      await this.unstage(staging)
      throw error
    }
  }

  /** Delete an installation's staging folder, and the project's staging folder when no other installation uses it. */
  private async unstage(staging: StagingFolder): Promise<void> {
    const removal = rm(staging.dir, { recursive: true, force: true }).then(async () => { await removeEmpty(staging.root) })
    await removal.catch((error: unknown) => {
      // Files that another program holds, as Windows antivirus can, stay as unused files in .wasdengine/staging; the
      // installation's outcome does not depend on them.
      void error
    })
  }

  /**
   * The locked step of a Godot installation: check the project again, then move the staged folder into place, enable
   * the add-on in `project.godot`, write its notice, and record it, or, when the project has the catalog's version in
   * place, only write lost `project.godot` entries again. A failed step undoes the steps before it.
   * @param staged - the unpacked add-on, or undefined when the first check found it in place.
   * @returns what was recorded, or undefined when the add-on needs a staged folder that the caller has not made.
   */
  private async commitGodot(
    projectDir: string,
    addon: GameAddon,
    options: InstallOptions,
    record: HeldRecord,
    staged: StagedAddon | undefined,
  ): Promise<CommittedInstall | undefined> {
    const current = await this.checkGodotInstall(projectDir, addon, options, record.entries)
    if (current !== undefined) {
      // A reinstall at the same version only repairs what enabling wrote.
      const repair = await editProject(projectDir, (project) => { this.enableInProject(project, addon) })
      return { addon: current, unchanged: true, notes: repair === undefined || repair.after === repair.before ? [] : [REPAIR_NOTE] }
    }
    if (staged === undefined) return undefined
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const folderPath = addonFolder(addon)
    const installed: InstalledGameAddon = {
      id: addon.id,
      title: addon.title,
      host: addon.host,
      version: addon.version,
      license: addon.license,
      ...addon.archive === undefined ? {} : { source: addon.archive.url, sha256: addon.archive.sha256 },
      paths: [folderPath],
      installedAt: this.options.now().toISOString(),
    }
    const root = await realpath(projectDir)
    const rollback = new Rollback()
    // The add-on folder that the installation replaced, until it moves to the add-on's backup.
    let replaced: TakenEntry | undefined
    try {
      const addonsExisted = await projectEntry(projectDir, 'addons') !== undefined
      const addons = await projectFolder(projectDir, 'addons')
      if (!addonsExisted) rollback.add(async () => { await removeEmpty(addons) }, 'an empty addons folder')
      const previous = await projectEntry(projectDir, folderPath)
      if (previous !== undefined) {
        const trashRoot = await projectFolder(projectDir, `${STATE_DIR}/trash`)
        rollback.add(async () => { await removeEmpty(trashRoot) }, `an empty ${STATE_DIR}/trash folder`)
        const trash = join(trashRoot, randomUUID())
        await rename(previous, trash)
        rollback.add(async () => { await rename(trash, previous) }, `the ${folderPath} folder it replaced is in ${projectRelative(root, trash)}`)
        replaced = { path: folderPath, location: trash }
      }
      const target = join(addons, godot.addonDir)
      await rename(staged.folder, target)
      rollback.add(async () => { await rename(target, staged.folder) }, `${folderPath} holds ${addon.title} ${addon.version}`)
      const enabled = await editProject(projectDir, (project) => { this.enableInProject(project, addon) })
      if (enabled === undefined) throw new GameAddonError(`No project.godot in ${projectDir}.`)
      rollback.add(async () => { await revertProject(projectDir, enabled) }, `project.godot enables ${addon.title}`)
      const notice = await readNotice(projectDir, addon.id)
      await writeNotice(projectDir, noticeSection(addon, staged.licenseText), addon.id)
      rollback.add(async () => {
        if (notice === undefined) await removeNotice(projectDir, addon.id)
        else await writeNotice(projectDir, notice, addon.id)
      }, `${NOTICES_FILE} holds the notice of ${addon.title} ${addon.version}`)
      await record.write([...record.entries.filter(item => item.id !== addon.id), installed])
    } catch (error) {
      throw await rollback.undo(error, 'installation')
    }
    const notes = replaced === undefined ? [] : [await this.keepReplaced(projectDir, addon.id, replaced)]
    return { addon: installed, unchanged: false, notes }
  }

  private async installBlender(projectDir: string, addon: GameAddon, signal: AbortSignal): Promise<GameAddonInstallResult> {
    const blender = addon.blender as NonNullable<GameAddon['blender']>
    // The check before the downloads refuses a conflicting add-on without downloading anything; the check under the
    // record's lock decides.
    this.checkConflicts(addon, await this.presence(projectDir))
    await this.writeStoreIndex(signal)
    if (addon.archive !== undefined) {
      const archive = addon.archive
      await this.storeFolder(join(this.options.blenderStore, blender.module), addon, this.archiveSource(archive, signal), (files) => {
        if (!files.includes('blender_manifest.toml') && !files.includes('__init__.py')) {
          const root = archive.root === '' ? 'its root' : archive.root
          throw new GameAddonError(`The archive of ${addon.title} has neither blender_manifest.toml nor __init__.py under ${root}.`)
        }
      }, signal)
    } else if (blender.files !== undefined) {
      const folder = join(this.catalog.dir, ...blender.files.split('/'))
      const source = await catalogFilesSource(folder, await catalogFiles(folder))
      await this.storeFolder(join(this.options.blenderStore, blender.module), addon, source, () => undefined, signal)
    }
    if (addon.assets !== undefined) {
      await this.storeFolder(this.assetsFolder(addon), addon, this.archiveSource(addon.assets, signal), () => undefined, signal)
    }
    const installed: InstalledGameAddon = {
      id: addon.id,
      title: addon.title,
      host: addon.host,
      version: addon.version,
      license: addon.license,
      ...addon.archive === undefined ? {} : { source: addon.archive.url, sha256: addon.archive.sha256 },
      paths: [],
      installedAt: this.options.now().toISOString(),
    }
    const commit = await lockRecord(projectDir, async (record): Promise<CommittedInstall> => {
      this.checkConflicts(addon, await this.presenceOf(projectDir, record.entries))
      const previous = record.entries.find(item => item.id === addon.id)
      if (previous !== undefined && previous.version === addon.version) return { addon: previous, unchanged: true, notes: [] }
      await record.write([...record.entries.filter(item => item.id !== addon.id), installed])
      return { addon: installed, unchanged: false, notes: [] }
    }, signal)
    this.options.changed(projectDir)
    return {
      addon: commit.addon,
      projectDir,
      unchanged: commit.unchanged,
      importIssues: [],
      notes: [`In each Blender Session, run \`import wasd_addons; wasd_addons.enable("${addon.id}")\` with mcp__wasd_blender__execute_python before using ${addon.title}.`],
    }
  }

  /** The presence of every catalog add-on in a project with the given record entries. */
  private async presenceOf(projectDir: string, entries: readonly InstalledGameAddon[]): Promise<Map<string, GameAddonPresence>> {
    const recorded = new Map(entries.map(addon => [addon.id, addon]))
    const result = new Map<string, GameAddonPresence>()
    for (const addon of this.catalog.entries) {
      const record = recorded.get(addon.id)
      if (record !== undefined) {
        result.set(addon.id, { state: 'installed', version: record.version })
        continue
      }
      if (addon.godot !== undefined) {
        const folder = join(projectDir, ...addonFolder(addon).split('/'))
        if (await exists(folder)) {
          const cfg = addon.godot.plugin === undefined ? undefined : await readText(join(folder, addon.godot.plugin))
          const version = cfg === undefined ? undefined : pluginVersion(cfg)
          result.set(addon.id, { state: 'found', ...version === undefined ? {} : { version } })
          continue
        }
      }
      result.set(addon.id, { state: 'absent' })
    }
    return result
  }

  /**
   * Refuse an add-on whose conflict the project has.
   * @throws {GameAddonError} naming the add-on in the project that does the same job.
   */
  private checkConflicts(addon: GameAddon, presence: ReadonlyMap<string, GameAddonPresence>): void {
    for (const other of addon.conflicts ?? []) {
      const state = presence.get(other)?.state
      if (state !== undefined && state !== 'absent') {
        const title = this.catalog.get(other)?.title ?? other
        throw new GameAddonError(`${title} (${other}) is already in this project and does the same job as ${addon.title}; keep it, or remove it first.`)
      }
    }
  }

  /**
   * What a removal takes out of a project as it is now.
   * @returns the entries of the add-on's recorded paths that exist, each with its location; none for a Blender add-on.
   * @throws {GameAddonError} when the project does not have the add-on, or when its record lists a path outside the
   *   add-on's folder.
   * @throws {GameAddonPathError} when a folder on the way to the add-on leads outside the project.
   */
  private async removalPlan(projectDir: string, addon: GameAddon, entries: readonly InstalledGameAddon[]): Promise<TakenEntry[]> {
    const record = entries.find(item => item.id === addon.id)
    const presence = (await this.presenceOf(projectDir, entries)).get(addon.id)
    if (record === undefined && presence?.state !== 'found') throw new GameAddonError(`${addon.title} is not in this project.`)
    if (addon.godot === undefined) return []
    const folder = addonFolder(addon)
    const paths = record?.paths ?? [folder]
    const foreign = paths.filter(path => path !== folder && !path.startsWith(`${folder}/`))
    if (foreign.length > 0) {
      throw new GameAddonError(`${STATE_DIR}/${RECORD_FILE} lists ${foreign.join(', ')} for ${addon.title}, outside its folder ${folder}, so nothing was removed. Fix or delete that entry of the record.`)
    }
    const taken: TakenEntry[] = []
    for (const path of outermost(paths)) {
      const location = await projectEntry(projectDir, path)
      if (location !== undefined) taken.push({ path, location })
    }
    return taken
  }

  /**
   * The locked step of a removal: check the project again, then move the add-on's folder to a new backup, take its
   * entries out of `project.godot` and its notice out of the notices, and drop it from the record. A failed step undoes
   * the steps before it.
   * @returns the paths taken out and their backup folder.
   */
  private async commitRemoval(projectDir: string, addon: GameAddon, record: HeldRecord): Promise<CommittedRemoval> {
    const taken = await this.removalPlan(projectDir, addon, record.entries)
    const rollback = new Rollback()
    try {
      const backup = taken.length === 0 ? undefined : await this.keepBackup(projectDir, addon.id, taken, rollback)
      if (addon.godot !== undefined) {
        const others = [...(await this.presenceOf(projectDir, record.entries)).entries()]
          .filter(([other, state]) => other !== addon.id && state.state !== 'absent')
          .flatMap(([other]) => this.catalog.get(other)?.godot?.settings ?? [])
        const shared = new Set(others.map(setting => `${setting.section}/${setting.key}`))
        const disabled = await editProject(projectDir, (project) => { this.disableInProject(project, addon, shared) })
        if (disabled !== undefined) rollback.add(async () => { await revertProject(projectDir, disabled) }, `project.godot no longer enables ${addon.title}`)
        const notice = await removeNotice(projectDir, addon.id)
        if (notice !== undefined) rollback.add(async () => { await writeNotice(projectDir, notice, addon.id) }, `${NOTICES_FILE} no longer holds the notice of ${addon.title}`)
      }
      if (record.entries.some(item => item.id === addon.id)) await record.write(record.entries.filter(item => item.id !== addon.id))
      return { removed: taken.map(entry => entry.path), ...backup === undefined ? {} : { backup } }
    } catch (error) {
      throw await rollback.undo(error, 'removal')
    }
  }

  /** The folder of a Blender add-on's asset pack. */
  private assetsFolder(addon: GameAddon): string {
    return join(this.options.assetsDir, addon.id)
  }

  /**
   * Write the store index that Blender workers read to enable add-ons by id: each Blender add-on's module, kind, and
   * version, and its setup script and asset folder as absolute paths. The index names no catalog file: a worker runs
   * the setup script with its own Python, which cannot read the catalog where the Desktop app keeps it, inside
   * `app.asar`, so each setup script is first copied into the store's {@link STORE_SETUP_DIR}, like a store folder,
   * with a marker that names the SHA-256 of its path and bytes. The whole index is replaced, so a call also replaces an
   * index that names catalog files, as earlier versions wrote it.
   * @param signal - cancellation while a copy waits for its folder's lock.
   */
  async writeStoreIndex(signal: AbortSignal): Promise<void> {
    const addons: Record<string, { module: string; kind: string; version: string; setup?: string; assets?: string }> = {}
    for (const addon of this.catalog.entries) {
      if (addon.blender === undefined) continue
      const setup = addon.blender.setup === undefined ? undefined : await this.storeSetup(addon, addon.blender.setup, signal)
      addons[addon.id] = {
        module: addon.blender.module,
        kind: addon.blender.kind,
        version: addon.version,
        ...setup === undefined ? {} : { setup },
        ...addon.assets === undefined ? {} : { assets: this.assetsFolder(addon) },
      }
    }
    await writeFileAtomic(join(this.options.blenderStore, STORE_INDEX), `${JSON.stringify({ format: 1, addons }, null, 2)}\n`, { mode: 0o644 })
  }

  /**
   * Copy a Blender add-on's setup script into its folder of the store's {@link STORE_SETUP_DIR}, unless that folder
   * already holds the script as the catalog has it.
   * @param addon - the catalog entry.
   * @param script - the setup script's file name in the entry's catalog folder.
   * @param signal - cancellation while the copy waits for its folder's lock.
   * @returns the absolute path of the copy.
   */
  private async storeSetup(addon: GameAddon, script: string, signal: AbortSignal): Promise<string> {
    const folder = join(this.options.blenderStore, STORE_SETUP_DIR, addon.id)
    await this.storeFolder(folder, addon, await catalogFilesSource(this.catalog.folder(addon.id), [script]), () => undefined, signal)
    return join(folder, script)
  }

  /** An archive as the source of a store folder: it downloads only when the folder does not hold it yet. */
  private archiveSource(
    archive: { readonly url: string; readonly sha256: string; readonly bytes: number; readonly root: string },
    signal: AbortSignal,
  ): StoreSource {
    let archivePath: string | undefined
    return {
      sha256: archive.sha256,
      write: async (staging) => {
        archivePath = await cachedArchive(archive, this.options.downloads, signal)
        return await unpackFolder(archivePath, archive.root, staging, signal)
      },
      placed: async () => {
        if (archivePath !== undefined) await rm(archivePath, { force: true })
      },
    }
  }

  /**
   * Fill a shared folder from its source once per content, under that folder's lock: a marker names the SHA-256 of
   * what the folder came from, a matching marker skips the work, and the source's `placed` step runs once the folder
   * holds it.
   */
  private async storeFolder(
    target: string,
    addon: GameAddon,
    source: StoreSource,
    check: (files: readonly string[]) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const parent = dirname(target)
    await mkdir(parent, { recursive: true })
    await withFileLock(target, async () => {
      const marker = await readText(join(target, STORE_MARKER))
      if (marker !== undefined && (JSON.parse(marker) as { sha256?: unknown }).sha256 === source.sha256) return
      const staging = join(parent, `.staging-${randomUUID()}`)
      const trash = join(parent, `.trash-${randomUUID()}`)
      let movedOld = false
      let placed = false
      try {
        check(await source.write(staging))
        signal.throwIfAborted()
        await writeFile(join(staging, STORE_MARKER), `${JSON.stringify({ id: addon.id, version: addon.version, sha256: source.sha256 })}\n`, { flag: 'wx' })
        if (await exists(target)) {
          await rename(target, trash)
          movedOld = true
        }
        await rename(staging, target)
        placed = true
      } catch (error) {
        // The version that was in place goes back when the new one could not take its place.
        if (movedOld && !placed) await rename(trash, target)
        throw error
      } finally {
        await rm(staging, { recursive: true, force: true })
        if (!movedOld || placed) await rm(trash, { recursive: true, force: true })
      }
      await source.placed?.()
    }, { signal, waitMs: 120_000 })
  }

  /**
   * Copy the files of one catalog overlay folder into an unpacked add-on folder, keeping their relative paths.
   * @throws {GameAddonError} when a file would replace one that the archive put there.
   */
  private async addOverlay(addon: GameAddon, overlay: string, target: string, signal: AbortSignal): Promise<void> {
    const source = join(this.catalog.dir, ...overlay.split('/'))
    for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name === '.DS_Store') continue
      signal.throwIfAborted()
      const path = relative(source, join(entry.parentPath, entry.name))
      await mkdir(join(target, dirname(path)), { recursive: true })
      try {
        await copyFile(join(entry.parentPath, entry.name), join(target, path), constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new GameAddonError(`The catalog file ${overlay}/${path.split(sep).join('/')} would replace a file of the ${addon.title} archive.`)
      }
    }
  }

  /**
   * The add-on's license text: the archive's license file, else a license file at the top of the installed folder,
   * else the standard text of its license with its copyright line.
   */
  private async licenseText(addon: GameAddon, archivePath: string, staging: string, files: readonly string[]): Promise<string | undefined> {
    const archive = addon.archive as NonNullable<GameAddon['archive']>
    if (archive.license !== undefined) return new TextDecoder().decode(await readArchiveFile(archivePath, archive.license))
    const top = files.find(file => !file.includes('/') && LICENSE_NAMES.test(file))
    return top === undefined ? standardLicenseText(addon.license, addon.copyright) : await readFile(join(staging, top), 'utf8')
  }

  private enableInProject(project: ProjectFile, addon: GameAddon): void {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    if (godot.plugin !== undefined) project.enablePlugin(`res://addons/${godot.addonDir}/${godot.plugin}`)
    for (const autoload of godot.autoloads ?? []) {
      if (project.autoload(autoload.name) !== autoload.path) project.addAutoload(autoload.name, autoload.path)
    }
    for (const setting of godot.settings ?? []) project.set(setting.section, setting.key, setting.value)
  }

  /** Take an add-on's plugin, autoloads, and settings out of `project.godot`, keeping settings in `shared`. */
  private disableInProject(project: ProjectFile, addon: GameAddon, shared: ReadonlySet<string>): void {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    if (godot.plugin !== undefined) project.disablePlugin(`res://addons/${godot.addonDir}/${godot.plugin}`)
    for (const autoload of godot.autoloads ?? []) {
      if (project.autoload(autoload.name) === autoload.path) project.remove('autoload', autoload.name)
    }
    for (const setting of godot.settings ?? []) {
      if (!shared.has(`${setting.section}/${setting.key}`)) project.remove(setting.section, setting.key)
    }
  }

  /** Project files outside the add-on's folder that name its folder or its autoloads. */
  private async references(projectDir: string, addon: GameAddon, signal: AbortSignal): Promise<string[]> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const folderPrefix = `res://addons/${godot.addonDir}/`
    const names = (godot.autoloads ?? []).map(autoload => new RegExp(`\\b${autoload.name}\\b`, 'u'))
    const found: string[] = []
    let read = 0
    const visit = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (found.length >= LISTED_ISSUES || read >= REFERENCE_SCAN_FILES) return
        signal.throwIfAborted()
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name) && path !== join(projectDir, 'addons', godot.addonDir)) await visit(path)
          continue
        }
        if (!entry.isFile() || !REFERENCE_FILES.test(entry.name) || path === join(projectDir, 'project.godot')) continue
        read += 1
        const text = await readText(path)
        if (text === undefined) continue
        const isScript = entry.name.endsWith('.gd') || entry.name.endsWith('.cs')
        if (text.includes(folderPrefix) || (isScript && names.some(name => name.test(text)))) {
          found.push(relative(projectDir, path).split(sep).join('/'))
        }
      }
    }
    await visit(projectDir)
    return found
  }
}
