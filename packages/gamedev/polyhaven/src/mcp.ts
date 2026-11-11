/**
 * The Poly Haven tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions,
 * which need no Session, with preview images sent as image bytes and the download folder named by absolute path.
 * @module @deepseek-ai/dsh-polyhaven/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PreviewImage } from './api.ts'
import { polyHavenToolDefinitions, type PolyHavenToolHost, type PolyHavenToolSurface } from './tools.ts'

/** How connected agents use the Poly Haven tools. */
export const MCP_INSTRUCTIONS = 'Poly Haven is a free library of CC0 HDRI skies, tileable PBR textures, and 3D models that any game may use without attribution. '
  + 'polyhaven_search finds assets from a description in any language; without a query it lists the most downloaded ones and their categories. '
  + 'polyhaven_asset shows one asset\'s formats, resolutions, and sizes, and its preview image. '
  + 'polyhaven_download saves one format and resolution into the folder you pass as directory, an absolute path such as <game project>/assets/polyhaven/<asset id>, '
  + 'and refuses to overwrite a changed file unless replace is true. '
  + 'For games prefer 1k or 2k, gltf for models, and jpg maps with the nor_gl normal map for textures, which Godot and Blender read. Record each asset\'s polyhaven.com page with it.'

/** The preview images of each call, waiting for the call's result. */
type CapturedImages = WeakMap<ToolRunContext, PreviewImage[]>

/** Description of the download folder for connected agents. */
const DIRECTORY_PARAMETER = { type: 'string', description: 'Absolute path of the folder to save into, such as <game project>/assets/polyhaven/<asset id>.' } as const

/**
 * The previews of connected agents: each image's bytes wait for the call's result, which sends them after its text.
 * @param images - preview images per call.
 * @returns the preview surface.
 */
function mcpPreviews(images: CapturedImages): PolyHavenToolSurface {
  return {
    async preview(exec, load) {
      const image = await load(exec.signal)
      images.set(exec, [...images.get(exec) ?? [], image])
      return undefined
    },
  }
}

/**
 * Offer one Poly Haven tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' previews.
 * @param images - preview images per call.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, images: CapturedImages): GameMcpTool {
  const content = (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => [
    ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
    ...(images.get(exec) ?? []).map((image): GameMcpContent => ({ type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType })),
  ]
  if (definition.name !== 'polyhaven_download') return { name: definition.name, definition, readOnly: true, content }
  // `defineTool` writes an object schema whose properties describe the arguments.
  const { properties } = definition.parameters as { readonly properties: Readonly<Record<string, JsonObject>> }
  return {
    name: definition.name,
    definition,
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, directory: DIRECTORY_PARAMETER }, required: ['id', 'directory'] },
    readOnly: false,
    prepare(args) {
      const directory = args.directory
      if (typeof directory !== 'string' || !isAbsolute(directory)) return Promise.reject(new Error('directory must be an absolute path.'))
      return Promise.resolve({ args })
    },
    content,
  }
}

/**
 * The Poly Haven provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider.
 */
export function polyHavenMcpProvider(host: PolyHavenToolHost): GameMcpProvider {
  const images: CapturedImages = new WeakMap()
  const tools = polyHavenToolDefinitions(host, mcpPreviews(images)).map(definition => mcpTool(definition, images))
  return {
    id: 'polyhaven',
    title: 'Poly Haven',
    description: 'Find free CC0 HDRIs, textures, and 3D models on Poly Haven, and download them into the user\'s game project.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
