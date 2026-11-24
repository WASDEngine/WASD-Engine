/**
 * The ambientCG tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions,
 * which need no Session, with preview images sent as image bytes and the download folder named by absolute path.
 * @module @deepseek-ai/dsh-ambientcg/src/mcp
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import { connectedLibraryTools } from '@deepseek-ai/dsh-game-mcp/kit'
import { AMBIENTCG_ERRORS } from './errors.ts'
import { ambientCgToolDefinitions, type AmbientCgToolHost } from './tools.ts'

/** How connected agents use the ambientCG tools. */
export const MCP_INSTRUCTIONS = 'ambientCG is a free library of more than 2,000 CC0 PBR materials, with decals, atlases of cut-out pieces such as leaves, and HDRI skies, that any game may use without attribution. '
  + 'Look here, and on Poly Haven, before you generate or paint a surface, and download what suits the game\'s art style. '
  + 'ambientcg_search finds assets by English keywords, each of which an asset must have, so use few, such as "brick wall" or "rusty metal"; without a query it lists the most popular ones and the kinds of surface to search for. '
  + 'ambientcg_asset shows one asset\'s picture formats and resolutions with their sizes, and its preview image; names such as "Wood 099" say little, so look before you choose. '
  + 'ambientcg_download saves the map pictures of one resolution into the folder you pass as directory, an absolute path such as <game project>/assets/ambientcg/<asset id>, '
  + 'and refuses to overwrite a changed file unless replace is true. '
  + 'For games prefer 1k or 2k and jpg; NormalGL is the normal map that Godot and Blender read. Record each asset\'s ambientcg.com page with it.'

/** Description of the download folder for connected agents. */
const DIRECTORY_PARAMETER = { type: 'string', description: 'Absolute path of the folder to save into, such as <game project>/assets/ambientcg/<asset id>.' } as const

/**
 * The ambientCG provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider.
 */
export function ambientCgMcpProvider(host: AmbientCgToolHost): GameMcpProvider {
  const tools = connectedLibraryTools<ImageAttachmentRef>(
    surface => ambientCgToolDefinitions(host, surface), { tool: 'ambientcg_download', directory: DIRECTORY_PARAMETER, errors: AMBIENTCG_ERRORS },
  )
  return {
    id: 'ambientcg',
    title: 'ambientCG',
    description: 'Find free CC0 PBR materials, decals, and HDRI skies and download their maps into the game.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
