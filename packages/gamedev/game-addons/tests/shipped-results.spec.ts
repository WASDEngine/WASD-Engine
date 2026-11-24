/**
 * What `game_addons` returns over the add-on catalog that WASD Engine ships, for the Session's agent and for connected
 * agents: the profiles' `resultChars` is the gamedev preset's tool-result pruner threshold; each guide, with the files
 * it links that fit, and each linked file by itself stay within it; a search of each category describes all of the
 * category's add-ons, inside a project as outside one, as the system prompt section and the tool's description
 * promise; and a query that names Godot or Blender keeps to that application's add-ons.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { CATEGORIES, GUIDE_FILE, guideReferences, loadCatalog, loadGuides, parseGuide, type GameAddonCatalog } from '../src/catalog.ts'
import GameAddons from '../src/index.ts'
import { GameAddonManager } from '../src/manager.ts'
import { MCP_WORDING } from '../src/mcp.ts'
import { gameAddonToolDefinition, SESSION_WORDING, type GameAddonToolWording } from '../src/tools.ts'
import { scratch, writeProject } from './fixtures.ts'
import { BUNDLED_SKILLS_DIR, CATALOG_DIR } from './shipped-catalog.ts'

/** The gamedev preset's profile overlay beside the catalog, whose compaction group mounts the tool-result pruner. */
const GAMEDEV_OVERLAY = join(CATALOG_DIR, '..', 'gamedev.cordis.patch.yml')

/** The overlay that inserts the `game-addons` row into the Web and Desktop profiles. */
const GAME_TOOLS_OVERLAY = join(CATALOG_DIR, '..', 'game-tools.cordis.patch.yml')

/** The guides that go with the add-ons in the Web and Desktop profiles, as the `game-addons` row's `guides` names them. */
const ROW_GUIDES = [join(BUNDLED_SKILLS_DIR, 'game-look', GUIDE_FILE)]

const catalog = await loadCatalog(CATALOG_DIR)
const guides = await loadGuides(ROW_GUIDES, catalog)

/** The two surfaces with their wording. */
const SURFACES: ReadonlyArray<readonly [string, GameAddonToolWording]> = [['Session', SESSION_WORDING], ['MCP', MCP_WORDING]]

/** Every config of a parsed overlay row with the given id, at any depth. */
function rowConfigs(node: unknown, id: string): unknown[] {
  if (Array.isArray(node)) return node.flatMap(item => rowConfigs(item, id))
  if (typeof node !== 'object' || node === null) return []
  const fields: ReadonlyArray<readonly [string, unknown]> = Object.entries(node)
  const own = fields.some(([key, value]) => key === 'id' && value === id) ? [fields.find(([key]) => key === 'config')?.[1]] : []
  return [...own, ...fields.flatMap(([, value]) => rowConfigs(value, id))]
}

/**
 * One numeric field of the config of an overlay's row.
 * @param overlay - absolute path of the overlay.
 * @param id - the row's id, which the overlay has once.
 * @param field - the config field.
 * @returns the field's value, or undefined when the row leaves it out.
 */
async function rowNumber(overlay: string, id: string, field: string): Promise<number | undefined> {
  const configs = rowConfigs(parseYaml(await readFile(overlay, 'utf8'), { logLevel: 'error' }), id)
  expect(configs, `${id} rows in ${overlay}`).toHaveLength(1)
  const [config] = configs
  const fields: ReadonlyArray<readonly [string, unknown]> = typeof config === 'object' && config !== null ? Object.entries(config) : []
  const value = fields.find(([key]) => key === field)?.[1]
  if (value !== undefined) expect(value, `${id}.${field}`).toBeTypeOf('number')
  return typeof value === 'number' ? value : undefined
}

/** The `resultChars` that the Web and Desktop profiles give the `game-addons` row: its own, or the Config's default. */
const RESULT_CHARS = await rowNumber(GAME_TOOLS_OVERLAY, 'game-addons', 'resultChars')
  ?? GameAddons.Config({ catalogDir: '/unused/catalog', dataRoot: '/unused/data', blenderStore: '/unused/store' }).resultChars

/** Run one call of the tool over the shipped catalog and return its result text. */
type Call = (args: Record<string, unknown>) => Promise<string>

/**
 * The tool of one surface over the shipped catalog, with every add-on on, as the profiles configure it; nothing
 * downloads or installs.
 * @param shipped - the shipped catalog.
 * @param wording - the surface's wording.
 * @param project - the folder of the project that every call names; without it, no call has a project, which no search
 *   or guide needs.
 * @returns a function that runs one call.
 */
