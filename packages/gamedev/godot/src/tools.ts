/**
 * The model-facing Godot tools. Every tool runs against the calling Session's game. Each result reports the
 * error-level entries the run logged since the Session's previous Godot tool call (up to
 * {@link DIGEST_ENTRIES}, then a count), and its text stays within {@link TEXT_BUDGET} characters; complete
 * values remain available to programs. One set of definitions serves one {@link GodotToolSurface}: the Session's
 * own agent, whose screenshots become attachments for its model, or agents that reach the tools over WASD Engine's
 * MCP server, whose screenshots travel as image bytes.
 * @module @deepseek-ai/dsh-godot/src/tools
 */
import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { analyzeAudio, describeAudioImage, drawAudioImage, type AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'
import { encodePng } from '@deepseek-ai/dsh-game-audio/png'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { applyMasterVolume, AUDIO_PROPERTIES, describeAudio, encodeWav, summarizeAudio } from './audio.ts'
import type { CheckReport, CheckRequest } from './check.ts'
import { hasPointerEvents, parseInputEvents, parseWindowSize, screenshotToWindow } from './input.ts'
import { isErrorEntry } from './logs.ts'
import { fixedFps, GODOT_ENGINE_OPTIONS, MAX_FIXED_FPS } from './launch.ts'
import { MAX_VIDEO_SECONDS } from './video.ts'
import { formatPerformance, PERFORMANCE_PROPERTIES, summarizePerformance } from './performance.ts'
import { MAX_INPUT_EVENTS, type GodotRun, type ScreenshotRegion, type ViewParams } from './run.ts'
import {
  DEFAULT_SCRIPT_SECONDS, MAX_SCRIPT_CALL_SECONDS, MAX_SCRIPT_RUNS, MAX_SCRIPT_SECONDS, OUTPUT_DIR_VARIABLE,
  type EngineIssue, type GodotScriptReport, type GodotScriptRunsReport, type ScriptRunResult,
} from './script.ts'
import type { GodotSession, GodotSessions } from './runs.ts'
import type { GodotInputEvent, GodotLogEntry, GodotLogLevel, GodotRunRequest } from './types.ts'

/** Most characters of text in one tool result. */
export const TEXT_BUDGET = 6000

/** Most error entries listed in a result's new-error report. */
export const DIGEST_ENTRIES = 10

/** The `web` parameter of `godot_run`. */
export const WEB_RUN_DESCRIPTION = 'true runs the game as its Web build plays: with the Compatibility renderer (WebGL 2 in browsers), whose shading, '
  + 'shadows, and limits differ from Forward+, so what you see is what players of the released game see. Default: false, the project\'s renderer.'

/** Most errors and warnings listed in a `godot_run` result. */
export const STARTUP_ENTRIES = 20

/** How long `godot_run` keeps collecting startup logs after the game runs. */
export const STARTUP_LOG_WINDOW_MS = 1000

/** Longest log message quoted in a result. */
const MESSAGE_CHARS = 500

/** Default `max_width` of `godot_screenshot`, and the largest width of the screenshot `godot_input` and `godot_wait` take. */
export const SCREENSHOT_WIDTH = 1280

/** Width a small screenshot region grows toward, by a whole factor, so its detail is large enough to see. */
export const REGION_MIN_WIDTH = 768

/** Default, shortest, and longest real seconds that `godot_eval` code may await. */
const CODE_SECONDS = { default: 10, min: 1, max: 300 } as const

/** Default and largest sides in pixels of a `godot_view` image. */
const VIEW_SIZE = { width: 1280, height: 720, max: 4096 } as const

/** Default, shortest, and longest real seconds that `godot_performance` measures. */
const PERFORMANCE_SECONDS = { default: 2, min: 0.25, max: 20 } as const

/** Default, shortest, and longest seconds of audio that `godot_audio` captures. */
export const AUDIO_SECONDS = { default: 3, min: 0.25, max: 30 } as const

const LEVELS = ['stdout', 'stderr', 'warning', 'error', 'script_error', 'shader_error'] as const

/** What the tools need from the plugin. */
export interface GodotToolHost {
  /** Per-Session state. */
  readonly sessions: GodotSessions
  /** Whether agent runs use the Dummy audio driver unless the call says otherwise. */
  readonly agentRunsMuted: boolean
  /**
   * Record the Session's running game to a video file through a WASD Engine window, which encodes it.
   * @param agent - calling Session.
   * @param run - the running game.
   * @param request - duration, frame rate, size, input, and where to save the video.
   * @param signal - cancellation; it stops the recording and saves nothing.
   * @returns the saved video and a sheet of its frames.
   */
  record(agent: Agent, run: GodotRun, request: GodotVideoRequest, signal: AbortSignal): Promise<GodotVideo>
  /**
   * Start or restart the Session's game and wait until it runs or has ended.
   * @param agent - calling Session.
   * @param request - run parameters.
   * @param signal - cancellation of the wait; the run belongs to the Session.
   * @returns the new run.
   */
  run(agent: Agent, request: GodotRunRequest & { readonly muted: boolean }, signal: AbortSignal): Promise<GodotRun>
  /**
   * Check scripts without running the game.
   * @param agent - calling Session.
   * @param request - project and paths as the model gave them.
   * @param signal - cancellation.
   * @returns the project folder, the checked scripts, and how many scripts the project selection holds.
   */
  check(agent: Agent, request: CheckRequest, signal: AbortSignal): Promise<CheckReport>
  /**
   * Run a GDScript that extends `SceneTree` or `MainLoop` against the project headless, without running the game.
   * @param agent - calling Session.
   * @param request - project, script, user arguments, runs, fixed frame rate, and time limit as the model gave them.
   * @param signal - cancellation.
   * @returns for a request without runs, the exit code, the end of the output, the engine errors, and the files the
   *   script wrote; with runs, how each run ended.
   */
  script(agent: Agent, request: GodotScriptRequest, signal: AbortSignal): Promise<GodotScriptReport | GodotScriptRunsReport>
  /**
   * Resolve a file path as the model gave it: absolute, or relative to the Session's working directory.
   * @param agent - calling Session.
   * @param path - the path.
   * @param signal - cancellation.
   * @returns the absolute path.
   */
  resolvePath(agent: Agent, path: string, signal: AbortSignal): Promise<string>
}

/** A recording as `godot_record` asks for it, its events already in window pixels. */
export interface GodotVideoRequest {
  /** Real seconds to record. */
  readonly seconds: number
  /** Frames per second of the video. */
  readonly fps: number
  /** Largest frame width in pixels; smaller windows keep their size. */
  readonly maxWidth: number
  /** Where to save the video, relative to the working directory or absolute; a new file under `recordings/` when undefined. */
  readonly path?: string
  /** Input events the game receives from the recording's start, in window pixels. */
  readonly events?: readonly GodotInputEvent[]
  /** Frames in the sheet that shows the recording, from 0 to 24. */
  readonly sheetFrames: number
  /** Whether an existing file at `path` may be replaced. */
  readonly replace: boolean
}

/** A saved recording. */
export interface GodotVideo {
  /** Absolute path of the video file. */
  readonly path: string
  /** Its size in bytes. */
  readonly bytes: number
  /** Video codec, such as `H.264`. */
  readonly codec: string
  /** Frames in the video. */
  readonly frames: number
  /** Frames the game skipped because capturing or encoding fell behind. */
  readonly skipped: number
  /** Seconds the video plays. */
  readonly seconds: number
  /** Frames per second of the video. */
  readonly fps: number
  /** Frame size in pixels. */
  readonly width: number
  readonly height: number
  /** Whether every frame advanced the game by the same game time (a run with `--fixed-fps`) instead of real time. */
  readonly fixedFps: boolean
  /** Why the input events failed, when the game refused one; the recording went on without the rest. */
  readonly inputError?: string
  /** The frame sheet as a JPEG file, with the time of each frame in seconds; absent with no sheet frames. */
  readonly sheet?: { readonly data: Buffer; readonly width: number; readonly height: number; readonly times: readonly number[] }
}

/** A script run as the model asked for it. */
export interface GodotScriptRequest {
  /** Project folder relative to the working directory, or absolute; the running game's project or the nearest one when omitted. */
  readonly project?: string
  /** `res://` path of the script, or a path relative to the working directory. */
  readonly script: string
  /** User arguments after `--`. */
  readonly args?: readonly string[]
  /** Time limit of each run in seconds. */
  readonly timeoutSeconds?: number
  /** Runs at once, each with its own arguments after `args` and an optional name; one run with `args` when omitted. */
  readonly runs?: readonly GodotScriptRunRequest[]
  /** Frame rate that `--fixed-fps` fixes; real time when omitted. */
  readonly fixedFps?: number
  /** Whether each run runs while no other script run, script check, or export of the Host runs. */
  readonly exclusive?: boolean
}

/** One run of a script request as the model asked for it. */
export interface GodotScriptRunRequest {
  /** User arguments after the request's own `args`. */
  readonly args?: readonly string[]
  /** Name of the run in its folder's name and the report. */
  readonly name?: string
}

/** A required string field. */
const STRING = { type: 'string', required: true } as const

/** A required number field. */
const NUMBER = { type: 'number', required: true } as const

/** A required integer field. */
const INTEGER = { type: 'integer', required: true } as const

/** A required boolean field. */
const BOOLEAN = { type: 'boolean', required: true } as const

/** A size in pixels. */
const SIZE = { width: INTEGER, height: INTEGER } as const

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: INTEGER,
    source: STRING,
    level: STRING,
    message: STRING,
    file: { type: 'string' },
    line: { type: 'integer' },
    function: { type: 'string' },
  },
} as const

const DIGEST_SCHEMA = {
  newErrors: { type: 'array', items: ENTRY_SCHEMA },
  moreNewErrors: { type: 'integer' },
} as const

/** The stored image: the attachment reference that the attachment store returned for it. */
const IMAGE_OBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    ...SIZE,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: SIZE },
  },
} as const

const IMAGE_SCHEMA = { ...IMAGE_OBJECT, required: true } as const

const SCREENSHOT_PROPERTIES = {
  width: { ...INTEGER, description: 'Image width in pixels; mouse coordinates refer to this size.' },
  height: INTEGER,
  windowWidth: INTEGER,
  windowHeight: INTEGER,
  x: { type: 'integer', description: 'Window pixels from the left edge to the region the image shows.' },
  y: { type: 'integer', description: 'Window pixels from the top edge to the region the image shows.' },
  regionWidth: { type: 'integer', description: 'Width in window pixels of the region the image shows.' },
  regionHeight: { type: 'integer', description: 'Height in window pixels of the region the image shows.' },
  frame: INTEGER,
  paused: BOOLEAN,
  image: IMAGE_SCHEMA,
} as const

