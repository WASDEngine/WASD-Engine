/**
 * The asset tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run in
 * the connected agent's Session of the game project it names as `project`, with paths from that folder and drawn
 * images sent as image bytes.
 * @module @deepseek-ai/dsh-game-assets/src/mcp
 */
import { callFolder, type CallFolders, projectMcpTool } from '@deepseek-ai/dsh-game-mcp/kit'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assetToolDefinitions, type AssetToolHost, type AssetToolSurface } from './tools.ts'
import type { AssetRenderedImage } from './types.ts'

/** How connected agents use the asset tools. */
export const MCP_INSTRUCTIONS = 'The asset tools list a game project\'s 2D art and 3D models and look at them as WASD Engine\'s Assets panel draws them. '
  + 'Pass the game project\'s folder as project, an absolute path, and asset paths relative to it. '
  + 'asset_search lists the images and models with how many each folder holds; asset_view draws one asset and lists the details needed to edit it: '
  + 'a model\'s size, triangles, materials and textures, bones, animation clips, and morph targets, drawn from any side, in its materials, as clay, or as wireframe, with its skeleton and frames across a clip; '
  + 'an image\'s pixel size, transparency, colors, and the 2D animations it plays or takes part in, with their frames. '
  + 'The open WASD Engine window draws the pictures. Set show to open the asset in the user\'s Assets panel when you want them to see it.'

/** What the provider's status says while no WASD Engine window is connected. */
export const NO_WINDOW_STATUS = 'No WASD Engine window is open, so asset_view fails until the user opens one; asset_search works without it.'

/** The drawn images of each call, waiting for the call's result. */
type CapturedImages = WeakMap<ToolRunContext, readonly AssetRenderedImage[]>

/**
 * The images of connected agents: each call's images wait for its result, which sends them after its text.
 * @param images - drawn images per call.
 * @returns the image surface.
 */
function mcpImages(images: CapturedImages): AssetToolSurface {
  return {
    seesImages: () => Promise.resolve(true),
    keep(exec, drawn) {
      images.set(exec, drawn)
      return Promise.resolve([])
    },
  }
}

/**
 * The asset provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider, whose tools are `asset_search` and `asset_view`.
 */
export function assetMcpProvider(host: AssetToolHost): GameMcpProvider {
  const images: CapturedImages = new WeakMap()
  const folders: CallFolders = new WeakMap()
  const named: AssetToolHost = {
    ...host,
    project: async exec => callFolder(await host.project(exec), folders, exec),
  }
  const tools = assetToolDefinitions(named, mcpImages(images))
    .map(definition => projectMcpTool(definition, folders, exec => images.get(exec) ?? []))
  return {
    id: 'asset',
    title: 'Assets',
    description: 'List a game project\'s 2D art and 3D models and look at them as WASD Engine draws them.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    // The tools run either way; asset_view alone needs a window to draw the asset.
    status: () => Promise.resolve(host.windowConnected() ? { state: 'ready' } : { state: 'ready', message: NO_WINDOW_STATUS }),
  }
}
