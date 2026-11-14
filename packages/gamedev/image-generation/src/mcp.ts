/**
 * The image tool for agents connected through WASD Engine's MCP server: the Session's own tool definition, which needs
 * no Session, with every file named by absolute path. The images are charged to the account WASD Engine is signed in
 * to, like the Session's own calls.
 * @module @deepseek-ai/dsh-image-generation/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { imageToolDefinitions, type ImageToolHost, type ImageToolSurface } from './tools.ts'

/** How connected agents use the image tool. */
export const MCP_INSTRUCTIONS = 'Nano Banana makes images for the user\'s game with Google\'s Nano Banana 2.1, charged to the AI usage of the WASD Engine account the app is signed in to. '
  + 'image_generate makes one image from a prompt and saves it at path, an absolute path such as <game project>/art/items/potion.png, as PNG, JPEG, or WebP by its extension, and refuses to overwrite a file unless replace is true. '
  + 'Pass images, absolute paths of up to 14 existing images, to work from references, to edit them, or to keep a character, object, or art style consistent; aspect_ratio sets the shape and size 1K, 2K, or 4K the resolution. '
  + 'It makes no transparent backgrounds: ask for one flat background color the art does not use and make it transparent with GIMP, with a little tolerance for JPEG edges. '
  + 'Look at each image before building on it, and save and reuse images instead of making them again, since every image costs the user\'s plan, more at 2K and 4K.'

/** The connected agents' surface: absolute paths, which `prepare` checks before the call runs. */
const MCP_SURFACE: ImageToolSurface = {
  pathDescription: 'Absolute path of the file to write, such as <game project>/art/items/potion.png.',
  imagesDescription: 'Absolute paths of existing images, such as <game project>/art/items/potion.png.',
}

function absolute(value: unknown): boolean {
  return typeof value === 'string' && isAbsolute(value)
}

/**
 * Offer the image tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' path wording.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition): GameMcpTool {
  return {
    name: definition.name,
    definition,
    readOnly: false,
    prepare(args) {
      if (!absolute(args.path)) return Promise.reject(new Error('path must be an absolute path.'))
      if (args.images !== undefined && (!Array.isArray(args.images) || !args.images.every(absolute))) {
        return Promise.reject(new Error('images must be absolute paths.'))
      }
      return Promise.resolve({ args })
    },
  }
}

/**
 * The image provider of WASD Engine's MCP server.
 * @param host - plugin operations the tool calls.
 * @returns the provider.
 */
export function imageMcpProvider(host: ImageToolHost): GameMcpProvider {
  const tools = imageToolDefinitions(host, MCP_SURFACE).map(mcpTool)
  return {
    id: 'image',
    title: 'Nano Banana',
    description: 'Make game art, UI pieces, and textures with Google\'s Nano Banana 2.1, saved into the user\'s game project.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