const SCREENSHOT_SCHEMA = { type: 'object', additionalProperties: false, properties: SCREENSHOT_PROPERTIES } as const

/** A screenshot as a result value holds it: its size, the game window it shows, and the stored image. */
export type ScreenshotValue = InferValue<typeof SCREENSHOT_SCHEMA>

/** A stored image as a result value holds it: the attachment reference, or the image id for connected agents. */
export type ImageValue = InferValue<typeof IMAGE_SCHEMA>

/** An image the game or a window made for a tool call, which the surface stores for its callers. */
export interface MadeImage {
  /** PNG or JPEG bytes. */
  readonly data: Buffer
  readonly mediaType: 'image/png' | 'image/jpeg'
  /** Size in pixels. */
  readonly width: number
  readonly height: number
  /** File name the stored image takes. */
  readonly name: string
}

/** Captures and stores the images of one tool call for the callers of a {@link GodotToolSurface}. */
export interface ScreenshotTaker {
  /**
   * Capture the running game's window, or a region of it, and store the image where the surface's callers receive it.
   * @param run - running game.
   * @param maxWidth - largest image width the call asked for.
   * @param signal - cancellation.
   * @param region - part of the window to capture, in window pixels.
   * @returns the screenshot as a result value holds it; input coordinates in screenshot pixels refer to its
   * `width` and `height`.
   */
  capture(run: GodotRun, maxWidth: number, signal: AbortSignal, region?: ScreenshotRegion): Promise<ScreenshotValue>
  /**
   * Store an image where the surface's callers receive it.
   * @param image - the image.
   * @param signal - cancellation.
   * @returns the stored image as a result value holds it.
   */
  store(image: MadeImage, signal: AbortSignal): Promise<ImageValue>
  /**
   * Fit a size that the call asks the game to draw within the images the surface's callers receive unresized.
   * @param width - asked width in pixels.
   * @param height - asked height in pixels.
   * @returns the size to draw, with the same aspect ratio.
   */
  fit(width: number, height: number): { readonly width: number; readonly height: number }
}

/** Tool description text that depends on how a surface's callers name projects and files. */
export interface GodotToolWording {
  /** First sentence of the `godot_run` description, with its trailing space. */
  readonly run: string
  /** How the `godot_check` description names the paths it accepts. */
  readonly checkPaths: string
  /** How the `godot_script` description names the script path it accepts. */
  readonly scriptPath: string
  /** The `godot_logs` description's sentence about reading without `since`. */
  readonly logsDefault: string
  /** How the `godot_audio` description names the file path it accepts. */
  readonly audioPath: string
}

/** The callers that one set of Godot tool definitions serves. */
export interface GodotToolSurface {
  /**
   * Resolve what a call's screenshots need. A tool that acts on the game and then takes a screenshot resolves this
   * before it acts, so a caller that cannot receive images fails before anything happens in the game.
   * @param exec - the tool call.
   * @param agent - calling Session.
   * @returns the call's screenshot taker.
   * @throws when the caller cannot receive screenshots.
   */
  screenshots(exec: ToolRunContext, agent: Agent): Promise<ScreenshotTaker>
  /**
   * Resolve where a call's pictures go, such as an audio capture's waveform, which a result can do without.
   * @param exec - the tool call.
   * @param agent - calling Session.
   * @returns what stores the call's pictures, or undefined when the callers receive no images, so that the result keeps
   * to text.
   */
  pictures(exec: ToolRunContext, agent: Agent): Promise<Pick<ScreenshotTaker, 'store'> | undefined>
  /** Description text for these callers. */
  readonly wording: GodotToolWording
}

/** Wording of the Session's own tools, which name projects and files relative to the working directory. */
export const SESSION_WORDING: GodotToolWording = {
  run: 'Start the Godot project in the working directory, or restart it if it is running, and wait until the game runs. ',
  checkPaths: 'files or folders, as res:// paths or relative to the working directory',
  scriptPath: 'a res:// path or a path relative to the working directory',
  logsDefault: 'Without since, returns the entries after the ones this Session last read.',
  audioPath: 'a path relative to the working directory, or absolute',
}

/** A log entry as tools report it. */
export interface ToolLogEntry {
  readonly seq: number
  readonly source: string
  readonly level: string
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly function?: string
}

/** New-error report fields of every result. */
interface Digest {
  newErrors?: ToolLogEntry[]
  moreNewErrors?: number
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Report a log entry compactly.
 * @param entry - stored entry.
 * @returns the entry without run id, time, and backtrace, with its message shortened.
 */
export function toolLogEntry(entry: GodotLogEntry): ToolLogEntry {
  return {
    seq: entry.seq,
    source: entry.source,
    level: entry.level,
    message: clip(entry.message, MESSAGE_CHARS),
    ...entry.file === undefined ? {} : { file: entry.file },
    ...entry.line === undefined ? {} : { line: entry.line },
    ...entry.function === undefined ? {} : { function: entry.function },
  }
}

/**
 * Format a log entry as one line.
 * @param entry - reported entry.
 * @returns `[level] file:line (function): message`, naming the source when it is not the game.
 */
export function formatLogEntry(entry: ToolLogEntry): string {
  const source = entry.source === 'game' ? '' : `, ${entry.source}`
  const line = entry.line === undefined ? '' : `:${entry.line}`
  const fn = entry.function === undefined ? '' : ` (${entry.function})`
  const location = entry.file === undefined ? '' : `${entry.file}${line}${fn}: `
  return `[${entry.level}${source}] ${location}${entry.message}`
}

/**
 * Format the new-error report of a result.
 * @param digest - report fields.
 * @returns the report, or an empty string when nothing new was logged.
 */
export function formatDigest(digest: Digest): string {
  if (digest.newErrors === undefined) return ''
  const more = digest.moreNewErrors === undefined ? '' : `\n… and ${digest.moreNewErrors} more; read them with godot_logs.`
  return `New errors since your last Godot call:\n${digest.newErrors.map(formatLogEntry).join('\n')}${more}`
}

/** Join text sections and keep them within the budget. */
function finishText(...sections: string[]): string {
  const text = sections.filter(section => section !== '').join('\n\n')
  return text.length > TEXT_BUDGET ? `${text.slice(0, TEXT_BUDGET - 30)}\n… (output shortened)` : text
}

function textResult(...sections: string[]): ContentBlock[] {
  return [{ type: 'text', text: finishText(...sections) }]
}

function screenshotBlocks(shot: ScreenshotValue): ContentBlock[] {
  return imageBlocks(shot.image)
}

function imageBlocks(image: ImageValue): ContentBlock[] {
  // The value holds the reference that the attachment store returned, so its id is a stored attachment id.
  return [{ type: 'image', attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } }]
}

/**
 * Read a point a call gives as [x, y, z].
 * @param value - the call's list.
 * @param name - the parameter, for the error.
 * @returns the point.
 * @throws when the list is not three finite numbers.
 */
