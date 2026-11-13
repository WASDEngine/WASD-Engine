/**
 * The model-facing tools of WASD Engine Plugins: `wasd_export_web` builds a Godot project for the Web,
 * `wasd_record_preview` records the game's preview, an animated GIF and a still, and `wasd_release_game` builds the
 * project and publishes the build as the next version of its game on the WASD Engine site, with the preview. The same
 * definitions serve the Session's own agent, which may name the project relative to its working directory, and agents
 * connected through WASD Engine's MCP server, which name it by absolute path and run the game in a Session of theirs.
 * @module @deepseek-ai/dsh-wasd-plugins/src/tools
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { GodotWebExport } from '@deepseek-ai/dsh-godot'
import type { GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { IMAGE_SCHEMA, type StoredScreenshot } from './browser.ts'
import { MAX_NOTES, MAX_TITLE, type ReleaseRequest } from './release.ts'
import type { WasdRelease } from './types.ts'

/** What a preview recording asks for. */
export interface PreviewRequest {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Length of the clip in seconds. */
  readonly seconds: number
  /** Seconds into the clip of the still. Default: the middle. */
  readonly stillAt?: number
  /** Input played from the start of the recording, as `godot_input` takes it; the Godot plugin validates it. */
  readonly events?: readonly unknown[]
  /** Unit of the events' pointer coordinates. Default: `screenshot`. */
  readonly coordinateSpace?: 'screenshot' | 'window'
}

/** A recorded preview, saved in the project's preview folder. */
export interface RecordedPreview {
  /** Absolute path of the GIF. */
  readonly gif: string
  /** Absolute path of the still. */
  readonly image: string
  /** Frames in the GIF. */
  readonly frames: number
  /** Playing time of the GIF in seconds. */
  readonly seconds: number
  /** GIF width in pixels. */
  readonly width: number
  /** GIF height in pixels. */
  readonly height: number
  /** GIF size in bytes. */
  readonly gifBytes: number
  /** Still width in pixels. */
  readonly imageWidth: number
  /** Still height in pixels. */
  readonly imageHeight: number
  /** Still size in bytes. */
  readonly imageBytes: number
  /** Whether the recording started the game, because none ran. */
  readonly started: boolean
  /** Whether the game was paused in every frame. */
  readonly paused: boolean
  /** The still as the calling Session's model receives it; absent when that model cannot see images. */
  readonly view?: StoredScreenshot
}

/** The preview lengths the tools offer, from the plugin's configuration. */
export interface PreviewLengths {
  /** Default clip length in seconds. */
  readonly seconds: number
  /** Longest clip in seconds. */
  readonly maxSeconds: number
}

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
   * Record the game's preview in the Session of the call's Agent and save it in the project's preview folder.
   * @param request - project, length, input, and the still's moment.
   * @param exec - the call's execution.
   * @returns the saved preview.
   */
  recordPreview(request: PreviewRequest, exec: ToolRunContext): Promise<RecordedPreview>
  /**
   * Export a project for the Web and release the build with the game's preview.
   * @param request - project, notes, title, and preview files.
   * @param exec - the call's execution: its cancellation, and its Agent, whose Session can record a missing preview.
   * @returns the release.
   */
  release(request: ReleaseRequest, exec: ToolRunContext): Promise<WasdRelease>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const NUMBER = { type: 'number', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const WARNINGS = { type: 'array', required: true, items: { type: 'string' } } as const

const PROJECT = {
  type: 'string',
  description: 'Folder containing project.godot, relative to the working directory. Default: the nearest one.',
} as const

const RECORDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gif: STRING,
    image: STRING,
    frames: INTEGER,
    seconds: NUMBER,
    width: INTEGER,
    height: INTEGER,
    gifBytes: INTEGER,
    imageWidth: INTEGER,
    imageHeight: INTEGER,
    imageBytes: INTEGER,
    started: BOOLEAN,
    paused: BOOLEAN,
    view: {
      type: 'object',
      additionalProperties: false,
      properties: { width: INTEGER, height: INTEGER, image: IMAGE_SCHEMA },
    },
  },
} as const

/** A `wasd_record_preview` result. */
export type RecordedPreviewValue = InferValue<typeof RECORDING_SCHEMA>

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : megabytes(bytes)
}

function withWarnings(text: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? text : `${text}\nNotes:\n${warnings.map(warning => `- ${warning}`).join('\n')}`
}

