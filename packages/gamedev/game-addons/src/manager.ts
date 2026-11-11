/**
 * Installation and removal of catalog add-ons, and what a project has. A Godot add-on unpacks from its checked
 * archive into a staging folder inside the project, then takes its place in `res://addons/<folder>/`; the installer
 * enables it in `project.godot` the way the editor's plugin switch does, writes its license into the project's
 * notices, records it in `.wasdengine/addons.json`, and imports the project so the add-on's errors show at once. A
 * failure before the record is written puts the previous folder and `project.godot` back. A Blender extension unpacks
 * once into the shared add-on store, where every Blender worker enables it by id, and its asset pack, if it has one,
 * into the asset folder beside the store; its project keeps only the record. Their archives then leave the cache.
 * @module @deepseek-ai/dsh-game-addons/src/manager
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { cachedArchive, readArchiveFile, unpackFolder, type ArchiveDownloads } from './archive.ts'
import { searchCatalog, type CatalogQuery, type GameAddonCatalog } from './catalog.ts'
import { standardLicenseText } from './licenses.ts'
import { noticeSection, removeNotice, writeNotice } from './notices.ts'
import { ProjectFile } from './project-file.ts'
import { readRecord, STATE_DIR, updateRecord } from './record.ts'
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
    const recorded = new Map((await readRecord(projectDir)).map(addon => [addon.id, addon]))
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
   * Install one catalog add-on into a project.
   * @param projectDir - absolute folder that holds `project.godot`.
   * @param id - catalog id.
   * @param options - whether to replace a folder copied in by hand.
   * @param signal - cancellation; a cancelled installation leaves the project as it was.
   * @returns the recorded add-on, the import's problems, and notes.
   * @throws {GameAddonError} for an unknown id, a conflicting add-on, an occupied folder or autoload name, or a failed step.
   */
  async install(projectDir: string, id: string, options: InstallOptions, signal: AbortSignal): Promise<GameAddonInstallResult> {
    const addon = this.entry(id)
    const presence = await this.presence(projectDir)
    for (const other of addon.conflicts ?? []) {
      const state = presence.get(other)?.state
      if (state !== undefined && state !== 'absent') {
        const title = this.catalog.get(other)?.title ?? other
        throw new GameAddonError(`${title} (${other}) is already in this project and does the same job as ${addon.title}; keep it, or remove it first.`)
      }
    }
    const result = addon.host === 'godot'
      ? await this.installGodot(projectDir, addon, presence.get(addon.id) ?? { state: 'absent' }, options, signal)
      : await this.installBlender(projectDir, addon, signal)
    this.options.changed(projectDir)
    return result
  }

  /**
   * Remove one add-on from a project: an installed one by its record, or a catalog add-on found in `res://addons/`.
   * @param projectDir - absolute folder that holds `project.godot`.
   * @param id - catalog id.
   * @param signal - cancellation before files are deleted.
   * @returns the deleted paths and the project files that still name the add-on.
   * @throws {GameAddonError} when the project does not have the add-on.
   */
  async remove(projectDir: string, id: string, signal: AbortSignal): Promise<GameAddonRemoveResult> {
    const addon = this.entry(id)
    const record = (await readRecord(projectDir)).find(item => item.id === id)
    const presence = (await this.presence(projectDir)).get(id)
    if (record === undefined && presence?.state !== 'found') throw new GameAddonError(`${addon.title} is not in this project.`)
    signal.throwIfAborted()
    const removed: string[] = []
    let references: string[] = []
    if (addon.godot !== undefined) {
      const paths = record?.paths ?? [addonFolder(addon)]
      for (const path of paths) {
        const absolute = join(projectDir, ...path.split('/'))
        if (await exists(absolute)) {
          await rm(absolute, { recursive: true, force: true })
          removed.push(path)
        }
      }
      const others = [...(await this.presence(projectDir)).entries()]
        .filter(([other, state]) => other !== id && state.state !== 'absent')
        .flatMap(([other]) => this.catalog.get(other)?.godot?.settings ?? [])
      await this.disableInProject(projectDir, addon, new Set(others.map(setting => `${setting.section}/${setting.key}`)))
      await removeNotice(projectDir, addon.id)
      references = await this.references(projectDir, addon, signal)
    }
    const withoutAddon = (current: readonly InstalledGameAddon[]): InstalledGameAddon[] | undefined =>
      current.some(item => item.id === id) ? current.filter(item => item.id !== id) : undefined
    await updateRecord(projectDir, withoutAddon, signal)
    this.options.changed(projectDir)
    return { id, projectDir, removed, references }
  }

  private async installGodot(
    projectDir: string,
    addon: GameAddon,
    presence: GameAddonPresence,
    options: InstallOptions,
    signal: AbortSignal,
  ): Promise<GameAddonInstallResult> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const archive = addon.archive as NonNullable<GameAddon['archive']>
    const folderPath = addonFolder(addon)
    const folder = join(projectDir, 'addons', godot.addonDir)
    const projectPath = join(projectDir, 'project.godot')
    const projectText = await readText(projectPath)
    if (projectText === undefined) throw new GameAddonError(`No project.godot in ${projectDir}.`)
    if (presence.state === 'found' && options.replace !== true) {
      const version = presence.version === undefined ? '' : ` (version ${presence.version})`
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
    const unchanged = presence.state === 'installed' && presence.version === addon.version && await exists(folder)
    const notes: string[] = []
    if (!unchanged) {
      const archivePath = await cachedArchive(archive, this.options.downloads, signal)
      const staging = join(projectDir, STATE_DIR, 'staging', randomUUID())
      const trash = join(projectDir, STATE_DIR, 'trash', randomUUID())
      let movedOld = false
      let placed = false
      try {
        await mkdir(join(projectDir, STATE_DIR, 'staging'), { recursive: true })
        const files = await unpackFolder(archivePath, archive.root, staging, signal)
        const licenseText = await this.licenseText(addon, archivePath, staging, files)
        const rootPrefix = archive.root === '' ? '' : `${archive.root}/`
        const licenseOutside = archive.license !== undefined && !archive.license.startsWith(rootPrefix)
        if (licenseOutside && licenseText !== undefined && !files.some(file => LICENSE_NAMES.test(file))) {
          await writeFile(join(staging, 'LICENSE'), licenseText, { flag: 'wx' })
        }
        signal.throwIfAborted()
        await mkdir(join(projectDir, 'addons'), { recursive: true })
        if (await exists(folder)) {
          await mkdir(join(projectDir, STATE_DIR, 'trash'), { recursive: true })
          await rename(folder, trash)
          movedOld = true
        }
        await rename(staging, folder)
        placed = true
        this.enableInProject(project, addon)
        await writeFileAtomic(projectPath, project.toString(), { mode: 0o644 })
        await writeNotice(projectDir, noticeSection(addon, licenseText), addon.id)
      } catch (error) {
        if (placed) await rm(folder, { recursive: true, force: true })
        if (movedOld) await rename(trash, folder)
        await writeFileAtomic(projectPath, projectText, { mode: 0o644 })
        throw error
      } finally {
        await rm(staging, { recursive: true, force: true })
        if (!movedOld || placed) await rm(trash, { recursive: true, force: true })
        await removeEmpty(join(projectDir, STATE_DIR, 'staging'))
        await removeEmpty(join(projectDir, STATE_DIR, 'trash'))
      }
    } else {
      // A reinstall at the same version only repairs what enabling wrote.
      this.enableInProject(project, addon)
      const next = project.toString()
      if (next !== projectText) {
        await writeFileAtomic(projectPath, next, { mode: 0o644 })
        notes.push('project.godot had lost some of the add-on\'s settings; they were written again.')
      }
    }
    const installed: InstalledGameAddon = {
      id: addon.id,
      title: addon.title,
      host: addon.host,
      version: addon.version,
      license: addon.license,
      source: archive.url,
      sha256: archive.sha256,
      paths: [folderPath],
      installedAt: this.options.now().toISOString(),
    }
    let recorded = installed
    await updateRecord(projectDir, (current) => {
      const previous = current.find(item => item.id === addon.id)
      if (unchanged && previous !== undefined) {
        recorded = previous
        return undefined
      }
      return [...current.filter(item => item.id !== addon.id), installed]
    }, signal)
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
    return { addon: recorded, projectDir, unchanged, importIssues, notes }
  }

  private async installBlender(projectDir: string, addon: GameAddon, signal: AbortSignal): Promise<GameAddonInstallResult> {
    const blender = addon.blender as NonNullable<GameAddon['blender']>
    await this.writeStoreIndex()
    if (addon.archive !== undefined) {
      await this.storeFolder(join(this.options.blenderStore, blender.module), addon, addon.archive, (files) => {
        if (!files.includes('blender_manifest.toml') && !files.includes('__init__.py')) {
          const root = addon.archive?.root === '' ? 'its root' : addon.archive?.root ?? ''
          throw new GameAddonError(`The archive of ${addon.title} has neither blender_manifest.toml nor __init__.py under ${root}.`)
        }
      }, signal)
    }
    if (addon.assets !== undefined) await this.storeFolder(this.assetsFolder(addon), addon, addon.assets, () => undefined, signal)
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
    let unchanged = false
    let recorded = installed
    await updateRecord(projectDir, (current) => {
      const previous = current.find(item => item.id === addon.id)
      if (previous !== undefined && previous.version === addon.version) {
        unchanged = true
        recorded = previous
        return undefined
      }
      return [...current.filter(item => item.id !== addon.id), installed]
    }, signal)
    return {
      addon: recorded,
      projectDir,
      unchanged,
      importIssues: [],
      notes: [`In each Blender Session, run \`import wasd_addons; wasd_addons.enable("${addon.id}")\` with mcp__wasd_blender__execute_python before using ${addon.title}.`],
    }
  }

  /** The folder of a Blender add-on's asset pack. */
  private assetsFolder(addon: GameAddon): string {
    return join(this.options.assetsDir, addon.id)
  }

  /**
   * Write the store index that Blender workers read to enable add-ons by id: each Blender add-on's module, kind, and
   * version, and its setup script and asset folder as absolute paths.
   */
  async writeStoreIndex(): Promise<void> {
    const addons: Record<string, { module: string; kind: string; version: string; setup?: string; assets?: string }> = {}
    for (const addon of this.catalog.entries) {
      if (addon.blender === undefined) continue
      addons[addon.id] = {
        module: addon.blender.module,
        kind: addon.blender.kind,
        version: addon.version,
        ...addon.blender.setup === undefined ? {} : { setup: join(this.catalog.folder(addon.id), addon.blender.setup) },
        ...addon.assets === undefined ? {} : { assets: this.assetsFolder(addon) },
      }
    }
    await writeFileAtomic(join(this.options.blenderStore, STORE_INDEX), `${JSON.stringify({ format: 1, addons }, null, 2)}\n`, { mode: 0o644 })
  }

  /**
   * Unpack an archive into a shared folder once per archive, under that folder's lock: a marker names the archive the
   * folder came from, a matching marker skips the work, and the cached archive is removed once the folder holds it.
   */
  private async storeFolder(
    target: string,
    addon: GameAddon,
    archive: { readonly url: string; readonly sha256: string; readonly bytes: number; readonly root: string },
    check: (files: readonly string[]) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const parent = dirname(target)
    await mkdir(parent, { recursive: true })
    await withFileLock(target, async () => {
      const marker = await readText(join(target, STORE_MARKER))
      if (marker !== undefined && (JSON.parse(marker) as { sha256?: unknown }).sha256 === archive.sha256) return
      const archivePath = await cachedArchive(archive, this.options.downloads, signal)
      const staging = join(parent, `.staging-${randomUUID()}`)
      const trash = join(parent, `.trash-${randomUUID()}`)
      let movedOld = false
      let placed = false
      try {
        check(await unpackFolder(archivePath, archive.root, staging, signal))
        await writeFile(join(staging, STORE_MARKER), `${JSON.stringify({ id: addon.id, version: addon.version, sha256: archive.sha256 })}\n`, { flag: 'wx' })
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
      await rm(archivePath, { force: true })
    }, { signal, waitMs: 120_000 })
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
  private async disableInProject(projectDir: string, addon: GameAddon, shared: ReadonlySet<string>): Promise<void> {
    const godot = addon.godot as NonNullable<GameAddon['godot']>
    const projectPath = join(projectDir, 'project.godot')
    const text = await readText(projectPath)
    if (text === undefined) return
    const project = new ProjectFile(text)
    if (godot.plugin !== undefined) project.disablePlugin(`res://addons/${godot.addonDir}/${godot.plugin}`)
    for (const autoload of godot.autoloads ?? []) {
      if (project.autoload(autoload.name) === autoload.path) project.remove('autoload', autoload.name)
    }
    for (const setting of godot.settings ?? []) {
      if (!shared.has(`${setting.section}/${setting.key}`)) project.remove(setting.section, setting.key)
    }
    const next = project.toString()
    if (next !== text) await writeFileAtomic(projectPath, next, { mode: 0o644 })
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