function point(value: readonly number[], name: string): readonly [number, number, number] {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${name} must be [x, y, z], three numbers.`)
  return [value[0] as number, value[1] as number, value[2] as number]
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describeScreenshot(shot: ScreenshotValue): string {
  const paused = shot.paused ? ' (paused)' : ''
  if (shot.x !== undefined && shot.y !== undefined && shot.regionWidth !== undefined && shot.regionHeight !== undefined) {
    return `Screenshot at frame ${shot.frame}${paused}: ${shot.width}x${shot.height} px showing the ${shot.regionWidth}x${shot.regionHeight} px region at (${shot.x}, ${shot.y}) of a ${shot.windowWidth}x${shot.windowHeight} px game window. Mouse coordinates for godot_input are pixels of this image, which map into that region.`
  }
  const smaller = shot.width < shot.windowWidth ? ' To see detail at the window\'s own pixels, pass region.' : ''
  return `Screenshot at frame ${shot.frame}${paused}: ${shot.width}x${shot.height} px of a ${shot.windowWidth}x${shot.windowHeight} px game window. Mouse coordinates for godot_input are pixels of this image.${smaller}`
}

/** The screenshot fields of a result that may end with a screenshot. */
interface ScreenshotOutcome {
  readonly screenshot?: ScreenshotValue
  readonly screenshotError?: string
}

function describeStep(step: { readonly frames?: number; readonly endedEarly?: boolean; readonly timedOut?: boolean }): string {
  if (step.frames === undefined) return ''
  if (step.endedEarly === true) return `Ran ${step.frames} frames before a pause, a resume, or a newer step ended the step. `
  if (step.timedOut === true) return `Ran ${step.frames} frames before the step reached its real-time limit. `
  return `Ran ${step.frames} frames. `
}

/** The completion facts of an input sequence, as `godot_input` returns them. */
interface InputOutcome {
  readonly events: number
  readonly frames: number
  readonly seconds: number
  readonly frame: number
  readonly timedOut: boolean
}

function describeInput(input: InputOutcome): string {
  const span = `over ${input.frames} frames (${input.seconds.toFixed(2)} s)`
  return input.timedOut
    ? `The input ended at its real-time limit after ${input.events} of its events, ${span}; the keys and buttons it held were released, and the game is at frame ${input.frame}.`
    : `Sent ${input.events} events ${span}; the game is at frame ${input.frame}.`
}

function describeOutcome(outcome: ScreenshotOutcome, action: string): string {
  if (outcome.screenshot !== undefined) return describeScreenshot(outcome.screenshot)
  return outcome.screenshotError === undefined ? '' : `The screenshot after ${action} failed: ${outcome.screenshotError}`
}

function takeDigest(session: GodotSession): Digest {
  const run = session.run
  if (run === undefined) return {}
  const fresh = run.logs.filter(entry => entry.seq > session.digestCursor && isErrorEntry(entry))
  session.digestCursor = Math.max(session.digestCursor, run.logs.lastSeq)
  if (fresh.length === 0) return {}
  return {
    newErrors: fresh.slice(0, DIGEST_ENTRIES).map(toolLogEntry),
    ...fresh.length > DIGEST_ENTRIES ? { moreNewErrors: fresh.length - DIGEST_ENTRIES } : {},
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('Godot tools run only inside a Session.')
  return exec.agent
}

function requireRunning(session: GodotSession): GodotRun {
  const run = session.run
  if (run === undefined) throw new Error('No game is running in this Session; call godot_run first.')
  if (run.terminal) {
    const view = run.view()
    throw new Error(`The game is not running (${view.phase}); call godot_run to start it again.${view.message === undefined ? '' : `\n${view.message}`}`)
  }
  if (!run.connected) throw new Error('The game is starting or stopping; call godot_run to wait for it.')
  return run
}

/**
 * Run a tool body against the calling Session and add its new-error report. A failure's message carries the
 * report too.
 */
async function invoke<T extends object>(
  host: GodotToolHost,
  exec: ToolRunContext,
  body: (agent: Agent, session: GodotSession) => T | Promise<T>,
): Promise<T & Digest> {
  const agent = requireAgent(exec)
  const session = host.sessions.session(agent)
  let value: T
  try {
    value = await body(agent, session)
  } catch (error) {
    const report = formatDigest(takeDigest(session))
    if (report === '') throw error
    throw new Error(`${(error as Error).message}\n\n${report}`, { cause: error })
  }
  return { ...value, ...takeDigest(session) }
}

/**
 * Store an image of a tool call as an attachment of the Session.
 * @param attachments - the Session's attachment store.
 * @param made - the image.
 * @param signal - cancellation.
 * @returns the attachment reference.
 */
async function storeImage(attachments: AttachmentStore, made: MadeImage, signal: AbortSignal): Promise<ImageValue> {
  const [image] = await attachments.saveImages([{ data: made.data, mediaType: made.mediaType, name: made.name }]) as [ImageAttachmentRef]
  signal.throwIfAborted()
  return image
}

/**
 * The screenshots of the Session's own tools: each image becomes an attachment that the Session's model receives,
 * measured as that model sees it.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the screenshot resolution of {@link GodotToolSurface}.
 */
export function sessionScreenshots(ctx: Context): GodotToolSurface['screenshots'] {
  return async (exec, agent) => {
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    const route = agent.model.current()
    if (attachments === undefined || llm === undefined || route === undefined) {
      throw new Error('Screenshots need an attachment store and a resolved model route, and this Session has neither.')
    }
    const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
    if (info.inputModalities?.includes('image') !== true) {
      throw new Error(`The model "${route.model}" does not accept images, so it cannot see screenshots; switch to an image-capable model.`)
    }
    return {
      async capture(run, maxWidth, signal, region) {
        const shot = await run.screenshot(maxWidth, signal, undefined, region)
        const [image] = await attachments.saveImages([{ data: shot.image, mediaType: 'image/png', name: `godot-frame-${shot.meta.frame}.png` }]) as [ImageAttachmentRef]
        signal.throwIfAborted()
        const seen = await attachments.readImageRequest(image, llm.imageRequestTarget(route.provider, route.model, image), signal)
        return {
          width: seen.width,
          height: seen.height,
          windowWidth: shot.meta.windowWidth,
          windowHeight: shot.meta.windowHeight,
          ...regionFields(shot.meta),
          frame: shot.meta.frame,
          paused: shot.meta.paused,
          image,
        }
      },
      store: (made, signal) => storeImage(attachments, made, signal),
      fit: (width, height) => ({ width, height }),
    }
  }
}

/**
 * The region fields of a screenshot's metadata.
 * @param meta - what the game reported.
 * @returns the region in window pixels, or nothing for a screenshot of the whole window.
 */
export function regionFields(meta: {
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly regionWidth?: number | undefined
  readonly regionHeight?: number | undefined
}): {
  x?: number
  y?: number
  regionWidth?: number
  regionHeight?: number
} {
  if (meta.x === undefined || meta.y === undefined || meta.regionWidth === undefined || meta.regionHeight === undefined) return {}
  return { x: meta.x, y: meta.y, regionWidth: meta.regionWidth, regionHeight: meta.regionHeight }
}

/**
 * The pictures of the Session's own tools, such as an audio capture's waveform: each becomes an attachment that the
 * Session's model receives. A Session whose model does not accept images keeps none, so its results keep to text.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the picture resolution of {@link GodotToolSurface}.
 */
export function sessionPictures(ctx: Context): GodotToolSurface['pictures'] {
  return async (exec, agent) => {
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    const route = agent.model.current()
    if (attachments === undefined || llm === undefined || route === undefined) return undefined
    const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
    if (info.inputModalities?.includes('image') !== true) return undefined
    return { store: (made, signal) => storeImage(attachments, made, signal) }
  }
}

/**
 * Capture a screenshot; afterwards input coordinates in screenshot pixels refer to it.
 * @param taker - the call's screenshot taker.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param maxWidth - largest captured width.
 * @param signal - cancellation.
 * @returns the screenshot as a result value holds it.
 */
async function captureScreenshot(
  taker: ScreenshotTaker,
  session: GodotSession,
  run: GodotRun,
  maxWidth: number,
  signal: AbortSignal,
  region?: ScreenshotRegion,
): Promise<ScreenshotValue> {
  const shot = await taker.capture(run, maxWidth, signal, region)
  const { width, height, windowWidth, windowHeight } = shot
  session.screenshot = { runId: run.id, width, height, windowWidth, windowHeight, ...regionFields(shot) }
  return shot
}

/**
 * Take the screenshot that ends an action on the game. The action already happened, so a failed capture becomes
 * part of the result instead of failing the call; cancellation still fails it.
 * @param taker - the call's screenshot taker, resolved before the action.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param signal - cancellation.
 * @returns the screenshot, or why it failed.
 */
async function screenshotAfter(
  taker: ScreenshotTaker,
  session: GodotSession,
  run: GodotRun,
  signal: AbortSignal,
): Promise<ScreenshotOutcome> {
  try {
    return { screenshot: await captureScreenshot(taker, session, run, SCREENSHOT_WIDTH, signal) }
  } catch (error) {
    signal.throwIfAborted()
    return { screenshotError: (error as Error).message }
  }
}

/**
 * Refuse a path that holds a folder, or a file the call may not replace.
 * @param path - absolute path.
 * @param replace - whether a file may be replaced.
 * @throws Error when the path is a folder, or a file and `replace` is false.
 */
async function refuseExisting(path: string, replace: boolean): Promise<void> {
  let found
  try {
    found = await stat(path)
  } catch (error) {
    // Only a path that does not exist yet is free; any other failure stops the call.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (found.isDirectory()) throw new Error(`${path} is a folder; pass the path of a .wav file.`)
  if (!replace) throw new Error(`${path} already exists; pass replace: true to overwrite it, or choose another path.`)
}

/**
 * Capture the game's audio while an input sequence plays from the capture's start; input still running when the
 * capture ends is cancelled, and the game releases what it held.
 * @param run - running game.
 * @param seconds - seconds of audio.
 * @param events - input in window pixels.
 * @param signal - cancellation of the call.
 * @returns the capture.
 * @throws the input sequence's failure, other than the cancellation that ends it with the capture.
 */
async function captureWithInput(
  run: GodotRun, seconds: number, events: readonly GodotInputEvent[] | undefined, signal: AbortSignal,
): ReturnType<GodotRun['audio']> {
  const capture = run.audio(seconds, signal)
  if (events === undefined || events.length === 0) return await capture
  const input = new AbortController()
  const cancelInput = (): void => { input.abort(signal.reason) }
  signal.addEventListener('abort', cancelInput, { once: true })
  let failure: { readonly error: unknown } | undefined
  const played = run.input(events, input.signal).then(() => {}, (error: unknown) => {
    // The capture cancels the input it outlasts; any other failure fails the call.
    if (!input.signal.aborted) failure = { error }
  })
  try {
    const captured = await capture
    if (failure !== undefined) throw failure.error
    return captured
  } finally {
    signal.removeEventListener('abort', cancelInput)
    input.abort(new Error('The audio capture ended.'))
    await played
  }
}

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['key', 'text', 'mouse_button', 'mouse_motion', 'action', 'joy_button', 'joy_axis'], description: 'Event kind; omit it for a wait.' },
    wait: { type: 'number', description: 'Seconds to wait before the next event; use alone.' },
    key: { type: 'string', description: 'key: Godot key name such as W, Space, Left, Enter, Escape, Shift.' },
    keycode: { type: 'integer', description: 'key: Godot keycode, instead of key.' },
    pressed: { type: 'boolean', description: 'key, mouse_button, action, joy_button: true presses, false releases.' },
    hold: { type: 'number', description: 'key, mouse_button, action: seconds until an automatic release.' },
    echo: { type: 'boolean' },
    unicode: { type: 'integer' },
    text: { type: 'string', description: 'text: characters to type.' },
    button: { type: 'string', enum: ['left', 'right', 'middle', 'wheel_up', 'wheel_down', 'wheel_left', 'wheel_right'] },
    x: { type: 'number', description: 'mouse_button, mouse_motion: horizontal position.' },
    y: { type: 'number', description: 'mouse_button, mouse_motion: vertical position.' },
    dx: { type: 'number', description: 'mouse_motion: relative motion.' },
    dy: { type: 'number' },
    double: { type: 'boolean', description: 'mouse_button: double click.' },
    factor: { type: 'number' },
    action: { type: 'string', description: 'action: input map action such as ui_accept or ui_left.' },
    strength: { type: 'number', description: 'action: 0 to 1.' },
    device: { type: 'integer', description: 'joy_button, joy_axis: joypad index.' },
    axis: { type: 'integer' },
    value: { type: 'number', description: 'joy_axis: -1 to 1.' },
    shift: { type: 'boolean' },
    ctrl: { type: 'boolean' },
    alt: { type: 'boolean' },
    meta: { type: 'boolean' },
  },
} as const

/**
 * The window region a `godot_screenshot` call names, in window pixels.
 * @param region - the rectangle as the call gives it.
 * @param space - the rectangle's unit.
 * @param session - the calling Session's state, whose latest screenshot screenshot pixels refer to.
 * @param run - the running game.
 * @param maxWidth - the call's largest image width, which a small region grows toward at most.
 * @returns the region with the width a small region grows toward.
 * @throws when the rectangle is empty, or in screenshot pixels while this game has no screenshot.
 */
function windowRegion(
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  space: 'screenshot' | 'window',
  session: GodotSession,
  run: GodotRun,
  maxWidth: number,
): ScreenshotRegion {
  if (region.width < 1 || region.height < 1) throw new Error('region width and height must be at least 1.')
  const minWidth = Math.min(REGION_MIN_WIDTH, maxWidth)
  if (space === 'window') return { x: region.x, y: region.y, width: region.width, height: region.height, minWidth }
  const frame = session.screenshot
  if (frame === undefined || frame.runId !== run.id) {
    throw new Error('region is in screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
  }
  const scaleX = (frame.regionWidth ?? frame.windowWidth) / frame.width
  const scaleY = (frame.regionHeight ?? frame.windowHeight) / frame.height
  return {
    x: (frame.x ?? 0) + Math.floor(region.x * scaleX),
    y: (frame.y ?? 0) + Math.floor(region.y * scaleY),
    width: Math.max(1, Math.ceil(region.width * scaleX)),
    height: Math.max(1, Math.ceil(region.height * scaleY)),
    minWidth,
  }
}

function boundedInteger(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (value < min || value > max) throw new Error(`${name} must be from ${min} to ${max}.`)
  return value
}

/**
 * Register the Session's own Godot tools.
 * @param ctx - plugin context; registrations end with it.
 * @param host - plugin operations the tools call.
 */
export function registerGodotTools(ctx: Context, host: GodotToolHost): void {
  const surface = { screenshots: sessionScreenshots(ctx), pictures: sessionPictures(ctx), wording: SESSION_WORDING }
  for (const definition of godotToolDefinitions(host, surface)) {
    ctx.tools.register(definition)
  }
}

/**
 * Build the Godot tool definitions for one surface. The definitions are not registered; each call runs against
 * the Agent its execution names.
 * @param host - plugin operations the tools call.
 * @param surface - how the callers receive screenshots, and their wording.
 * @returns the definitions, in catalog order.
 */
export function godotToolDefinitions(host: GodotToolHost, surface: GodotToolSurface): ToolDefinition[] {
  const { wording } = surface
  return [defineTool({
    name: 'godot_run',
    description: wording.run
      + 'Reports the window size, the renderer, and the errors and warnings logged while importing and starting. Then look with godot_screenshot and play with godot_input.',
    parameters: {
      project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the nearest project.godot.' },
      scene: { type: 'string', description: 'res:// path of a scene to run instead of the main scene.' },
      width: { type: 'integer', description: 'Game window width in pixels; give height too.' },
      height: { type: 'integer', description: 'Game window height in pixels; give width too.' },
      muted: { type: 'boolean', description: `Run without audio. Default: ${String(host.agentRunsMuted)}.` },
      web: { type: 'boolean', description: WEB_RUN_DESCRIPTION },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Launch options for the game itself: arguments it reads with OS.get_cmdline_user_args(), such as a test or capture mode the game offers. Default: none.',
      },
      engine_args: {
        type: 'array',
        items: { type: 'string' },
        description: `Godot command-line options, each followed by its value: ${Object.keys(GODOT_ENGINE_OPTIONS).join(', ')}. `
          + '["--fixed-fps", "30"] makes every frame advance 1/30 s of game time however fast or slow it draws, so godot_record keeps every '
          + 'frame; --max-fps does not slow such a game. --time-scale speeds the game up or slows it down. Default: none.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: STRING,
          phase: STRING,
          projectDir: STRING,
          projectName: { type: 'string' },
          scene: { type: 'string' },
          width: INTEGER,
          height: INTEGER,
          renderer: STRING,
          godot: STRING,
          windowless: BOOLEAN,
          muted: BOOLEAN,
          web: { type: 'boolean' },
          scale: { type: 'integer', description: 'The whole factor by which the window grew from the project\'s small window size.' },
          args: { type: 'array', items: { type: 'string' } },
          engineArgs: { type: 'array', items: { type: 'string' } },
          issues: { type: 'array', items: ENTRY_SCHEMA, required: true },
          moreIssues: INTEGER,
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        const window = value.scale === undefined
          ? `window ${value.width}x${value.height}`
          : `window ${value.width}x${value.height} (the project's ${value.width / value.scale}x${value.height / value.scale} grown ${value.scale}x; pass width and height for another size)`
        const facts = [
          ...value.scene === undefined ? [] : [`scene ${value.scene}`],
          window,
          `renderer ${value.renderer}${value.web === true ? ' as on the Web' : ''}`,
          `Godot ${value.godot}`,
          ...value.windowless ? ['windowless'] : [],
          ...value.muted ? ['muted'] : [],
          ...value.engineArgs === undefined ? [] : [`Godot options ${value.engineArgs.join(' ')}`],
          ...value.args === undefined ? [] : [`game arguments ${JSON.stringify(value.args)}`],
        ].join(', ')
        const name = value.projectName === undefined ? value.projectDir : `${value.projectName} (${value.projectDir})`
        const issues = value.issues.length === 0
          ? 'No errors or warnings were logged while importing and starting.'
          : `Errors and warnings logged while importing and starting:\n${value.issues.map(formatLogEntry).join('\n')}${value.moreIssues > 0 ? `\n… and ${value.moreIssues} more; read them with godot_logs.` : ''}`
        return textResult(`The game is ${value.phase}: ${name}; ${facts}.`, issues, formatDigest(value))
      },
    },
    async execute(args, exec) {
      const size = parseWindowSize(args.width, args.height)
      return invoke(host, exec, async (agent, session) => {
        const run = await host.run(agent, {
          ...args.project === undefined ? {} : { project: args.project },
          ...args.scene === undefined ? {} : { scene: args.scene },
          ...size,
          muted: args.muted ?? host.agentRunsMuted,
          ...args.web === true ? { web: true } : {},
          ...args.args === undefined ? {} : { args: args.args },
          ...args.engine_args === undefined ? {} : { engineArgs: args.engine_args },
        }, exec.signal)
        let timer: NodeJS.Timeout | undefined
        await Promise.race([run.whenEnded(), new Promise<void>((resolve) => { timer = setTimeout(resolve, STARTUP_LOG_WINDOW_MS) })])
        clearTimeout(timer)
        exec.signal.throwIfAborted()
        const view = run.view()
        const issues = run.logs.filter(entry => isErrorEntry(entry) || entry.level === 'warning').map(toolLogEntry)
        session.digestCursor = Math.max(session.digestCursor, run.logs.lastSeq)
        if (run.terminal) {
          const listed = issues.slice(0, STARTUP_ENTRIES).map(formatLogEntry).join('\n')
          throw new Error(`The game did not keep running (${view.phase}).${view.message === undefined ? '' : `\n${view.message}`}${listed === '' ? '' : `\nErrors and warnings:\n${listed}`}`)
        }
        // A started run that has not ended connected once, so the game reported its window, renderer, and version.
        return {
          runId: view.runId,
          phase: view.phase,
          projectDir: view.projectDir,
          ...view.projectName === undefined ? {} : { projectName: view.projectName },
          ...view.scene === undefined ? {} : { scene: view.scene },
          width: view.width as number,
          height: view.height as number,
          renderer: view.renderer as string,
          godot: run.godotVersion as string,
          windowless: view.windowless,
          muted: view.muted,
          ...view.launch.web === true ? { web: true } : {},
          ...view.launch.scale === undefined ? {} : { scale: view.launch.scale },
          ...view.launch.args === undefined ? {} : { args: [...view.launch.args] },
          ...view.launch.engineArgs === undefined ? {} : { engineArgs: [...view.launch.engineArgs] },
          issues: issues.slice(0, STARTUP_ENTRIES),
          moreIssues: Math.max(0, issues.length - STARTUP_ENTRIES),
        }
      })
    },
  }), defineTool({
    name: 'godot_stop',
    description: 'Stop the running game.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { stopped: BOOLEAN, ...DIGEST_SCHEMA } },
      render: (_args, value) => textResult(value.stopped ? 'Stopped the game.' : 'No game was running.', formatDigest(value)),
    },
    async execute(_args, exec) {
      return invoke(host, exec, async (_agent, session) => {
        const running = session.run !== undefined && !session.run.terminal
        await host.sessions.stop(session)
        return { stopped: running }
      })
    },
  }), defineTool({
    name: 'godot_screenshot',
    description: 'Capture the running game\'s window as an image, or a region of it at the window\'s own pixels, to see small detail such as faces or text. '
      + 'Mouse coordinates for godot_input refer to the pixels of the latest screenshot. To see the game larger than its window, or from another camera, use godot_view.',
    parameters: {
      max_width: { type: 'integer', description: `Largest image width in pixels. Default: ${SCREENSHOT_WIDTH}.` },
      region: {
        type: 'object',
        additionalProperties: false,
        properties: { x: INTEGER, y: INTEGER, width: INTEGER, height: INTEGER },
        description: `Capture only this rectangle: x and y of its top left corner, width, and height. A region narrower than ${REGION_MIN_WIDTH} px grows by a whole factor, each window pixel a square.`,
      },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of region: pixels of the latest screenshot, or of the game window. Default: screenshot.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ...SCREENSHOT_PROPERTIES, ...DIGEST_SCHEMA } },
      render: (_args, value) => [...textResult(describeScreenshot(value), formatDigest(value)), ...screenshotBlocks(value)],
    },
    async execute(args, exec) {
      const maxWidth = boundedInteger(args.max_width, 'max_width', SCREENSHOT_WIDTH, 64, 4096)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        const region = args.region === undefined ? undefined : windowRegion(args.region, args.coordinate_space ?? 'screenshot', session, run, maxWidth)
        return captureScreenshot(await surface.screenshots(exec, agent), session, run, maxWidth, exec.signal, region)
      })
    },
  }), defineTool({
    name: 'godot_input',
    description: 'Send input events to the running game, in order: keys, typed text, mouse buttons and motion, input map actions, and joypad events. '
      + 'An event { "wait": seconds } pauses the sequence. A press stays down until its release event or until its hold time ends. '
      + 'Mouse coordinates are pixels of the latest godot_screenshot unless coordinate_space is "window".',
    parameters: {
      events: { type: 'array', required: true, items: EVENT_SCHEMA, description: `Events in order, at most ${MAX_INPUT_EVENTS}.` },
      screenshot: { type: 'boolean', description: 'Capture a screenshot after the events.' },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of x, y, dx, dy. Default: screenshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          events: INTEGER,
          frames: INTEGER,
          seconds: NUMBER,
          frame: INTEGER,
          timedOut: BOOLEAN,
          screenshot: SCREENSHOT_SCHEMA,
          screenshotError: { type: 'string' },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => [
        ...textResult(describeInput(value), describeOutcome(value, 'the events'), formatDigest(value)),
        ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
      ],
    },
    async execute(args, exec) {
      const events = parseInputEvents(args.events, MAX_INPUT_EVENTS)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        let delivered = events
        if (args.coordinate_space !== 'window' && hasPointerEvents(events)) {
          const frame = session.screenshot
          if (frame === undefined || frame.runId !== run.id) {
            throw new Error('Mouse coordinates are screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
          }
          delivered = screenshotToWindow(events, frame)
        }
        const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
        const reply = await run.input(delivered, exec.signal)
        return {
          events: reply.events,
          frames: reply.frames,
          seconds: reply.seconds,
          frame: reply.frame,
          timedOut: reply.timedOut,
          ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
        }
      })
    },
  }), defineTool({
    name: 'godot_wait',
    description: 'Let the running game advance: seconds of unpaused game time, or a number of frames. Optionally capture a screenshot afterwards.',
    parameters: {
      seconds: { type: 'number', description: 'Seconds of game time.' },
      frames: { type: 'integer', description: 'Frames, instead of seconds.' },
      screenshot: { type: 'boolean', description: 'Capture a screenshot afterwards.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frames: INTEGER,
          seconds: NUMBER,
          frame: INTEGER,
          paused: BOOLEAN,
          timedOut: BOOLEAN,
          screenshot: SCREENSHOT_SCHEMA,
          screenshotError: { type: 'string' },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        const state = `the game is at frame ${value.frame}${value.paused ? ' and paused' : ''}`
        const summary = value.timedOut
          ? `The wait ended at its real-time limit after ${value.seconds.toFixed(2)} s of game time (${value.frames} frames); ${state}. Game time passes only while the game runs unpaused.`
          : `Waited ${value.frames} frames (${value.seconds.toFixed(2)} s of game time); ${state}.`
        return [
          ...textResult(summary, describeOutcome(value, 'the wait'), formatDigest(value)),
          ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
        ]
      },
    },
    async execute(args, exec) {
      if ((args.seconds === undefined) === (args.frames === undefined)) throw new Error('Give either seconds or frames.')
      if (args.seconds !== undefined && !(args.seconds > 0)) throw new Error('seconds must be positive.')
      const frames = args.frames === undefined ? undefined : boundedInteger(args.frames, 'frames', 1, 1, 100_000)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        if (frames === undefined && run.view().phase === 'paused') {
          throw new Error('The game is paused, so game time does not advance; resume it with godot_control, or wait frames instead.')
        }
        const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
        const reply = await run.wait(frames === undefined ? { seconds: args.seconds as number } : { frames }, exec.signal)
        return {
          frames: reply.frames,
          seconds: reply.seconds,
          frame: reply.frame,
          paused: reply.paused,
          timedOut: reply.timedOut,
          ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
        }
      })
    },
  }), defineTool({
    name: 'godot_view',
    description: 'Draw the running game\'s 3D world from your own camera at any size, without changing its window or camera, to judge faces, materials, '
      + 'and animation up close as the game draws them: its shaders, lights, and current pose. Frame a node (or one of its bones, such as Head) from an angle, '
      + 'place the camera yourself, or omit both for the game camera\'s view at the size you ask. asset draws a scene or model alone as the game imports '
      + 'it, its scripts running, optionally posed in an animation.',
    parameters: {
      node: { type: 'string', description: 'Node path of a 3D node to frame, such as /root/Main/Zombie.' },
      asset: { type: 'string', description: 'res:// path of a scene or model (.tscn, .glb, .fbx, .blend, …) to draw alone, instead of node.' },
      bone: { type: 'string', description: 'Frame this Skeleton3D bone of the subject, such as Head.' },
      yaw: { type: 'number', description: 'Degrees around the subject\'s heading: 0 looks at its +Z side (the front of most imported models), 180 at its back. Default: 30.' },
      pitch: { type: 'number', description: 'Degrees above the subject. Default: 10.' },
      distance: { type: 'number', description: 'Multiplier of the distance that fits the subject: below 1 is closer. Default: 1.' },
      radius: { type: 'number', description: 'Meters around the subject\'s center to fit. Default: its bounds, or 0.25 around a bone.' },
      camera: {
        type: 'object',
        additionalProperties: false,
        properties: {
          position: { type: 'array', items: { type: 'number' }, required: true, description: '[x, y, z] of the camera in world coordinates.' },
          target: { type: 'array', items: { type: 'number' }, required: true, description: '[x, y, z] the camera looks at.' },
        },
        description: 'Place the camera yourself.',
      },
      fov: { type: 'number', description: 'Vertical field of view in degrees. Default: the game camera\'s, or 35 for an asset.' },
      isolate: { type: 'boolean', description: 'node: draw it alone, lit as the game lights it.' },
      lighting: { type: 'string', enum: ['studio', 'game'], description: 'asset: a neutral studio, or the game\'s sky and sun. Default: studio.' },
      animation: { type: 'string', description: 'asset: an AnimationPlayer animation to pose it in.' },
      time: { type: 'number', description: 'asset: seconds into the animation. Default: 0.' },
      width: { type: 'integer', description: `Image width in pixels, up to ${VIEW_SIZE.max}. Default: ${VIEW_SIZE.width}.` },
      height: { type: 'integer', description: `Image height in pixels, up to ${VIEW_SIZE.max}. Default: ${VIEW_SIZE.height}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: INTEGER,
          height: INTEGER,
          frame: INTEGER,
          paused: BOOLEAN,
          camera: { type: 'json', required: true, description: 'The camera that drew the view: position, direction, and vertical fov.' },
          subject: { type: 'json', description: 'The framed center, radius in meters, and the camera\'s distance from the center.' },
          image: IMAGE_SCHEMA,
          ...DIGEST_SCHEMA,
        },
      },
      render: (args, value) => {
        const what = args.asset ?? args.node ?? 'the game camera\'s view'
        const camera = value.camera as { position?: JsonValue; direction?: JsonValue; fov?: JsonValue }
        const lines = [`View of ${what} at frame ${value.frame}${value.paused ? ' (paused)' : ''}: ${value.width}x${value.height} px; camera at ${formatVector(camera.position) ?? '?'} looking along ${formatVector(camera.direction) ?? '?'}, fov ${typeof camera.fov === 'number' ? camera.fov.toFixed(1) : '?'}°.`]
        const subject = value.subject as { center?: JsonValue; radius?: JsonValue; distance?: JsonValue } | undefined
        if (subject !== undefined && typeof subject.radius === 'number' && typeof subject.distance === 'number') {
          lines.push(`Framed ${subject.radius.toFixed(3)} m around ${formatVector(subject.center) ?? '?'} from ${subject.distance.toFixed(3)} m.`)
        }
        return [...textResult(lines.join(' '), formatDigest(value)), ...imageBlocks(value.image)]
      },
    },
    async execute(args, exec) {
      const width = boundedInteger(args.width, 'width', VIEW_SIZE.width, 16, VIEW_SIZE.max)
      const height = boundedInteger(args.height, 'height', VIEW_SIZE.height, 16, VIEW_SIZE.max)
      if (args.asset !== undefined && args.node !== undefined) throw new Error('Give node or asset, not both.')
      const framing = [args.bone, args.yaw, args.pitch, args.distance, args.radius].some(value => value !== undefined)
      if (args.camera !== undefined && framing) {
        throw new Error('camera places the camera itself; leave out bone, yaw, pitch, distance, and radius.')
      }
      const camera = args.camera === undefined ? undefined : { position: point(args.camera.position, 'camera.position'), target: point(args.camera.target, 'camera.target') }
      if (args.isolate === true && args.node === undefined) throw new Error('isolate draws a node alone; name the node.')
      if ((args.animation !== undefined || args.time !== undefined || args.lighting !== undefined) && args.asset === undefined) {
        throw new Error('animation, time, and lighting apply to an asset; name the asset.')
      }
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        const taker = await surface.screenshots(exec, agent)
        const size = taker.fit(width, height)
        const params: ViewParams = {
          width: size.width,
          height: size.height,
          ...args.node === undefined ? {} : { node: args.node },
          ...args.asset === undefined ? {} : { asset: args.asset },
          ...args.bone === undefined ? {} : { bone: args.bone },
          ...args.yaw === undefined ? {} : { yaw: args.yaw },
          ...args.pitch === undefined ? {} : { pitch: args.pitch },
          ...args.distance === undefined ? {} : { distance: args.distance },
          ...args.radius === undefined ? {} : { radius: args.radius },
          ...camera === undefined ? {} : { camera },
          ...args.fov === undefined ? {} : { fov: args.fov },
          ...args.isolate === true ? { isolate: true } : {},
          ...args.lighting === undefined ? {} : { lighting: args.lighting },
          ...args.animation === undefined ? {} : { animation: args.animation },
          ...args.time === undefined ? {} : { time: args.time },
        }
        const drawn = await run.drawView(params, exec.signal)
        const image = await taker.store({ data: drawn.image, mediaType: 'image/png', width: drawn.meta.width, height: drawn.meta.height, name: `godot-view-${drawn.meta.frame}.png` }, exec.signal)
        return {
          width: drawn.meta.width,
          height: drawn.meta.height,
          frame: drawn.meta.frame,
          paused: drawn.meta.paused,
          camera: drawn.meta.camera,
          ...drawn.meta.subject === undefined ? {} : { subject: drawn.meta.subject },
          image,
        }
      })
    },
  }), defineTool({
    name: 'godot_record',
    description: 'Record the running game to an MP4 video (H.264) while it plays, optionally sending input events, and see a sheet of frames from '
      + 'across it to judge motion. The WASD Engine window encodes the video. For films without dropped frames, start the game with engine_args '
      + '["--fixed-fps", "30"]: the recording then captures every frame, each advancing the game by the same time, and seconds counts seconds of video.',
    parameters: {
      seconds: { type: 'number', required: true, description: `Seconds to record, from 0.5 to ${MAX_VIDEO_SECONDS}: real seconds, or seconds of video in a run with --fixed-fps.` },
      fps: { type: 'integer', description: 'Frames per second, 1 to 60. Default: 30, or the run\'s --fixed-fps rate.' },
      max_width: { type: 'integer', description: 'Largest frame width in pixels, 64 to 3840. Default: 1920.' },
      path: { type: 'string', description: '.mp4 file to save, inside the working directory or the project. Default: a new file in the project\'s recordings folder.' },
      replace: { type: 'boolean', description: 'Replace an existing file at path.' },
      events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: `Input events to send from the recording's start, as godot_input's events, at most ${MAX_INPUT_EVENTS}.` },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' mouse coordinates. Default: screenshot.' },
      sheet_frames: { type: 'integer', description: 'Frames in the returned sheet, spread from start to end, 0 to 24. Default: 12.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: STRING,
          bytes: INTEGER,
          codec: STRING,
          frames: INTEGER,
          skipped: INTEGER,
          seconds: NUMBER,
          fps: NUMBER,
          width: INTEGER,
          height: INTEGER,
          fixedFps: BOOLEAN,
          inputError: { type: 'string' },
          sheetTimes: { type: 'array', items: { type: 'number' } },
          sheet: IMAGE_OBJECT,
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        const pacing = value.fixedFps ? 'every frame advancing the game by the same time' : 'at real time'
        const skipped = value.skipped > 0 ? ` The game skipped ${value.skipped} frames because capturing fell behind; start it with --fixed-fps to keep every frame.` : ''
        const lines = [`Recorded ${value.seconds.toFixed(2)} s at ${numberText(value.fps)} fps, ${pacing}: ${value.frames} frames of ${value.width}x${value.height} px in ${value.codec}, saved to ${value.path} (${sizeText(value.bytes)}).${skipped}`]
        if (value.inputError !== undefined) lines.push(`The input events stopped at an error: ${value.inputError}`)
        if (value.sheetTimes !== undefined && value.sheetTimes.length > 0) {
          lines.push(`The sheet shows ${value.sheetTimes.length} frames left to right, top to bottom, at ${value.sheetTimes.map(time => `${time.toFixed(2)} s`).join(', ')}.`)
        }
        return [...textResult(lines.join('\n'), formatDigest(value)), ...value.sheet === undefined ? [] : imageBlocks(value.sheet)]
      },
    },
    timeoutMs: (MAX_VIDEO_SECONDS * 3 + 120) * 1000,
    async execute(args, exec) {
      if (!(args.seconds >= 0.5 && args.seconds <= MAX_VIDEO_SECONDS)) throw new Error(`seconds must be from 0.5 to ${MAX_VIDEO_SECONDS}.`)
      const maxWidth = boundedInteger(args.max_width, 'max_width', 1920, 64, 3840)
      const sheetFrames = boundedInteger(args.sheet_frames, 'sheet_frames', 12, 0, 24)
      if (args.fps !== undefined) boundedInteger(args.fps, 'fps', 30, 1, 60)
      const events = args.events === undefined ? undefined : parseInputEvents(args.events, MAX_INPUT_EVENTS)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        let delivered = events
        if (events !== undefined && args.coordinate_space !== 'window' && hasPointerEvents(events)) {
          const frame = session.screenshot
          if (frame === undefined || frame.runId !== run.id) {
            throw new Error('Mouse coordinates are screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
          }
          delivered = screenshotToWindow(events, frame)
        }
        const taker = sheetFrames > 0 ? await surface.screenshots(exec, agent) : undefined
        const fixed = fixedFps(run.view().launch.engineArgs ?? [])
        const fps = args.fps ?? (fixed === undefined ? 30 : fixed / Math.ceil(fixed / 60))
        const video = await host.record(agent, run, {
          seconds: args.seconds,
          fps,
          maxWidth,
          sheetFrames,
          replace: args.replace === true,
          ...args.path === undefined ? {} : { path: args.path },
          ...delivered === undefined ? {} : { events: delivered },
        }, exec.signal)
        const sheet = taker === undefined || video.sheet === undefined
          ? undefined
          : await taker.store({ data: video.sheet.data, mediaType: 'image/jpeg', width: video.sheet.width, height: video.sheet.height, name: 'godot-recording-sheet.jpg' }, exec.signal)
        return {
          path: video.path,
          bytes: video.bytes,
          codec: video.codec,
          frames: video.frames,
          skipped: video.skipped,
          seconds: video.seconds,
          fps: video.fps,
          width: video.width,
          height: video.height,
          fixedFps: video.fixedFps,
          ...video.inputError === undefined ? {} : { inputError: video.inputError },
          ...video.sheet === undefined ? {} : { sheetTimes: [...video.sheet.times] },
          ...sheet === undefined ? {} : { sheet },
        }
      })
    },
  }), defineTool({
    name: 'godot_control',
    description: 'Pause or resume the running game, or step it: step runs a number of frames and pauses again.',
    parameters: {
      action: { type: 'string', enum: ['pause', 'resume', 'step'], required: true },
      frames: { type: 'integer', description: 'step: frames to run. Default: 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paused: BOOLEAN,
          frame: INTEGER,
          frames: { type: 'integer' },
          endedEarly: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => textResult(
        `${describeStep(value)}The game is ${value.paused ? 'paused' : 'running'} at frame ${value.frame}.`,
        formatDigest(value),
      ),
    },
    async execute(args, exec) {
      const frames = boundedInteger(args.frames, 'frames', 1, 1, 100_000)
      return invoke(host, exec, async (_agent, session) => {
        const run = requireRunning(session)
        if (args.action === 'step') {
          const reply = await run.step(frames, exec.signal)
          return { paused: reply.paused, frame: reply.frame, frames: reply.frames, endedEarly: reply.cancelled, timedOut: reply.timedOut }
        }
        return run.setPaused(args.action === 'pause', exec.signal)
      })
    },
  }), defineTool({
    name: 'godot_eval',
    description: 'Evaluate a Godot Expression in the running game and return its value, for example scene.get_node("Player").position, '
      + 'or run GDScript code there with code. In an expression, the names scene (the current scene), root, tree, the engine singletons '
      + 'such as Input, OS, and ResourceLoader, and the autoloads are defined; method calls without a base run on node, or on the current scene. '
      + 'code runs as the body of a function, so it may declare variables, loop, use lambdas and await, and set up a capture or test '
      + 'without changing the game\'s files; it returns its value with return, and a single expression returns its value.',
    parameters: {
      expression: { type: 'string', description: 'A Godot Expression. Give expression or code.' },
      code: {
        type: 'string',
        description: 'GDScript statements, indented as a function body; tree, root, scene (the current scene), and node (the object at the node path, else the current scene) are defined, get_tree() works, and await waits for signals such as get_tree().process_frame.',
      },
      node: { type: 'string', description: 'Node path of the base object, for example /root/Main/Player.' },
      timeout_seconds: {
        type: 'number',
        description: `code: real seconds to wait for code that awaits, from ${CODE_SECONDS.min} to ${CODE_SECONDS.max}; the code keeps running after them. Default: ${CODE_SECONDS.default}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'json', required: true }, valueType: STRING, ...DIGEST_SCHEMA },
      },
      render: (_args, value) => textResult(`${value.valueType}: ${JSON.stringify(value.value)}`, formatDigest(value)),
    },
    timeoutMs: (CODE_SECONDS.max + 60) * 1000,
    async execute(args, exec) {
      if ((args.expression === undefined) === (args.code === undefined)) throw new Error('Give either expression or code.')
      const source = (args.expression ?? args.code) as string
      if (source.trim() === '') throw new Error(`${args.code === undefined ? 'expression' : 'code'} must not be empty.`)
      const seconds = args.timeout_seconds ?? CODE_SECONDS.default
      if (!(seconds >= CODE_SECONDS.min && seconds <= CODE_SECONDS.max)) {
        throw new Error(`timeout_seconds must be from ${CODE_SECONDS.min} to ${CODE_SECONDS.max}.`)
      }
      return invoke(host, exec, async (_agent, session) => {
        const run = requireRunning(session)
        const reply = args.code === undefined
          ? await run.evaluate(source, args.node, exec.signal)
          : await run.runCode(source, args.node, seconds * 1000, exec.signal)
        return { value: reply.value, valueType: reply.valueType }
      })
    },
  }), defineTool({
    name: 'godot_scene_tree',
    description: 'Describe the running game\'s scene tree: node names, classes, scripts, positions, sizes, visibility, and label text.',
    parameters: {
      node: { type: 'string', description: 'Node path to start from. Default: the current scene.' },
      depth: { type: 'integer', description: 'Levels below the start node. Default: 6.' },
      max_nodes: { type: 'integer', description: 'Most nodes described. Default: 400.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tree: { type: 'json', required: true }, truncated: BOOLEAN, ...DIGEST_SCHEMA },
      },
      render: (_args, value) => textResult(
        formatTree(value.tree),
        value.truncated ? 'The node limit cut the tree; narrow it with node or depth.' : '',
        formatDigest(value),
      ),
    },
    async execute(args, exec) {
      const depth = boundedInteger(args.depth, 'depth', 6, 0, 64)
      const maxNodes = boundedInteger(args.max_nodes, 'max_nodes', 400, 1, 5000)
      return invoke(host, exec, async (_agent, session) => {
        const reply = await requireRunning(session).tree(args.node, depth, maxNodes, exec.signal)
        return { tree: reply.tree, truncated: reply.truncated }
      })
    },
  }), defineTool({
    name: 'godot_performance',
    description: 'Measure the running game\'s performance over seconds of real time: frame rate and frame time percentiles, '
      + 'milliseconds per frame in physics, scripts, and drawing, GPU time, draw calls, memory, object and orphan node counts, '
      + 'physics bodies, pipeline compilations, the most common node classes and scripts, and custom Performance monitors. '
      + 'Then, for as many seconds again, it profiles the game\'s scripts: milliseconds per frame of each script and its costliest '
      + 'functions, with the engine methods they call.',
    parameters: {
      seconds: {
        type: 'number',
        description: `Real seconds to measure, from ${PERFORMANCE_SECONDS.min} to ${PERFORMANCE_SECONDS.max}. Default: ${PERFORMANCE_SECONDS.default}.`,
      },
      scripts: { type: 'boolean', description: 'Profile the scripts after measuring the frames. Default: true.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ...PERFORMANCE_PROPERTIES, ...DIGEST_SCHEMA } },
      render: (args, value) => textResult(formatPerformance(value, args.scripts !== false), formatDigest(value)),
    },
    async execute(args, exec) {
      const seconds = args.seconds ?? PERFORMANCE_SECONDS.default
      if (!(seconds >= PERFORMANCE_SECONDS.min && seconds <= PERFORMANCE_SECONDS.max)) {
        throw new Error(`seconds must be from ${PERFORMANCE_SECONDS.min} to ${PERFORMANCE_SECONDS.max}.`)
      }
      return invoke(host, exec, async (_agent, session) => {
        const run = requireRunning(session)
        const sample = await run.performance(seconds, args.scripts === false ? 0 : seconds, exec.signal)
        return summarizePerformance(sample, run.view().windowless)
      })
    },
  }), defineTool({
    name: 'godot_audio',
    description: 'Listen to the running game: capture its audio mix, the Master bus as players hear it, for seconds of real time while '
      + 'optional input events play, then report levels, loudness, clipping, silence, spectrum, when sounds start and stop, which '
      + 'audio players played on which buses, and the bus volumes and peaks, with a waveform and spectrogram picture. '
      + 'A muted run mixes its audio as usual, so it can be captured too.',
    parameters: {
      seconds: {
        type: 'number',
        description: `Seconds of audio, from ${AUDIO_SECONDS.min} to ${AUDIO_SECONDS.max}. Default: ${AUDIO_SECONDS.default}.`,
      },
      events: {
        type: 'array',
        items: EVENT_SCHEMA,
        description: `Input events to play from the capture's start, as godot_input takes them, at most ${MAX_INPUT_EVENTS}.`,
      },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' x, y, dx, dy. Default: screenshot.' },
      path: { type: 'string', description: `Save the capture as a 16-bit .wav file at this path, ${wording.audioPath}.` },
      replace: { type: 'boolean', description: 'Overwrite the file at path when it exists. Default: false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...AUDIO_PROPERTIES,
          savedPath: { type: 'string' },
          picture: IMAGE_OBJECT,
          pictureText: { type: 'string' },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => [
        ...textResult(
          describeAudio(value).join('\n'),
          value.savedPath === undefined ? '' : `Saved the capture to ${value.savedPath}.`,
          value.pictureText ?? '',
          formatDigest(value),
        ),
        ...value.picture === undefined ? [] : imageBlocks(value.picture),
      ],
    },
    async execute(args, exec) {
      const seconds = args.seconds ?? AUDIO_SECONDS.default
      if (!(seconds >= AUDIO_SECONDS.min && seconds <= AUDIO_SECONDS.max)) {
        throw new Error(`seconds must be from ${AUDIO_SECONDS.min} to ${AUDIO_SECONDS.max}.`)
      }
      if (args.path !== undefined && extname(args.path).toLowerCase() !== '.wav') throw new Error('path must end in .wav.')
      const events = args.events === undefined ? undefined : parseInputEvents(args.events, MAX_INPUT_EVENTS)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        let delivered = events
        if (events !== undefined && args.coordinate_space !== 'window' && hasPointerEvents(events)) {
          const frame = session.screenshot
          if (frame === undefined || frame.runId !== run.id) {
            throw new Error('Mouse coordinates are screenshot pixels, but this game has no screenshot yet; call godot_screenshot first, or pass coordinate_space "window".')
          }
          delivered = screenshotToWindow(events, frame)
        }
        // The target is checked before the capture, so a refused path wastes no capture.
        const target = args.path === undefined ? undefined : await host.resolvePath(agent, args.path, exec.signal)
        if (target !== undefined) await refuseExisting(target, args.replace === true)
        const pictures = await surface.pictures(exec, agent)
        const { meta, samples } = await captureWithInput(run, seconds, delivered, exec.signal)
        const audio: AudioSamples = {
          sampleRate: meta.sampleRate, channels: 2, frames: meta.frames,
          samples: applyMasterVolume(samples.subarray(0, meta.frames * 2), meta.masterVolumes),
        }
        const summary = summarizeAudio(meta, audio, analyzeAudio(audio))
        if (target !== undefined) await writeFileAtomic(target, encodeWav(audio), { mode: 0o644 })
        if (pictures === undefined || audio.frames === 0) return { ...summary, ...target === undefined ? {} : { savedPath: target } }
        const { image, layout } = drawAudioImage(audio)
        const picture = await pictures.store({
          data: encodePng(image), mediaType: 'image/png', width: image.width, height: image.height, name: `godot-audio-${String(meta.frame)}.png`,
        }, exec.signal)
        return { ...summary, ...target === undefined ? {} : { savedPath: target }, picture, pictureText: describeAudioImage(layout) }
      })
    },
  }), defineTool({
    name: 'godot_logs',
    description: 'Read the game\'s log: printed output, errors, and warnings from the game, the engine, and the import step. '
      + wording.logsDefault,
    parameters: {
      since: { type: 'integer', description: 'Return entries after this cursor, the next value of an earlier result. 0 reads from the start.' },
      levels: { type: 'array', items: { type: 'string', enum: LEVELS }, description: 'Only these levels.' },
      limit: { type: 'integer', description: 'Most entries. Default: 200.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', items: ENTRY_SCHEMA, required: true },
          next: INTEGER,
          missed: BOOLEAN,
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => textResult(
        value.entries.length === 0 ? 'No new log entries.' : value.entries.map(formatLogEntry).join('\n'),
        value.missed ? 'Older entries after the cursor were discarded because the log is full.' : '',
        `Next cursor: ${value.next}.`,
        formatDigest(value),
      ),
    },
    async execute(args, exec) {
      const limit = boundedInteger(args.limit, 'limit', 200, 1, 1000)
      const levels = args.levels === undefined ? undefined : new Set<GodotLogLevel>(args.levels)
      return invoke(host, exec, (_agent, session) => {
        const run = session.run
        if (run === undefined) throw new Error('No game has run in this Session; call godot_run first.')
        const page = run.logs.after(args.since ?? session.logCursor, limit, entry => levels === undefined || levels.has(entry.level))
        // Keep the listed entries within the text budget; the cursor stops at the last one listed.
        const entries: ToolLogEntry[] = []
        let next = page.next
        let length = 0
        for (const entry of page.entries) {
          const reported = toolLogEntry(entry)
          length += formatLogEntry(reported).length + 1
          const last = entries.at(-1)
          if (last !== undefined && length > TEXT_BUDGET - 500) {
            next = last.seq
            break
          }
          entries.push(reported)
        }
        session.logCursor = next
        session.digestCursor = Math.max(session.digestCursor, next)
        return { entries, next, missed: page.missed }
      })
    },
  }), defineTool({
    name: 'godot_check',
    description: `Check GDScript files for parse and load errors without running the game. Checks paths (${wording.checkPaths}), or every .gd file of the project, at most 400.`,
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Scripts or folders to check. Default: the whole project.' },
      project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the running game\'s project, else the nearest one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          checked: INTEGER,
          total: INTEGER,
          importWarning: { type: 'string' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: STRING,
                issues: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      level: STRING,
                      file: STRING,
                      line: { type: 'integer' },
                      message: STRING,
                    },
                  },
                },
              },
            },
          },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        const scope = value.checked < value.total ? `${value.checked} of ${value.total}` : `${value.checked}`
        const problems = value.files.flatMap(file => file.issues.map(issue => `[${issue.level}] ${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}: ${clip(issue.message, MESSAGE_CHARS)}`))
        const summary = value.files.length === 0 ? `Checked ${scope} scripts in ${value.projectDir}: no errors.` : `Checked ${scope} scripts in ${value.projectDir}; ${value.files.length} have problems:`
        return textResult([...value.importWarning === undefined ? [] : [value.importWarning], summary, ...problems].join('\n'), formatDigest(value))
      },
    },
    async execute(args, exec) {
      return invoke(host, exec, async (agent) => {
        const report = await host.check(agent, {
          ...args.project === undefined ? {} : { project: args.project },
          ...args.paths === undefined ? {} : { paths: args.paths },
        }, exec.signal)
        return {
          projectDir: report.projectDir,
          checked: report.scripts.length,
          total: report.total,
          ...report.importWarning === undefined ? {} : { importWarning: report.importWarning },
          files: report.scripts
            .filter(script => script.issues.length > 0)
            .map(script => ({ path: script.path, issues: [...script.issues] })),
        }
      })
    },
  }), defineTool({
    name: 'godot_script',
    description: `Run a GDScript that extends SceneTree or MainLoop against the project in a headless Godot, without running the game, and report the end of what it printed: test runners such as GUT's or GdUnit4's, build or generator scripts, and measurements, which runs repeats at once with other arguments and fixed_fps makes repeatable. The script is ${wording.scriptPath}; args reach it after --, where OS.get_cmdline_user_args() reads them. Each run gets a folder with stdout.log, stderr.log, and files/, which the environment variable ${OUTPUT_DIR_VARIABLE} names: write results there, and the report lists them. Runs share the project, so they should write only there; with runs, each also gets its own user:// folder. It imports the project first, as godot_run does. The script must quit itself with quit(); the built-in Godot does not pass on its exit code, so judge the result by what it prints or writes.`,
    parameters: {
      script: { type: 'string', required: true, description: 'The script to run, such as res://addons/gut/gut_cmdln.gd.' },
      args: { type: 'array', items: { type: 'string' }, description: 'User arguments passed after --; with runs, before each run\'s own. Default: none.' },
      runs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments of this run, after args.' },
            name: { type: 'string', description: 'Name in the run\'s folder and the report.' },
          },
        },
        description: `One run per entry, 1 to ${MAX_SCRIPT_RUNS}, as many at once as this computer allows, all within ${MAX_SCRIPT_CALL_SECONDS / 60} minutes. Default: one run with args.`,
      },
      fixed_fps: {
        type: 'integer',
        description: `Game time per frame is 1/fixed_fps s however long frames take (Godot's --fixed-fps), so runs repeat exactly and finish as fast as they can; 1 to ${MAX_FIXED_FPS}. Default: real time.`,
      },
      exclusive: {
        type: 'boolean',
        description: 'Run the runs one at a time while no other godot_script run, check, or export runs, for timing measurements. Default: false.',
      },
      timeout_seconds: { type: 'integer', description: `Time limit of each run in seconds, from 1 to ${MAX_SCRIPT_SECONDS}. Default: ${DEFAULT_SCRIPT_SECONDS}.` },
      project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the running game\'s project, else the nearest one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          script: STRING,
          exitCode: { type: 'integer', description: 'Exit code of the Godot runner: 0 once the script quit, another value when the runner itself failed; absent when a signal or the time limit ended it.' },
          timedOut: { type: 'boolean' },
          durationMs: INTEGER,
          output: { type: 'string' },
          omittedLines: { type: 'integer' },
          issues: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
          },
          totalIssues: { type: 'integer' },
          folder: { type: 'string', description: 'Folder of the run, for a call without runs.' },
          files: { type: 'array', items: { type: 'string' } },
          totalFiles: { type: 'integer' },
          resultsDir: { type: 'string', description: 'Folder of a call with runs: summary.json and one folder per run.' },
          fixedFps: { type: 'integer' },
          parallel: { type: 'integer' },
          importIssues: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
          },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                args: { type: 'array', items: { type: 'string' }, required: true },
                folder: STRING,
                status: { type: 'string', enum: ['finished', 'timed-out', 'ended', 'not-started'], required: true },
                exitCode: { type: 'integer' },
                reason: { type: 'string' },
                durationMs: INTEGER,
                files: { type: 'array', items: { type: 'string' }, required: true },
                totalFiles: INTEGER,
                issues: {
                  type: 'array',
                  required: true,
                  items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
                },
                totalIssues: INTEGER,
                lastLine: { type: 'string' },
              },
            },
          },
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        if (value.runs !== undefined) return textResult(formatScriptRuns(value.script, value), formatDigest(value))
        const seconds = (value.durationMs / 1000).toFixed(1)
        const ended = value.timedOut === true
          ? `did not finish within its time limit and was stopped after ${seconds} s.`
          : value.exitCode === undefined
            ? 'was ended by a signal.'
            : value.exitCode === 0
              ? `finished after ${seconds} s. The built-in Godot does not report the script's own exit code; read the result from its output.`
              : `could not run: the Godot runner failed with exit code ${value.exitCode} after ${seconds} s.`
        const lines = [`${value.script} ${ended}`]
        if (value.folder !== undefined) lines.push(describeRunFolder(value.folder, value.files ?? [], value.totalFiles ?? 0))
        const issues = value.issues ?? []
        if (issues.length > 0) lines.push(`Engine errors (${value.totalIssues ?? issues.length}):`, ...issues.map(formatEngineIssue))
        const output = value.output ?? ''
        const omitted = value.omittedLines ?? 0
        lines.push(output === '' ? 'It printed nothing.' : `${omitted > 0 ? `Output (last lines; ${omitted} earlier lines left out):` : 'Output:'}\n${output}`)
        return textResult(lines.join('\n'), formatDigest(value))
      },
    },
    timeoutMs: (MAX_SCRIPT_CALL_SECONDS + 600) * 1000,
    async execute(args, exec) {
      return invoke(host, exec, async (agent) => {
        const report = await host.script(agent, {
          script: args.script,
          ...args.project === undefined ? {} : { project: args.project },
          ...args.args === undefined ? {} : { args: args.args },
          ...args.timeout_seconds === undefined ? {} : { timeoutSeconds: args.timeout_seconds },
          ...args.runs === undefined ? {} : { runs: args.runs },
          ...args.fixed_fps === undefined ? {} : { fixedFps: args.fixed_fps },
          ...args.exclusive === undefined ? {} : { exclusive: args.exclusive },
        }, exec.signal)
        if ('runs' in report) {
          return {
            projectDir: report.projectDir,
            script: report.script,
            durationMs: report.durationMs,
            resultsDir: report.resultsDir,
            ...report.fixedFps === undefined ? {} : { fixedFps: report.fixedFps },
            parallel: report.parallel,
            importIssues: report.importIssues.map(issueValue),
            runs: report.runs.map(runValue),
          }
        }
        return {
          projectDir: report.projectDir,
          script: report.script,
          ...report.exitCode === null ? {} : { exitCode: report.exitCode },
          timedOut: report.timedOut,
          durationMs: report.durationMs,
          output: report.output,
          omittedLines: report.omittedLines,
          issues: report.issues.map(issueValue),
          totalIssues: report.totalIssues,
          folder: report.folder,
          files: [...report.files],
          totalFiles: report.totalFiles,
        }
      })
    },
  })]
}

