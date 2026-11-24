/**
 * A Godot project's multiplayer setup: the WASD Multiplayer add-on in `res://addons/wasd_multiplayer/`, which this
 * package ships in its `addon/wasd_multiplayer/` folder, its `WasdMultiplayer` autoload and editor plugin in
 * `project.godot`, and the add-on's configuration `res://wasd_multiplayer.cfg`, whose `[wasd]` section names the
 * mode (`player_hosted` or `dedicated`), the most players, the site's origins, and the released game's id. Edits of
 * `project.godot` change only the two keys they own, and edits of `res://wasd_multiplayer.cfg` only the `[wasd]` keys
 * WASD Engine writes; both keep every other line byte for byte. The setup installs the add-on and a release brings an
 * older, unchanged copy up to date; neither overwrites an example or Markdown file the game changed, and neither writes
 * through a link in the add-on's folder. The setup replaces the add-on's own files whatever their changes, and first
 * keeps the ones the game changed in a backup folder of the add-on ({@link ADDON_BACKUPS_DIR}).
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-project
 */
import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { addonFileDigest, isShippedAddonFile, shippedAddonHas } from './multiplayer-addon-files.ts'
import { MultiplayerError } from './multiplayer-api.ts'
import { STATE_DIR, writeWhole } from './state.ts'

/** The add-on's folder inside a project. */
export const ADDON_DIR = 'addons/wasd_multiplayer'

/** The add-on's autoload name. */
export const AUTOLOAD_NAME = 'WasdMultiplayer'

/** The add-on's autoload value in `project.godot`: a singleton of the add-on's main script. */
export const AUTOLOAD_VALUE = `"*res://${ADDON_DIR}/wasd_multiplayer.gd"`

/** The add-on's editor plugin. */
export const PLUGIN_PATH = `res://${ADDON_DIR}/plugin.cfg`

/** The add-on's configuration file inside a project. */
export const CONFIG_FILE = 'wasd_multiplayer.cfg'

/**
 * Project-relative folder of the add-on's backups: one folder per setup that replaced files of the add-on that the game
 * had changed, beside the game add-ons' backups.
 */
export const ADDON_BACKUPS_DIR = `${STATE_DIR}/backups/wasd_multiplayer`

/** The two ways a game goes online. */
export const MULTIPLAYER_MODES = ['player_hosted', 'dedicated'] as const

/** One of {@link MULTIPLAYER_MODES}. */
export type MultiplayerMode = (typeof MULTIPLAYER_MODES)[number]

/** The `[wasd]` section of `res://wasd_multiplayer.cfg`. */
export interface MultiplayerConfig {
  /** How the game goes online. */
  readonly mode: MultiplayerMode
  /** Most players in one session or on one server. */
  readonly maxPlayers: number
  /** Origin of the site's API, such as `https://app.wasdengine.com`. */
  readonly apiOrigin: string
  /** Origin of the site's pages, where players sign in. */
  readonly appOrigin: string
  /** The released game's id on the site; empty before the first release. */
  readonly gameId: string
  /** The release the build belongs to; 0 for builds that were never released. */
  readonly version: number
}

const SECTION_LINE = /^\[([^\]\r\n]+)\]\s*$/u
const KEY_LINE = /^([^=;\s[][^=]*?)\s*=(.*)$/u

/**
 * Read a Godot ConfigFile value this package writes: a quoted string or an integer.
 * @param value - the text after `=`.
 * @returns the string or the number, or undefined for another kind of value.
 */
function configValue(value: string): string | number | undefined {
  const text = value.trim()
  const quoted = /^"((?:[^"\\]|\\.)*)"$/u.exec(text)
  if (quoted !== null) return (quoted[1] as string).replace(/\\(.)/gu, '$1')
  return /^-?\d+$/u.test(text) ? Number(text) : undefined
}

