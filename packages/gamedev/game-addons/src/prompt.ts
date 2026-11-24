/**
 * What the agent knows about the add-on catalog before it calls `game_addons`: that it decides itself when an add-on
 * is worth installing, without asking the user first, and the catalog's index, which lists each add-on that the user
 * has not turned off under its category with a cue of a few words. The Session's agent reads the index in the
 * `game-addons` system prompt section; agents connected through WASD Engine's MCP server read it as the result of
 * action search without a query, which the server's instructions send them to. Both read when to use and skip an
 * add-on, its size, license, and conflicts from a search with words, a category, or an id.
 * @module @deepseek-ai/dsh-game-addons/src/prompt
 */
import { CATEGORIES, type GuideHeader } from './catalog.ts'
import type { GameAddon, GameAddonCategory } from './types.ts'

/** Name of the Session's system prompt section. */
export const PROMPT_SECTION = 'game-addons'

/**
 * The heading of each category in the index: it names what the category's shipped entries cover, so it changes when
 * an entry adds a kind.
 */
export const CATEGORY_TITLES: Readonly<Record<GameAddonCategory, string>> = {
  environment: 'Environment: lighting, sky, weather, terrain, water, grass, trees, scattering, roads, dungeons, level layout',
  rendering: 'Rendering: materials, effects, light shafts, fog banks, mirrors, trails, fur, surface marks, screen looks',
  characters: 'Characters: humans, rigs, animation clips, movement, faces, crowds',
  physics: 'Physics: cloth, ropes, ragdolls, vehicles, destruction',
  gameplay: 'Game systems: AI, state, dialogue, inventories',
  camera: 'Camera and game feel',
  interface: 'Interface: menus, HUD, loading screens, button prompts',
  'two-d': '2D levels and sprites',
  kits: 'Starter kits',
  assets: 'Models: import hints, texture baking',
  testing: 'Tests',
}

/** When an add-on is worth installing; both surfaces state it. */
const JUDGMENT = 'Decide yourself when one is worth it; you do not need to ask the user first. '
  + 'Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. '
  + 'Skip it when Godot\'s own nodes, Blender\'s own tools, or a short script do the job, and do not install one in case it is needed later.'

/** How to read more of an add-on than its cue. */
const DETAILS = 'action search with an add-on\'s id, a category, or words shows when it helps, when to skip it, its download size, license, and conflicts.'

/**
 * One category of the index: its entries in catalog order.
 */
export interface CatalogIndexGroup {
  /** The category. */
  readonly category: GameAddonCategory
  /** Its heading. */
  readonly title: string
  /** The category's entries, in catalog order. */
  readonly entries: readonly GameAddon[]
}

/**
 * Group entries by category, in the order of the categories.
 * @param entries - catalog entries, in catalog order.
 * @returns the categories that have an entry.
 */
export function catalogIndex(entries: readonly GameAddon[]): CatalogIndexGroup[] {
  return CATEGORIES
    .map(category => ({ category, title: CATEGORY_TITLES[category], entries: entries.filter(entry => entry.category === category) }))
    .filter(group => group.entries.length > 0)
}

/**
 * The index as text: a heading per category that names the category's search value, then one line per add-on with its
 * id and cue; a Blender add-on's line says so.
 * @param entries - the catalog entries, in catalog order.
 * @param state - what to add after an add-on's cue in brackets, such as its presence in a project; empty adds nothing.
 * @returns the lines, joined by newlines.
 */
export function catalogLines(entries: readonly GameAddon[], state: (entry: GameAddon) => string = () => ''): string {
  return catalogIndex(entries).map(group => [
    `${group.title} (${group.category})`,
    ...group.entries.map((entry) => {
      const note = state(entry)
      return `- ${entry.id}${entry.host === 'blender' ? ' (Blender)' : ''}: ${entry.cue}${note === '' ? '' : ` [${note}]`}`
    }),
  ].join('\n')).join('\n')
}

/**
 * The `game-addons` system prompt section of the Session's agent.
 * @param entries - the catalog entries that agents may use, in catalog order.
 * @returns the section text; empty when the user turned off every add-on, which leaves the section out.
 */
export function sessionPrompt(entries: readonly GameAddon[]): string {
  if (entries.length === 0) return ''
  return `# Game add-ons

game_addons installs tested add-ons, WASD Engine's own and third-party ones, into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. ${JUDGMENT}
Before you build what a listed add-on does, read about it: ${DETAILS} After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

Every add-on, under its category, with what it is for:
${catalogLines(entries)}`
}

/** The line before the guides that go with the add-ons, in the index's search result and the MCP server's instructions. */
export const GUIDES_HEADING = 'Before the work each of these guides is for, read it with action guide and its name as id:'

/**
 * The game add-ons part of WASD Engine's MCP server instructions. It lists no add-on, since the server's overview has
 * connected agents read the catalog's index with action search, but it lists the guides that go with the add-ons, such
 * as the `game-look` guide that the Session's agent reads as a skill, which connected agents have none of.
 * @param guides - the guides' names and descriptions.
 * @returns the instructions.
 */
export function mcpInstructions(guides: readonly GuideHeader[]): string {
  const listed = guides.length === 0 ? '' : `\n${GUIDES_HEADING}\n${guides.map(guide => `- ${guide.name}: ${guide.description}`).join('\n')}`
  return `game_addons installs tested add-ons, WASD Engine's own and third-party ones, into the user's game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with WASD Engine's Godot 4.7 and Blender 5.2. ${JUDGMENT}
Read the catalog's index with action search and no query before you plan a game: it lists every add-on under its category with what it is for. Before you build what a listed add-on does, read about it: ${DETAILS}
Install one with action install and project set to the absolute folder that holds project.godot; it unpacks the add-on into addons/, enables it in project.godot, adds its license to THIRD_PARTY_NOTICES.md, and imports the project. Before using an add-on, read its guide with action guide, and for a Blender add-on run import wasd_addons; wasd_addons.enable("<id>") with blender_execute_python. Tell the user what you added and why, with its license and any credit it requires.${listed}`
}