/** An engine issue as a result value holds it. */
interface IssueValue {
  readonly level: string
  readonly message: string
  readonly file?: string
  readonly line?: number
}

/** A run of a call with runs as a result value holds it. */
interface RunValue {
  readonly name?: string
  readonly args: string[]
  readonly folder: string
  readonly status: ScriptRunResult['status']
  readonly exitCode?: number
  readonly reason?: string
  readonly durationMs: number
  readonly files: string[]
  readonly totalFiles: number
  readonly issues: IssueValue[]
  readonly totalIssues: number
  readonly lastLine?: string
}

/** An engine issue as a result value holds it. */
function issueValue(issue: EngineIssue): IssueValue {
  return {
    level: issue.level,
    message: issue.message,
    ...issue.file === undefined ? {} : { file: issue.file },
    ...issue.line === undefined ? {} : { line: issue.line },
  }
}

/** A run of a call with runs as a result value holds it. */
function runValue(run: ScriptRunResult): RunValue {
  return {
    ...run.name === undefined ? {} : { name: run.name },
    args: [...run.args],
    folder: run.folder,
    status: run.status,
    ...run.exitCode === undefined ? {} : { exitCode: run.exitCode },
    ...run.reason === undefined ? {} : { reason: run.reason },
    durationMs: run.durationMs,
    files: [...run.files],
    totalFiles: run.totalFiles,
    issues: run.issues.map(issueValue),
    totalIssues: run.totalIssues,
    ...run.lastLine === undefined ? {} : { lastLine: run.lastLine },
  }
}