function describeRecording(value: RecordedPreviewValue): string {
  return [
    `Recorded the game's preview: ${value.gif} (${value.frames} frames, ${value.seconds.toFixed(1)} s, ${value.width}x${value.height}, ${size(value.gifBytes)}) and the still ${value.image} (${value.imageWidth}x${value.imageHeight}, ${size(value.imageBytes)}). wasd_release_game uploads them with the next release.`,
    ...value.started ? ['The recording started the game, which keeps running.'] : [],
    ...value.paused ? ['The game was paused throughout, so the GIF shows no motion: resume it with godot_control, then record again.'] : [],
    ...value.view === undefined ? [] : ['The image below is the still.'],
  ].join('\n')
}

/**
 * Build the WASD Engine Plugins tool definitions.
 * @param host - plugin operations the tools call.
 * @param lengths - the preview lengths the recording tool offers.
 * @returns the definitions, not registered.
 */
export function wasdToolDefinitions(host: WasdToolHost, lengths: PreviewLengths): ToolDefinition[] {
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
    name: 'wasd_record_preview',
    description: 'Record the game\'s preview for WASD Engine: an animated GIF of a few seconds of the running game and a still image, which Explore and the game\'s share link show once wasd_release_game uploads them. First start the game with godot_run and bring it to its gameplay, such as past its title menu; events then play from the start of the recording, as godot_input takes them, so the clip shows the game in action. Without a running game, the recording starts the game and records its first seconds. The result shows the still: when it does not show the game well, record again. Each recording replaces the project\'s previous preview in its .wasdengine/preview folder.',
    parameters: {
      project: PROJECT,
      seconds: { type: 'number', description: `Length of the clip in seconds, from 1 to ${lengths.maxSeconds}. Default: ${lengths.seconds}.` },
      events: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Input played in order from the start of the recording, in the event format of godot_input: keys, typed text, mouse buttons and motion, input actions, joypad events, and { "wait": seconds }. What still plays when the clip ends is released.',
      },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' x, y, dx, dy: pixels of the latest godot_screenshot (default) or of the game window.' },
      still_at: { type: 'number', description: 'Seconds into the clip at which the still is taken. Default: the middle.' },
    },
    output: {
      schema: RECORDING_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: describeRecording(value) },
        ...value.view === undefined ? [] : [{ type: 'image' as const, attachment: { ...value.view.image, attachmentId: brandString<AttachmentId>(value.view.image.attachmentId) } }],
      ],
    },
    async execute(args, exec) {
      const seconds = args.seconds ?? lengths.seconds
      if (!(seconds >= 1 && seconds <= lengths.maxSeconds)) throw new Error(`seconds must be from 1 to ${lengths.maxSeconds}.`)
      if (args.still_at !== undefined && !(args.still_at >= 0 && args.still_at <= seconds)) throw new Error(`still_at must be from 0 to ${seconds}.`)
      const projectDir = await host.project(args.project, exec)
      const recorded = await host.recordPreview({
        projectDir,
        seconds,
        ...args.still_at === undefined ? {} : { stillAt: args.still_at },
        ...args.events === undefined ? {} : { events: args.events },
        ...args.coordinate_space === undefined ? {} : { coordinateSpace: args.coordinate_space },
      }, exec)
      return { ...recorded, ...recorded.view === undefined ? {} : { view: { ...recorded.view, image: { ...recorded.view.image } } } }
    },
  }), defineTool({
    name: 'wasd_release_game',
    description: 'Release the Godot game on WASD Engine: export it for the Web, upload the build as the game\'s next version (1, 2, 3, ...) with its preview, and return its share link, where anyone can play it in a browser, switch to earlier versions, and comment. The preview is the GIF and still that wasd_record_preview saved, unless preview_gif or preview_image name other files; record it first, so Explore and the share link show the game in action. A game that has no preview on WASD Engine yet and none to upload gets the first seconds of the game recorded without input. The first release creates the game, titled from project.godot unless title is given; later releases add versions to it. Every call publishes a new public version, so call it only when the user asks to release, publish, or share the game.',
    parameters: {
      project: PROJECT,
      notes: { type: 'string', description: `What changed in this version, shown on the game page; at most ${MAX_NOTES} characters.` },
      title: { type: 'string', description: `Game title for the first release, or a new title for the game; at most ${MAX_TITLE} characters. Default: the project's name.` },
      preview_image: { type: 'string', description: 'PNG, JPEG, or WebP picture that Explore shows for the game, relative to the working directory; 16:9 fits best. Default: the still that wasd_record_preview saved.' },
      preview_gif: { type: 'string', description: 'Animated GIF that Explore plays on hover and the share link shows, relative to the working directory. Default: the GIF that wasd_record_preview saved.' },
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
          imageLink: { type: 'string' },
          gifLink: { type: 'string' },
          warnings: WARNINGS,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings([
          `Released ${value.title} version ${value.version} (${megabytes(value.totalBytes)}).`,
          `Share link: ${value.gameUrl}`,
          `This version: ${value.url}`,
          ...value.gifLink === undefined ? [] : [`GIF link: ${value.gifLink}`],
          ...value.imageLink === undefined ? [] : [`Image link: ${value.imageLink}`],
          'The share page plays the latest version, lists the earlier ones with their release dates, and takes comments.',
          ...value.gifLink === undefined
            ? []
            : ['Posted on Reddit, Discord, Slack, Telegram, or iMessage, the share link and the GIF link show the GIF; opened in a browser, both play the game.'],
        ].join('\n'), value.warnings),
      }],
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const previewImage = args.preview_image === undefined ? undefined : await host.file(args.preview_image, exec)
      const previewGif = args.preview_gif === undefined ? undefined : await host.file(args.preview_gif, exec)
      const released = await host.release({
        projectDir,
        ...args.notes === undefined ? {} : { notes: args.notes },
        ...args.title === undefined ? {} : { title: args.title },
        ...previewImage === undefined ? {} : { previewImage },
        ...previewGif === undefined ? {} : { previewGif },
      }, exec)
      return { ...released, warnings: [...released.warnings] }
    },
  })]
}

