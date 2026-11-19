/**
 * Plugin tools that a connected agent calls with a game project's folder as their first argument, `project`: each call
 * runs in the Session of the game project that holds the folder, its paths start at that folder
 * ({@link callFolder}), and its result's text and images go back to the agent.
 * @module @deepseek-ai/dsh-game-mcp/src/project-tools
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { pathWithin } from './plugin-kit.ts'
import type { GameMcpContent, GameMcpTool, JsonObject } from './provider.ts'

/** The `project` argument: the absolute folder of the game project. */
export const PROJECT_PARAMETER = {
  type: 'string',
  description: 'Absolute path of the game project\'s folder, such as the folder that holds project.godot.',
} as const

/** The folder each call named, by the call's arguments, which the tool reads its folder from. */
export type CallFolders = WeakMap<object, string>

/** An image a tool's result shows the agent: base64 data and its media type. */
export interface ResultImage {
  /** Base64 data. */
  readonly data: string
  /** Its media type. */
  readonly mediaType: string
}

/**
 * Offer a plugin tool to connected agents with `project` as its first argument.
 * @param definition - the tool.
 * @param folders - where the call's folder is kept for {@link callFolder}.
 * @param images - the images a finished call shows, by the call.
 * @returns the tool as the MCP server offers it.
 */
export function projectMcpTool(
  definition: ToolDefinition, folders: CallFolders, images: (exec: ToolRunContext) => readonly ResultImage[],
): GameMcpTool {
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
    content: (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => [
      ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
      ...images(exec).map((image): GameMcpContent => ({ type: 'image', data: image.data, mimeType: image.mediaType })),
    ],
  }
}

/**
 * The folder a call's paths start at: the folder the call named, when it lies inside its Session's project folder,
 * else the Session's.
 * @param sessionFolder - the Session's project folder.
 * @param folders - the calls' folders.
 * @param exec - the call.
 * @returns the folder.
 */
export function callFolder(sessionFolder: string, folders: CallFolders, exec: ToolRunContext): string {
  const folder = typeof exec.arguments === 'object' && exec.arguments !== null ? folders.get(exec.arguments) : undefined
  if (folder === undefined) return sessionFolder
  return pathWithin(sessionFolder, folder) === undefined ? sessionFolder : folder
}