/** One engine issue as a line of a script result. */
function formatEngineIssue(issue: IssueValue): string {
  return `[${issue.level}] ${issue.file === undefined ? '' : `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}: `}${clip(issue.message, MESSAGE_CHARS)}`
}

/** Most file names that a script result names for one run. */
const NAMED_RUN_FILES = 5

/** The files a run wrote, as a phrase: the first few names, then how many more. */
function describeFiles(files: readonly string[], total: number): string {
  if (total === 0) return 'no files'
  const named = files.slice(0, NAMED_RUN_FILES).join(', ')
  return total > NAMED_RUN_FILES ? `${named}, and ${total - NAMED_RUN_FILES} more` : named
}

/**
 * Describe the folder of a call's only run.
 * @param folder - absolute folder.
 * @param files - files the script wrote to `files/`, relative to it.
 * @param total - files in `files/` in all.
 * @returns one line.
 */
function describeRunFolder(folder: string, files: readonly string[], total: number): string {
  return `Its folder ${folder} keeps stdout.log and stderr.log; files the script wrote to ${OUTPUT_DIR_VARIABLE} (files/): ${describeFiles(files, total)}.`
}

/** The phrase of a run's end in a call with runs. */
function describeRunEnd(run: Pick<RunValue, 'durationMs' | 'exitCode' | 'reason'> & { readonly status: string }): string {
  const seconds = (run.durationMs / 1000).toFixed(1)
  switch (run.status) {
    case 'finished':
      return `finished in ${seconds} s`
    case 'timed-out':
      return `timed out after ${seconds} s`
    case 'not-started':
      return `did not start: ${run.reason ?? 'unknown reason'}`
    default:
      return run.exitCode === undefined ? `was ended by a signal after ${seconds} s` : `failed: the Godot runner exited with code ${run.exitCode} after ${seconds} s`
  }
}

