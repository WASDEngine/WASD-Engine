/**
 * The curated add-on catalog: one folder per add-on under the catalog folder, holding `addon.json`, the entry, and
 * `SKILL.md`, its usage guide. Loading validates every entry, its archive pin, and its guide's frontmatter, and
 * rejects a catalog whose entries name unknown conflicts. Search ranks entries by query words against their ids,
 * titles, tags, and descriptions.
 * @module @deepseek-ai/dsh-game-addons/src/catalog
 */
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { GameAddon, GameAddonHost, GameAddonStage } from './types.ts'

/** File name of an entry inside its folder. */
export const ENTRY_FILE = 'addon.json'

/** File name of an entry's usage guide inside its folder. */
export const GUIDE_FILE = 'SKILL.md'

/** Kebab-case add-on id, which is also a valid skill name. */
export const ADDON_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Godot folder, autoload, and section names the installer writes. */
const GODOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u
/** A relative path inside an archive, with `/` separators and no `.` or `..` segments. */
const ARCHIVE_PATH = /^(?:[^/\\]+(?:\/[^/\\]+)*)?$/u
const RES_PATH = /^res:\/\/[^\s"]+$/u

const STAGES = ['prototype', 'content', 'polish', 'ship'] as const satisfies readonly GameAddonStage[]
const HOSTS = ['godot', 'blender'] as const satisfies readonly GameAddonHost[]

const ArchivePath = z.string().regex(ARCHIVE_PATH).refine(path => !path.split('/').some(segment => segment === '.' || segment === '..'), 'must not contain . or .. segments')

const Entry = z.strictObject({
  id: z.string().regex(ADDON_ID_PATTERN),
  title: z.string().min(1).max(80),
  host: z.enum(HOSTS),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u),
  summary: z.string().min(1).max(200),
  useWhen: z.string().min(1).max(300),
  avoidWhen: z.string().min(1).max(300).exactOptional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u)).min(1),
  stages: z.array(z.enum(STAGES)).min(1),
  license: z.string().min(1),
  copyright: z.string().min(1),
  credit: z.string().min(1).exactOptional(),
  homepage: z.url({ protocol: /^https$/u }),
  archive: z.strictObject({
    url: z.url({ protocol: /^https$/u }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().positive(),
    root: ArchivePath,
    license: ArchivePath.min(1).exactOptional(),
  }).exactOptional(),
  godot: z.strictObject({
    addonDir: z.string().regex(GODOT_NAME).refine(name => name !== '..' && name !== '.', 'must name a folder'),
    plugin: z.string().regex(/^[^/\\]+\.cfg$/u).exactOptional(),
    autoloads: z.array(z.strictObject({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
      path: z.string().regex(RES_PATH),
    })).min(1).exactOptional(),
    settings: z.array(z.strictObject({ section: z.string().regex(GODOT_NAME), key: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u), value: z.string().min(1).refine(value => !value.includes('\n'), 'must be one line') })).min(1).exactOptional(),
    importTwice: z.boolean().exactOptional(),
  }).exactOptional(),
  assets: z.strictObject({
    url: z.url({ protocol: /^https$/u }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().positive(),
    root: ArchivePath,
    license: z.string().min(1),
    homepage: z.url({ protocol: /^https$/u }),
  }).exactOptional(),
  blender: z.strictObject({
    module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    kind: z.enum(['extension', 'core']),
    setup: z.string().regex(/^[A-Za-z0-9_-]+\.py$/u).exactOptional(),
  }).exactOptional(),
  icon: z.strictObject({
    file: z.string().regex(/^icon\.(?:png|svg)$/u),
    source: z.url({ protocol: /^https$/u }),
    license: z.string().min(1),
    copyright: z.string().min(1).exactOptional(),
  }).exactOptional(),
  conflicts: z.array(z.string().regex(ADDON_ID_PATTERN)).min(1).exactOptional(),
  verified: z.strictObject({
    godot: z.string().min(1).exactOptional(),
    bpy: z.string().min(1).exactOptional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  }),
})

