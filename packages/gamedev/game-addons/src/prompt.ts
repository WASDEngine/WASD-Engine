/**
 * What the agent knows about the add-on catalog before it calls `game_addons`: that it decides itself when an add-on
 * is worth installing, without asking the user first, and each catalog add-on with the stages of a game at which it
 * helps and when to use it. The Session's agent reads it as the `game-addons` system prompt section; agents connected
 * through WASD Engine's MCP server read it in the server's instructions.
 * @module @deepseek-ai/dsh-game-addons/src/prompt
 */
import type { GameAddon } from './types.ts'

/** Name of the Session's system prompt section. */
export const PROMPT_SECTION = 'game-addons'

const HOSTS = { godot: 'Godot', blender: 'Blender' } as const

/** When an add-on is worth installing; both surfaces state it. */
const JUDGMENT = 'Decide yourself when one is worth it; you do not need to ask the user first. '
  + 'Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. '
  + 'Skip it when Godot\'s own nodes, Blender\'s own tools, or a short script do the job, and do not install one in case it is needed later. '
  + 'action search shows each add-on\'s download size, conflicts, and when to skip it.'

/** The heading of the catalog lines, which also says what the stage names mean. */
const LIST_HEADING = 'Each add-on below shows its id, its application, the stages at which it helps '
  + '(prototype makes the core game playable, content adds levels, characters, and assets, polish adds game feel and finish, and ship tests and releases the game), '
  + 'and when to use it:'

/**
 * One line per catalog add-on: its id, application, stages, and when to use it.
 * @param entries - the catalog entries, in catalog order.
 * @returns the lines, joined by newlines.
 */
export function catalogLines(entries: readonly GameAddon[]): string {
  return entries.map(entry => `- ${entry.id} (${HOSTS[entry.host]}; ${entry.stages.join(', ')}): ${entry.useWhen}`).join('\n')
}

/**
 * The `game-addons` system prompt section of the Session's agent.
 * @param entries - the catalog entries, in catalog order.
 * @returns the section text.
 */
export function sessionPrompt(entries: readonly GameAddon[]): string {
  return `# Game add-ons

game_addons installs tested third-party add-ons into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. ${JUDGMENT}
After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

${LIST_HEADING}
${catalogLines(entries)}`
}

/**
 * The game add-ons part of WASD Engine's MCP server instructions.
 * @param entries - the catalog entries, in catalog order.
 * @returns the instructions.
 */
export function mcpInstructions(entries: readonly GameAddon[]): string {
  return `game_addons installs tested third-party add-ons into the user's game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with WASD Engine's Godot 4.7 and Blender 5.2. ${JUDGMENT}
Install one with action install and project set to the absolute folder that holds project.godot; it unpacks the add-on into addons/, enables it in project.godot, adds its license to THIRD_PARTY_NOTICES.md, and imports the project. Before using an add-on, read its guide with action guide, and for a Blender add-on run import wasd_addons; wasd_addons.enable("<id>") with blender_execute_python. Tell the user what you added and why, with its license and any credit it requires.

${LIST_HEADING}
${catalogLines(entries)}`
}