/** Absolute-path arguments of the tools offered to connected agents, by tool. */
const MCP_PATHS: Readonly<Record<string, Readonly<Record<string, { readonly type: 'string'; readonly description: string }>>>> = {
  wasd_export_web: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_record_preview: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_release_game: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
    preview_image: { type: 'string', description: 'Absolute path of a PNG, JPEG, or WebP picture that Explore shows for the game; 16:9 fits best. Default: the still that wasd_record_preview saved.' },
    preview_gif: { type: 'string', description: 'Absolute path of an animated GIF that Explore plays on hover and the share link shows. Default: the GIF that wasd_record_preview saved.' },
  },
}

/**
 * Tools that run the game in the connected agent's Session for the project: the recording, which needs the Session,
 * and a release, which records a missing preview in it when it has one.
 */
const MCP_SESSION_TOOLS: ReadonlySet<string> = new Set(['wasd_record_preview', 'wasd_release_game'])

/** Media types of preview stills, by file extension. */
const STILL_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg' }

/**
 * The content a connected agent receives from a recording: the text, then the still from its file.
 * @param definition - the recording tool.
 * @param value - the call's result.
 * @param args - the call's arguments.
 * @returns the text and the still.
 */
async function recordingContent(definition: ToolDefinition, value: RecordedPreviewValue, args: JsonObject): Promise<GameMcpContent[]> {
  const text = definition.output.render(args, value as never).flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [])
  const mimeType = STILL_TYPES[value.image.slice(value.image.lastIndexOf('.') + 1).toLowerCase()]
  if (mimeType === undefined) return text
  return [...text, { type: 'image', data: (await readFile(value.image)).toString('base64'), mimeType }]
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
    async prepare(args, call) {
      for (const name of Object.keys(paths)) {
        const value = args[name]
        if (name === 'project' ? typeof value !== 'string' || !isAbsolute(value) : value !== undefined && (typeof value !== 'string' || !isAbsolute(value))) {
          throw new Error(`${name} must be an absolute path.`)
        }
      }
      if (!MCP_SESSION_TOOLS.has(definition.name)) return { args }
      // The game plays in the connected agent's Session of the project, in the WASD Engine window's Game tab.
      if (definition.name === 'wasd_record_preview') return { args, agent: await call.session(args.project as string) }
      try {
        return { args, agent: await call.session(args.project as string) }
      } catch {
        // Without a Session the release still goes out; it only cannot record a missing preview.
        return { args }
      }
    },
    ...definition.name === 'wasd_record_preview'
      ? { content: (value, args) => recordingContent(definition, value as RecordedPreviewValue, args) }
      : {},
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
    description: 'Export the user\'s Godot game for the Web, record its preview, and release it on WASD Engine with a share link.',
    instructions: 'wasd_export_web builds the Godot project for the Web into its .wasdengine/web folder. wasd_record_preview records the game\'s preview, a short GIF and a still of the running game, which Explore and the share link show: start the game with godot_run, bring it to its gameplay, then record with events that play it. wasd_release_game builds the project and publishes the build as the game\'s next numbered version on WASD Engine with the recorded preview, and returns the share link, where anyone can play the game, pick earlier versions, and comment. Each release is public: release only when the user asks to, and pass notes that say what changed. Releasing needs WASD Engine to be signed in.',
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
