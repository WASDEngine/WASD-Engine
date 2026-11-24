/**
 * Installation and removal of catalog add-ons, and what a project has. A Godot add-on downloads and unpacks from its
 * checked archive into a staging folder inside the project and gains the files of its catalog overlay folders, or, when
 * WASD Engine wrote it, consists of those files alone; then,
 * holding the record's lock, the installer checks the project again, moves the folder into `res://addons/<folder>/`,
 * enables it in `project.godot` the way the editor's plugin switch does, a setting whose value is a Dictionary by adding
 * its entries to the project's own, writes its license into the project's notices, and records it in
 * `.wasdengine/addons.json` with the values its settings replaced, which a note of the result names when the project
 * had its own, and afterwards imports the project so the add-on's errors show at once. `project.godot` and the notices
 * are read and written at the moment each changes, and a step that fails puts
 * back only what the change itself did, keeping what others changed meanwhile; what it cannot put back, it names. A
 * removal scans the project for files that use the add-on first, then, holding the record's lock, takes out only paths
 * in the add-on's own folder in the same way, and gives each setting it still holds the add-on's value the value it
 * had before the installation. Every folder that a removal or a replacement takes out moves to a new
 * backup folder of the add-on, `.wasdengine/backups/<id>/<time>/`, and stays there. Every change stays inside the
 * project, whatever symbolic links lie on its way (`paths.ts`). A Blender extension unpacks once into the shared add-on
 * store, or is copied there from its catalog files when WASD Engine wrote it, and every Blender worker enables it by id;
 * its asset pack, if it has one, unpacks into the asset folder beside the store; its project keeps only the record.
 * Their archives then leave the cache. The store's index names setup scripts by their copies in the store, never by a
 * catalog file, which a worker's Python cannot read inside the Desktop app's `app.asar`. An add-on that the user turned
 * off in the Add-ons dialog is left out of searches and refused by installations, and the store's index marks it, so
 * workers refuse to enable it; a removal still takes it out of a project.
 * @module @deepseek-ai/dsh-game-addons/src/manager
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { cachedArchive, readArchiveFile, unpackFolder, type ArchiveDownloads, type LocalArchive } from './archive.ts'
import { searchCatalog, type CatalogQuery, type GameAddonCatalog } from './catalog.ts'
import { GameAddonError } from './errors.ts'
import { standardLicenseText } from './licenses.ts'
import { NOTICES_FILE, noticeSection, readNotice, removeNotice, writeNotice } from './notices.ts'
import { projectEntry, projectFolder, readProjectText } from './paths.ts'
import { PROJECT_ROOT_SKIPPED, rebaseProjectPaths } from './project-root.ts'
import { dictionaryEntries, dictionaryLiteral, ProjectFile, revertEdit, type DictionaryEntry } from './project-file.ts'
import { lockRecord, readRecord, RECORD_FILE, SETTINGS_FILE, STATE_DIR, type HeldRecord, type SettingBefore } from './record.ts'
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

/** One Blender add-on in the store index that workers read. */
interface StoreIndexEntry {
  readonly module: string
  readonly kind: string
  readonly version: string
  /** Absolute path of the store's copy of the setup script. */
  readonly setup?: string
  /** Absolute folder of the asset pack. */
  readonly assets?: string
  /** False for an add-on that the user turned off; absent otherwise. */
  readonly allowed?: false
  /** The refusal that workers raise for an add-on that is off. */
  readonly message?: string
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
  /**
   * Whether agents may use an add-on, read at every call.
   * @param id - catalog id.
   * @returns false for an add-on that the user turned off in the Add-ons dialog.
   */
  readonly allowed: (id: string) => boolean
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

/**
 * The SHA-256 that a shared folder's marker names; undefined for a missing or damaged marker, such as one a crash cut
 * short, whose folder is then filled again rather than blocking every installation.
 * @param text - the marker's text, or undefined when there is none.
 * @returns the digest, or undefined.
 */
function markedSha256(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_damaged) {
    // SyntaxError: a damaged marker names no content.
    return undefined
  }
  const sha256 = typeof parsed === 'object' && parsed !== null && 'sha256' in parsed ? parsed.sha256 : undefined
  return typeof sha256 === 'string' ? sha256 : undefined
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

/** One project setting of a catalog add-on. */
type GodotSetting = NonNullable<NonNullable<GameAddon['godot']>['settings']>[number]

/** Whether two value texts are the same value, as Godot writes them again with other spacing. */
function sameValue(left: string, right: string): boolean {
  return left.trim() === right.trim()
}

/** Whether two Dictionaries hold the same entries in the same order. */
function sameEntries(left: readonly DictionaryEntry[], right: readonly DictionaryEntry[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.key === right[index]?.key && sameValue(entry.value, right[index].value))
}

/**
 * What an add-on's settings set, as ids that others' settings share: each setting, or each entry of a Dictionary.
 * @param settings - the add-on's settings.
 * @returns the ids.
 */
function settingIds(settings: readonly GodotSetting[]): string[] {
  return settings.flatMap((setting) => {
    const entries = dictionaryEntries(setting.value)
    const id = `${setting.section}\n${setting.key}`
    return entries === undefined ? [id] : entries.map(entry => `${id}\n${entry.key}`)
  })
}

/**
 * The values an add-on's settings hold in a project before its installation changes them, to remember with it: the
 * remembered values of an earlier installation, with the values of settings it did not have.
 * @param project - `project.godot` before the installation.
 * @param settings - the add-on's settings.
 * @param remembered - what an earlier installation remembered.
 * @param reinstall - whether the project has the add-on already, whose settings then hold the add-on's values.
 * @returns what to remember, or undefined when an earlier installation remembered nothing, so nothing can be known.
 */
function settingsBefore(
  project: ProjectFile,
  settings: readonly GodotSetting[],
  remembered: readonly SettingBefore[] | undefined,
  reinstall: boolean,
): SettingBefore[] | undefined {
  if (remembered === undefined && reinstall) return undefined
  const known = [...remembered ?? []]
  for (const setting of settings) {
    if (known.some(entry => entry.section === setting.section && entry.key === setting.key)) continue
    const before = project.get(setting.section, setting.key)
    known.push({ section: setting.section, key: setting.key, ...before === undefined ? {} : { before } })
  }
  return known
}

/**
 * The settings whose own value a project had before an add-on's installation and now holds the add-on's: a setting
 * whose remembered value differs from the one it holds now, or a Dictionary setting whose remembered entry of a key
 * that the add-on sets differs from the entry it holds now. A setting that the project did not have, or a Dictionary
 * entry that the add-on only adds, replaced nothing.
 * @param project - `project.godot` once the installation enabled the add-on.
 * @param settings - the add-on's settings.
 * @param remembered - the values the settings held before the add-on's installation.
 * @returns each replaced setting as `[section] key`, in the add-on's order.
 */
function replacedSettings(project: ProjectFile, settings: readonly GodotSetting[], remembered: readonly SettingBefore[]): string[] {
  return settings.filter((setting) => {
    const before = remembered.find(entry => entry.section === setting.section && entry.key === setting.key)?.before
    const now = project.get(setting.section, setting.key)
    if (before === undefined || now === undefined) return false
    const own = dictionaryEntries(setting.value)
    const earlier = dictionaryEntries(before)
    const held = dictionaryEntries(now)
    if (own === undefined || earlier === undefined || held === undefined) return !sameValue(before, now)
    return own.some((entry) => {
      const was = earlier.find(item => item.key === entry.key)
      const is = held.find(item => item.key === entry.key)
      return was !== undefined && is !== undefined && !sameValue(was.value, is.value)
    })
  }).map(setting => `[${setting.section}] ${setting.key}`)
}

/**
 * The installation's note on the project's own setting values that the add-on's replaced, for the model.
 * @param replaced - the settings as {@link replacedSettings} names them.
 * @returns the note.
 */
function replacedNote(replaced: readonly string[]): string {
  return `It replaced the project's own values of these project.godot settings: ${replaced.join(', ')}. Removing the add-on puts back each one that still holds the add-on's value.`
}

/**
 * Edit `project.godot` as it is now: read it, apply the edit, and write it when its text changed.
 * @param projectDir - absolute project folder.
 * @param edit - the edit.
 * @returns the text before and after the edit, or undefined when the project has no `project.godot`.
 */
async function editProject(projectDir: string, edit: (project: ProjectFile) => void): Promise<ProjectEdit | undefined> {
  const path = join(projectDir, 'project.godot')
  const before = await readProjectText(projectDir, 'project.godot')
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
  const current = await readProjectText(projectDir, 'project.godot')
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
   * @returns `error` when every step was undone, else a {@link GameAddonError} with the code
   *   `GAME_ADDON_UNDO_INCOMPLETE` and `error` as its cause, whose message adds what stays in the project.
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
    return new GameAddonError(`${(error as Error).message} The ${change} could not be undone completely: ${stays.join('; ')}.`, 'GAME_ADDON_UNDO_INCOMPLETE', { cause: error })
  }
}

