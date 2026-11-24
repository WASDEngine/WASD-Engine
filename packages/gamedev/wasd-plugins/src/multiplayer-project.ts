/**
 * A Godot project's multiplayer setup: the WASD Multiplayer add-on in `res://addons/wasd_multiplayer/`, which this
 * package ships in its `addon/wasd_multiplayer/` folder, its `WasdMultiplayer` autoload and editor plugin in
 * `project.godot`, and the add-on's configuration `res://wasd_multiplayer.cfg`, whose `[wasd]` section names the
 * mode (`player_hosted` or `dedicated`), the most players, the site's origins, and the released game's id. Edits of
 * `project.godot` change only the two keys they own and keep every other line byte for byte. The setup installs the
 * add-on and a release brings an older, unchanged copy up to date; neither overwrites an example file the game adapted.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-project
 */
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { addonFileDigest, isShippedAddonFile, shippedAddonHas } from './multiplayer-addon-files.ts'
import { writeWhole } from './state.ts'

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

/**
 * Render `res://wasd_multiplayer.cfg`.
 * @param config - the configuration.
 * @returns the file's text.
 */
export function renderMultiplayerConfig(config: MultiplayerConfig): string {
  return [
    '; WASD Multiplayer: how this game goes online. WASD Engine writes this file; Release fills in game_id.',
    '[wasd]',
    '',
    `mode=${quote(config.mode)}`,
    `max_players=${String(config.maxPlayers)}`,
    `api_origin=${quote(config.apiOrigin)}`,
    `app_origin=${quote(config.appOrigin)}`,
    `game_id=${quote(config.gameId)}`,
    `version=${String(config.version)}`,
    '',
  ].join('\n')
}

/**
 * Read a project's multiplayer configuration.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the configuration, or undefined when the project has no usable `res://wasd_multiplayer.cfg`.
 */
