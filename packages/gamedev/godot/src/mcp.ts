/**
 * The Godot tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions, run for
 * the connected agent's Session in the game project it names, so its games play in the WASD Engine window's Game
 * tab. Every tool takes `project`, an absolute path that defaults to the agent's previous one, and `session`, a name
 * that gives agents sharing one connection Sessions, and games, of their own; images travel as their PNG or JPEG bytes,
 * screenshots sized for agent image limits; and `godot_run` asks the window to show the Session's Game tab and takes
 * `model`, the name of the AI model the agent is, which the server reports with the call for the game's credits.
 * @module @deepseek-ai/dsh-godot/src/mcp
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute } from 'node:path'
import type { GameMcpContent, GameMcpProvider, GameMcpProviderStatus, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveGodotProject } from './project.ts'
import { godotToolDefinitions, regionFields, type GodotToolHost, type GodotToolSurface, type GodotToolWording } from './tools.ts'
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
  scriptPath: 'a res:// path or an absolute path inside the project',
  logsDefault: 'Without since, returns the entries after the ones you last read.',
  savePath: 'an absolute path',
}

/** How connected agents use the Godot tools, before the sentence that names the Godot release. */
export const MCP_INSTRUCTIONS = `Test the user's Godot project with the godot_* tools. Pass project, the absolute path of the folder that holds project.godot, to your first Godot call; later calls default to it.
1. godot_run starts or restarts the game and reports import and startup errors; pass screenshot to see the game in the same call. The game plays inside the WASD Engine window, where the user watches and can play it too. When you first run a game, pass model, the name of the AI model you are, so the game's page credits it.
2. godot_screenshot shows you the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting: godot_input, godot_wait, and godot_eval take screenshot to show the result in the same call.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_performance measures frame times, rendering, memory, and the time of each script; godot_audio captures and measures the game's audio mix; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game, and godot_script runs a SceneTree script headless, such as a test add-on's command-line runner, once or many times at once.
5. Captures and tests need no changes to the game: godot_run takes launch options (args, engine_args), godot_eval runs GDScript code, godot_view draws any camera at any size or a scene alone, and godot_record saves video.
Agents that work at the same time through one connection, such as the subagents of one session, share a game unless each passes its own session name to every Godot call: one agent's godot_run would restart the game another is testing.
Released games play in browsers, where Godot draws with its Compatibility renderer (WebGL 2) whatever renderer the project uses, without a RenderingDevice: compute shaders, FogVolumes, volumetric fog, SDFGI, SSR, TAA, and FSR do nothing there. Start new games on it, with renderer/rendering_method="gl_compatibility" under [rendering] in project.godot, so they look the same everywhere. Give desktop-only work a path for browsers, such as SoftBody3D sheets on Jolt in place of compute-shader cloth, and stand in for the effects browsers lack: depth and height fog with soft particle cards for fog banks, additive cone meshes for light shafts, emission with glow, MSAA for edges, and ambient occlusion baked into textures. The same light and fog values look different there, so tune the browser's look from godot_run web: true, which draws the game as browsers do. wasd_export_web ends with a Web check that opens the build in a browser and reports its freezes, errors, and a screenshot: fix what it finds while you build.`

const PROJECT_PARAMETER = {
  type: 'string',
  description: 'Absolute path of the Godot project: the folder that holds project.godot, or a folder above it. Default: the project of your previous Godot call.',
} as const

const SESSION_PARAMETER = {
  type: 'string',
  description: 'Name of a Session of your own, such as your task, for agents that work at the same time: each name runs its own game. Use one name in all your Godot calls. Default: your shared Session.',
} as const

/** The tool whose calls name the AI model the calling agent is: every agent that makes a game runs it. */
const MODEL_TOOL = 'godot_run'

const MODEL_PARAMETER = {
  type: 'string',
  description: 'The name of the AI model you are, as its maker writes it, such as Claude Opus 5.5. The released game\'s page credits it for your work on the project; pass it when you first run a game.',
} as const

