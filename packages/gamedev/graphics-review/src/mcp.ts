/**
 * The graphics review for agents connected through WASD Engine's MCP server: the Session's own tool definition, which
 * needs no Session, with the image named by absolute path, under the provider `graphics`, whose description in the
 * overview of the server instructions asks for a review after all graphics work.
 * @module @deepseek-ai/dsh-graphics-review/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import { MCP_DESCRIPTION, MCP_INSTRUCTIONS } from './prompt.ts'
import { graphicsReviewToolDefinition, type GraphicsReviewHost, type GraphicsReviewWording } from './tools.ts'

/** Provider id; it prefixes the tool name. */
export const MCP_PROVIDER_ID = 'graphics'

/** Wording for connected agents, which name every file by absolute path. */
export const MCP_WORDING: GraphicsReviewWording = {
  image: 'Absolute path of the PNG, JPEG, or WebP image to review: a game screenshot that godot_screenshot or godot_view saved at their '
    + 'path, a Blender render, an image from image_generate, a texture, or a sprite sheet.',
}

/**
 * The graphics review provider of WASD Engine's MCP server.
 * @param host - the limits and the review; the provider resolves only absolute image paths.
 * @returns the provider.
 */
export function graphicsReviewMcpProvider(host: Omit<GraphicsReviewHost, 'image'>): GameMcpProvider {
  const definition = graphicsReviewToolDefinition({
    ...host,
    image: requested => isAbsolute(requested)
      ? Promise.resolve(requested)
      : Promise.reject(new Error(`image must be an absolute path, got ${JSON.stringify(requested)}.`)),
  }, MCP_WORDING)
  // The review reads the image and changes nothing in the game project.
  const tool: GameMcpTool = { name: definition.name, definition, readOnly: true }
  return {
    id: MCP_PROVIDER_ID,
    title: 'Graphics review',
    description: MCP_DESCRIPTION,
    instructions: MCP_INSTRUCTIONS,
    tools: () => [tool],
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