export async function readMultiplayerConfig(projectDir: string): Promise<MultiplayerConfig | undefined> {
  let text: string
  try {
    text = await readFile(join(projectDir, CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseMultiplayerConfig(text)
}

/**
 * Write a project's multiplayer configuration.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param config - the configuration.
 */
export async function writeMultiplayerConfig(projectDir: string, config: MultiplayerConfig): Promise<void> {
  // Replaced whole, so an export that reads it meanwhile never packs part of it.
  await writeWhole(join(projectDir, CONFIG_FILE), renderMultiplayerConfig(config))
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

/**
 * The add-on's files in a folder, by forward-slash path, without hidden files, the `.i18n.yaml` translation records of
 * this repository's documentation, and the files Godot keeps beside a project's files ({@link GODOT_SIDECARS}). Reads
 * go through `node:fs/promises`, which Electron's `app.asar` support resolves, so the folder may sit inside a packaged
 * Desktop app.
 * @param folder - absolute folder.
 * @returns each file's absolute path by its path in the folder; empty when the folder does not exist.
 */
async function addonFiles(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      // A project without the folder has none of the add-on's files.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.i18n.yaml')) continue
      if (GODOT_SIDECARS.some(ending => entry.name.endsWith(ending))) continue
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.isFile()) files.set(`${prefix}${entry.name}`, join(dir, entry.name))
    }
  }
  await walk(folder, '')
  return files
}

/**
 * The {@link addonFileDigest} of each of the add-on's files in a folder.
 * @param folder - absolute folder.
 * @returns each file's digest by its path in the folder.
 */
async function addonDigests(folder: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>()
  for (const [path, file] of await addonFiles(folder)) digests.set(path, addonFileDigest(path, await readFile(file)))
  return digests
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

/** Whether a path in the add-on folder is one of its examples, which a game may adapt where they are. */
function isExample(path: string): boolean {
  return path.startsWith('examples/')
}

/** What copying the shipped add-on into a project wrote and kept. */
export interface AddonCopy {
  /** The files written, as forward-slash paths in the add-on folder. */
  readonly written: readonly string[]
  /**
   * The game's own files that stayed as they were: example files it changed or added, and files it added beside the
   * add-on's own.
   */
  readonly kept: readonly string[]
}

/**
 * Copy the shipped add-on's files over a project's add-on folder. Over an existing copy, an example file that the game
 * changed stays, and so does one it removed from the version it had; a file of an earlier add-on that the shipped one
 * leaves out goes, with the files Godot keeps beside it; files of the game's own stay. Each file is replaced whole, and
 * `plugin.cfg` last, so a copy that stops part way still names the version it replaces and the next one finishes it.
 * @param destination - the project's add-on folder.
 * @param shipped - the shipped add-on's files ({@link addonFiles}).
 * @param present - the existing copy: the digests of its files and the version it names, or undefined for a folder
 *   without one.
 * @returns what was written and kept.
 */
async function copyAddon(
  destination: string, shipped: ReadonlyMap<string, string>,
  present: { readonly digests: ReadonlyMap<string, string>; readonly version: string | undefined } | undefined,
): Promise<AddonCopy> {
  const written: string[] = []
  const kept: string[] = []
  const order = [...shipped].sort(([left], [right]) => Number(left === 'plugin.cfg') - Number(right === 'plugin.cfg') || left.localeCompare(right))
  for (const [path, file] of order) {
    const digest = present?.digests.get(path)
    if (present !== undefined && isExample(path)) {
      // An example the game adapted stays, and so does the removal of one that its version shipped.
      const adapted = digest !== undefined && !isShippedAddonFile(path, digest)
      const removed = digest === undefined && present.version !== undefined && shippedAddonHas(present.version, path)
      if (adapted) kept.push(path)
      if (adapted || removed) continue
    }
    const target = join(destination, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeWhole(target, await readFile(file))
    written.push(path)
  }
  for (const [path, digest] of present?.digests ?? []) {
    if (shipped.has(path) || extname(path) === '.md') continue
    if (isShippedAddonFile(path, digest)) {
      for (const ending of ['', ...GODOT_SIDECARS]) await rm(join(destination, ...`${path}${ending}`.split('/')), { force: true })
    } else kept.push(path)
  }
  return { written, kept: kept.sort() }
}

/**
 * Install the shipped add-on into a project, over any copy it has: the setup's copy, which replaces the add-on's own
 * files whatever their version and changes, and keeps the example files the game changed or removed.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param source - absolute folder of the shipped add-on.
 * @returns what was written and kept.
 */
export async function installMultiplayerAddon(projectDir: string, source: string): Promise<AddonCopy> {
  const destination = join(projectDir, ADDON_DIR)
  const present = await hasMultiplayerAddon(projectDir)
    ? { digests: await addonDigests(destination), version: await copyVersion(destination) }
    : undefined
  return await copyAddon(destination, await addonFiles(source), present)
}

/** What a release's update of a project's older add-on did ({@link updateMultiplayerAddon}). */
export type AddonUpdate =
  /** The project has the shipped add-on now; `kept` names the game's own files that stayed ({@link AddonCopy.kept}). */
  | { readonly outcome: 'updated'; readonly from?: string; readonly to: string; readonly kept: readonly string[] }
  /** The project's copy stayed as it was, because the game changed or added the files `changed` of the add-on's own code. */
  | { readonly outcome: 'changed'; readonly from?: string; readonly to: string; readonly changed: readonly string[] }

/**
 * Bring a project's add-on up to the shipped one when its `plugin.cfg` names an older version, or none, and every file
 * of its own code is one WASD Engine shipped ({@link isShippedAddonFile}); the example files and the Markdown files do
 * not count, and the copy keeps the example files the game changed or removed ({@link installMultiplayerAddon}).
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
  const present = await addonDigests(destination)
  const changed = [...present]
    .filter(([path, digest]) => !isExample(path) && extname(path) !== '.md' && !isShippedAddonFile(path, digest))
    .map(([path]) => path)
    .sort()
  if (changed.length > 0) return { outcome: 'changed', ...named, to, changed }
  const { kept } = await copyAddon(destination, await addonFiles(source), { digests: present, version: from })
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
 * The add-on version a `plugin.cfg` names.
 * @param text - the file's text.
 * @returns the version, or undefined when it names none.
 */
export function pluginVersion(text: string): string | undefined {
  return /^version="([^"]*)"/mu.exec(text)?.[1]
}
