/**
 * The `game_addons` tool for agents connected through WASD Engine's MCP server: the Session's own definition with
 * projects named by absolute path, and the catalog in the server's instructions. Connected agents have no WASD Engine
 * skills, so they read an add-on's guide with the `guide` action. They decide when to install an add-on as the
 * Session's agent does; WASD Engine asks nobody, and their own harness applies its own approval rules.
 * @module @deepseek-ai/dsh-game-addons/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import { mcpInstructions } from './prompt.ts'
import { gameAddonToolDefinition, type GameAddonToolHost, type GameAddonToolWording } from './tools.ts'

/** Provider id; it prefixes the tool name. */
export const MCP_PROVIDER_ID = 'game'

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
    instructions: mcpInstructions(host.manager.catalog.entries),
    tools: () => [tool],
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