/** A catalog folder that cannot be used: the plugin does not start with it. */
export class GameAddonCatalogError extends Error {
  override name = 'GameAddonCatalogError'
}

/** The frontmatter fields of a usage guide that the skill catalog shows. */
export interface GuideHeader {
  /** Skill name; equals the add-on id. */
  readonly name: string
  /** Skill description the model sees before loading the guide. */
  readonly description: string
}

/** A usage guide split into its frontmatter and its Markdown body. */
export interface ParsedGuide extends GuideHeader {
  /** Markdown after the frontmatter. */
  readonly body: string
}

/**
 * Split a guide into its YAML frontmatter fields and body, as the harness's skill files are read.
 * @param raw - complete `SKILL.md` text.
 * @param source - path named in errors.
 * @returns the name, description, and body.
 * @throws {GameAddonCatalogError} without frontmatter, or without a string `name` and `description`.
 */
export function parseGuide(raw: string, source: string): ParsedGuide {
  const lines = raw.split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== '---') throw new GameAddonCatalogError(`${source} has no YAML frontmatter.`)
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/u, '') === '---')
  if (closing < 0) throw new GameAddonCatalogError(`${source} does not close its YAML frontmatter.`)
  let data: unknown
  try {
    data = parseYaml(lines.slice(1, closing).map(line => line.replace(/\r$/u, '')).join('\n'))
  } catch (error) {
    throw new GameAddonCatalogError(`${source} has invalid YAML frontmatter: ${(error as Error).message}`)
  }
  const fields = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {}
  const { name, description } = fields
  if (typeof name !== 'string' || typeof description !== 'string' || description.trim() === '') {
    throw new GameAddonCatalogError(`${source} needs string name and description fields in its frontmatter.`)
  }
  return { name, description: description.trim(), body: lines.slice(closing + 1).join('\n') }
}

/** Check the host-specific requirements of one parsed entry. */
function checkEntry(entry: GameAddon, folder: string): void {
  const where = `${folder}/${ENTRY_FILE}`
  if (entry.id !== folder) throw new GameAddonCatalogError(`${where}: id ${entry.id} must equal its folder name.`)
  if (entry.host === 'godot') {
    if (entry.godot === undefined || entry.blender !== undefined) throw new GameAddonCatalogError(`${where}: a Godot add-on needs godot and no blender field.`)
    if (entry.archive === undefined) throw new GameAddonCatalogError(`${where}: a Godot add-on needs an archive.`)
    if (entry.assets !== undefined) throw new GameAddonCatalogError(`${where}: only a Blender add-on has an asset pack.`)
    if (entry.verified.godot === undefined) throw new GameAddonCatalogError(`${where}: verified.godot is missing.`)
    for (const autoload of entry.godot.autoloads ?? []) {
      if (!autoload.path.startsWith(`res://addons/${entry.godot.addonDir}/`)) {
        throw new GameAddonCatalogError(`${where}: autoload ${autoload.name} must point inside res://addons/${entry.godot.addonDir}/.`)
      }
    }
    return
  }
  if (entry.blender === undefined || entry.godot !== undefined) throw new GameAddonCatalogError(`${where}: a Blender add-on needs blender and no godot field.`)
  if ((entry.blender.kind === 'extension') !== (entry.archive !== undefined)) {
    throw new GameAddonCatalogError(`${where}: a Blender extension needs an archive, and a core add-on has none.`)
  }
  // Blender add-ons stay in the add-on store and never ship with the game, so no notice copies their license.
  if (entry.archive?.license !== undefined) throw new GameAddonCatalogError(`${where}: archive.license applies only to Godot add-ons.`)
  if (entry.verified.bpy === undefined) throw new GameAddonCatalogError(`${where}: verified.bpy is missing.`)
}