/** The refusal of an add-on that the user turned off in the Add-ons dialog, for the model. */
function turnedOffMessage(addon: GameAddon): string {
  return `The user turned ${addon.title} (${addon.id}) off in WASD Engine's Add-ons dialog, so agents cannot use it. Do the work without it, or ask the user to turn it on there.`
}

/**
 * A one-line view of a catalog entry for the tools and the dialog.
 * @param addon - the catalog entry.
 * @param allowed - whether agents may use the add-on.
 * @param presence - whether a project has the add-on (installed, found without a record, or absent) and its version;
 *   omitted outside a project.
 * @returns the view.
 */
export function addonView(addon: GameAddon, allowed: boolean, presence?: GameAddonPresence): GameAddonView {
  return {
    id: addon.id,
    title: addon.title,
    host: addon.host,
    version: addon.version,
    category: addon.category,
    cue: addon.cue,
    summary: addon.summary,
    useWhen: addon.useWhen,
    ...addon.avoidWhen === undefined ? {} : { avoidWhen: addon.avoidWhen },
    tags: addon.tags,
    stages: addon.stages,
    license: addon.license,
    ...addon.credit === undefined ? {} : { credit: addon.credit },
    homepage: addon.homepage,
    ...addon.archive === undefined
      ? { shipsWith: addon.blender?.kind === 'core' ? 'blender' as const : 'app' as const }
      : { bytes: addon.archive.bytes + (addon.assets?.bytes ?? 0) },
    ...addon.assets === undefined
      ? {}
      : { assets: { license: addon.assets.license, bytes: addon.assets.bytes, homepage: addon.assets.homepage } },
    conflicts: addon.conflicts ?? [],
    allowed,
    ...presence === undefined ? {} : { presence },
  }
}

