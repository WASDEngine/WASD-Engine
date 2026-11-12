/**
 * The asset tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run in
 * the connected agent's Session of the game project it names as `project`, with paths from that folder and drawn
 * images sent as image bytes.
 * @module @deepseek-ai/dsh-game-assets/src/mcp
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { assetToolDefinitions, type AssetToolHost, type AssetToolSurface } from './tools.ts'
import type { AssetRenderedImage } from './types.ts'

/** How connected agents use the asset tools. */
export const MCP_INSTRUCTIONS = 'The asset tools list a game project\'s 2D art and 3D models and look at them as WASD Engine\'s Assets panel draws them. '
  + 'Pass the game project\'s folder as project, an absolute path, and asset paths relative to it. '
  + 'asset_search lists the images and models with how many each folder holds; asset_view draws one asset and lists the details needed to edit it: '
  + 'a model\'s size, triangles, materials and textures, bones, animation clips, and morph targets, drawn from any side, in its materials, as clay, or as wireframe, with its skeleton and frames across a clip; '
  + 'an image\'s pixel size, transparency, colors, and the 2D animations it plays or takes part in, with their frames. '
  + 'The open WASD Engine window draws the pictures. Set show to open the asset in the user\'s Assets panel when you want them to see it.'

/** Description of the project folder for connected agents. */
const PROJECT_PARAMETER = { type: 'string', description: 'Absolute path of the game project\'s folder, such as the folder that holds project.godot.' } as const

/** The object schema that `defineTool` writes for a tool's arguments. */
type ArgumentSchema = { readonly properties: Readonly<Record<string, JsonObject>>; readonly required?: readonly string[] }

/** The drawn images of each call, waiting for the call's result. */
type CapturedImages = WeakMap<ToolRunContext, readonly AssetRenderedImage[]>

/** The canonical project folder each call names, by the arguments object the call's execution carries. */
type CallFolders = WeakMap<object, string>

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
 * Offer one asset tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' image surface.
 * @param images - drawn images per call.
 * @param folders - the project folder per call.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, images: CapturedImages, folders: CallFolders): GameMcpTool {
  // `defineTool` writes an object schema whose properties describe the arguments.
  const { properties, required = [] } = definition.parameters as ArgumentSchema
  return {
    name: definition.name,
    definition,
    inputSchema: { type: 'object', additionalProperties: false, properties: { project: PROJECT_PARAMETER, ...properties }, required: ['project', ...required] },
    readOnly: true,
    async prepare(args, call) {
      const { project, ...rest } = args
      if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('project must be the absolute path of the game project\'s folder.')
      const agent = await call.session(project)
      // The Session belongs to the registered game project that holds the folder; the call's paths start at the folder.
      folders.set(rest, await realpath(project))
      return { args: rest, agent }
    },
    content: (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => [
      ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
      ...(images.get(exec) ?? []).map((image): GameMcpContent => ({ type: 'image', data: image.data, mimeType: image.mediaType })),
    ],
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
    async project(exec) {
      const session = await host.project(exec)
      const folder = typeof exec.arguments === 'object' && exec.arguments !== null ? folders.get(exec.arguments) : undefined
      if (folder === undefined) return session
      const inside = relative(session, folder)
      return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? session : folder
    },
  }
  const tools = assetToolDefinitions(named, mcpImages(images)).map(definition => mcpTool(definition, images, folders))
  return {
    id: 'asset',
    title: 'Assets',
    description: 'List a game project\'s 2D art and 3D models and look at them as WASD Engine\'s Assets panel draws them, with the details needed to edit them.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