function quote(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Parse the `[wasd]` section of `res://wasd_multiplayer.cfg`.
 * @param text - the file's text.
 * @returns the configuration, or undefined when the file has no usable mode.
 */
export function parseMultiplayerConfig(text: string): MultiplayerConfig | undefined {
  const values = new Map<string, string | number>()
  let section = ''
  for (const raw of text.split(/\r?\n/u)) {
    const header = SECTION_LINE.exec(raw)
    if (header !== null) {
      section = (header[1] as string).trim()
      continue
    }
    const item = section === 'wasd' ? KEY_LINE.exec(raw) : null
    const value = item === null ? undefined : configValue(item[2] as string)
    if (item !== null && value !== undefined) values.set((item[1] as string).trim(), value)
  }
  const mode = values.get('mode')
  if (mode !== 'player_hosted' && mode !== 'dedicated') return undefined
  const number = (key: string, fallback: number): number => {
    const value = values.get(key)
    return typeof value === 'number' ? value : fallback
  }
  const string = (key: string): string => {
    const value = values.get(key)
    return typeof value === 'string' ? value : ''
  }
  return {
    mode,
    maxPlayers: number('max_players', 8),
    apiOrigin: string('api_origin'),
    appOrigin: string('app_origin'),
    gameId: string('game_id'),
    version: number('version', 0),
  }
}

/** The keys of the `[wasd]` section that WASD Engine writes, in the order it writes them; the section's other keys are the game's. */
const CONFIG_KEYS = ['mode', 'max_players', 'api_origin', 'app_origin', 'game_id', 'version'] as const

/**
 * The value text of each key that WASD Engine writes ({@link CONFIG_KEYS}).
 * @param config - the configuration.
 * @returns each key's text after `=`, in the order of {@link CONFIG_KEYS}.
 */
function configValues(config: MultiplayerConfig): ReadonlyMap<string, string> {
  const values: Record<(typeof CONFIG_KEYS)[number], string> = {
    mode: quote(config.mode),
    max_players: String(config.maxPlayers),
    api_origin: quote(config.apiOrigin),
    app_origin: quote(config.appOrigin),
    game_id: quote(config.gameId),
    version: String(config.version),
  }
  return new Map(CONFIG_KEYS.map(key => [key, values[key]]))
}

/**
 * Render a new `res://wasd_multiplayer.cfg`.
 * @param config - the configuration.
 * @returns the file's text.
 */
export function renderMultiplayerConfig(config: MultiplayerConfig): string {
  return [
    '; WASD Multiplayer: how this game goes online. WASD Engine sets the keys below and keeps any others; Release fills in game_id.',
    '[wasd]',
    '',
    ...[...configValues(config)].map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n')
}

/**
 * The text of a project's `res://wasd_multiplayer.cfg`.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the text, or undefined when the project has no such file.
 */
async function configText(projectDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(projectDir, CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read a project's multiplayer configuration.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the configuration, or undefined when the project has no usable `res://wasd_multiplayer.cfg`.
 */
export async function readMultiplayerConfig(projectDir: string): Promise<MultiplayerConfig | undefined> {
  const text = await configText(projectDir)
  return text === undefined ? undefined : parseMultiplayerConfig(text)
}

/**
 * Write a project's multiplayer configuration: into its `res://wasd_multiplayer.cfg` as {@link withMultiplayerConfig}
 * does, keeping the file's other keys, sections, and comments, or as a new file ({@link renderMultiplayerConfig}) when
 * the project has none or an empty one.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param config - the configuration.
 */
export async function writeMultiplayerConfig(projectDir: string, config: MultiplayerConfig): Promise<void> {
  const text = await configText(projectDir)
  const written = text === undefined || text.trim() === '' ? renderMultiplayerConfig(config) : withMultiplayerConfig(text, config)
  // Replaced whole, so an export that reads it meanwhile never packs part of it.
  if (written !== text) await writeWhole(join(projectDir, CONFIG_FILE), written)
}

/** A `[section]`'s line range in a ConfigFile. */
interface Section {
  /** Index of the header line. */
  readonly header: number
  /** Index after the section's last line. */
  readonly end: number
}

function findSection(lines: readonly string[], name: string): Section | undefined {
  for (let index = 0; index < lines.length; index++) {
    const header = SECTION_LINE.exec(lines[index] as string)
    if (header === null || (header[1] as string).trim() !== name) continue
    let end = index + 1
    while (end < lines.length && SECTION_LINE.exec(lines[end] as string) === null) end++
    return { header: index, end }
  }
  return undefined
}

/**
 * Set one key of a ConfigFile section, adding the key at the end of the section, or the section at the end of the
 * file, when absent. The value must fit on one line.
 * @param lines - the file's lines; changed in place.
 * @param name - the section.
 * @param key - the key.
 * @param value - the value text after `=`.
 * @returns whether the file changed.
 */
function setKey(lines: string[], name: string, key: string, value: string): boolean {
  const section = findSection(lines, name)
  if (section === undefined) {
    while (lines.length > 0 && (lines.at(-1) as string).trim() === '') lines.pop()
    lines.push('', `[${name}]`, '', `${key}=${value}`, '')
    return true
  }
  for (let index = section.header + 1; index < section.end; index++) {
    const item = KEY_LINE.exec(lines[index] as string)
    if (item === null || (item[1] as string).trim() !== key) continue
    if ((item[2] as string).trim() === value) return false
    lines[index] = `${key}=${value}`
    return true
  }
  let insert = section.end
  while (insert > section.header + 1 && (lines[insert - 1] as string).trim() === '') insert--
  lines.splice(insert, 0, `${key}=${value}`)
  return true
}

/**
 * Write a configuration into the text of a `res://wasd_multiplayer.cfg`: each key that WASD Engine writes gets its value
 * wherever a `[wasd]` section holds it, a key the file lacks goes at the end of its first `[wasd]` section, or of a new
 * one at the end of the file, and every other line stays byte for byte, such as the section's other keys, other
 * sections, and comments. Lines are read one by one, as Godot writes the file; a value of another key that spans lines
 * can be misread.
 * @param text - the file's text.
 * @param config - the configuration.
 * @returns the new text, which equals `text` when it held the configuration already.
 */
export function withMultiplayerConfig(text: string, config: MultiplayerConfig): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  const values = configValues(config)
  const found = new Set<string>()
  let section = ''
  for (let index = 0; index < lines.length; index++) {
    const header = SECTION_LINE.exec(lines[index] as string)
    if (header !== null) {
      section = (header[1] as string).trim()
      continue
    }
    const item = section === 'wasd' ? KEY_LINE.exec(lines[index] as string) : null
    if (item === null) continue
    const key = (item[1] as string).trim()
    const value = values.get(key)
    if (value === undefined) continue
    found.add(key)
    if ((item[2] as string).trim() !== value) lines[index] = `${key}=${value}`
  }
  for (const [key, value] of values) {
    if (!found.has(key)) setKey(lines, 'wasd', key, value)
  }
  const joined = lines.join(newline)
  return joined.endsWith(newline) ? joined : `${joined}${newline}`
}

/**
 * The strings of a `PackedStringArray(...)` value.
 * @param value - the value text.
 * @returns its strings in order; empty for another kind of value.
 */
function packedStrings(value: string): string[] {
  const match = /^\s*PackedStringArray\(([\s\S]*)\)\s*$/u.exec(value)
  if (match === null) return []
  return [...(match[1] as string).matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(found => (found[1] as string).replace(/\\(.)/gu, '$1'))
}

function keyValue(lines: readonly string[], name: string, key: string): string | undefined {
  const section = findSection(lines, name)
  if (section === undefined) return undefined
  for (let index = section.header + 1; index < section.end; index++) {
    const item = KEY_LINE.exec(lines[index] as string)
    if (item !== null && (item[1] as string).trim() === key) return item[2]
  }
  return undefined
}

/**
 * Turn the add-on on in a `project.godot` text: the `WasdMultiplayer` autoload and the editor plugin.
 * @param text - the file's text.
 * @returns the new text, which equals `text` when both were on already.
 */
export function withMultiplayerAddon(text: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  setKey(lines, 'autoload', AUTOLOAD_NAME, AUTOLOAD_VALUE)
  const plugins = packedStrings(keyValue(lines, 'editor_plugins', 'enabled') ?? '')
  if (!plugins.includes(PLUGIN_PATH)) {
    setKey(lines, 'editor_plugins', 'enabled', `PackedStringArray(${[...plugins, PLUGIN_PATH].map(quote).join(', ')})`)
  }
  const joined = lines.join(newline)
  return joined.endsWith(newline) ? joined : `${joined}${newline}`
}

/** Endings of the files Godot keeps beside a project's files: a script's UID, an asset's import settings. */
const GODOT_SIDECARS = ['.uid', '.import'] as const

/** The add-on's entries in a folder ({@link addonEntries}). */
interface AddonEntries {
  /** Each regular file's absolute path, by its forward-slash path in the folder. */
  readonly files: ReadonlyMap<string, string>
  /** The forward-slash paths of the entries that are neither regular files nor folders, such as links. */
  readonly links: ReadonlySet<string>
}

/**
 * The add-on's entries in a folder, without hidden entries, the `.i18n.yaml` translation records of this repository's
 * documentation, and the files Godot keeps beside a project's files ({@link GODOT_SIDECARS}). Each entry is read as it
 * is: a link inside the folder is one of {@link AddonEntries.links}, and the walk never enters it, while the folder
 * itself may be a link. Reads go through `node:fs/promises`, which Electron's `app.asar` support resolves, so the
 * folder may sit inside a packaged Desktop app.
 * @param folder - absolute folder.
 * @returns its files and its other entries; none when the folder does not exist.
 */
async function addonEntries(folder: string): Promise<AddonEntries> {
  const files = new Map<string, string>()
  const links = new Set<string>()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      // A project without the folder has none of the add-on's files.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.i18n.yaml')) continue
      if (GODOT_SIDECARS.some(ending => entry.name.endsWith(ending))) continue
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`)
      else if (entry.isFile()) files.set(path, join(dir, entry.name))
      else links.add(path)
    }
  }
  await walk(folder, '')
  return { files, links }
}

/** A project's copy of the add-on as a copy over it finds it. */
interface PresentCopy extends AddonEntries {
  /** The {@link addonFileDigest} of each regular file, by its path in the folder. */
  readonly digests: ReadonlyMap<string, string>
  /** The version its `plugin.cfg` names. */
  readonly version: string | undefined
}

/**
 * Read a project's copy of the add-on.
 * @param folder - absolute add-on folder.
 * @param version - the version its `plugin.cfg` names ({@link copyVersion}).
 * @returns its entries and their digests; none when the folder does not exist.
 */
async function presentCopy(folder: string, version: string | undefined): Promise<PresentCopy> {
  const entries = await addonEntries(folder)
  const digests = new Map<string, string>()
  for (const [path, file] of entries.files) digests.set(path, addonFileDigest(path, await readFile(file)))
  return { ...entries, digests, version }
}

/**
 * The version an add-on folder's `plugin.cfg` names.
 * @param folder - absolute add-on folder.
 * @returns the version, or undefined when the folder has no `plugin.cfg` or it names none.
 */
async function copyVersion(folder: string): Promise<string | undefined> {
  try {
    return pluginVersion(await readFile(join(folder, 'plugin.cfg'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether add-on version `older` comes before `newer`, comparing their dot-separated whole numbers in order.
 * @param older - a version, such as `1.2.0`.
 * @param newer - another version.
 * @returns true when `older` is the earlier version; false when either is not dot-separated whole numbers.
 */
export function olderAddonVersion(older: string, newer: string): boolean {
  const parse = (version: string): number[] | undefined => /^\d+(?:\.\d+)*$/u.test(version) ? version.split('.').map(Number) : undefined
  const left = parse(older)
  const right = parse(newer)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}

/** Whether a path in the add-on folder is one of its examples, or their folder, which a game may adapt where they are. */
function isExample(path: string): boolean {
  return path === 'examples' || path.startsWith('examples/')
}

/**
 * Whether a path in the add-on folder is the game's to change: an example ({@link isExample}), or a Markdown file, which
 * documents the add-on. The other paths are the add-on's own code.
 */
function isAdaptable(path: string): boolean {
  return isExample(path) || extname(path) === '.md'
}

/**
 * The first of a copy's links on the way to a path: one of the path's folders, or the path itself.
 * @param path - a path in the add-on folder.
 * @param links - the copy's entries that are neither files nor folders ({@link AddonEntries.links}).
 * @returns the link's path, or undefined when none is on the way.
 */
function linkOnTheWay(path: string, links: ReadonlySet<string>): string | undefined {
  const parts = path.split('/')
  for (let end = 1; end <= parts.length; end++) {
    const way = parts.slice(0, end).join('/')
    if (links.has(way)) return way
  }
  return undefined
}

/** The backup of the add-on's own files that a copy replaced although the game had changed them. */
export interface AddonBackup {
  /** Project-relative backup folder, `.wasdengine/backups/wasd_multiplayer/<time>` ({@link ADDON_BACKUPS_DIR}). */
  readonly folder: string
  /**
   * The forward-slash paths in the add-on folder that the backup keeps, each at `<folder>/addons/wasd_multiplayer/<path>`:
   * a copy of each file the game changed, and each link that stood in place of a file of the add-on or of its folder,
   * moved as it is.
   */
  readonly files: readonly string[]
}

/** What copying the shipped add-on into a project wrote, kept, and backed up. */
export interface AddonCopy {
  /** The files written, as forward-slash paths in the add-on folder. */
  readonly written: readonly string[]
  /**
   * The game's own entries that stayed as they were: example and Markdown files it changed or added, links in their
   * place, and files and links it added beside the add-on's own.
   */
  readonly kept: readonly string[]
  /** The add-on's own files that the game changed and the copy replaced; absent when it replaced none. */
  readonly backup?: AddonBackup
}

/**
 * Make the folders of {@link ADDON_BACKUPS_DIR} in a project one at a time, each checked by its real path, so that no
 * folder is made and no backup kept outside the project.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the real path of each folder on the way, `.wasdengine` first.
 * @throws {MultiplayerError} when one of the folders is a link that leads outside the project, before anything changes
 *   outside it.
 */
async function backupFolders(projectDir: string): Promise<string[]> {
  const root = await realpath(projectDir)
  const segments = ADDON_BACKUPS_DIR.split('/')
  const reals: string[] = []
  for (const [index, segment] of segments.entries()) {
    const next = join(reals.at(-1) ?? root, segment)
    try {
      await mkdir(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const real = await realpath(next)
    const rest = relative(root, real)
    if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
      throw new MultiplayerError(`The setup changed nothing: ${segments.slice(0, index + 1).join('/')} in ${projectDir} leads outside the project, to ${real}, where the setup would keep the game's versions of the add-on files it replaces. Make it a folder of the project, then call wasd_multiplayer_setup again.`)
    }
    reals.push(real)
  }
  return reals
}

/**
 * Make a new backup folder of the add-on in {@link ADDON_BACKUPS_DIR}, named by the time, with `-2`, `-3`, and so on
 * added when an earlier backup took the name. A `.gitignore` in `.wasdengine/backups/` keeps the backups out of version
 * control, as it does the game add-ons' backups there.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the project-relative backup folder.
 * @throws {MultiplayerError} when a folder on the way leads outside the project ({@link backupFolders}).
 */
async function newBackup(projectDir: string): Promise<string> {
  const reals = await backupFolders(projectDir)
  const parent = reals.at(-1) as string
  try {
    // Exclusive creation keeps a .gitignore that is there, and never writes through a link in its place.
    await writeFile(join(reals.at(-2) as string, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stamp = new Date().toISOString().replaceAll(':', '-')
  for (let count = 1; ; count++) {
    const name = count === 1 ? stamp : `${stamp}-${String(count)}`
    try {
      await mkdir(join(parent, name))
      return `${ADDON_BACKUPS_DIR}/${name}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/**
 * Copy the shipped add-on's files over a project's add-on folder. An example or a Markdown file that the game changed
 * stays, and so does a link in its place or in place of its folder, and so does the removal of an example that the
 * copy's version shipped; a file of an earlier add-on that the shipped one leaves out goes, with the files Godot keeps
 * beside it; files and links of the game's own stay. A file of the add-on's own code that the game changed, and a link
 * in place of such a file or of its folder, first go to a new backup folder of the add-on ({@link newBackup}), the
 * files as copies and the links as they are, so the copy never writes through a link. Each file is replaced whole, and
 * `plugin.cfg` last, so a copy that stops part way still names the version it replaces and the next one finishes it.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param shipped - the shipped add-on's files ({@link addonEntries}).
 * @param present - the project's copy, empty for a project without one.
 * @returns what was written, kept, and backed up.
 * @throws {MultiplayerError} when the copy needs a backup and its folder leads outside the project ({@link backupFolders});
 *   the add-on folder stays as it was then.
 */
async function copyAddon(projectDir: string, shipped: ReadonlyMap<string, string>, present: PresentCopy): Promise<AddonCopy> {
  const destination = join(projectDir, ADDON_DIR)
  const kept = new Set<string>()
  const replaced = new Set<string>()
  const writes: (readonly [string, string])[] = []
  const order = [...shipped].sort(([left], [right]) => Number(left === 'plugin.cfg') - Number(right === 'plugin.cfg') || left.localeCompare(right))
  for (const [path, file] of order) {
    const link = linkOnTheWay(path, present.links)
    const digest = present.digests.get(path)
    if (isAdaptable(path)) {
      // An example or a Markdown file the game changed stays, and so does the removal of an example its version shipped.
      const adapted = link !== undefined || (digest !== undefined && !isShippedAddonFile(path, digest))
      const removed = link === undefined && digest === undefined && isExample(path)
        && present.version !== undefined && shippedAddonHas(present.version, path)
      if (adapted) kept.add(link ?? path)
      if (adapted || removed) continue
    } else if (link !== undefined) replaced.add(link)
    else if (digest !== undefined && !isShippedAddonFile(path, digest)) replaced.add(path)
    writes.push([path, file])
  }
  const backup = replaced.size === 0 ? undefined : await newBackup(projectDir)
  for (const path of backup === undefined ? [] : [...replaced].sort()) {
    const from = join(destination, ...path.split('/'))
    const to = join(projectDir, ...`${backup}/${ADDON_DIR}/${path}`.split('/'))
    await mkdir(dirname(to), { recursive: true })
    // A file stays in place until the shipped one replaces it whole, so a copy that stops part way leaves no file out.
    if (present.links.has(path)) await rename(from, to)
    else await copyFile(from, to, constants.COPYFILE_EXCL)
  }
  const written: string[] = []
  for (const [path, file] of writes) {
    const target = join(destination, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeWhole(target, await readFile(file))
    written.push(path)
  }
  for (const [path, digest] of present.digests) {
    if (shipped.has(path)) continue
    if (isShippedAddonFile(path, digest)) {
      for (const ending of ['', ...GODOT_SIDECARS]) await rm(join(destination, ...`${path}${ending}`.split('/')), { force: true })
    } else kept.add(path)
  }
  for (const path of present.links) if (!replaced.has(path)) kept.add(path)
  return {
    written,
    kept: [...kept].sort(),
    ...backup === undefined ? {} : { backup: { folder: backup, files: [...replaced].sort() } },
  }
}

/**
 * Install the shipped add-on into a project, over any copy it has: the setup's copy, which replaces the add-on's own
 * code whatever its version and changes, after keeping the files of it that the game changed in a backup folder, and
 * keeps the example and Markdown files the game changed and the files it added ({@link copyAddon}).
 * @param projectDir - absolute folder holding `project.godot`.
 * @param source - absolute folder of the shipped add-on.
 * @returns what was written, kept, and backed up.
 * @throws {MultiplayerError} when the files the game changed need a backup and `.wasdengine/backups/wasd_multiplayer/`
 *   leads outside the project; the add-on folder stays as it was then.
 */
export async function installMultiplayerAddon(projectDir: string, source: string): Promise<AddonCopy> {
  const destination = join(projectDir, ADDON_DIR)
  const present = await presentCopy(destination, await copyVersion(destination))
  return await copyAddon(projectDir, (await addonEntries(source)).files, present)
}

/** What a release's update of a project's older add-on did ({@link updateMultiplayerAddon}). */
export type AddonUpdate =
  /** The project has the shipped add-on now; `kept` names the game's own files that stayed ({@link AddonCopy.kept}). */
  | { readonly outcome: 'updated'; readonly from?: string; readonly to: string; readonly kept: readonly string[] }
  /**
   * The project's copy stayed as it was, because the game changed or added the entries `changed` of the add-on's own
   * code: files, or links in place of a file or a folder.
   */
  | { readonly outcome: 'changed'; readonly from?: string; readonly to: string; readonly changed: readonly string[] }

/**
 * Bring a project's add-on up to the shipped one when its `plugin.cfg` names an older version, or none, and every entry
 * of its own code is a file that WASD Engine shipped ({@link isShippedAddonFile}), never a link; the examples and the
 * Markdown files do not count, and the copy keeps the ones the game changed, and the examples it removed
 * ({@link copyAddon}). The update thus replaces no file that the game changed, and needs no backup.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param source - absolute folder of the shipped add-on.
 * @returns the update, or why the copy stayed; undefined when the project has no add-on or one as new as the shipped one.
 * @throws {Error} when the shipped add-on's `plugin.cfg` names no version.
 */
export async function updateMultiplayerAddon(projectDir: string, source: string): Promise<AddonUpdate | undefined> {
  if (!await hasMultiplayerAddon(projectDir)) return undefined
  const to = pluginVersion(await readFile(join(source, 'plugin.cfg'), 'utf8'))
  if (to === undefined) throw new Error(`${join(source, 'plugin.cfg')} names no version.`)
  const destination = join(projectDir, ADDON_DIR)
  const from = await copyVersion(destination)
  if (from !== undefined && !olderAddonVersion(from, to)) return undefined
  const named = from === undefined ? {} : { from }
  const present = await presentCopy(destination, from)
  const changed = [
    ...[...present.digests].filter(([path, digest]) => !isAdaptable(path) && !isShippedAddonFile(path, digest)).map(([path]) => path),
    ...[...present.links].filter(path => !isAdaptable(path)),
  ].sort()
  if (changed.length > 0) return { outcome: 'changed', ...named, to, changed }
  const { kept } = await copyAddon(projectDir, (await addonEntries(source)).files, present)
  return { outcome: 'updated', ...named, to, kept }
}

/**
 * Whether a project has the add-on's main script.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns true when `res://addons/wasd_multiplayer/wasd_multiplayer.gd` is a file.
 */
export async function hasMultiplayerAddon(projectDir: string): Promise<boolean> {
  try {
    return (await stat(join(projectDir, ADDON_DIR, 'wasd_multiplayer.gd'))).isFile()
  } catch {
    // A project without the add-on's folder has no add-on.
    return false
  }
}

/**
 * The version of a project's add-on.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the version its `plugin.cfg` names, or undefined when the project has no add-on ({@link hasMultiplayerAddon})
 *   or its `plugin.cfg` names none.
 */
export async function multiplayerAddonVersion(projectDir: string): Promise<string | undefined> {
  return await hasMultiplayerAddon(projectDir) ? await copyVersion(join(projectDir, ADDON_DIR)) : undefined
}

/**
 * The add-on version a `plugin.cfg` names.
 * @param text - the file's text.
 * @returns the version, or undefined when it names none.
 */
export function pluginVersion(text: string): string | undefined {
  return /^version="([^"]*)"/mu.exec(text)?.[1]
}
