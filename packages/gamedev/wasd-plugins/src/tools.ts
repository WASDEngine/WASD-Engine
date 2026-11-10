/**
 * The model-facing tools of WASD Engine Plugins: `wasd_export_web` builds a Godot project for the Web, and
 * `wasd_release_game` builds it and publishes the build as the next version of its game on the WASD Engine site.
 * The same definitions serve the Session's own agent, which may name the project relative to its working directory,
 * and agents connected through WASD Engine's MCP server, which name it by absolute path.
 * @module @deepseek-ai/dsh-wasd-plugins/src/tools
 */
import { isAbsolute } from 'node:path'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import type { GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MAX_NOTES, MAX_TITLE, type ReleaseRequest } from './release.ts'
import type { WasdRelease } from './types.ts'

/** What the tools need from the plugin. */
export interface WasdToolHost {
  /**
   * The project folder of one call.
   * @param requested - the folder the call names: absolute, or relative to the calling Session's working directory;
   * undefined for the nearest project.
   * @param exec - the call's execution.
   * @returns the absolute folder holding `project.godot`.
   */
  project(requested: string | undefined, exec: ToolRunContext): Promise<string>
  /**
   * A file path of one call.
   * @param requested - absolute, or relative to the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute path.
   */
  file(requested: string, exec: ToolRunContext): Promise<string>
  /**
   * Export a project for the Web into its `.wasdengine/web` folder.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation.
   * @returns the exported files.
   */
  exportWeb(projectDir: string, signal: AbortSignal): Promise<GodotWebExport>
  /**
   * Export a project for the Web and release the build.
   * @param request - project, notes, title, and cover.
   * @param signal - cancellation.
   * @returns the release.
   */
  release(request: ReleaseRequest, signal: AbortSignal): Promise<WasdRelease>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const WARNINGS = { type: 'array', required: true, items: { type: 'string' } } as const

const PROJECT = {
  type: 'string',
  description: 'Folder containing project.godot, relative to the working directory. Default: the nearest one.',
} as const

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function withWarnings(text: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? text : `${text}\nNotes:\n${warnings.map(warning => `- ${warning}`).join('\n')}`
}

/**
 * Build the WASD Engine Plugins tool definitions.
 * @param host - plugin operations the tools call.
 * @returns the definitions, not registered.
 */
export function wasdToolDefinitions(host: WasdToolHost): ToolDefinition[] {
  return [defineTool({
    name: 'wasd_export_web',
    description: 'Export the Godot project for the Web with the built-in Godot: a single-threaded HTML5 build (index.html, index.js, index.wasm, index.pck) in the project\'s .wasdengine/web folder, which any static web server can serve. The Web build renders with the Compatibility renderer. The first export downloads Godot\'s Web template, about 10 MB. To publish the game for others to play, call wasd_release_game instead.',
    parameters: { project: PROJECT },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          outputDir: STRING,
          entry: STRING,
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: STRING, bytes: INTEGER } } },
          totalBytes: INTEGER,
          warnings: WARNINGS,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings(
          `Exported ${value.projectDir} for the Web into ${value.outputDir}: ${value.files.map(file => file.path).join(', ')} (${megabytes(value.totalBytes)}). Open ${value.entry} through a web server, not from the file system.`,
          value.warnings,
        ),
      }],
    },
    async execute(args, exec) {
      const exported = await host.exportWeb(await host.project(args.project, exec), exec.signal)
      return { ...exported, files: exported.files.map(file => ({ ...file })), warnings: [...exported.warnings] }
    },
  }), defineTool({
    name: 'wasd_release_game',
    description: 'Release the Godot game on WASD Engine: export it for the Web, upload the build as the game\'s next version (1, 2, 3, ...), and return its share link, where anyone can play it in a browser, switch to earlier versions, and comment. The first release creates the game, titled from project.godot unless title is given; later releases add versions to it. Every call publishes a new public version, so call it only when the user asks to release, publish, or share the game.',
    parameters: {
      project: PROJECT,
      notes: { type: 'string', description: `What changed in this version, shown on the game page; at most ${MAX_NOTES} characters.` },
      title: { type: 'string', description: `Game title for the first release, or a new title for the game; at most ${MAX_TITLE} characters. Default: the project's name.` },
      cover_image: { type: 'string', description: 'PNG, JPEG, or WebP image the Explore page shows for the game, relative to the working directory; 16:9 fits best.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: STRING,
          version: INTEGER,
          url: STRING,
          gameUrl: STRING,
          playUrl: STRING,
          totalBytes: INTEGER,
          warnings: WARNINGS,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings(
          `Released ${value.title} version ${value.version} (${megabytes(value.totalBytes)}).\nShare link: ${value.gameUrl}\nThis version: ${value.url}\nThe share page plays the latest version, lists the earlier ones with their release dates, and takes comments.`,
          value.warnings,
        ),
      }],
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const coverImage = args.cover_image === undefined ? undefined : await host.file(args.cover_image, exec)
      const released = await host.release({
        projectDir,
        ...args.notes === undefined ? {} : { notes: args.notes },
        ...args.title === undefined ? {} : { title: args.title },
        ...coverImage === undefined ? {} : { coverImage },
      }, exec.signal)
      return { ...released, warnings: [...released.warnings] }
    },
  })]
}

/** Absolute-path arguments of the tools offered to connected agents, by tool. */
const MCP_PATHS: Readonly<Record<string, Readonly<Record<string, { readonly type: 'string'; readonly description: string }>>>> = {
  wasd_export_web: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_release_game: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
    cover_image: { type: 'string', description: 'Absolute path of a PNG, JPEG, or WebP image the Explore page shows for the game; 16:9 fits best.' },
  },
}

/**
 * Offer one tool to agents connected through WASD Engine's MCP server, which name paths absolutely.
 * @param definition - the tool.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition): GameMcpTool {
  const paths = MCP_PATHS[definition.name] ?? {}
  const { properties } = definition.parameters as { readonly properties: Readonly<Record<string, object>> }
  return {
    name: definition.name,
    definition,
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, ...paths } as Record<string, JsonObject>, required: ['project'] },
    readOnly: false,
    prepare(args) {
      for (const name of Object.keys(paths)) {
        const value = args[name]
        if (name === 'project' ? typeof value !== 'string' || !isAbsolute(value) : value !== undefined && (typeof value !== 'string' || !isAbsolute(value))) {
          return Promise.reject(new Error(`${name} must be an absolute path.`))
        }
      }
      return Promise.resolve({ args })
    },
  }
}

/**
 * The WASD Engine provider of WASD Engine's MCP server.
 * @param definitions - the tool definitions.
 * @returns the provider.
 */
export function wasdMcpProvider(definitions: readonly ToolDefinition[]): GameMcpProvider {
  const tools = definitions.map(mcpTool)
  return {
    id: 'wasd',
    title: 'WASD Engine',
    description: 'Export the user\'s Godot game for the Web, and release it on WASD Engine with a share link.',
    instructions: 'wasd_export_web builds the Godot project for the Web into its .wasdengine/web folder. wasd_release_game builds it and publishes the build as the game\'s next numbered version on WASD Engine, and returns the share link, where anyone can play the game, pick earlier versions, and comment. Each release is public: release only when the user asks to, and pass notes that say what changed. Releasing needs WASD Engine to be signed in.',
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
