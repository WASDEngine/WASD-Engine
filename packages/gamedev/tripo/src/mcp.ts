/**
 * The Tripo tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, which need
 * no Session, with every file named by absolute path. The tasks are charged to the account WASD Engine is signed in to,
 * like the Session's own calls.
 * @module @deepseek-ai/dsh-tripo/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { tripoToolDefinitions, type TripoToolHost, type TripoToolSurface } from './tools.ts'

/**
 * How connected agents use the Tripo tools. Like the tools' descriptions, it leaves out what a model costs, so the agent
 * makes what the game needs; only the usage-limit failure asks the user to upgrade.
 */
export const MCP_INSTRUCTIONS = 'Tripo makes 3D models for the user\'s game with Tripo\'s P2 model: textured models, their skeletons, and their animations, saved as .glb files. '
  + 'Prefer it to modeling characters, creatures, and props in Blender or building them from primitives in code, and use Blender to adjust, combine, or clean up what it makes. '
  + 'tripo_generate makes a model with PBR textures from image, one image of the object, from views, two to four views of it, or from a prompt; the best results come from one image of the whole object, centered on a plain background, in the game\'s art style, such as a concept image_generate makes, with a character standing in a T-pose. '
  + 'Each tool saves its model at path, an absolute path ending in .glb such as <game project>/models/knight.glb, refuses to overwrite a file unless replace is true, and returns a task_id that the next step takes: '
  + 'tripo_texture gives a generated model a new texture from a prompt or an image, tripo_rig adds a skeleton, picking the rig type unless rig_type names it, and tripo_animate adds up to five of Tripo\'s preset animations to a rig, on the spot where it stands at rest unless in_place is false. '
  + 'A call waits for Tripo, often a minute; when one stops waiting, tripo_task with the task_id it names waits again and saves the model. '
  + 'Every saved model faces +Z, glTF\'s front: look at it with asset_view, then scale it and turn it in Godot or Blender to fit the game.'

/** The connected agents' surface: absolute paths, which `prepare` checks before the call runs. */
const MCP_SURFACE: TripoToolSurface = {
  pathDescription: 'Absolute path of the file to write, such as <game project>/models/knight.glb.',
  imageDescription: 'Absolute path of an existing image, such as <game project>/art/concepts/knight.png.',
}

function absolute(value: unknown): boolean {
  return typeof value === 'string' && isAbsolute(value)
}

/**
 * Refuse a call that names a file by a relative path.
 * @param args - the call's arguments.
 * @returns the error message, or undefined when every file is absolute.
 */
function relativeFile(args: Record<string, unknown>): string | undefined {
  if (args.path !== undefined && !absolute(args.path)) return 'path must be an absolute path.'
  if (args.image !== undefined && !absolute(args.image)) return 'image must be an absolute path.'
  const views = args.views
  if (views !== undefined && (typeof views !== 'object' || views === null || !Object.values(views).every(absolute))) {
    return 'views must be absolute paths.'
  }
  return undefined
}

/**
 * Offer one Tripo tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' path wording.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition): GameMcpTool {
  return {
    name: definition.name,
    definition,
    readOnly: false,
    prepare(args) {
      const refused = relativeFile(args)
      return refused === undefined ? Promise.resolve({ args }) : Promise.reject(new Error(refused))
    },
  }
}

/**
 * The Tripo provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider.
 */
export function tripoMcpProvider(host: TripoToolHost): GameMcpProvider {
  const tools = tripoToolDefinitions(host, MCP_SURFACE).map(mcpTool)
  return {
    id: 'tripo',
    title: 'Tripo',
    description: 'Make textured, rigged, and animated 3D models. Prefer it to modeling them yourself.',
    instructions: MCP_INSTRUCTIONS,
    spendsUsage: true,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
