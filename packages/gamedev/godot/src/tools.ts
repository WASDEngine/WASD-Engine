/**
 * The model-facing Godot tools. Every tool runs against the calling Session's game. Each result reports the
 * error-level entries the run logged since the Session's previous Godot tool call (up to `DIGEST_ENTRIES` of
 * `tool-parts.ts`, then a count), and its text stays within `TEXT_BUDGET` characters (`tool-text.ts`); complete
 * values remain available to programs. The tools come in groups: `run-tools.ts`, `play-tools.ts`, `inspect-tools.ts`,
 * and `script-tools.ts`. One set of definitions serves one {@link GodotToolSurface}: the Session's
 * own agent, whose screenshots become attachments for its model, or agents that reach the tools over WASD Engine's
 * MCP server, whose screenshots travel as image bytes.
 * @module @deepseek-ai/dsh-godot/src/tools
 */
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CheckReport, CheckRequest } from './check.ts'
import type { GodotRun } from './run.ts'
import type { GodotScriptReport, GodotScriptRunsReport } from './script.ts'
import type { GodotSessions } from './runs.ts'
import type { GodotInputEvent, GodotRunRequest } from './types.ts'
import { sessionPictures, sessionScreenshots, type ScreenshotTaker } from './screenshot-capture.ts'
import { runTools } from './run-tools.ts'
import { playTools } from './play-tools.ts'
import { inspectTools } from './inspect-tools.ts'
import { scriptTools } from './script-tools.ts'

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
   * Resolve a file path as the model gave it: absolute, or relative to the Session's working directory. The tools
   * resolve a `res://` path themselves, in the running game's project.
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
  /**
   * Where to save the video, relative to the working directory, absolute, or a `res://` path in the project; a new
   * file under `recordings/` when undefined.
   */
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
  /** How the descriptions of `godot_audio`, `godot_screenshot`, and `godot_view` name the file path they save at. */
  readonly savePath: string
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
   * Resolve where a call's pictures go, which a result can do without: an audio capture's waveform, a recording's sheet
   * of frames, or the image of a capture that the call saves to a file, which the file holds whether or not the callers
   * receive it.
   * @param exec - the tool call.
   * @param agent - calling Session.
   * @returns the call's screenshot taker, or undefined when the callers receive no images, so that the result keeps to
   * text.
   */
  pictures(exec: ToolRunContext, agent: Agent): Promise<ScreenshotTaker | undefined>
  /** Description text for these callers. */
  readonly wording: GodotToolWording
}

/** Wording of the Session's own tools, which name projects and files relative to the working directory. */
export const SESSION_WORDING: GodotToolWording = {
  run: 'Start the Godot project in the working directory, or restart it if it is running, and wait until the game runs. ',
  checkPaths: 'files or folders, as res:// paths or relative to the working directory',
  scriptPath: 'a res:// path or a path relative to the working directory',
  logsDefault: 'Without since, returns the entries after the ones this Session last read.',
  savePath: 'a path relative to the working directory, or absolute',
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
  return [...runTools(host, surface), ...playTools(host, surface), ...inspectTools(host, surface), ...scriptTools(host, surface)]
}
