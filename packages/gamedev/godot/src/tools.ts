/**
 * The model-facing Godot tools. Every tool runs against the calling Session's game. Each result reports the
 * error-level entries the run logged since the Session's previous Godot tool call (up to
 * {@link DIGEST_ENTRIES}, then a count), and its text stays within {@link TEXT_BUDGET} characters; complete
 * values remain available to programs. One set of definitions serves one {@link GodotToolSurface}: the Session's
 * own agent, whose screenshots become attachments for its model, or agents that reach the tools over WASD Engine's
 * MCP server, whose screenshots travel as image bytes.
 * @module @deepseek-ai/dsh-godot/src/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CheckReport, CheckRequest } from './check.ts'
import { hasPointerEvents, parseInputEvents, parseWindowSize, screenshotToWindow } from './input.ts'
import { isErrorEntry } from './logs.ts'
import { MAX_INPUT_EVENTS, type GodotRun } from './run.ts'
import type { GodotSession, GodotSessions } from './runs.ts'
import type { GodotLogEntry, GodotLogLevel, GodotRunRequest } from './types.ts'

/** Most characters of text in one tool result. */
export const TEXT_BUDGET = 6000

/** Most error entries listed in a result's new-error report. */
export const DIGEST_ENTRIES = 10

/** Most errors and warnings listed in a `godot_run` result. */
export const STARTUP_ENTRIES = 20

/** How long `godot_run` keeps collecting startup logs after the game runs. */
export const STARTUP_LOG_WINDOW_MS = 1000

/** Longest log message quoted in a result. */
const MESSAGE_CHARS = 500

/** Default `max_width` of `godot_screenshot`, and the largest width of the screenshot `godot_input` and `godot_wait` take. */
export const SCREENSHOT_WIDTH = 1280

const LEVELS = ['stdout', 'stderr', 'warning', 'error', 'script_error', 'shader_error'] as const

/** What the tools need from the plugin. */
export interface GodotToolHost {
  /** Per-Session state. */
  readonly sessions: GodotSessions
  /** Whether agent runs use the Dummy audio driver unless the call says otherwise. */
  readonly agentRunsMuted: boolean
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
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    ...SIZE,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: SIZE },
  },
} as const

const SCREENSHOT_PROPERTIES = {
  width: { ...INTEGER, description: 'Image width in pixels; mouse coordinates refer to this size.' },
  height: INTEGER,
  windowWidth: INTEGER,
  windowHeight: INTEGER,
  frame: INTEGER,
  paused: BOOLEAN,
  image: IMAGE_SCHEMA,
} as const

const SCREENSHOT_SCHEMA = { type: 'object', additionalProperties: false, properties: SCREENSHOT_PROPERTIES } as const

/** A screenshot as a result value holds it: its size, the game window it shows, and the stored image. */
export type ScreenshotValue = InferValue<typeof SCREENSHOT_SCHEMA>

/** Captures the screenshots of one tool call for the callers of a {@link GodotToolSurface}. */
export interface ScreenshotTaker {
  /**
   * Capture the running game's window and store the image where the surface's callers receive it.
   * @param run - running game.
   * @param maxWidth - largest image width the call asked for.
   * @param signal - cancellation.
   * @returns the screenshot as a result value holds it; input coordinates in screenshot pixels refer to its
   * `width` and `height`.
   */
  capture(run: GodotRun, maxWidth: number, signal: AbortSignal): Promise<ScreenshotValue>
}

/** Tool description text that depends on how a surface's callers name projects and files. */
export interface GodotToolWording {
  /** First sentence of the `godot_run` description, with its trailing space. */
  readonly run: string
  /** How the `godot_check` description names the paths it accepts. */
  readonly checkPaths: string
  /** The `godot_logs` description's sentence about reading without `since`. */
  readonly logsDefault: string
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
  /** Description text for these callers. */
  readonly wording: GodotToolWording
}