/** Installs, removes, and reports catalog add-ons in game projects. */
export class GameAddonManager {
  /** The last queued write of the store index; settles without a value, whatever the write's outcome. */
  private storeIndexWrites: Promise<void> = Promise.resolve()

  /**
   * @param options - catalog, downloads, Blender store, import step, clock, change listener, and the user's switches.
   */
  constructor(private readonly options: GameAddonManagerOptions) {}

  /** The loaded catalog. */
  get catalog(): GameAddonCatalog {
    return this.options.catalog
  }

  /**
   * Whether agents may use an add-on.
   * @param id - catalog id.
   * @returns false for an add-on that the user turned off.
   */
  allowed(id: string): boolean {
    return this.options.allowed(id)
  }

  /**
   * The catalog entries that agents may use.
   * @returns the entries the user has not turned off, in catalog order.
   */
  allowedEntries(): GameAddon[] {
    return this.catalog.entries.filter(addon => this.options.allowed(addon.id))
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
   * Every catalog add-on with whether agents may use it, and its presence in a project when one is given.
   * @param projectDir - absolute project folder, or undefined.
   * @returns the views in catalog order.
   */
  async views(projectDir: string | undefined): Promise<GameAddonView[]> {
    const presence = projectDir === undefined ? undefined : await this.presence(projectDir)
    return this.catalog.entries.map(addon => addonView(addon, this.options.allowed(addon.id), presence?.get(addon.id)))
  }

  /**
   * Search the add-ons that agents may use, with each one's presence in a project when one is given.
   * @param query - words and filters.
   * @param projectDir - absolute project folder, or undefined.
   * @returns matching add-ons, best first.
   */
  async search(query: CatalogQuery, projectDir: string | undefined): Promise<GameAddonView[]> {
    const presence = projectDir === undefined ? undefined : await this.presence(projectDir)
    return searchCatalog(this.allowedEntries(), query).map(addon => addonView(addon, true, presence?.get(addon.id)))
  }

  /**
   * The add-ons whose guides apply to a project: installed ones and catalog add-ons found in its `addons` folder that
   * agents may use.
   * @param projectDir - absolute project folder.
   * @returns catalog ids in catalog order.
   */
  async guided(projectDir: string): Promise<string[]> {
    const presence = await this.presence(projectDir)
    return this.allowedEntries().filter(addon => presence.get(addon.id)?.state !== 'absent').map(addon => addon.id)
  }

  /**
   * The catalog entry of an id.
   * @param id - catalog id.
   * @returns the entry.
   * @throws {GameAddonError} for an unknown id.
   */
  entry(id: string): GameAddon {
    const addon = this.catalog.get(id)
    if (addon === undefined) throw new GameAddonError(`No catalog add-on has the id ${JSON.stringify(id)}; search the catalog for its id.`, 'GAME_ADDON_NOT_FOUND')
    return addon
  }

  /**
   * The catalog entry of an id that agents may use.
   * @param id - catalog id.
   * @returns the entry.
   * @throws {GameAddonError} for an unknown id, and for an add-on that the user turned off.
   */
  usableEntry(id: string): GameAddon {
    const addon = this.entry(id)
    if (!this.options.allowed(addon.id)) throw new GameAddonError(turnedOffMessage(addon), 'GAME_ADDON_PERMISSION_DENIED')
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
   * @throws {GameAddonError} for an unknown id, an add-on that the user turned off, a conflicting add-on, an occupied
   *   folder or autoload name, or a failed step; a failed step is undone, and the message names what could not be put
   *   back.
   */
  async install(projectDir: string, id: string, options: InstallOptions, signal: AbortSignal): Promise<GameAddonInstallResult> {
    const addon = this.usableEntry(id)
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
    const projectText = await readProjectText(projectDir, 'project.godot')
    if (projectText === undefined) throw new GameAddonError(`No project.godot in ${projectDir}.`, 'GAME_ADDON_PROJECT_NOT_FOUND')
    const own = presence.get(addon.id) ?? { state: 'absent' }
    if (own.state === 'found' && options.replace !== true) {
      const version = own.version === undefined ? '' : ` (version ${own.version})`
      throw new GameAddonError(`${folderPath}${version} is already in the project without a WASD Engine record. Install with replace: true to replace it with ${addon.title} ${addon.version}, or keep it: its guide is listed either way.`, 'GAME_ADDON_ALREADY_EXISTS')
    }
    const project = new ProjectFile(projectText)
    for (const autoload of godot.autoloads ?? []) {
      const current = project.autoload(autoload.name)
      if (current !== undefined && current !== autoload.path) {
        throw new GameAddonError(`The autoload ${autoload.name} already points to ${current}; ${addon.title} needs that name for ${autoload.path}. Rename or remove that autoload first.`, 'GAME_ADDON_CONFLICT')
      }
    }
    // A recorded add-on whose folder was deleted installs again.
    if (own.state !== 'installed' || own.version !== addon.version || await projectEntry(projectDir, folderPath) === undefined) return undefined
    return entries.find(item => item.id === addon.id)
  }

  /**
   * Download a Godot add-on's archive and unpack its folder into a new staging folder of the project, without the
   * paths its entry leaves out, with its license file and the files of its overlay folders; an add-on without an
   * archive is its overlay folders' files alone. A project archive, such as a starter kit, loses its `project.godot`
   * and gets its `res://` paths rewritten to the add-on folder.
   * @returns the staged folder; on failure nothing of it is left.
   */
  private async stage(projectDir: string, addon: GameAddon, signal: AbortSignal): Promise<StagedAddon> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const archive = addon.archive
    const archivePath = archive === undefined ? undefined : (await cachedArchive(archive, this.options.downloads, signal)).path
    const staging = await stagingFolder(projectDir)
    const folder = join(staging.dir, godot.addonDir)
    try {
      let licenseText = standardLicenseText(addon.license, addon.copyright)
      if (archive === undefined || archivePath === undefined) {
        await mkdir(folder, { recursive: true })
      } else {
        const files = await unpackFolder(archivePath, archive.root, folder, signal, {
          ...archive.exclude === undefined ? {} : { exclude: archive.exclude },
          ...archive.projectRoot === true ? { skip: PROJECT_ROOT_SKIPPED } : {},
        })
        if (archive.projectRoot === true) await rebaseProjectPaths(folder, files, `res://addons/${godot.addonDir}/`, signal)
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
   * The project record of an add-on installed now.
   * @param addon - the catalog entry.
   * @param paths - the project folders the installation wrote.
   * @returns the record, with the archive the installation came from when the entry has one.
   */
  private installedRecord(addon: GameAddon, paths: string[]): InstalledGameAddon {
    return {
      id: addon.id,
      title: addon.title,
      host: addon.host,
      version: addon.version,
      license: addon.license,
      ...addon.archive === undefined ? {} : { source: addon.archive.url, sha256: addon.archive.sha256 },
      paths,
      installedAt: this.options.now().toISOString(),
    }
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
    const installed = this.installedRecord(addon, [folderPath])
    const root = await realpath(projectDir)
    const rollback = new Rollback()
    // The add-on folder that the installation replaced, until it moves to the add-on's backup.
    let replaced: TakenEntry | undefined
    // The settings whose own values in the project the add-on's replaced.
    let displaced: string[] = []
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
      // What the settings held before is read in the same edit that changes them.
      let remember: SettingBefore[] | undefined
      const reinstall = record.entries.some(item => item.id === addon.id) || previous !== undefined
      const enabled = await editProject(projectDir, (project) => {
        remember = settingsBefore(project, godot.settings ?? [], record.settings.get(addon.id), reinstall)
        this.enableInProject(project, addon)
        displaced = remember === undefined ? [] : replacedSettings(project, godot.settings ?? [], remember)
      })
      if (enabled === undefined) throw new GameAddonError(`No project.godot in ${projectDir}.`, 'GAME_ADDON_PROJECT_NOT_FOUND')
      rollback.add(async () => { await revertProject(projectDir, enabled) }, `project.godot enables ${addon.title}`)
      // A setting the project did not have goes at the removal whether or not it is remembered.
      if (remember !== undefined && remember.some(entry => entry.before !== undefined)) {
        await record.writeSettings(new Map([...record.settings, [addon.id, remember]]))
        rollback.add(async () => { await record.writeSettings(record.settings) }, `${STATE_DIR}/${SETTINGS_FILE} holds the settings ${addon.title} replaced`)
      }
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
    const notes = [
      ...replaced === undefined ? [] : [await this.keepReplaced(projectDir, addon.id, replaced)],
      ...displaced.length === 0 ? [] : [replacedNote(displaced)],
    ]
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
          throw new GameAddonError(`The archive of ${addon.title} has neither blender_manifest.toml nor __init__.py under ${root}.`, 'GAME_ADDON_CATALOG_INVALID')
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
    const installed = this.installedRecord(addon, [])
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
        throw new GameAddonError(`${title} (${other}) is already in this project and does the same job as ${addon.title}; keep it, or remove it first.`, 'GAME_ADDON_CONFLICT')
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
    if (record === undefined && presence?.state !== 'found') throw new GameAddonError(`${addon.title} is not in this project.`, 'GAME_ADDON_NOT_INSTALLED')
    if (addon.godot === undefined) return []
    const folder = addonFolder(addon)
    const paths = record?.paths ?? [folder]
    const foreign = paths.filter(path => path !== folder && !path.startsWith(`${folder}/`))
    if (foreign.length > 0) {
      throw new GameAddonError(`${STATE_DIR}/${RECORD_FILE} lists ${foreign.join(', ')} for ${addon.title}, outside its folder ${folder}, so nothing was removed. Fix or delete that entry of the record.`, 'GAME_ADDON_RECORD_CORRUPT')
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
        const shared = new Set(settingIds(others))
        const remembered = record.settings.get(addon.id)
        const disabled = await editProject(projectDir, (project) => { this.disableInProject(project, addon, shared, remembered) })
        if (disabled !== undefined) rollback.add(async () => { await revertProject(projectDir, disabled) }, `project.godot no longer enables ${addon.title}`)
        if (remembered !== undefined) {
          const kept = new Map(record.settings)
          kept.delete(addon.id)
          await record.writeSettings(kept)
          rollback.add(async () => { await record.writeSettings(record.settings) }, `${STATE_DIR}/${SETTINGS_FILE} no longer holds the settings ${addon.title} replaced`)
        }
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
   * version, its setup script and asset folder as absolute paths, and `allowed: false` with the refusal `message` for
   * one that the user turned off, which workers then refuse to enable. The index names no catalog file: a worker runs
   * the setup script with its own Python, which cannot read the catalog where the Desktop app keeps it, inside
   * `app.asar`, so each setup script is first copied into the store's {@link STORE_SETUP_DIR}, like a store folder,
   * with a marker that names the SHA-256 of its path and bytes. The whole index is replaced, so a call also replaces an
   * index that names catalog files, as earlier versions wrote it. Calls write one after another, each with the switches
   * as they are when it starts, so the last call's index stays.
   * @param signal - cancellation while a copy waits for its folder's lock.
   */
  async writeStoreIndex(signal: AbortSignal): Promise<void> {
    const write = this.storeIndexWrites.then(() => this.storeIndex(signal))
    this.storeIndexWrites = write.catch(() => {
      // The caller of this write receives its failure; the next write starts regardless.
    })
    await write
  }

  private async storeIndex(signal: AbortSignal): Promise<void> {
    const addons: Record<string, StoreIndexEntry> = {}
    for (const addon of this.catalog.entries) {
      if (addon.blender === undefined) continue
      const setup = addon.blender.setup === undefined ? undefined : await this.storeSetup(addon, addon.blender.setup, signal)
      addons[addon.id] = {
        module: addon.blender.module,
        kind: addon.blender.kind,
        version: addon.version,
        ...setup === undefined ? {} : { setup },
        ...addon.assets === undefined ? {} : { assets: this.assetsFolder(addon) },
        ...this.options.allowed(addon.id) ? {} : { allowed: false as const, message: turnedOffMessage(addon) },
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
    let local: LocalArchive | undefined
    return {
      sha256: archive.sha256,
      write: async (staging) => {
        local = await cachedArchive(archive, this.options.downloads, signal)
        return await unpackFolder(local.path, archive.root, staging, signal)
      },
      placed: async () => {
        // A downloaded archive leaves the cache once the store holds it; one the app ships stays in the app.
        if (local !== undefined && !local.bundled) await rm(local.path, { force: true })
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
      if (markedSha256(await readText(join(target, STORE_MARKER))) === source.sha256) return
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
        throw new GameAddonError(`The catalog file ${overlay}/${path.split(sep).join('/')} would replace a file of the ${addon.title} archive.`, 'GAME_ADDON_CATALOG_INVALID')
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

  /**
   * Enable an add-on in `project.godot`: its plugin, autoloads, and settings. A setting whose value is a Dictionary, as
   * `[importer_defaults]` holds the import options of each importer, adds its entries to the project's own Dictionary,
   * replacing only entries of the same key; a project's value that is no Dictionary, and any other setting, takes the
   * add-on's value.
   */
  private enableInProject(project: ProjectFile, addon: GameAddon): void {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    if (godot.plugin !== undefined) project.enablePlugin(`res://addons/${godot.addonDir}/${godot.plugin}`)
    for (const autoload of godot.autoloads ?? []) {
      if (project.autoload(autoload.name) !== autoload.path) project.addAutoload(autoload.name, autoload.path)
    }
    for (const setting of godot.settings ?? []) {
      const wanted = dictionaryEntries(setting.value)
      const current = project.get(setting.section, setting.key)
      const existing = current === undefined ? [] : dictionaryEntries(current)
      if (wanted === undefined || existing === undefined) {
        if (current === undefined || !sameValue(current, setting.value)) project.set(setting.section, setting.key, setting.value)
        continue
      }
      const merged = existing.map(entry => wanted.find(own => own.key === entry.key) ?? entry)
      for (const own of wanted) if (!existing.some(entry => entry.key === own.key)) merged.push(own)
      if (current === undefined || !sameEntries(existing, merged)) project.set(setting.section, setting.key, dictionaryLiteral(merged))
    }
  }

  /**
   * Take an add-on's plugin, autoloads, and settings out of `project.godot`. A setting, or an entry of a Dictionary
   * setting, that still holds the add-on's value gets back the value it had before the installation, or goes when it
   * had none; one changed since keeps its value, and so does one that another installed add-on in `shared` sets.
   * @param shared - ids of what other add-ons' settings set, from `settingIds`.
   * @param remembered - the values the installation replaced, when it remembered them.
   */
  private disableInProject(
    project: ProjectFile,
    addon: GameAddon,
    shared: ReadonlySet<string>,
    remembered: readonly SettingBefore[] | undefined,
  ): void {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    if (godot.plugin !== undefined) project.disablePlugin(`res://addons/${godot.addonDir}/${godot.plugin}`)
    for (const autoload of godot.autoloads ?? []) {
      if (project.autoload(autoload.name) === autoload.path) project.remove('autoload', autoload.name)
    }
    for (const setting of godot.settings ?? []) {
      const id = `${setting.section}\n${setting.key}`
      const before = remembered?.find(entry => entry.section === setting.section && entry.key === setting.key)?.before
      const current = project.get(setting.section, setting.key)
      if (current === undefined) continue
      const wanted = dictionaryEntries(setting.value)
      const existing = dictionaryEntries(current)
      if (wanted === undefined || existing === undefined) {
        if (shared.has(id) || !sameValue(current, setting.value)) continue
        if (before === undefined) project.remove(setting.section, setting.key)
        else project.set(setting.section, setting.key, before)
        continue
      }
      const earlier = before === undefined ? [] : dictionaryEntries(before) ?? []
      const entries = [...existing]
      for (const own of wanted) {
        const at = entries.findIndex(entry => entry.key === own.key)
        const held = entries[at]
        if (held === undefined || shared.has(`${id}\n${own.key}`) || !sameValue(held.value, own.value)) continue
        const previous = earlier.find(entry => entry.key === own.key)
        if (previous === undefined) entries.splice(at, 1)
        else entries[at] = previous
      }
      if (entries.length === 0 && before === undefined) project.remove(setting.section, setting.key)
      else if (!sameEntries(existing, entries)) project.set(setting.section, setting.key, dictionaryLiteral(entries))
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
