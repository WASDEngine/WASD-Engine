/**
 * The audio tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run in
 * the connected agent's Session of the game project it names as `project`, with sound paths from that folder and the
 * picture sent as image bytes.
 * @module @deepseek-ai/dsh-game-audio/src/mcp
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { audioToolDefinitions, type AudioToolHost, type AudioToolSurface } from './tools.ts'
import type { AudioPicture } from './types.ts'

/** How connected agents use the audio tools. */
export const MCP_INSTRUCTIONS = 'The audio tools list a game project\'s sound effects, dialogue, and music and measure them as WASD Engine\'s Audio panel plays them, since you cannot listen. '
  + 'Pass the game project\'s folder as project, an absolute path, and sound paths relative to it. '
  + 'audio_search lists the sounds with their kind, format, and length and how many each folder holds; audio_review measures one sound: '
  + 'its peak and loudness, clipping, silence at either end, spectrum, whether it loops without a click, its stereo channels, and how Godot imports it, with a picture of its waveform and spectrogram. '
  + 'The open WASD Engine window decodes the sound. Set show to open the sound in the user\'s Audio panel when you want them to listen to it.'

/** Description of the project folder for connected agents. */
const PROJECT_PARAMETER = { type: 'string', description: 'Absolute path of the game project\'s folder, such as the folder that holds project.godot.' } as const

/** The picture of each call, waiting for the call's result. */
type CapturedPictures = WeakMap<ToolRunContext, AudioPicture>

/** The canonical project folder each call names, by the arguments object the call's execution carries. */
type CallFolders = WeakMap<object, string>

/**
 * The picture surface of connected agents: each call's picture waits for its result, which sends it after its text.
 * @param pictures - the picture of each call.
 * @returns the surface.
 */
function mcpPictures(pictures: CapturedPictures): AudioToolSurface {
  return {
    seesImages: () => Promise.resolve(true),
    keep(exec, picture) {
      pictures.set(exec, picture)
      return Promise.resolve([])
    },
  }
}

/**
 * Offer one audio tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' picture surface.
 * @param pictures - the picture of each call.
 * @param folders - the project folder per call.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, pictures: CapturedPictures, folders: CallFolders): GameMcpTool {
  // `defineTool` writes an object schema whose properties describe the arguments.
  const { properties, required = [] } = definition.parameters as {
    readonly properties: Readonly<Record<string, JsonObject>>
    readonly required?: readonly string[]
  }
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
    content: (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => {
      const picture = pictures.get(exec)
      return [
        ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
        ...picture === undefined ? [] : [{ type: 'image' as const, data: picture.data, mimeType: picture.mediaType }],
      ]
    },
  }
}

/**
 * The audio provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider, whose tools are `audio_search` and `audio_review`.
 */
export function audioMcpProvider(host: AudioToolHost): GameMcpProvider {
  const pictures: CapturedPictures = new WeakMap()
  const folders: CallFolders = new WeakMap()
  const named: AudioToolHost = {
    ...host,
    async project(exec) {
      const session = await host.project(exec)
      const folder = typeof exec.arguments === 'object' && exec.arguments !== null ? folders.get(exec.arguments) : undefined
      if (folder === undefined) return session
      const inside = relative(session, folder)
      return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? session : folder
    },
  }
  const tools = audioToolDefinitions(named, mcpPictures(pictures)).map(definition => mcpTool(definition, pictures, folders))
  return {
    id: 'audio',
    title: 'Audio',
    description: 'List a game project\'s sound effects, dialogue, and music and measure them as WASD Engine\'s Audio panel plays them, with a picture of each sound\'s waveform and spectrogram.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
