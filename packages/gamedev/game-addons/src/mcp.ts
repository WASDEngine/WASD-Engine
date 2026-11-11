/**
 * The `game_addons` tool for agents connected through WASD Engine's MCP server: the Session's own definition with
 * projects named by absolute path. Connected agents have no WASD Engine skills, so they read an add-on's guide with
 * the `guide` action; their own harness asks their user before an installation.
 * @module @deepseek-ai/dsh-game-addons/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import { gameAddonToolDefinition, type GameAddonToolHost, type GameAddonToolWording } from './tools.ts'

/** Provider id; it prefixes the tool name. */
export const MCP_PROVIDER_ID = 'game'

/** How connected agents use the add-on tool. */
export const MCP_INSTRUCTIONS = 'game_addons manages a curated catalog of third-party add-ons, each pinned to a version tested with WASD Engine\'s Godot 4.7 and Blender 5.2: Godot add-ons (GDScript only, so Web releases keep working) for cameras, dialogue, behavior trees, state charts, inventories, unit tests, tile terrain, importers, sky, and scattering, and Blender add-ons for rigging, humans, trees, landscapes, and VRM. '
  + 'Use action search with what the game needs, then action guide with the id to read how to use it. Install only what the user agreed to, with action install and project set to the absolute folder that holds project.godot; it unpacks the add-on into addons/, enables it in project.godot, adds its license to THIRD_PARTY_NOTICES.md, and imports the project. '
  + 'For a Blender add-on, run import wasd_addons; wasd_addons.enable("<id>") with blender_execute_python before using it. Prefer what Godot and Blender already do.'

/** Wording for connected agents, which name projects by absolute path. */
export const MCP_WORDING: GameAddonToolWording = {
  project: 'Absolute path of the folder that holds project.godot. Required for install, remove, and list; with search and guide it adds whether the project has each add-on.',
}

/**
 * The add-on provider of WASD Engine's MCP server.
 * @param host - the manager and project resolution; `project` must accept an absolute path without an Agent.
 * @returns the provider.
 */
export function gameAddonMcpProvider(host: GameAddonToolHost): GameMcpProvider {
  const definition = gameAddonToolDefinition(host, MCP_WORDING)
  const tool: GameMcpTool = {
    name: definition.name,
    definition,
    readOnly: false,
    prepare(args) {
      const project = args.project
      if (project !== undefined && (typeof project !== 'string' || !isAbsolute(project))) {
        return Promise.reject(new Error('project must be an absolute path.'))
      }
      const action = args.action
      if ((action === 'install' || action === 'remove' || action === 'list') && project === undefined) {
        return Promise.reject(new Error(`action ${action} needs project, the absolute folder that holds project.godot.`))
      }
      return Promise.resolve({ args })
    },
  }
  return {
    id: MCP_PROVIDER_ID,
    title: 'Game add-ons',
    description: 'Search, read, install, and remove curated Godot and Blender add-ons in the user\'s game project.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => [tool],
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
