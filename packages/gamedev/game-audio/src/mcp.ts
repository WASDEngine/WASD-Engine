/**
 * The audio tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run in
 * the connected agent's Session of the game project it names as `project`, with sound paths from that folder and the
 * picture sent as image bytes.
 * @module @deepseek-ai/dsh-game-audio/src/mcp
 */
import { callFolder, type CallFolders, projectMcpTool } from '@deepseek-ai/dsh-game-mcp/kit'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { audioToolDefinitions, type AudioToolHost, type AudioToolSurface } from './tools.ts'
import type { AudioPicture } from './types.ts'

/** How connected agents use the audio tools. */
export const MCP_INSTRUCTIONS = 'The audio tools list a game project\'s sound effects, dialogue, and music and measure them as WASD Engine\'s Audio panel plays them, since you cannot listen. '
  + 'Pass the game project\'s folder as project, an absolute path, and sound paths relative to it. '
  + 'audio_search lists the sounds with their kind, format, and length and how many each folder holds; audio_review measures one sound: '
  + 'its peak and loudness, clipping, silence at either end, spectrum, whether it loops without a click, its stereo channels, and how Godot imports it, and with picture a picture of its waveform and spectrogram, for when the figures leave a question. '
  + 'The open WASD Engine window decodes the sound. Set show to open the sound in the user\'s Audio panel when you want them to listen to it.'

/** What the provider's status says while no WASD Engine window is connected. */
export const NO_WINDOW_STATUS = 'No WASD Engine window is open, so audio_review fails until the user opens one; audio_search works without it.'

/** The picture of each call, waiting for the call's result. */
type CapturedPictures = WeakMap<ToolRunContext, AudioPicture>

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
 * The audio provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider, whose tools are `audio_search` and `audio_review`.
 */
export function audioMcpProvider(host: AudioToolHost): GameMcpProvider {
  const pictures: CapturedPictures = new WeakMap()
  const folders: CallFolders = new WeakMap()
  const named: AudioToolHost = {
    ...host,
    project: async exec => callFolder(await host.project(exec), folders, exec),
  }
  const tools = audioToolDefinitions(named, mcpPictures(pictures)).map(definition => projectMcpTool(definition, folders, (exec) => {
    const picture = pictures.get(exec)
    return picture === undefined ? [] : [picture]
  }))
  return {
    id: 'audio',
    title: 'Audio',
    description: 'List a game project\'s sound effects, dialogue, and music, and measure each one.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    // The tools run either way; audio_review alone needs a window to decode the sound.
    status: () => Promise.resolve(host.windowConnected() ? { state: 'ready' } : { state: 'ready', message: NO_WINDOW_STATUS }),
  }
}