/** Largest icon file the catalog accepts, in bytes. */
export const MAX_ICON_BYTES = 16 * 1024

/**
 * Read an entry's icon as a data URL.
 * @param path - absolute path of `icon.png` or `icon.svg`.
 * @returns the data URL.
 * @throws {GameAddonCatalogError} for a missing, oversized, or scripted icon.
 */
async function readIcon(path: string): Promise<string> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new GameAddonCatalogError(`Cannot read the icon ${path}: ${(error as Error).message}`)
  }
  if (bytes.byteLength > MAX_ICON_BYTES) throw new GameAddonCatalogError(`The icon ${path} has ${bytes.byteLength} bytes; at most ${MAX_ICON_BYTES} fit.`)
  if (path.endsWith('.svg')) {
    const text = bytes.toString('utf8')
    if (/<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?(?:https?:|\/\/)/iu.test(text)) {
      throw new GameAddonCatalogError(`The icon ${path} has scripts or external references.`)
    }
    return `data:image/svg+xml;base64,${bytes.toString('base64')}`
  }
  return `data:image/png;base64,${bytes.toString('base64')}`
}

/** A loaded catalog: every entry, and the guide headers the skill provider lists. */
export class GameAddonCatalog {
  private readonly byId: ReadonlyMap<string, GameAddon>

  /**
   * @param dir - absolute catalog folder.
   * @param entries - validated entries, Godot first, each group by title.
   * @param guides - each entry's guide header, by id.
   * @param icons - the data URLs of the entries that have an icon, by id.
   */
  constructor(
    readonly dir: string,
    readonly entries: readonly GameAddon[],
    private readonly guides: ReadonlyMap<string, GuideHeader>,
    readonly icons: Readonly<Record<string, string>> = {},
  ) {
    this.byId = new Map(entries.map(entry => [entry.id, entry]))
  }

  /**
   * One entry.
   * @param id - catalog id.
   * @returns the entry, or undefined for an unknown id.
   */
  get(id: string): GameAddon | undefined {
    return this.byId.get(id)
  }

  /**
   * One entry's guide header.
   * @param id - catalog id.
   * @returns the header, or undefined for an unknown id.
   */
  guide(id: string): GuideHeader | undefined {
    return this.guides.get(id)
  }

  /**
   * The folder of one entry, which holds its guide and the guide's references.
   * @param id - catalog id of a known entry.
   * @returns the absolute folder.
   */
  folder(id: string): string {
    return join(this.dir, id)
  }
}

/**
 * Load and validate a catalog folder.
 * @param dir - absolute catalog folder.
 * @returns the catalog.
 * @throws {GameAddonCatalogError} for an unreadable folder, an invalid entry or guide, a duplicate id, or a conflict
 * that names an unknown id.
 */