/**
 * Format the result of a call with runs: a summary line, the call's folder, the import errors, and one line per run.
 * @param script - `res://` path of the script.
 * @param value - the result value.
 * @returns the text.
 */
function formatScriptRuns(script: string, value: {
  readonly durationMs: number
  readonly resultsDir?: string
  readonly fixedFps?: number
  readonly parallel?: number
  readonly importIssues?: readonly IssueValue[]
  readonly runs?: ReadonlyArray<Omit<RunValue, 'status'> & { readonly status: string }>
}): string {
  const runs = value.runs ?? []
  const counts = new Map<string, number>()
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  const tally = [
    ['finished', 'finished'], ['timed-out', 'timed out'], ['ended', 'failed'], ['not-started', 'did not start'],
  ].flatMap(([status, words]) => counts.has(status as string) ? [`${String(counts.get(status as string))} ${words as string}`] : []).join(', ')
  const pace = value.fixedFps === undefined ? '' : ` at a fixed ${value.fixedFps} FPS`
  const lines = [
    `Ran ${script} ${runs.length === 1 ? 'once' : `${runs.length} times, up to ${value.parallel ?? 1} at a time`}${pace}, in ${(value.durationMs / 1000).toFixed(1)} s: ${tally}.`,
    `The call's folder ${value.resultsDir ?? '(unknown)'} holds summary.json, with every run's details, and one folder per run with stdout.log, stderr.log, files/ (its ${OUTPUT_DIR_VARIABLE}), and home/, which holds its user:// folder.`,
  ]
  const importIssues = value.importIssues ?? []
  if (importIssues.length > 0) lines.push('Errors of the import before the runs:', ...importIssues.map(formatEngineIssue))
  runs.forEach((run, index) => {
    const parts = [`${String(index + 1)}${run.name === undefined ? '' : ` ${run.name}`}: ${describeRunEnd(run)}`]
    if (run.status !== 'not-started') parts.push(`files: ${describeFiles(run.files, run.totalFiles)}`)
    const first = run.issues[0]
    if (first !== undefined) parts.push(`${run.totalIssues} engine error${run.totalIssues === 1 ? '' : 's'}, first: ${formatEngineIssue(first)}`)
    if (run.lastLine !== undefined) parts.push(`last line: ${run.lastLine}`)
    lines.push(parts.join('; '))
  })
  return lines.join('\n')
}