/** Wording of the Session's own tools, which name projects and files relative to the working directory. */
export const SESSION_WORDING: GodotToolWording = {
  run: 'Start the Godot project in the working directory, or restart it if it is running, and wait until the game runs. ',
  checkPaths: 'files or folders, as res:// paths or relative to the working directory',
  logsDefault: 'Without since, returns the entries after the ones this Session last read.',
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
  // The value holds the reference that the attachment store returned, so its id is a stored attachment id.
  return [{ type: 'image', attachment: { ...shot.image, attachmentId: brandString<AttachmentId>(shot.image.attachmentId) } }]
}

function describeScreenshot(shot: ScreenshotValue): string {
  return `Screenshot at frame ${shot.frame}${shot.paused ? ' (paused)' : ''}: ${shot.width}x${shot.height} px of a ${shot.windowWidth}x${shot.windowHeight} px game window. Mouse coordinates for godot_input are pixels of this image.`
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
      async capture(run, maxWidth, signal) {
        const shot = await run.screenshot(maxWidth, signal)
        const [image] = await attachments.saveImages([{ data: shot.png, mediaType: 'image/png', name: `godot-frame-${shot.meta.frame}.png` }]) as [ImageAttachmentRef]
        signal.throwIfAborted()
        const seen = await attachments.readImageRequest(image, llm.imageRequestTarget(route.provider, route.model, image), signal)
        return {
          width: seen.width,
          height: seen.height,
          windowWidth: shot.meta.windowWidth,
          windowHeight: shot.meta.windowHeight,
          frame: shot.meta.frame,
          paused: shot.meta.paused,
          image,
        }
      },
    }
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
): Promise<ScreenshotValue> {
  const shot = await taker.capture(run, maxWidth, signal)
  const { width, height, windowWidth, windowHeight } = shot
  session.screenshot = { runId: run.id, width, height, windowWidth, windowHeight }
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
  for (const definition of godotToolDefinitions(host, { screenshots: sessionScreenshots(ctx), wording: SESSION_WORDING })) {
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
          issues: { type: 'array', items: ENTRY_SCHEMA, required: true },
          moreIssues: INTEGER,
          ...DIGEST_SCHEMA,
        },
      },
      render: (_args, value) => {
        const facts = [
          ...value.scene === undefined ? [] : [`scene ${value.scene}`],
          `window ${value.width}x${value.height}`,
          `renderer ${value.renderer}`,
          `Godot ${value.godot}`,
          ...value.windowless ? ['windowless'] : [],
          ...value.muted ? ['muted'] : [],
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
    description: 'Capture the running game\'s window as an image. Mouse coordinates for godot_input refer to the pixels of the latest screenshot.',
    parameters: {
      max_width: { type: 'integer', description: `Largest image width in pixels. Default: ${SCREENSHOT_WIDTH}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ...SCREENSHOT_PROPERTIES, ...DIGEST_SCHEMA } },
      render: (_args, value) => [...textResult(describeScreenshot(value), formatDigest(value)), ...screenshotBlocks(value)],
    },
    async execute(args, exec) {
      const maxWidth = boundedInteger(args.max_width, 'max_width', SCREENSHOT_WIDTH, 64, 4096)
      return invoke(host, exec, async (agent, session) => {
        const run = requireRunning(session)
        return captureScreenshot(await surface.screenshots(exec, agent), session, run, maxWidth, exec.signal)
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
    description: 'Evaluate a Godot Expression in the running game and return its value, for example scene.get_node("Player").position. '
      + 'The names scene (the current scene), root, and tree are defined; method calls without a base run on node, or on the current scene.',
    parameters: {
      expression: STRING,
      node: { type: 'string', description: 'Node path of the base object, for example /root/Main/Player.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'json', required: true }, valueType: STRING, ...DIGEST_SCHEMA },
      },
      render: (_args, value) => textResult(`${value.valueType}: ${JSON.stringify(value.value)}`, formatDigest(value)),
    },
    async execute(args, exec) {
      if (args.expression.trim() === '') throw new Error('expression must not be empty.')
      return invoke(host, exec, async (_agent, session) => {
        const reply = await requireRunning(session).evaluate(args.expression, args.node, exec.signal)
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
        return textResult([summary, ...problems].join('\n'), formatDigest(value))
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
          files: report.scripts
            .filter(script => script.issues.length > 0)
            .map(script => ({ path: script.path, issues: [...script.issues] })),
        }
      })
    },
  })]
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
