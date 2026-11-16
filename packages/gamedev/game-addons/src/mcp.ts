/**
 * The `game_addons` tool for agents connected through WASD Engine's MCP server: the Session's own definition with
 * projects named by absolute path, a description that asks for the whole catalog before a game is planned, and the
 * catalog in the server's instructions, whose overview says what the add-ons add. Connected agents have no WASD Engine
 * skills, so they read an add-on's guide with the `guide` action, as the install and list results say. They decide
 * when to install an add-on as the Session's agent does; WASD Engine asks nobody, and their own harness applies its own
 * approval rules.
 * @module @deepseek-ai/dsh-game-addons/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import { mcpInstructions } from './prompt.ts'
import { gameAddonToolDefinition, type GameAddonToolHost, type GameAddonToolWording } from './tools.ts'

/** Provider id; it prefixes the tool name. */
export const MCP_PROVIDER_ID = 'game'

/** Wording for connected agents, which name projects by absolute path and read guides with the guide action. */
export const MCP_WORDING: GameAddonToolWording = {
  project: 'Absolute path of the folder that holds project.godot. Required for install, remove, and list; with search and guide it adds whether the project has each add-on.',
  installedGuide: id => `Read its guide with action guide and id ${id} before using the add-on.`,
  listedGuides: 'read each one\'s guide with action guide',
}

/** What the add-ons add, and when to read the catalog, as the server instructions list it. */
export const MCP_DESCRIPTION = 'Curated add-ons, tested with WASD Engine\'s Godot and Blender, that do common game jobs better than code written from '
  + 'scratch: cameras, sky, scattering, terrain, dialogue, inventories, AI, trees, humans, rigs, cloth, and animations. Before you plan a game, '
  + 'read the whole catalog with game_addons action search and install each one that fits.'

/** The sentence that the tool's description adds for connected agents, which have no catalog in a system prompt. */
const CATALOG_FIRST = 'Before you plan a game, read the whole catalog with action search and no query.'

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
    description: `${definition.description} ${CATALOG_FIRST}`,
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
    description: MCP_DESCRIPTION,
    instructions: mcpInstructions(host.manager.catalog.entries),
    tools: () => [tool],
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
