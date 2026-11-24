/**
 * The Poly Haven tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions,
 * which need no Session, with preview images sent as image bytes and the download folder named by absolute path.
 * @module @deepseek-ai/dsh-polyhaven/src/mcp
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import { connectedLibraryTools } from '@deepseek-ai/dsh-game-mcp/kit'
import { POLYHAVEN_ERRORS } from './errors.ts'
import { polyHavenToolDefinitions, type PolyHavenToolHost } from './tools.ts'

/** How connected agents use the Poly Haven tools. */
export const MCP_INSTRUCTIONS = 'Poly Haven is a free library of CC0 HDRI skies, tileable PBR textures, and 3D models that any game may use without attribution. '
  + 'Look here before you make or generate a sky, texture, or model, and download what suits the game\'s art style. '
  + 'polyhaven_search finds assets from a description in any language; without a query it lists the most downloaded ones and their categories. '
  + 'polyhaven_asset shows one asset\'s formats, resolutions, and sizes, and its preview image. '
  + 'polyhaven_download saves one format and resolution into the folder you pass as directory, an absolute path such as <game project>/assets/polyhaven/<asset id>, '
  + 'and refuses to overwrite a changed file unless replace is true. '
  + 'For games prefer 1k or 2k, gltf for models, and jpg maps with the nor_gl normal map for textures, which Godot and Blender read. Record each asset\'s polyhaven.com page with it.'

/** Description of the download folder for connected agents. */
const DIRECTORY_PARAMETER = { type: 'string', description: 'Absolute path of the folder to save into, such as <game project>/assets/polyhaven/<asset id>.' } as const

/**
 * The Poly Haven provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider.
 */
export function polyHavenMcpProvider(host: PolyHavenToolHost): GameMcpProvider {
  const tools = connectedLibraryTools<ImageAttachmentRef>(
    surface => polyHavenToolDefinitions(host, surface), { tool: 'polyhaven_download', directory: DIRECTORY_PARAMETER, errors: POLYHAVEN_ERRORS },
  )
  return {
    id: 'polyhaven',
    title: 'Poly Haven',
    description: 'Find free CC0 HDRIs, textures, and 3D models and download them into the game. Look here before you make or generate an '
      + 'asset, and use what suits the game\'s art style.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