/** A scene tree node as the harness describes it. */
interface SceneNode {
  readonly name?: JsonValue
  readonly class?: JsonValue
  readonly script?: JsonValue
  readonly position?: JsonValue
  readonly size?: JsonValue
  readonly visible?: JsonValue
  readonly text?: JsonValue
  readonly processDisabled?: JsonValue
  readonly childCount?: JsonValue
  readonly children?: JsonValue
}

function label(value: JsonValue | undefined): string {
  if (value === undefined) return '?'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isNode(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatVector(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'number')) return undefined
  return `(${value.map(item => Number(item.toFixed(2))).join(', ')})`
}

/**
 * Format a scene tree description as an indented outline.
 * @param tree - root node from the harness.
 * @returns one line per node.
 */
export function formatTree(tree: JsonValue): string {
  const lines: string[] = []
  const visit = (value: JsonValue, depth: number): void => {
    if (!isNode(value)) return
    const node: SceneNode = value
    const position = formatVector(node.position)
    const size = formatVector(node.size)
    const parts = [
      `${'  '.repeat(depth)}${label(node.name)} (${label(node.class)})`,
      typeof node.script === 'string' ? node.script : '',
      position === undefined ? '' : `position ${position}`,
      size === undefined ? '' : `size ${size}`,
      node.visible === false ? 'hidden' : '',
      typeof node.text === 'string' ? `text ${JSON.stringify(clip(node.text, 80))}` : '',
      node.processDisabled === true ? 'processing disabled' : '',
      typeof node.childCount === 'number' && !Array.isArray(node.children) ? `${node.childCount} children not listed` : '',
    ]
    lines.push(parts.filter(part => part !== '').join(' '))
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1)
  }
  visit(tree, 0)
  return lines.join('\n')
}