/** The bytes and media type of each call's images, by image id. */
type CapturedImages = WeakMap<ToolRunContext, Map<string, { readonly data: Buffer; readonly mediaType: 'image/png' | 'image/jpeg' }>>

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
 * The widest image of a size's aspect ratio that agents receive unresized.
 * @param width - width of the size.
 * @param height - height of the size.
 * @returns the width in pixels.
 */
export function agentWidthLimit(width: number, height: number): number {
  const aspect = width / height
  const byEdge = aspect >= 1 ? AGENT_IMAGE_MAX_EDGE : AGENT_IMAGE_MAX_EDGE * aspect
  return Math.max(MIN_SCREENSHOT_WIDTH, Math.floor(Math.min(byEdge, Math.sqrt(AGENT_IMAGE_MAX_PIXELS * aspect))))
}

/**
 * The images of connected agents: each image's bytes wait, under the image's id, for the call's result, and the sizes
 * the game draws fit agent image limits.
 * @param images - image bytes by image id, per call.
 * @returns the screenshot resolution of {@link GodotToolSurface}.
 */
function mcpScreenshots(images: CapturedImages): GodotToolSurface['screenshots'] {
  return (exec) => {
    const keep = (prefix: string, data: Buffer, mediaType: 'image/png' | 'image/jpeg'): string => {
      const id = `${prefix}-${randomUUID()}`
      let captured = images.get(exec)
      if (captured === undefined) {
        captured = new Map()
        images.set(exec, captured)
      }
      captured.set(id, { data, mediaType })
      return id
    }
    return Promise.resolve({
      async capture(run, maxWidth, signal, region, save) {
        const view = run.view()
        let shot
        if (region === undefined) {
          shot = await run.screenshot(agentScreenshotWidth(maxWidth, view.width, view.height), signal)
        } else {
          const limit = Math.min(maxWidth, agentWidthLimit(region.width, region.height))
          shot = await run.screenshot(limit, signal, undefined, { ...region, minWidth: Math.min(region.minWidth, limit) })
        }
        await save?.(shot.image)
        const id = keep('godot-screenshot', shot.image, 'image/png')
        return {
          width: shot.meta.width,
          height: shot.meta.height,
          windowWidth: shot.meta.windowWidth,
          windowHeight: shot.meta.windowHeight,
          ...regionFields(shot.meta),
          frame: shot.meta.frame,
          paused: shot.meta.paused,
          image: { attachmentId: id, mediaType: 'image/png', bytes: shot.image.byteLength, width: shot.meta.width, height: shot.meta.height },
        }
      },
      store(made) {
        const id = keep('godot-image', made.data, made.mediaType)
        const { mediaType, width, height } = made
        return Promise.resolve({ attachmentId: id, mediaType, bytes: made.data.byteLength, width, height })
      },
      fit(width, height) {
        const limit = agentWidthLimit(width, height)
        return width <= limit ? { width, height } : { width: limit, height: Math.max(1, Math.round(height * limit / width)) }
      },
    })
  }
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
 * The key of an agent's most recent project in one of its Sessions: the agent, and the Session name when the call gives
 * one.
 * @param client - the agent's id.
 * @param session - the Session name as the call gave it.
 * @returns the key.
 */
function projectKey(client: string, session: string | undefined): string {
  return session === undefined ? `${client}\n` : `${client}\n${session.trim().toLowerCase()}`
}

/**
 * Offer one Godot tool definition to connected agents.
 * @param definition - the tool, built for connected agents.
 * @param images - the screenshots of each call.
 * @param projects - each agent's most recent project folder under its id, and in each of its Sessions under
 *   {@link projectKey}.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, images: CapturedImages, projects: Map<string, string>): GameMcpTool {
  // `defineTool` writes an object schema whose properties and required names describe the arguments.
  const { properties, required } = definition.parameters
  const { project: own, ...others } = isObject(properties) ? properties : {}
  const namesProject = own !== undefined
  const namesModel = definition.name === MODEL_TOOL
  const requiredNames = isStringList(required) ? required.filter(name => name !== 'project') : []
  return {
    name: definition.name,
    definition,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { project: PROJECT_PARAMETER, session: SESSION_PARAMETER, ...namesModel ? { model: MODEL_PARAMETER } : {}, ...others },
      ...requiredNames.length === 0 ? {} : { required: requiredNames },
    },
    // Clients may run read-only tools without asking. godot_screenshot and godot_view create and replace files with path
    // and save, and godot_check may import the project first, which writes import data into it.
    readOnly: ['godot_logs', 'godot_scene_tree', 'godot_performance'].includes(definition.name),
    async prepare(args, call) {
      const { project, session, ...own } = args
      // Only the tool that offers model takes it out of the arguments; another tool's model would be its own.
      const { model, ...unnamed } = own
      const rest = namesModel ? unnamed : own
      if (project !== undefined && typeof project !== 'string') throw new Error('project must be a string.')
      if (session !== undefined && typeof session !== 'string') throw new Error('session must be a string.')
      if (namesModel && model !== undefined && typeof model !== 'string') throw new Error('model must be a string.')
      // A Session's first call without project uses the agent's most recent project in any of its Sessions.
      const key = projectKey(call.client.id, session)
      const requested = project ?? projects.get(key) ?? projects.get(call.client.id)
      if (requested === undefined) throw new Error('Pass project: the absolute path of the folder that holds project.godot.')
      if (!isAbsolute(requested)) throw new Error(`project must be an absolute path, got ${JSON.stringify(requested)}.`)
      const folder = basename(requested) === 'project.godot' ? dirname(requested) : requested
      const found = await resolveGodotProject(folder, undefined, call.signal)
      const agent = await call.session(found.dir, session)
      projects.set(key, found.dir)
      projects.set(call.client.id, found.dir)
      // The window shows the Session, whose Game tab opens for a run an agent starts.
      if (definition.name === 'godot_run') call.reveal(agent.id)
      return {
        args: namesProject ? { ...rest, project: found.dir } : rest,
        agent,
        ...namesModel && typeof model === 'string' ? { model } : {},
      }
    },
    content(value, args, exec) {
      const captured = images.get(exec)
      return definition.output.render(args, value).flatMap((block): GameMcpContent[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type !== 'image') return []
        const image = captured?.get(block.attachment.attachmentId)
        return image === undefined ? [] : [{ type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType }]
      })
    },
  }
}

/**
 * The Godot provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @param runtime - resolves the runtime view.
 * @param release - the Godot release that the tools run, which the instructions name; omission names none.
 * @returns the provider.
 */
export function godotMcpProvider(
  host: GodotToolHost, runtime: (signal: AbortSignal) => Promise<GodotRuntimeView>, release?: string,
): GameMcpProvider {
  const images: CapturedImages = new WeakMap()
  const projects = new Map<string, string>()
  const screenshots = mcpScreenshots(images)
  // Connected agents always receive images, so a call's pictures are stored as its screenshots are.
  const tools = godotToolDefinitions(host, { screenshots, pictures: screenshots, wording: MCP_WORDING })
    .map(definition => mcpTool(definition, images, projects))
  return {
    id: 'godot',
    title: 'Godot',
    description: `Run the user's ${release === undefined ? 'Godot' : `Godot ${release}`} game in the WASD Engine window, where the user watches and plays it, `
      + 'and see, play, and measure it yourself. Run it and look after every change: code that compiles can still look or play wrong.',
    instructions: release === undefined
      ? MCP_INSTRUCTIONS
      : `${MCP_INSTRUCTIONS}\nThe godot_* tools run Godot ${release}: write code for it, and in a new project.godot, start config/features `
        + `with "${release}" and set 3d/physics_engine="Jolt Physics" under [physics].`,
    tools: () => tools,
    status: async signal => statusOf(await runtime(signal)),
  }
}
