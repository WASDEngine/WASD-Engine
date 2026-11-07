/**
 * The Godot tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run for
 * the connected agent's Session in the game project it names, so its games play in the WASD Engine window's Game
 * tab. Every tool takes `project`, an absolute path that defaults to the agent's previous one; screenshots travel as
 * PNG bytes, sized for agent image limits; and `godot_run` asks the window to show the Session's Game tab.
 * @module @deepseek-ai/dsh-godot/src/mcp
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpProviderStatus, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveGodotProject } from './project.ts'
import { godotToolDefinitions, type GodotToolHost, type GodotToolSurface, type GodotToolWording } from './tools.ts'
import type { GodotRuntimeView } from './types.ts'

/** Longest image edge an agent receives unresized. */
const AGENT_IMAGE_MAX_EDGE = 1568

/** Most pixels of an image an agent receives unresized. */
const AGENT_IMAGE_MAX_PIXELS = 1_150_000

/** Smallest screenshot width the game accepts. */
const MIN_SCREENSHOT_WIDTH = 64

/** Wording of the tools for connected agents, which name projects and files by absolute path. */
export const MCP_WORDING: GodotToolWording = {
  run: 'Start the Godot project, or restart it if it is running, and wait until the game runs; the game plays inside the WASD Engine window, '
    + 'where the user watches and can play it. ',
  checkPaths: 'files or folders, as res:// paths or absolute paths',
  logsDefault: 'Without since, returns the entries after the ones you last read.',
}

/** How connected agents use the Godot tools. */
export const MCP_INSTRUCTIONS = `Test the user's Godot project with the godot_* tools. Pass project, the absolute path of the folder that holds project.godot, to your first Godot call; later calls default to it.
1. godot_run starts or restarts the game and reports import and startup errors. The game plays inside the WASD Engine window, where the user watches and can play it too.
2. godot_screenshot shows you the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.`

const PROJECT_PARAMETER = {
  type: 'string',
  description: 'Absolute path of the Godot project: the folder that holds project.godot, or a folder above it. Default: the project of your previous Godot call.',
} as const

/** The PNG bytes of each call's screenshots, by image id. */
type CapturedImages = WeakMap<ToolRunContext, Map<string, Buffer>>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * The width to request of a screenshot so the image fits agent image limits.
 * @param maxWidth - width the call asked for.
 * @param width - game window width, when known.
 * @param height - game window height, when known.
 * @returns the width to request.
 */
export function agentScreenshotWidth(maxWidth: number, width: number | undefined, height: number | undefined): number {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return Math.min(maxWidth, AGENT_IMAGE_MAX_EDGE)
  const scale = Math.min(1, AGENT_IMAGE_MAX_EDGE / Math.max(width, height), Math.sqrt(AGENT_IMAGE_MAX_PIXELS / (width * height)))
  return Math.max(MIN_SCREENSHOT_WIDTH, Math.min(maxWidth, Math.floor(width * scale)))
}

/**
 * The screenshots of connected agents: each image's PNG bytes wait, under the image's id, for the call's result.
 * @param images - PNG bytes by image id, per call.
 * @returns the screenshot resolution of {@link GodotToolSurface}.
 */
function mcpScreenshots(images: CapturedImages): GodotToolSurface['screenshots'] {
  return exec => Promise.resolve({
    async capture(run, maxWidth, signal) {
      const view = run.view()
      const shot = await run.screenshot(agentScreenshotWidth(maxWidth, view.width, view.height), signal)
      const id = `godot-screenshot-${randomUUID()}`
      let captured = images.get(exec)
      if (captured === undefined) {
        captured = new Map()
        images.set(exec, captured)
      }
      captured.set(id, shot.png)
      return {
        width: shot.meta.width,
        height: shot.meta.height,
        windowWidth: shot.meta.windowWidth,
        windowHeight: shot.meta.windowHeight,
        frame: shot.meta.frame,
        paused: shot.meta.paused,
        image: { attachmentId: id, mediaType: 'image/png', bytes: shot.png.byteLength, width: shot.meta.width, height: shot.meta.height },
      }
    },
  })
}

/**
 * The provider's readiness from the runtime view.
 * @param view - the runtime view.
 * @returns the readiness.
 */
function statusOf(view: GodotRuntimeView): GameMcpProviderStatus {
  switch (view.state) {
    case 'ready':
      return { state: 'ready' }
    case 'installing':
      return { state: 'starting', message: 'WASD Engine is installing the Godot runtime.' }
    case 'missing':
    case 'failed':
      return { state: 'unavailable', ...view.message === undefined ? {} : { message: view.message } }
  }
}

/**
 * Offer one Godot tool definition to connected agents.
 * @param definition - the tool, built for connected agents.
 * @param images - the screenshots of each call.
 * @param projects - each agent's most recent project folder.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, images: CapturedImages, projects: Map<string, string>): GameMcpTool {
  // `defineTool` writes an object schema whose properties and required names describe the arguments.
  const { properties, required } = definition.parameters
  const { project: own, ...others } = isObject(properties) ? properties : {}
  const namesProject = own !== undefined
  const requiredNames = isStringList(required) ? required.filter(name => name !== 'project') : []
  return {
    name: definition.name,
    definition,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { project: PROJECT_PARAMETER, ...others },
      ...requiredNames.length === 0 ? {} : { required: requiredNames },
    },
    readOnly: ['godot_screenshot', 'godot_logs', 'godot_scene_tree', 'godot_check'].includes(definition.name),
    async prepare(args, call) {
      const { project, ...rest } = args
      if (project !== undefined && typeof project !== 'string') throw new Error('project must be a string.')
      const requested = project ?? projects.get(call.client.id)
      if (requested === undefined) throw new Error('Pass project: the absolute path of the folder that holds project.godot.')
      if (!isAbsolute(requested)) throw new Error(`project must be an absolute path, got ${JSON.stringify(requested)}.`)
      const folder = basename(requested) === 'project.godot' ? dirname(requested) : requested
      const found = await resolveGodotProject(folder, undefined, call.signal)
      const agent = await call.session(found.dir)
      projects.set(call.client.id, found.dir)
      // The window shows the Session, whose Game tab opens for a run an agent starts.
      if (definition.name === 'godot_run') call.reveal(agent.id)
      return { args: namesProject ? { ...rest, project: found.dir } : rest, agent }
    },
    content(value, args, exec) {
      const captured = images.get(exec)
      return definition.output.render(args, value).flatMap((block): GameMcpContent[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type !== 'image') return []
        const png = captured?.get(block.attachment.attachmentId)
        return png === undefined ? [] : [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
      })
    },
  }
}

/**
 * The Godot provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @param runtime - resolves the runtime view.
 * @returns the provider.
 */
export function godotMcpProvider(host: GodotToolHost, runtime: (signal: AbortSignal) => Promise<GodotRuntimeView>): GameMcpProvider {
  const images: CapturedImages = new WeakMap()
  const projects = new Map<string, string>()
  const tools = godotToolDefinitions(host, { screenshots: mcpScreenshots(images), wording: MCP_WORDING })
    .map(definition => mcpTool(definition, images, projects))
  return {
    id: 'godot',
    title: 'Godot',
    description: 'Run, test, and play the user\'s Godot game inside the WASD Engine window.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: async signal => statusOf(await runtime(signal)),
  }
}
