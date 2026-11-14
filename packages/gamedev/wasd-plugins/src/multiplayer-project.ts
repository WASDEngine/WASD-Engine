/**
 * A Godot project's multiplayer setup: the WASD Multiplayer add-on in `res://addons/wasd_multiplayer/`, which this
 * package ships in its `addon/wasd_multiplayer/` folder, its `WasdMultiplayer` autoload and editor plugin in
 * `project.godot`, and the add-on's configuration `res://wasd_multiplayer.cfg`, whose `[wasd]` section names the
 * mode (`player_hosted` or `dedicated`), the most players, the site's origins, and the released game's id. Edits of
 * `project.godot` change only the two keys they own and keep every other line byte for byte.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-project
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  await writeFile(join(projectDir, CONFIG_FILE), renderMultiplayerConfig(config))
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

/**
 * Copy a folder's files into another folder, replacing it, without hidden files and without the `.i18n.yaml`
 * translation records of this repository's documentation. Reads go through `node:fs/promises`, which Electron's
 * `app.asar` support resolves, so the source may sit inside a packaged Desktop app.
 * @param source - absolute folder to copy.
 * @param destination - absolute folder that is removed first, then filled.
 * @returns the copied files, as forward-slash paths relative to `destination`.
 */
export async function replaceFolder(source: string, destination: string): Promise<string[]> {
  const copied: string[] = []
  await rm(destination, { recursive: true, force: true })
  const walk = async (from: string, to: string, prefix: string): Promise<void> => {
    await mkdir(to, { recursive: true })
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      // Godot's own files beside a source checkout's add-on, such as `.uid` and `.import` files, belong to a project.
      if (entry.name.startsWith('.') || entry.name.endsWith('.i18n.yaml')) continue
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(from, entry.name), join(to, entry.name), `${name}/`)
      else if (entry.isFile()) {
        await writeFile(join(to, entry.name), await readFile(join(from, entry.name)))
        copied.push(name)
      }
    }
  }
  await walk(source, destination, '')
  return copied
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