export async function loadCatalog(dir: string): Promise<GameAddonCatalog> {
  let folders: string[]
  try {
    folders = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    throw new GameAddonCatalogError(`Cannot read the add-on catalog at ${dir}: ${(error as Error).message}`)
  }
  const entries: GameAddon[] = []
  const guides = new Map<string, GuideHeader>()
  const icons: Record<string, string> = {}
  for (const folder of folders) {
    const entryPath = join(dir, folder, ENTRY_FILE)
    let text: string
    try {
      text = await readFile(entryPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new GameAddonCatalogError(`Cannot read ${entryPath}: ${(error as Error).message}`)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      throw new GameAddonCatalogError(`${entryPath} is not valid JSON: ${(error as Error).message}`)
    }
    const parsed = Entry.safeParse(json)
    if (!parsed.success) throw new GameAddonCatalogError(`${entryPath} is not a valid add-on entry: ${z.prettifyError(parsed.error)}`)
    const entry: GameAddon = parsed.data
    checkEntry(entry, folder)
    const guidePath = join(dir, folder, GUIDE_FILE)
    let guideText: string
    try {
      guideText = await readFile(guidePath, 'utf8')
    } catch (error) {
      throw new GameAddonCatalogError(`Cannot read the guide of ${entry.id} at ${guidePath}: ${(error as Error).message}`)
    }
    const setup = entry.blender?.setup
    if (setup !== undefined) {
      try {
        await access(join(dir, folder, setup))
      } catch (error) {
        throw new GameAddonCatalogError(`Cannot read the setup script of ${entry.id} at ${join(dir, folder, setup)}: ${(error as Error).message}`)
      }
    }
    const guide = parseGuide(guideText, guidePath)
    if (guide.name !== entry.id) throw new GameAddonCatalogError(`${guidePath}: name ${guide.name} must equal the add-on id ${entry.id}.`)
    if (entry.icon !== undefined) icons[entry.id] = await readIcon(join(dir, folder, entry.icon.file))
    entries.push(entry)
    guides.set(entry.id, { name: guide.name, description: guide.description })
  }
  const ids = new Set(entries.map(entry => entry.id))
  for (const entry of entries) {
    for (const other of entry.conflicts ?? []) {
      if (!ids.has(other) || other === entry.id) throw new GameAddonCatalogError(`${entry.id}: conflict ${other} is not another catalog add-on.`)
    }
  }
  entries.sort((a, b) => a.host === b.host ? a.title.localeCompare(b.title, 'en') : a.host === 'godot' ? -1 : 1)
  return new GameAddonCatalog(dir, entries, guides, icons)
}

/** Filters and words of one catalog search. */
export interface CatalogQuery {
  /** Words to match; empty lists every entry. */
  readonly text?: string
  /** Only add-ons for this application. */
  readonly host?: GameAddonHost
  /** Only add-ons for this development stage. */
  readonly stage?: GameAddonStage
}

/** Words too common to rank by. */
const STOPWORDS: ReadonlySet<string> = new Set(['a', 'an', 'and', 'or', 'the', 'for', 'with', 'to', 'of', 'in', 'on', 'my', 'me', 'i', 'that', 'this', 'it', 'is', 'add', 'addon', 'addons', 'plugin', 'plugins', 'godot', 'blender', 'game', 'need', 'want', 'use'])

function words(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
}

/**
 * Rank the entries that match a query: each query word scores by the best field it starts a word of, 3 for the id
 * or title, 2 for a tag, and 1 for the summary or use; entries without any matching word are left out.
 * @param entries - catalog entries in catalog order.
 * @param query - words and filters.
 * @returns matching entries, best first, catalog order among equals; every filtered entry without words.
 */
export function searchCatalog(entries: readonly GameAddon[], query: CatalogQuery): GameAddon[] {
  const filtered = entries.filter(entry => (query.host === undefined || entry.host === query.host)
    && (query.stage === undefined || entry.stages.includes(query.stage)))
  const wanted = words(query.text ?? '').filter(word => !STOPWORDS.has(word))
  if (wanted.length === 0) return filtered
  // A query word matches a catalog word it starts, or, from five letters on, one of four letters or more that it starts with.
  const matchesWord = (candidate: string, word: string): boolean => candidate.startsWith(word)
    || (word.length >= 5 && word.startsWith(candidate) && candidate.length >= 4)
  const scored = filtered.map((entry, index) => {
    const fields: ReadonlyArray<readonly [readonly string[], number]> = [
      [[...words(entry.id), ...words(entry.title)], 3],
      [entry.tags.flatMap(words), 2],
      [[...words(entry.summary), ...words(entry.useWhen)], 1],
    ]
    let score = 0
    for (const word of wanted) {
      let best = 0
      for (const [fieldWords, weight] of fields) {
        if (weight > best && fieldWords.some(candidate => matchesWord(candidate, word))) best = weight
      }
      score += best
    }
    return { entry, index, score }
  })
  return scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.entry)
}