function tool(shipped: GameAddonCatalog, wording: GameAddonToolWording, project?: string): Call {
  const manager = new GameAddonManager({
    catalog: shipped,
    downloads: { cacheDir: '/unused/archives', fetch: () => Promise.reject(new Error('The shipped-results spec downloads nothing.')) },
    blenderStore: '/unused/store',
    assetsDir: '/unused/assets',
    importProject: () => Promise.resolve(undefined),
    now: () => new Date('2026-11-23T12:00:00Z'),
    changed: () => {},
    allowed: () => true,
  })
  const definition = gameAddonToolDefinition({
    manager,
    guides,
    resultChars: RESULT_CHARS,
    project: () => project === undefined ? Promise.reject(new Error('No project.')) : Promise.resolve(project),
  }, wording)
  const exec = { signal: new AbortController().signal } as ToolRunContext
  return async (args) => {
    const value = await definition.execute(args, exec) as JsonValue
    return definition.output.render(args, value).map(block => block.type === 'text' ? block.text : '').join('')
  }
}

/** The length of a text in Unicode code points, as the pruner counts it. */
function codePoints(text: string): number {
  return Array.from(text).length
}

describe('game_addons over the shipped catalog', () => {
  it('keeps results within the threshold of the gamedev preset\'s tool-result pruner', async () => {
    const threshold = await rowNumber(GAMEDEV_OVERLAY, 'tool-result-pruner', 'thresholdChars')
    expect(threshold, 'the pruner row sets thresholdChars').toBeTypeOf('number')
    expect(RESULT_CHARS).toBe(threshold)
  })

  it.each(SURFACES)('returns every guide for the %s agent within the result limit, and each file it leaves out by its reference', async (_surface, wording) => {
    const call = tool(catalog, wording)
    const named = [...catalog.entries.map(entry => entry.id), ...guides.keys()]
    for (const id of named) {
      const own = guides.get(id)
      const path = own === undefined ? join(catalog.folder(id), GUIDE_FILE) : join(own.folder, GUIDE_FILE)
      const references = guideReferences(parseGuide(await readFile(path, 'utf8'), path).body)
      const guide = await call({ action: 'guide', id })
      expect(codePoints(guide), `${id} guide result`).toBeLessThanOrEqual(RESULT_CHARS)
      for (const reference of references) {
        // A linked file comes with the guide or is named with the call that shows it.
        const left = `The file ${reference}, which this guide links, did not fit in this result; read it with action guide, id ${id}, and reference ${reference}.`
        expect(guide.includes(`The file ${reference}, which this guide links:\n\n`) || guide.includes(left), `${id} names ${reference}`).toBe(true)
        const file = await call({ action: 'guide', id, reference })
        expect(file, `${id} ${reference}`).toMatch(new RegExp(`^The file ${reference.replaceAll('.', '\\.')}, which the guide ${id} links:\n\n`, 'u'))
        expect(codePoints(file), `${id} ${reference} result`).toBeLessThanOrEqual(RESULT_CHARS)
      }
    }
  })

  it('describes all of each category\'s add-ons in full, inside a project that has none of them as outside one', async (test) => {
    const folder = await scratch('shipped-results')
    test.onTestFinished(() => folder.cleanup())
    const outside = tool(catalog, SESSION_WORDING)
    const inside = tool(catalog, SESSION_WORDING, await writeProject(join(folder.root, 'Games', 'Knight Training Yard')))
    for (const category of CATEGORIES) {
      const members = catalog.entries.filter(entry => entry.category === category)
      if (members.length === 0) continue
      const result = await outside({ action: 'search', category })
      expect(result.split('\n')[0], `${category}: shorten its entries' descriptions, or the search lists them by cue alone`).toBe(`${String(members.length)} matching add-on${members.length === 1 ? '' : 's'}:`)
      for (const entry of members) expect(result, `${category} ${entry.id}`).toContain(`\n- ${entry.id}: ${entry.title} ${entry.version} (`)
      // The project adds a note only on what it has, and its folder does not lengthen the descriptions' result.
      expect(await inside({ action: 'search', category }), `${category} in a project`).toBe(result)
    }
  })

  it('keeps to Blender\'s or Godot\'s add-ons for a query that names one, and gives the index for common words alone', async () => {
    const call = tool(catalog, MCP_WORDING)
    const blender = catalog.entries.filter(entry => entry.host === 'blender')
    for (const query of ['blender', 'blender add-ons', 'Blender addons']) {
      const result = await call({ action: 'search', query })
      expect(result.split('\n')[0], query).toBe(`${String(blender.length)} matching add-ons:`)
      for (const entry of blender) expect(result, `${query} ${entry.id}`).toContain(`\n- ${entry.id}: ${entry.title} ${entry.version} (Blender,`)
    }
    const godot = catalog.entries.filter(entry => entry.host === 'godot')
    const plugins = await call({ action: 'search', query: 'godot plugin' })
    expect(plugins.split('\n')[0]).toBe(`The ${String(godot.length)} matching add-ons, too many to describe in one result, under their categories, with what each is for:`)
    for (const entry of godot) expect(plugins, entry.id).toContain(`\n- ${entry.id}: ${entry.cue}`)
    expect(plugins).not.toContain('(Blender)')
    expect(codePoints(plugins)).toBeLessThanOrEqual(RESULT_CHARS)
    expect((await call({ action: 'search', query: 'game' })).split('\n')[0]).toBe(`The catalog's ${String(catalog.entries.length)} add-ons, under their categories, with what each is for:`)
  })
})
