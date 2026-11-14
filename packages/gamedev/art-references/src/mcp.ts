/**
 * The reference tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, which
 * need no Session. `reference_save` takes the game project's folder as `project`, an absolute path, and every image a
 * call returns is sent as image bytes after the call's text.
 * @module @deepseek-ai/dsh-art-references/src/mcp
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { MCP_INSTRUCTIONS } from './prompt.ts'
import { referenceToolDefinitions, type ReferenceToolHost, type ReferenceToolSurface } from './tools.ts'
import type { ModelImage } from './types.ts'

/** Description of the project folder for connected agents. */
const PROJECT_PARAMETER = {
  type: 'string',
  description: 'Absolute path of the game project\'s folder, such as the folder that holds project.godot; the references go into its references/ folder.',
} as const

/** The object schema that `defineTool` writes for a tool's arguments. */
type ArgumentSchema = { readonly properties: Readonly<Record<string, JsonObject>>; readonly required?: readonly string[] }

/** The images of each call, waiting for the call's result. */
type CapturedImages = WeakMap<ToolRunContext, readonly ModelImage[]>

/** The project folder each save names, by the arguments object the call's execution carries. */
type CallFolders = WeakMap<object, string>

/**
 * The images of connected agents: each call's images wait for its result, which sends them after its text.
 * @param images - images per call.
 * @returns the image surface.
 */
function mcpImages(images: CapturedImages): ReferenceToolSurface {
  return {
    seesImages: () => Promise.resolve(true),
    keep(exec, kept) {
      images.set(exec, kept)
      return Promise.resolve([])
    },
  }
}

/**
 * Offer one reference tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' image surface.
 * @param images - images per call.
 * @param folders - the project folder per save, or undefined for the search, which needs none.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, images: CapturedImages, folders: CallFolders | undefined): GameMcpTool {
  // `defineTool` writes an object schema whose properties describe the arguments.
  const { properties, required = [] } = definition.parameters as ArgumentSchema
  const content = (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => [
    ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
    ...(images.get(exec) ?? []).map((image): GameMcpContent => ({ type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType })),
  ]
  if (folders === undefined) return { name: definition.name, definition, readOnly: true, content }
  return {
    name: definition.name,
    definition,
    inputSchema: { type: 'object', additionalProperties: false, properties: { project: PROJECT_PARAMETER, ...properties }, required: ['project', ...required] },
    readOnly: false,
    async prepare(args) {
      const { project, ...rest } = args
      if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('project must be the absolute path of the game project\'s folder.')
      const folder = await realpath(project).catch((error: unknown) => {
        throw new Error(`project ${project} does not exist.`, { cause: error })
      })
      if (!(await stat(folder)).isDirectory()) throw new Error(`project ${project} is not a folder.`)
      folders.set(rest, folder)
      return { args: rest }
    },
    content,
  }
}

/**
 * The reference provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider, whose tools are `reference_search` and `reference_save`.
 */
export function referenceMcpProvider(host: ReferenceToolHost): GameMcpProvider {
  const images: CapturedImages = new WeakMap()
  const folders: CallFolders = new WeakMap()
  const named: ReferenceToolHost = {
    ...host,
    project(exec) {
      const folder = typeof exec.arguments === 'object' && exec.arguments !== null ? folders.get(exec.arguments) : undefined
      return folder === undefined ? Promise.reject(new Error('Pass project, the game project\'s folder.')) : Promise.resolve(folder)
    },
  }
  const tools = referenceToolDefinitions(named, mcpImages(images))
    .map(definition => mcpTool(definition, images, definition.name === 'reference_save' ? folders : undefined))
  return {
    id: 'reference',
    title: 'Art references',
    description: 'Find reference images, animations, and video posters on the web for art you are about to make, and save the ones you use into the game project.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
