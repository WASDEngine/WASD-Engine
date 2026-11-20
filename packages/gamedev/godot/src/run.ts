/**
 * One run of a Session's game: the optional import step, a loopback server with a token handshake, the Godot
 * process, request and response correlation, logs, status, frame fan-out, the frame rate cap of a game that nobody
 * shows or uses, whether a windowless game presents its frames, and shutdown.
 *
 * Lifecycle: `preparing` → `importing` (when configured) → `starting` → `running` ⇄ `paused` → `exited` or
 * `crashed`; a failure before the harness connects ends in `failed`. The run owns every process, socket, and
 * timer it creates; {@link GodotRun.stop} and the end of the process release all of them, and
 * {@link GodotRun.whenEnded} settles only after the process is gone.
 * @module @deepseek-ai/dsh-godot/src/run
 */
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessRuntime, SubprocessStdio } from '@deepseek-ai/dsh-subprocess'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { AudioReply } from './audio.ts'
import { importFailure, type GodotImportOutcome, type ProjectImports } from './imports.ts'
import { fixedFps } from './launch.ts'
import { isErrorEntry, LogRing, type LogSequence } from './logs.ts'
import { describeExit, formatSeconds, lastLines, parseEngineOutput, type EngineOutputLine } from './output.ts'
import { PerformanceReply } from './performance.ts'
import type { GodotProject } from './project.ts'
import {
  encodeJsonMessage, HarnessDecoder, HARNESS_PROTOCOL_VERSION, MAX_MESSAGE_BYTES,
  type HarnessBusy, type HarnessFrame, type HarnessHello, type HarnessJsonMessage, type HarnessLogEntry, type HarnessMessage,
  type HarnessRecordFrame, type HarnessResult, type HarnessStatus,
} from './protocol.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'
import type { GodotInputEvent, GodotLogEntry, GodotRunLayer, GodotRunPhase, GodotRunStarter, GodotRunView } from './types.ts'

/** Largest message accepted before a connection presents the run's token; `hello` is far smaller. */
const PRE_AUTH_MESSAGE_BYTES = 64 * 1024

/** Lines of process output quoted in crash and startup failure messages. */
export const FAILURE_OUTPUT_LINES = 20

/** Longest stored log message, in UTF-16 code units; longer messages keep their start. */
export const MAX_LOG_MESSAGE_CHARS = 4000

/** Most input events one request carries; queued user input beyond it drops its oldest events. */
export const MAX_INPUT_EVENTS = 256

/**
 * Slowest frame rate that the real-time limits of frame waits, steps, and agent input sequences allow for: such a
 * request may take its frames, and an input sequence one frame per wait and one to start, at this rate.
 */
export const LIMIT_FPS = 10

/** The rendering method of Godot's Web builds, which a Web run (`GodotRunSpec.web`) passes as `--rendering-method`. */
export const WEB_RENDERING_METHOD = 'gl_compatibility'

// The Desktop Host runs as Electron with ELECTRON_RUN_AS_NODE; Godot children must not inherit it.
const CHILD_ENV = { ELECTRON_RUN_AS_NODE: undefined }

/** Frame streaming parameters sent to the harness while a frame response is open. */
export interface StreamSettings {
  /** Frames per second. */
  readonly fps: number
  /** JPEG quality between 0.1 and 1. */
  readonly quality: number
  /** Largest frame width; wider frames are scaled down. */
  readonly maxWidth: number
  /** Send PNG frames while preparing a PNG frame keeps up with `fps`, and JPEG frames otherwise. */
  readonly lossless: boolean
}

/** Fully resolved launch parameters of one run. */
export interface GodotRunSpec {
  /** Opaque run id. */
  readonly runId: string
  /** Who started the run. */
  readonly startedBy: GodotRunStarter
  /** Project to run. */
  readonly project: GodotProject
  /** `res://` or `uid://` scene to run instead of the main scene. */
  readonly scene?: string
  /** Window size in pixels. */
  readonly size?: { readonly width: number; readonly height: number }
  /**
   * The whole factor by which `size` scales the project's window size, when the run named no size and the plugin chose
   * a larger one.
   */
  readonly scale?: number
  /** Arguments after `--` that the game reads with `OS.get_cmdline_user_args()`, before the harness's own. */
  readonly args: readonly string[]
  /** Validated Godot command-line options, each followed by its value. */
  readonly engineArgs: readonly string[]
  /** Run with the Dummy audio driver. */
  readonly muted: boolean
  /** Render with the Compatibility renderer, as the game's Web build does, instead of the project's renderer. */
  readonly web: boolean
  /** Runtime to launch. */
  readonly runtime: ResolvedGodotRuntime
  /** Pass `--embedded` (macOS LibGodot only). */
  readonly windowless: boolean
  /** Real path of `wasd_harness.gd`. */
  readonly harnessPath: string
  /** Host process id; the LibGodot runner exits when that process does. */
  readonly hostPid: number
  /** Run `--import` before launching. */
  readonly importBeforeRun: boolean
  /** Import step deadline. */
  readonly importTimeoutMs: number
  /** Deadline from launch to the harness handshake. */
  readonly startTimeoutMs: number
  /**
   * Deadline for instantaneous requests, the longest harness silence while any request waits, and the real time
   * that a wait, a step, or an agent input sequence may take beyond the time it needs. A game whose harness reports
   * its main loop busy is not silent, and its instantaneous requests wait until the main loop runs again.
   */
  readonly requestTimeoutMs: number
  /**
   * Longest time that the game's main loop may stay in one frame, as the harness reports it, before every request that
   * waits for the game fails.
   */
  readonly busyTimeoutMs: number
  /** Grace after `quit` or a closed connection before the process is terminated; also the subprocess termination grace. */
  readonly stopGraceMs: number
  /** Collected bytes kept per process output stream. */
  readonly outputBytes: number
  /** Retained log entries. */
  readonly maxLogEntries: number
  /** Frame streaming parameters. */
  readonly stream: StreamSettings
  /**
   * Frame rate of a windowless game that no view shows and no request uses: `fps` once `delayMs` passed since the game
   * connected or the latest view or request ended; an `fps` of 0 leaves every game at its own frame rate. A windowless
   * game also presents its frames only while a display ({@link GodotRun.display}) shows it.
   */
  readonly hidden: { readonly fps: number; readonly delayMs: number }
}

/** Services a run uses. */
export interface GodotRunDependencies {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Host-wide log sequence. */
  readonly sequence: LogSequence
  /** The plugin's import steps, which the run's import step waits its turn in. */
  readonly imports: ProjectImports
  /**
   * Report a Host-side diagnostic that no caller receives.
   * @param message - diagnostic text.
   */
  warn(message: string): void
}

/** Change notifications of a run. */
export type GodotRunEvent = { readonly type: 'view' } | { readonly type: 'logs' } | { readonly type: 'end' }

/** Receives the frames of one recording until the recording stops or the run ends. */
export interface RecordingSink {
  /**
   * Receive one frame.
   * @param frame - decoded frame.
   */
  frame(frame: HarnessRecordFrame): void
}

/** What a recording captures: frames per second, size, JPEG quality, game-frame pacing, and its longest duration. */
export interface RecordingParams {
  /** Frames per second of real time; ignored with `frameStep`. */
  readonly fps: number
  /** Largest frame width; wider windows are scaled down. */
  readonly maxWidth: number
  /** JPEG quality of the frames, 0.1 to 1. */
  readonly quality: number
  /** Capture every this many game frames, none skipped, instead of by real time; 0 captures by real time. */
  readonly frameStep: number
  /** Milliseconds of video that one game frame takes, with `frameStep`. */
  readonly frameMs: number
  /** Frames after which the game stops capturing; 0 for none. */
  readonly frames: number
  /** Real seconds after which the game stops capturing by itself. */
  readonly seconds: number
}

/** Receives streamed frames until the run ends. */
export interface FrameSink {
  /**
   * Receive one frame.
   * @param frame - decoded frame.
   */
  frame(frame: HarnessFrame): void
  /** The run ended; no further frames arrive. */
  end(): void
}

/** The run cannot serve a request in its current state. */
export class GodotRunStateError extends Error {
  override name = 'GodotRunStateError'
}

/** The game refused a request, or did not answer in time. */
export class GodotRequestError extends Error {
  override name = 'GodotRequestError'
}

/** A startup failure whose message explains it. */
class StartupFailure extends Error {}

const ScreenshotReply = z.object({
  format: z.enum(['png', 'jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  windowWidth: z.number().int(),
  windowHeight: z.number().int(),
  frame: z.number().int(),
  paused: z.boolean(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  regionWidth: z.number().int().positive().optional(),
  regionHeight: z.number().int().positive().optional(),
})

const Point = z.tuple([z.number(), z.number(), z.number()])

const ViewReply = z.object({
  format: z.enum(['png', 'jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frame: z.number().int(),
  paused: z.boolean(),
  camera: z.object({ position: Point, direction: Point, fov: z.number() }),
  subject: z.object({ center: Point, radius: z.number(), distance: z.number() }).optional(),
})

const RecordStartReply = z.object({ recording: z.number().int(), frame: z.number().int() })

const RecordStopReply = z.object({
  recording: z.number().int(),
  frames: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
})

const InputReply = z.object({
  events: z.number().int(),
  frames: z.number().int(),
  seconds: z.number(),
  frame: z.number().int(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
})

const WaitReply = z.object({
  frames: z.number().int(),
  seconds: z.number(),
  frame: z.number().int(),
  paused: z.boolean(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
})

const PauseReply = z.object({ paused: z.boolean(), frame: z.number().int() })

const EvalReply = z.object({ value: z.json(), valueType: z.string() })

const TreeReply = z.object({ tree: z.json(), truncated: z.boolean() })

/**
 * Screenshot metadata from the harness. A screenshot of a region of the window carries the region in window pixels:
 * its top left corner `x`, `y`, and its `regionWidth` and `regionHeight`.
 */
export type ScreenshotReply = z.infer<typeof ScreenshotReply>

/** The part of the window a screenshot shows, in window pixels, and the width a small part grows to. */
export interface ScreenshotRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Width the image grows to, by a whole factor of at most 8, when the region is narrower. */
  readonly minWidth: number
}

/**
 * A drawn view: its image size, the camera that drew it, and, when the view framed a node or an asset, the framed
 * center and radius in meters and the camera's distance from the center.
 */
export type ViewReply = z.infer<typeof ViewReply>

/** The end of a recording: the frames sent and skipped, the real seconds it ran, and the frame size. */
export type RecordStopReply = z.infer<typeof RecordStopReply>

/** What a view draws, as `godot_view` passes it to the harness. */
export interface ViewParams {
  /** Image size in pixels; the window size when absent. */
  readonly width?: number
  readonly height?: number
  /** Node path of a 3D node to frame. */
  readonly node?: string
  /** `res://` path of a scene or mesh to load and draw alone. */
  readonly asset?: string
  /** Animation to pose the asset in, and the seconds into it. */
  readonly animation?: string
  readonly time?: number
  /** Explicit camera position and the point it looks at, in world coordinates. */
  readonly camera?: { readonly position: readonly [number, number, number]; readonly target: readonly [number, number, number] }
  /** Degrees around the framed subject's heading (0 looks at its +Z side), and above it. */
  readonly yaw?: number
  readonly pitch?: number
  /** Multiplier of the distance that fits the subject. */
  readonly distance?: number
  /** Skeleton bone to frame instead of the whole subject, and the meters around it. */
  readonly bone?: string
  readonly radius?: number
  /** Vertical field of view in degrees. */
  readonly fov?: number
  /** Draw the framed node alone, lit as the game lights it. */
  readonly isolate?: boolean
  /** Light an asset with the game's environment and sun instead of a neutral studio. */
  readonly lighting?: 'studio' | 'game'
  /** Frames drawn before the capture. */
  readonly frames?: number
}

/**
 * Completion of an input sequence: the events that ran, and the frames and real seconds they took. `timedOut` marks
 * a sequence that its real-time limit ended, after the game released what the sequence held.
 */
export type InputReply = z.infer<typeof InputReply>

/**
 * Completion of a wait or step: the frames and game seconds that passed. `timedOut` marks a wait or step that its
 * real-time limit ended; `cancelled` marks a step that a pause, a resume, or a newer step ended.
 */
export type WaitReply = z.infer<typeof WaitReply>

/** Pause state after pause or resume. */
export type PauseReply = z.infer<typeof PauseReply>

/** An evaluated expression. */
export type EvalReply = z.infer<typeof EvalReply>

/** A scene tree description. */
export type TreeReply = z.infer<typeof TreeReply>

/** A frame in which the game's main loop is busy, and the real time from which, by the Host's clock. */
interface BusyFrame {
  readonly frame: number
  readonly since: number
}

interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

interface OutputOffsets {
  readonly stdout: number
  readonly stderr: number
}

/** The binary message that follows the JSON answer of a request: a screenshot's image or a capture's audio. */
type BinaryKind = 'image' | 'audio'

interface Reply {
  readonly result: HarnessResult
  readonly data?: Buffer
}

interface Pending {
  readonly wants: BinaryKind | undefined
  /** Whether the harness drops the request on `cancel`: waits, steps, and input sequences. */
  readonly cancelable: boolean
  readonly resolve: (reply: Reply) => void
  readonly reject: (error: unknown) => void
  readonly dispose: () => void
  result?: HarnessResult
  data?: Buffer
}

interface RequestOptions {
  readonly signal: AbortSignal
  /**
   * Whether the answer is due within `requestTimeoutMs`. Waits, steps, and input sequences end by the `timeoutMs`
   * limit that they carry, Game tab input carries none, and the harness drops one that the Host abandons.
   */
  readonly bounded: boolean
  /** The binary message that completes the answer. */
  readonly binary?: BinaryKind
  /**
   * Ends a cancelable request early without abandoning it: the Host sends `cancel`, and the harness answers with what
   * the request did until then.
   */
  readonly stop?: AbortSignal
  /** Whether the Host sends the request for itself, such as a frame rate or streaming change, so it does not use the game. */
  readonly background?: boolean
}

/**
 * The real time an input sequence needs: the seconds of its waits, which the harness counts in real time, and one
 * frame per wait and one to start, because a wait ends at a frame. Hold releases run outside the sequence.
 * @param events - validated events.
 * @returns the wait seconds and the frames.
 */
function sequenceNeeds(events: readonly GodotInputEvent[]): { readonly seconds: number; readonly frames: number } {
  let seconds = 0
  let frames = 1
  for (const event of events) {
    if (!('wait' in event) || event.wait === 0) continue
    seconds += event.wait
    frames += 1
  }
  return { seconds, frames }
}

/**
 * Build the game's argv. A run with `--fixed-fps` also passes its rate to the harness as `--wasd-fixed-fps`, since Godot
 * keeps the option from scripts, and the harness then applies the frame rate cap that Godot does not apply to it.
 * @param spec - run parameters.
 * @param port - loopback port of the run's server.
 * @param token - handshake token.
 * @returns the argv running the project with the harness as main loop.
 */
export function gameArgv(spec: GodotRunSpec, port: number, token: string): string[] {
  const fixed = fixedFps(spec.engineArgs)
  return launcherArgv(spec.runtime, spec.hostPid, [
    '--path', spec.project.dir,
    ...spec.windowless ? ['--embedded'] : [],
    '--script', spec.harnessPath,
    ...spec.muted ? ['--audio-driver', 'Dummy'] : [],
    ...spec.web ? ['--rendering-method', WEB_RENDERING_METHOD] : [],
    ...spec.size === undefined ? [] : ['--resolution', `${spec.size.width}x${spec.size.height}`],
    ...spec.engineArgs,
    '--', ...spec.args, `--wasd-port=${port}`, `--wasd-token=${token}`,
    ...spec.scene === undefined ? [] : [`--wasd-scene=${spec.scene}`],
    ...fixed === undefined ? [] : [`--wasd-fixed-fps=${String(fixed)}`],
  ])
}

function tokenMatches(candidate: string, token: string): boolean {
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(token, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function reader(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): SubprocessOutputReader {
  // Runs spawn both streams in collect mode, so both readers exist.
  return handle.collected[stream] as SubprocessOutputReader
}

/** Append user events; consecutive pointer motions merge into one with the last position and summed deltas. */
function enqueueUserEvents(queue: GodotInputEvent[], events: readonly GodotInputEvent[]): void {
  for (const event of events) {
    const previous = queue.at(-1)
    if ('kind' in event && event.kind === 'mouse_motion' && previous !== undefined && 'kind' in previous && previous.kind === 'mouse_motion') {
      queue[queue.length - 1] = { ...event, dx: (previous.dx ?? 0) + (event.dx ?? 0), dy: (previous.dy ?? 0) + (event.dy ?? 0) }
    } else {
      queue.push(event)
    }
  }
}

/** One game run; create it with {@link GodotRun.launch}. */
export class GodotRun {
  /** Run id. */
  readonly id: string
  /** Retained log entries of this run. */
  readonly logs: LogRing
  private phase: GodotRunPhase = 'preparing'
  private revisionValue = 0
  private readonly startedAt = Date.now()
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<(event: GodotRunEvent) => void>()
  private readonly frameSinks = new Set<FrameSink>()
  private readonly recordingSinks = new Map<number, RecordingSink>()
  private readonly pending = new Map<number, Pending>()
  private readonly sockets = new Set<Socket>()
  private readonly handshake = Promise.withResolvers<void>()
  private readonly ended = Promise.withResolvers<void>()
  private nextRequestId = 0
  private errorCount = 0
  private warningCount = 0
  private window: { readonly width: number; readonly height: number } | undefined
  private progress: { readonly fps: number; readonly frame: number; readonly mouseMode: number } | undefined
  private currentScene: string | undefined
  private renderer: string | undefined
  private godot: string | undefined
  private windowless: boolean
  private layer: GodotRunLayer | undefined
  private connection: Socket | undefined
  private server: Server | undefined
  private process: SubprocessHandle | undefined
  private exit: Promise<ProcessExit> | undefined
  private disconnectOffsets: OutputOffsets | undefined
  private startup!: Promise<void>
  private stopping: Promise<void> | undefined
  private stopRequested = false
  private lingered = false
  private finished = false
  private lastActivity = 0
  /** Where the game's main loop is busy while the harness reports it; any other message from the game ends it. */
  private busy: BusyFrame | undefined
  private silenceTimer: NodeJS.Timeout | undefined
  private disconnectTimer: NodeJS.Timeout | undefined
  /** Views that show the run's picture, such as Game tabs. */
  private views = 0
  /** Displays, the views through which a windowless game presents its frames, such as Game tabs. */
  private displays = 0
  /** Requests that use the game and have not settled. */
  private uses = 0
  /** Real time when the game connected or the latest view or use ended. */
  private lastUse = 0
  /** The frame rate cap that the harness applies: `hidden.fps` or 0. */
  private cap = 0
  /** Whether the harness presents the game's frames, as it does from its start. */
  private presenting = true
  private paceTimer: NodeJS.Timeout | undefined
  /** Holders that stopped the Host reading the game's connection; see {@link GodotRun.holdReading}. */
  private readonly readHolds = new Set<object>()
  private userInputInFlight = false
  private userQueue: GodotInputEvent[] = []
  private exitCode: number | null | undefined
  private exitSignal: string | null | undefined
  private message: string | undefined
  /** Why the run was stopped, which its view keeps once it ended. */
  private stopMessage: string | undefined

  private constructor(private readonly spec: GodotRunSpec, private readonly deps: GodotRunDependencies) {
    this.id = spec.runId
    this.logs = new LogRing(spec.maxLogEntries)
    this.windowless = spec.windowless
    // Startup awaits the handshake; a rejection after startup ended has no reader.
    this.handshake.promise.catch(() => {})
  }

  /**
   * Create a run and start its import, launch, and handshake.
   * @param spec - resolved launch parameters.
   * @param deps - services.
   * @returns the run; {@link GodotRun.started} settles when it is running or has ended.
   */
  static launch(spec: GodotRunSpec, deps: GodotRunDependencies): GodotRun {
    const run = new GodotRun(spec, deps)
    run.startup = run.start()
    return run
  }

  /**
   * Wait for the startup to settle.
   * @returns a promise settling when the run reached `running` or ended; it never rejects.
   */
  started(): Promise<void> {
    return this.startup
  }

  /**
   * Wait for the end of the run.
   * @returns a promise settling after the run ended and its process is gone.
   */
  whenEnded(): Promise<void> {
    return this.ended.promise
  }

  /** Whether the run ended. */
  get terminal(): boolean {
    return this.finished
  }

  /** Whether the game accepts requests: it is connected and no stop began. */
  get connected(): boolean {
    return this.connection !== undefined && !this.stopRequested
  }

  /** Counter that increases with every change of {@link GodotRun.view}. */
  get revision(): number {
    return this.revisionValue
  }

  /** Project the run started. */
  get project(): GodotProject {
    return this.spec.project
  }

  /** Godot version the harness reported, once connected. */
  get godotVersion(): string | undefined {
    return this.godot
  }

  /**
   * Observe changes.
   * @param listener - receives view, log, and end notifications synchronously.
   * @returns the unsubscriber.
   */
  subscribe(listener: (event: GodotRunEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Describe the run.
   * @returns the run as tools and the Game tab see it.
   */
  view(): GodotRunView {
    const scene = this.currentScene ?? this.spec.scene
    return {
      runId: this.id,
      phase: this.phase,
      startedBy: this.spec.startedBy,
      projectDir: this.spec.project.dir,
      ...this.spec.project.name === undefined ? {} : { projectName: this.spec.project.name },
      launch: {
        ...this.spec.scene === undefined ? {} : { scene: this.spec.scene },
        ...this.spec.scale === undefined ? this.spec.size : { scale: this.spec.scale },
        ...this.spec.web ? { web: true } : {},
        ...this.spec.args.length === 0 ? {} : { args: this.spec.args },
        ...this.spec.engineArgs.length === 0 ? {} : { engineArgs: this.spec.engineArgs },
      },
      ...scene === undefined ? {} : { scene },
      ...this.window,
      ...this.progress,
      ...this.renderer === undefined ? {} : { renderer: this.renderer },
      muted: this.spec.muted,
      windowless: this.windowless,
      ...this.layer === undefined ? {} : { layer: this.layer },
      runtime: this.spec.runtime.kind,
      ...this.exitCode === undefined ? {} : { exitCode: this.exitCode },
      ...this.exitSignal === undefined ? {} : { signal: this.exitSignal },
      ...this.message === undefined ? {} : { message: this.message },
      errorCount: this.errorCount,
      warningCount: this.warningCount,
      startedAt: this.startedAt,
    }
  }

  /**
   * The real time since which no view shows the run and no request uses it.
   * @returns milliseconds since the epoch, or undefined while a view or a request does, before the game connected, and
   *   once it is stopping or ended.
   */
  idleSince(): number | undefined {
    if (!this.connected || this.views > 0 || this.uses > 0) return undefined
    return this.lastUse
  }

  /**
   * Stop the run as {@link GodotRun.stop} does, and keep in its view a message that says why.
   * @param message - why the run stopped; the first message of a run's stops counts.
   * @returns a shared promise settling after the run ended.
   */
  stopWith(message: string): Promise<void> {
    this.stopMessage ??= message
    return this.stop()
  }

  /**
   * Quote the end of the process output.
   * @param count - maximum lines.
   * @returns the last lines of stderr, or of stdout when stderr is empty.
   */
  outputTail(count: number): string {
    if (this.process === undefined) return ''
    const stderr = lastLines(reader(this.process, 'stderr').readFrom(0).text, count)
    return stderr !== '' ? stderr : lastLines(reader(this.process, 'stdout').readFrom(0).text, count)
  }

  /**
   * Stream frames to a sink while it is subscribed; the harness streams only while at least one sink exists, and each
   * sink counts as a view of the run, as {@link GodotRun.show} counts one.
   * @param sink - frame receiver; an ended run calls `end` at once.
   * @returns the unsubscriber; it never throws, so an abort listener may call it.
   */
  subscribeFrames(sink: FrameSink): () => void {
    if (this.finished) {
      sink.end()
      return () => {}
    }
    this.frameSinks.add(sink)
    // A frame stream shows the run's picture.
    const hide = this.show()
    if (this.frameSinks.size === 1 && this.connected) this.setStreaming(true)
    return () => {
      hide()
      if (this.frameSinks.delete(sink) && this.frameSinks.size === 0 && this.connected) this.setStreaming(false)
    }
  }

  /**
   * Count a view of the run's picture, such as a Game tab that shows it, until the returned function is called. While
   * a view counts, and for `hidden.delayMs` after the last one ended, a windowless game keeps its own frame rate.
   * @returns the release; later calls do nothing.
   */
  show(): () => void {
    this.views += 1
    this.pace()
    let released = false
    return () => {
      if (released) return
      released = true
      this.views -= 1
      this.lastUse = Date.now()
      this.pace()
    }
  }

  /**
   * Count a display of the run: a view, as {@link GodotRun.show} counts one, through which a windowless game presents
   * its frames, such as a Game tab that shows the game's Core Animation layer. A windowless game that no display shows
   * renders into its texture without presenting, at most at the screen's refresh rate, so it never waits for the
   * window server; screenshots and streamed frames read that texture.
   * @returns the release; later calls do nothing.
   */
  display(): () => void {
    this.displays += 1
    const hide = this.show()
    let released = false
    return () => {
      if (released) return
      released = true
      this.displays -= 1
      hide()
    }
  }

  /**
   * Stop reading the game's connection until the returned function is called, so that the game's messages wait in the
   * connection, and the harness, once more than 48 MiB of its messages wait, makes a recording by game frames wait and
   * a real-time recording skip frames. The Host reads again once every hold is released, and as the run stops. While a
   * hold lasts, the game's silence does not fail the requests that wait for it; the requests' own limits still apply.
   * @returns the release; later calls do nothing.
   */
  holdReading(): () => void {
    const hold = {}
    this.readHolds.add(hold)
    if (this.readHolds.size === 1) this.connection?.pause()
    return () => {
      if (this.readHolds.delete(hold) && this.readHolds.size === 0) this.resumeReading()
    }
  }

  /** Read the game's connection again; the game's silence counts from now. */
  private resumeReading(): void {
    this.lastActivity = Date.now()
    this.connection?.resume()
  }

  /**
   * Capture the game window, or a region of it.
   * @param maxWidth - largest image width; wider windows and regions are scaled down.
   * @param signal - cancellation.
   * @param jpegQuality - JPEG quality from 0.1 to 1; without it, a PNG.
   * @param region - part of the window to capture at its own pixels, in window pixels; the game clips it to the window.
   * @returns metadata and the image bytes, of `meta.format`.
   */
  async screenshot(
    maxWidth: number, signal: AbortSignal, jpegQuality?: number, region?: ScreenshotRegion,
  ): Promise<{ readonly meta: ScreenshotReply; readonly image: Buffer }> {
    const params = {
      ...jpegQuality === undefined ? { format: 'png', maxWidth } : { format: 'jpeg', quality: jpegQuality, maxWidth },
      ...region === undefined
        ? {}
        : { region: { x: region.x, y: region.y, width: region.width, height: region.height }, minWidth: region.minWidth },
    }
    const reply = await this.send('screenshot', params, { signal, bounded: true, binary: 'image' })
    return { meta: ScreenshotReply.parse(reply.result), image: reply.data as Buffer }
  }

  /**
   * Capture the game's audio mix: the Master bus after its effects, as players hear it, for `seconds` of audio. The
   * capture ends early, with `timedOut`, once those seconds plus `requestTimeoutMs` of real time have passed since the
   * game received it, and with `cancelled` when `stop` aborts; both keep the audio captured until then.
   * @param seconds - seconds of audio.
   * @param signal - cancellation; the game also ends the capture, and its audio is lost.
   * @param stop - ends the capture early and keeps its audio.
   * @returns the capture's facts and its samples, left and right interleaved.
   */
  async audio(
    seconds: number,
    signal: AbortSignal,
    stop?: AbortSignal,
  ): Promise<{ readonly meta: AudioReply; readonly samples: Float32Array }> {
    const timeoutMs = this.limitMs(seconds, 0)
    const reply = await this.send('audio', { seconds, timeoutMs }, { signal, bounded: false, binary: 'audio', ...stop === undefined ? {} : { stop } })
    const data = reply.data as Buffer
    // The samples are little-endian 32-bit floats, as every platform of the Host stores them; a copy aligns them.
    const bytes = new Uint8Array(data.byteLength - data.byteLength % 4)
    bytes.set(data.subarray(0, bytes.length))
    return { meta: AudioReply.parse(reply.result), samples: new Float32Array(bytes.buffer) }
  }

  /**
   * Draw a view of the game's 3D world, or of an asset alone, from a camera of its own, without changing the game's
   * window or camera.
   * @param params - what to draw and from where.
   * @param signal - cancellation.
   * @returns metadata and the image bytes, of `meta.format`.
   */
  async drawView(params: ViewParams, signal: AbortSignal): Promise<{ readonly meta: ViewReply; readonly image: Buffer }> {
    const reply = await this.send('view', { ...params, format: 'png' }, { signal, bounded: true, binary: 'image' })
    return { meta: ViewReply.parse(reply.result), image: reply.data as Buffer }
  }

  /**
   * Start recording the game window: the game sends JPEG frames to `sink` until {@link GodotRun.stopRecording}
   * answers, or until `params.seconds` passed, after which it captures none.
   * @param recording - id of the recording, which its frames carry.
   * @param params - frame rate, size, quality, pacing, and longest duration.
   * @param sink - receives the frames in order.
   * @param signal - cancellation of the start request; the recording then stops at `params.seconds`.
   */
  async startRecording(recording: number, params: RecordingParams, sink: RecordingSink, signal: AbortSignal): Promise<void> {
    this.recordingSinks.set(recording, sink)
    try {
      RecordStartReply.parse((await this.send('record', { action: 'start', recording, ...params }, { signal, bounded: true })).result)
    } catch (error) {
      this.recordingSinks.delete(recording)
      throw error
    }
  }

  /**
   * Stop a recording: the game captures no further frames, or with `wait` lets the recording reach its `frames` or
   * `seconds`, and answers once the captured frames reached the sink. Only the game's silence bounds the wait for the
   * answer, which follows the frames, so a sink that holds reading the connection ({@link GodotRun.holdReading}) delays
   * it without failing it.
   * @param recording - id of the recording.
   * @param signal - cancellation.
   * @param wait - let the recording reach its end instead of stopping it now.
   * @returns the frames sent and skipped, the seconds the recording ran, and the frame size.
   */
  async stopRecording(recording: number, signal: AbortSignal, wait = false): Promise<RecordStopReply> {
    try {
      const params = { action: 'stop', recording, ...wait ? { wait: true } : {} }
      return RecordStopReply.parse((await this.send('record', params, { signal, bounded: false })).result)
    } finally {
      this.recordingSinks.delete(recording)
    }
  }

  /**
   * Run one input sequence of the agent; its waits and holds take real time. The sequence ends early, with
   * `timedOut`, once the time it needs at {@link LIMIT_FPS} plus `requestTimeoutMs` of real time have passed since
   * the game received it, also while it waited behind other input, so it cannot hold up later input for longer.
   * @param events - validated events in window pixels.
   * @param signal - cancellation; the game also drops the sequence and releases what it pressed.
   * @returns completion facts.
   */
  async input(events: readonly GodotInputEvent[], signal: AbortSignal): Promise<InputReply> {
    const needs = sequenceNeeds(events)
    const timeoutMs = this.limitMs(needs.seconds, needs.frames)
    return InputReply.parse((await this.send('input', { events, timeoutMs }, { signal, bounded: false })).result)
  }

  /**
   * Queue user input from the Game tab without waiting for the game. One request is in flight at a time; events
   * arriving meanwhile join one queued batch, consecutive pointer motions merge, and the oldest queued events
   * are dropped beyond {@link MAX_INPUT_EVENTS}.
   * @param events - validated events in window pixels.
   * @throws {GodotRunStateError} when the game does not accept requests: before it connects, once a stop began,
   * and after it ended.
   */
  sendUserInput(events: readonly GodotInputEvent[]): void {
    this.requireConnection()
    enqueueUserEvents(this.userQueue, events)
    if (this.userQueue.length > MAX_INPUT_EVENTS) this.userQueue.splice(0, this.userQueue.length - MAX_INPUT_EVENTS)
    if (!this.userInputInFlight) this.flushUserInput()
  }

  /**
   * Advance game time. A wait ends early, with `timedOut`, once its seconds, or its frames at {@link LIMIT_FPS}, plus
   * `requestTimeoutMs` of real time have passed, so a game that pauses itself, stops its time scale, or runs slower
   * than that cannot hold it.
   * @param target - frames, or seconds of unpaused game time.
   * @param signal - cancellation; the game also drops the wait.
   * @returns completion facts.
   */
  async wait(target: { readonly frames: number } | { readonly seconds: number }, signal: AbortSignal): Promise<WaitReply> {
    const timeoutMs = 'seconds' in target ? this.limitMs(target.seconds, 0) : this.limitMs(0, target.frames)
    return WaitReply.parse((await this.send('wait', { ...target, timeoutMs }, { signal, bounded: false })).result)
  }

  /**
   * Advance a number of frames, then pause. A step ends early, with `timedOut`, once its frames at
   * {@link LIMIT_FPS} plus `requestTimeoutMs` of real time have passed.
   * @param frames - frames to run.
   * @param signal - cancellation; the game also drops the step and pauses.
   * @returns completion facts; the game is paused afterwards unless a resume or a newer step ended the step.
   */
  async step(frames: number, signal: AbortSignal): Promise<WaitReply> {
    const timeoutMs = this.limitMs(0, frames)
    const reply = WaitReply.parse((await this.send('step', { frames, timeoutMs }, { signal, bounded: false })).result)
    this.notePaused(reply.paused)
    return reply
  }

  /**
   * Pause or resume the scene tree.
   * @param paused - target state.
   * @param signal - cancellation.
   * @returns the state after the change.
   */
  async setPaused(paused: boolean, signal: AbortSignal): Promise<PauseReply> {
    const reply = PauseReply.parse((await this.send(paused ? 'pause' : 'resume', {}, { signal, bounded: true })).result)
    this.notePaused(reply.paused)
    return reply
  }

  /**
   * Evaluate a Godot Expression.
   * @param expression - expression source.
   * @param node - node path of the base instance; the current scene when undefined.
   * @param signal - cancellation.
   * @returns the value as JSON and its Godot type name.
   */
  async evaluate(expression: string, node: string | undefined, signal: AbortSignal): Promise<EvalReply> {
    return EvalReply.parse((await this.send('eval', { expression, ...node === undefined ? {} : { node } }, { signal, bounded: true })).result)
  }

  /**
   * Run GDScript code as the body of a function in the game: it may use lambdas, the engine singletons, the autoloads,
   * and `await`. The game answers with the value the code returns, or with its compile or script errors, or once
   * `timeoutMs` of real time passed while the code awaits.
   * @param code - function body; a single expression returns its value.
   * @param node - node path of the object the code names `node`; the current scene when undefined.
   * @param timeoutMs - real time the answer waits for code that awaits.
   * @param signal - cancellation; the game stops waiting for the code, which keeps running.
   * @returns the value as JSON and its Godot type name.
   */
  async runCode(code: string, node: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<EvalReply> {
    const params = { code, timeoutMs, ...node === undefined ? {} : { node } }
    return EvalReply.parse((await this.send('eval', params, { signal, bounded: false })).result)
  }

  /**
   * Describe part of the scene tree.
   * @param node - start node path; the current scene when undefined.
   * @param depth - levels below the start node.
   * @param maxNodes - most nodes described.
   * @param signal - cancellation.
   * @returns the description and whether the node limit cut it.
   */
  async tree(node: string | undefined, depth: number, maxNodes: number, signal: AbortSignal): Promise<TreeReply> {
    return TreeReply.parse((await this.send('tree', { ...node === undefined ? {} : { node }, depth, maxNodes }, { signal, bounded: true })).result)
  }

  /**
   * Sample the game's performance for `seconds` of real time, then, for `scriptSeconds` more, profile its scripts
   * where the runtime can. The sample ends early, with `timedOut`, once those seconds plus `requestTimeoutMs` of real
   * time have passed since the game received it.
   * @param seconds - real seconds to sample frames.
   * @param scriptSeconds - real seconds to profile scripts after the frames; 0 profiles none.
   * @param engineCalls - also time the engine methods each script function calls, where the runtime can do so safely;
   *   the answer's `engineCalls` says whether it did.
   * @param signal - cancellation; the game also ends the sample.
   * @returns the per-frame series, monitors, scene census, script profile, and conditions that the game reported.
   */
  async performance(seconds: number, scriptSeconds: number, engineCalls: boolean, signal: AbortSignal): Promise<PerformanceReply> {
    const timeoutMs = this.limitMs(seconds + scriptSeconds, 0)
    const params = { seconds, scriptSeconds, timeoutMs, ...engineCalls ? { engineCalls } : {} }
    return PerformanceReply.parse((await this.send('performance', params, { signal, bounded: false })).result)
  }

  /**
   * Stop the run: ask the game to quit, terminate it after the grace period, and wait until it is gone. From the
   * call on, the run accepts no new requests.
   * @returns a shared promise settling after the run ended.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown()
    return this.stopping
  }

  private async start(): Promise<void> {
    try {
      if (this.spec.importBeforeRun) {
        this.setPhase('importing')
        await this.runImport()
      }
      this.setPhase('starting')
      await this.launchGame()
    } catch (error) {
      await this.failStartup(error)
    }
  }

  private collectedStdio(): SubprocessStdio {
    return { stdin: 'ignore', stdout: { maxBytes: this.spec.outputBytes }, stderr: { maxBytes: this.spec.outputBytes } }
  }

  private async runImport(): Promise<void> {
    const { imports } = this.deps
    const signal = this.lifetime.signal
    let outcome: GodotImportOutcome
    try {
      outcome = await imports.exclusive(this.spec.project.dir, () => imports.import({
        subprocess: this.deps.subprocess,
        runtime: this.spec.runtime,
        projectDir: this.spec.project.dir,
        hostPid: this.spec.hostPid,
        timeoutMs: this.spec.importTimeoutMs,
        graceMs: this.spec.stopGraceMs,
        outputBytes: this.spec.outputBytes,
        signal,
      }), signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new StartupFailure(`The Godot import step could not start: ${(error as Error).message}`, { cause: error })
    }
    const lines: EngineOutputLine[] = [
      ...outcome.blenderNote === undefined ? [] : [{ level: 'warning' as const, message: outcome.blenderNote }],
      ...parseEngineOutput(outcome.stdout, 'stdout', false),
      ...parseEngineOutput(outcome.stderr, 'stderr', false),
    ]
    const failure = importFailure(outcome, this.spec.importTimeoutMs)
    if (!signal.aborted && !outcome.timedOut && failure !== undefined) {
      lines.push({ level: 'warning', message: `The Godot import step ${failure}; imported resources may be incomplete.` })
    }
    for (const line of lines) this.append('import', line)
    if (lines.length > 0) this.emit({ type: 'logs' })
    if (outcome.timedOut) throw new StartupFailure(`The Godot import step did not finish within ${formatSeconds(this.spec.importTimeoutMs)}.`)
    signal.throwIfAborted()
  }

  private async launchGame(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const server = createServer()
    this.server = server
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    /* v8 ignore next -- accept failures after listening come from the operating system; tests cannot provoke them */
    server.on('error', (error) => { this.deps.warn(`Godot harness listener failed: ${error.message}`) })
    const { port } = server.address() as AddressInfo
    const token = randomBytes(16).toString('hex')
    server.on('connection', (socket) => { this.admit(socket, token) })
    const handle = this.deps.subprocess.spawn({
      argv: gameArgv(this.spec, port, token),
      cwd: this.spec.project.dir,
      stdio: this.collectedStdio(),
      graceMs: this.spec.stopGraceMs,
      signal: this.lifetime.signal,
      env: CHILD_ENV,
    })
    this.process = handle
    const exit = handle.done.then(
      (outcome): ProcessExit => outcome,
      // The subprocess service rejects `done` only with spawn and provider Errors.
      (error: unknown): ProcessExit => ({ exitCode: null, signal: null, error: error as Error }),
    )
    this.exit = exit
    void exit.then((outcome) => { this.onExit(outcome) })
    const timer = setTimeout(() => {
      this.handshake.reject(new StartupFailure(`The game did not connect within ${formatSeconds(this.spec.startTimeoutMs)}.`))
    }, this.spec.startTimeoutMs)
    const abort = (): void => { this.handshake.reject(this.lifetime.signal.reason) }
    this.lifetime.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.handshake.promise
    } finally {
      clearTimeout(timer)
      this.lifetime.signal.removeEventListener('abort', abort)
    }
  }

  private admit(socket: Socket, token: string): void {
    this.sockets.add(socket)
    const decoder = new HarnessDecoder(PRE_AUTH_MESSAGE_BYTES)
    let authenticated = false
    socket.on('error', () => {
      // A reset or failed read always emits 'close' next, where the connection is released.
    })
    socket.on('close', () => { this.onDisconnect(socket) })
    socket.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
      if (authenticated) this.lastActivity = Date.now()
      for (;;) {
        let message: HarnessMessage | undefined
        try {
          message = decoder.next()
        } catch (error) {
          socket.destroy()
          if (authenticated) this.logHost('error', `The game harness sent an invalid message: ${(error as Error).message}`)
          return
        }
        if (message === undefined) return
        if (authenticated) {
          this.dispatch(message)
          continue
        }
        if (message.kind !== 'json' || message.message.type !== 'hello' || !tokenMatches(message.message.token, token) || !this.connect(socket, message.message)) {
          socket.destroy()
          return
        }
        authenticated = true
        // Messages after hello, also those in the same chunk, are measured against the authenticated limit.
        decoder.maxMessageBytes = MAX_MESSAGE_BYTES
      }
    })
  }

  /** Accept an authenticated connection; false refuses it. */
  private connect(socket: Socket, hello: HarnessHello): boolean {
    // A hello after startup failed or stop began finds the lifetime aborted.
    if (this.lifetime.signal.aborted) return false
    if (hello.protocol !== HARNESS_PROTOCOL_VERSION) {
      this.handshake.reject(new StartupFailure(`The game harness speaks protocol ${hello.protocol}; this Host speaks ${HARNESS_PROTOCOL_VERSION}.`))
      return false
    }
    this.connection = socket
    if (this.readHolds.size > 0) socket.pause()
    this.window = { width: hello.width, height: hello.height }
    this.renderer = `${hello.renderingDriver} / ${hello.renderingMethod}`
    this.godot = hello.godot
    this.windowless = hello.displayServer === 'embedded'
    this.layer = this.windowless ? hello.layer : undefined
    this.lastActivity = Date.now()
    this.lastUse = this.lastActivity
    socket.setNoDelay(true)
    ;(this.server as Server).close()
    for (const other of this.sockets) if (other !== socket) other.destroy()
    this.setPhase('running')
    if (this.frameSinks.size > 0) this.setStreaming(true)
    this.pace()
    this.handshake.resolve()
    return true
  }

  private dispatch(message: HarnessMessage): void {
    // Every message but `busy` comes from the game's main loop, which therefore runs again.
    const busy = this.busy
    if (busy !== undefined && (message.kind !== 'json' || message.message.type !== 'busy')) this.endBusy(busy)
    switch (message.kind) {
      case 'frame':
        for (const sink of this.frameSinks) sink.frame(message.frame)
        return
      case 'image':
      case 'audio':
        this.receiveBinary(message.kind, message.id, message.data)
        return
      case 'record':
        this.recordingSinks.get(message.frame.recording)?.frame(message.frame)
        return
      case 'json':
        this.receiveJson(message.message)
        return
      /* v8 ignore next -- HarnessMessage is closed; this retains compile-time exhaustiveness. */
      default: assertNever(message, 'harness message')
    }
  }

  private receiveJson(message: HarnessJsonMessage): void {
    switch (message.type) {
      case 'status':
        this.receiveStatus(message)
        return
      case 'busy':
        this.receiveBusy(message)
        return
      case 'logs':
        this.receiveLogs(message.entries)
        return
      case 'result':
        this.receiveResult(message)
        return
      case 'hello':
        // A repeated hello carries nothing the run uses.
        return
      /* v8 ignore next -- HarnessJsonMessage is closed; this retains compile-time exhaustiveness. */
      default: assertNever(message, 'harness JSON message')
    }
  }

  private receiveStatus(status: HarnessStatus): void {
    this.window = { width: status.width, height: status.height }
    this.progress = { fps: status.fps, frame: status.frame, mouseMode: status.mouseMode }
    this.currentScene = status.scene === '' ? undefined : status.scene
    this.phase = status.paused ? 'paused' : 'running'
    this.bump()
  }

  private receiveBusy(busy: HarnessBusy): void {
    this.busy = { frame: busy.frame, since: Date.now() - busy.ms }
  }

  /**
   * Note that the game's main loop runs again, and log as a warning a frame that kept it busy for `requestTimeoutMs`
   * or longer, which players would wait through.
   */
  private endBusy({ frame, since }: BusyFrame): void {
    this.busy = undefined
    const took = Date.now() - since
    if (took < this.spec.requestTimeoutMs) return
    const what = frame <= 1
      ? `The game's first frame took ${formatSeconds(took)}, so the game showed nothing and took no input until then`
      : `Frame ${frame} of the game took ${formatSeconds(took)}, so the game showed no new picture and took no input meanwhile`
    this.logHost('warning', `${what}; a frame takes this long while the game compiles shaders or builds much at once.`)
  }

  /** Apply the pause state a request answer reported, before the next status message. */
  private notePaused(paused: boolean): void {
    this.phase = paused ? 'paused' : 'running'
    this.bump()
  }

  private receiveLogs(entries: readonly HarnessLogEntry[]): void {
    for (const entry of entries) {
      this.append('game', {
        level: entry.level,
        message: entry.message,
        ...entry.file === undefined || entry.file === '' ? {} : { file: entry.file },
        ...entry.line === undefined || entry.line <= 0 ? {} : { line: entry.line },
        ...entry.function === undefined || entry.function === '' ? {} : { function: entry.function },
        ...entry.backtrace === undefined ? {} : { backtrace: entry.backtrace },
      })
    }
    if (entries.length > 0) this.emit({ type: 'logs' })
  }

  private receiveResult(result: HarnessResult): void {
    const pending = this.pending.get(result.id)
    if (pending === undefined) return
    if (!result.ok) {
      this.settle(result.id, pending)
      pending.reject(new GodotRequestError(result.error ?? 'The game refused the request.'))
      return
    }
    if (pending.wants !== undefined && pending.data === undefined) {
      pending.result = result
      return
    }
    this.settle(result.id, pending)
    pending.resolve({ result, ...pending.data === undefined ? {} : { data: pending.data } })
  }

  private receiveBinary(kind: BinaryKind, id: number, data: Buffer): void {
    const pending = this.pending.get(id)
    if (pending === undefined || pending.wants !== kind) return
    if (pending.result === undefined) {
      pending.data = data
      return
    }
    this.settle(id, pending)
    pending.resolve({ result: pending.result, data })
  }

  private append(source: GodotLogEntry['source'], line: EngineOutputLine | Omit<GodotLogEntry, 'seq' | 'runId' | 'source' | 'time'>): void {
    const message = line.message.length > MAX_LOG_MESSAGE_CHARS ? `${line.message.slice(0, MAX_LOG_MESSAGE_CHARS)}…` : line.message
    const entry: GodotLogEntry = { ...line, message, seq: this.deps.sequence.next(), runId: this.id, source, time: Date.now() }
    this.logs.push(entry)
    if (isErrorEntry(entry)) this.errorCount += 1
    else if (entry.level === 'warning') this.warningCount += 1
  }

  private logHost(level: 'error' | 'warning', message: string): void {
    this.append('process', { level, message })
    this.emit({ type: 'logs' })
    this.bump()
  }

  private appendOutput(from: OutputOffsets): void {
    const handle = this.process as SubprocessHandle
    const lines = [
      ...parseEngineOutput(reader(handle, 'stdout').readFrom(from.stdout).text, 'stdout', true),
      ...parseEngineOutput(reader(handle, 'stderr').readFrom(from.stderr).text, 'stderr', true),
    ]
    for (const line of lines) this.append('process', line)
    if (lines.length > 0) this.emit({ type: 'logs' })
  }

  private outputOffsets(): OutputOffsets {
    const handle = this.process as SubprocessHandle
    return { stdout: reader(handle, 'stdout').readFrom(0).nextOffset, stderr: reader(handle, 'stderr').readFrom(0).nextOffset }
  }

  private requireConnection(): Socket {
    if (this.finished) throw new GodotRunStateError('The game is no longer running.')
    if (this.stopRequested) throw new GodotRunStateError('The game is stopping.')
    if (this.connection === undefined) throw new GodotRunStateError('The game is not accepting requests.')
    return this.connection
  }

  /**
   * Send one request and wait for its answer. Every failure rejects the returned promise, also a run that accepts
   * no requests and an aborted signal, so callers in abort listeners and `finally` callbacks never throw.
   */
  private async send(type: string, params: object, options: RequestOptions): Promise<Reply> {
    const connection = this.requireConnection()
    options.signal.throwIfAborted()
    this.nextRequestId += 1
    const id = this.nextRequestId
    const { promise, resolve, reject } = Promise.withResolvers<Reply>()
    let timer: NodeJS.Timeout | undefined
    const abort = (): void => {
      this.abandon(id, entry)
      reject(options.signal.reason)
    }
    const stop = (): void => {
      // The harness answers the request with what it did until now, which settles it.
      if (this.pending.get(id) === entry && this.connection !== undefined && !this.stopRequested) this.cancelRequest(id)
    }
    const entry: Pending = {
      wants: options.binary,
      cancelable: !options.bounded,
      resolve,
      reject,
      dispose: () => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        options.stop?.removeEventListener('abort', stop)
      },
    }
    this.pending.set(id, entry)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.stop?.aborted === true) queueMicrotask(stop)
    else options.stop?.addEventListener('abort', stop, { once: true })
    if (options.bounded) {
      const expire = (): void => {
        // A game whose main loop is busy answers once it runs again; `busyTimeoutMs` bounds the wait meanwhile.
        if (this.busy !== undefined) {
          timer = setTimeout(expire, this.spec.requestTimeoutMs)
          return
        }
        this.settle(id, entry)
        reject(new GodotRequestError(`The game did not answer ${type} within ${formatSeconds(this.spec.requestTimeoutMs)}.`))
      }
      timer = setTimeout(expire, this.spec.requestTimeoutMs)
    }
    if (options.background !== true) {
      // Lifting the cap first lets the request run at the game's own frame rate.
      this.uses += 1
      this.pace()
      const used = (): void => {
        this.uses -= 1
        this.lastUse = Date.now()
        this.pace()
      }
      promise.then(used, used)
    }
    this.armSilence()
    connection.write(encodeJsonMessage({ ...params, type, id }))
    return promise
  }

  /**
   * Pace a windowless game: cap one that no view shows and no request uses at `hidden.fps`, `hidden.delayMs` after the
   * game connected or the latest view or use ended, lifting the cap as soon as a view or a request begins; and have it
   * present its frames only while a display shows it.
   */
  private pace(): void {
    clearTimeout(this.paceTimer)
    this.paceTimer = undefined
    if (!this.windowless || !this.connected) return
    let cap = 0
    if (this.spec.hidden.fps > 0 && this.views === 0 && this.uses === 0) {
      const remaining = this.lastUse + this.spec.hidden.delayMs - Date.now()
      if (remaining > 0) this.paceTimer = setTimeout(() => { this.pace() }, remaining)
      else cap = this.spec.hidden.fps
    }
    const present = this.displays > 0
    if (cap === this.cap && present === this.presenting) return
    this.cap = cap
    this.presenting = present
    this.send('pace', { maxFps: cap, present }, { signal: this.lifetime.signal, bounded: true, background: true })
      .catch((error: unknown) => {
        // A closing connection or ending run also rejects the request; only a refusal or timeout is news.
        if (error instanceof GodotRequestError) this.deps.warn(`Godot frame rate request failed: ${error.message}`)
      })
  }

  /**
   * The `timeoutMs` of a request that needs `seconds` of real time and `frames` frames: that time with the frames
   * at {@link LIMIT_FPS}, plus `requestTimeoutMs`.
   */
  private limitMs(seconds: number, frames: number): number {
    return Math.ceil(seconds * 1000 + frames * 1000 / LIMIT_FPS) + this.spec.requestTimeoutMs
  }

  private settle(id: number, entry: Pending): void {
    entry.dispose()
    this.pending.delete(id)
    if (this.pending.size === 0) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = undefined
    }
  }

  /** Stop waiting for a request; the harness drops a cancelable one that it still runs. */
  private abandon(id: number, entry: Pending): void {
    this.settle(id, entry)
    if (!entry.cancelable || this.connection === undefined || this.stopRequested) return
    this.cancelRequest(id)
  }

  /** Ask the harness to end a cancelable request; its answer, if any, arrives as usual. */
  private cancelRequest(id: number): void {
    this.nextRequestId += 1
    ;(this.connection as Socket).write(encodeJsonMessage({ type: 'cancel', id: this.nextRequestId, request: id }))
  }

  private rejectPending(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.abandon(id, entry)
      entry.reject(error)
    }
  }

  /**
   * Fail every waiting request once the harness has sent nothing for `requestTimeoutMs`, or once it has reported the
   * game's main loop busy in one frame for `busyTimeoutMs`; while the Host holds reading the connection, it cannot
   * tell, and checks again later.
   */
  private armSilence(): void {
    if (this.silenceTimer !== undefined) return
    const waitMs = this.readHolds.size > 0 ? this.spec.requestTimeoutMs : this.unresponsiveIn(Date.now())
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined
      const now = Date.now()
      if (this.readHolds.size === 0 && this.unresponsiveIn(now) === 0) {
        this.rejectPending(new GodotRequestError(this.unresponsive(now)))
        return
      }
      this.armSilence()
    }, waitMs)
  }

  /** Milliseconds from `now` until the game has been silent for `requestTimeoutMs` or busy for `busyTimeoutMs`. */
  private unresponsiveIn(now: number): number {
    const silence = this.spec.requestTimeoutMs - (now - this.lastActivity)
    const busy = this.busy === undefined ? silence : this.spec.busyTimeoutMs - (now - this.busy.since)
    return Math.max(0, Math.min(silence, busy))
  }

  /** Say why the game no longer answers at `now`, once {@link GodotRun.unresponsiveIn} reached 0. */
  private unresponsive(now: number): string {
    const silent = now - this.lastActivity
    if (this.busy === undefined || silent >= this.spec.requestTimeoutMs) {
      return `The game stopped responding: it sent nothing for ${formatSeconds(silent)}.`
    }
    const { frame, since } = this.busy
    const where = frame <= 1 ? 'its first frame' : `frame ${frame}`
    return `The game has spent ${formatSeconds(now - since)} in ${where} without finishing it, so it answers nothing until it does. `
      + 'It still runs: a frame takes this long while the game compiles shaders or builds much at once, and never ends while a script loops forever.'
  }

  private setStreaming(on: boolean): void {
    const { fps, quality, maxWidth, lossless } = this.spec.stream
    const params = on ? { fps, quality, maxWidth, lossless } : { fps: 0 }
    this.send('stream', params, { signal: this.lifetime.signal, bounded: true, background: true }).catch((error: unknown) => {
      // A closing connection or ending run also rejects the request; only a refusal or timeout is news.
      if (error instanceof GodotRequestError) this.deps.warn(`Godot frame streaming request failed: ${error.message}`)
    })
  }

  private flushUserInput(): void {
    const events = this.userQueue
    this.userQueue = []
    this.userInputInFlight = true
    // Without `timeoutMs`, a batch that waits behind an agent's sequence still delivers its releases once that
    // sequence ends, which its own limit bounds.
    this.send('input', { events }, { signal: this.lifetime.signal, bounded: false }).then(
      () => {},
      (error: unknown) => {
        if (error instanceof GodotRequestError) this.deps.warn(`Godot rejected user input: ${error.message}`)
      },
    ).finally(() => {
      this.userInputInFlight = false
      // The queue only fills while connected and is cleared on disconnect.
      if (this.userQueue.length > 0) this.flushUserInput()
    })
  }

  private onDisconnect(socket: Socket): void {
    this.sockets.delete(socket)
    if (this.connection !== socket) return
    this.connection = undefined
    this.userQueue = []
    clearTimeout(this.paceTimer)
    this.disconnectOffsets = this.outputOffsets()
    this.rejectPending(new GodotRunStateError('The game closed its connection to the Host.'))
    this.bump()
    this.disconnectTimer = setTimeout(() => {
      this.lingered = true
      this.lifetime.abort(new Error('The game kept running after closing its connection'))
    }, this.spec.stopGraceMs)
  }

  private onExit(exit: ProcessExit): void {
    if (this.connection === undefined && this.disconnectOffsets === undefined) {
      const reason = exit.error === undefined
        ? `The game exited before it connected (${describeExit(exit)}).`
        : `The game could not start: ${exit.error.message}`
      this.handshake.reject(new StartupFailure(reason))
      return
    }
    if (this.disconnectOffsets !== undefined) this.appendOutput(this.disconnectOffsets)
    if (this.stopRequested || (exit.exitCode === 0 && exit.signal === null)) {
      this.finish('exited', exit, this.stopMessage)
      return
    }
    const summary = this.lingered
      ? `The game closed its connection without exiting and was stopped after ${formatSeconds(this.spec.stopGraceMs)}.`
      : `The game crashed (${describeExit(exit)}).`
    this.finish('crashed', exit, this.failureMessage(summary))
  }

  private failureMessage(summary: string): string {
    const tail = this.outputTail(FAILURE_OUTPUT_LINES)
    return tail === '' ? summary : `${summary}\nLast output:\n${tail}`
  }

  private async failStartup(error: unknown): Promise<void> {
    this.lifetime.abort(new Error('Godot run startup ended'))
    const exit = this.exit === undefined ? undefined : await this.exit
    if (this.stopRequested) {
      this.finish('exited', exit, this.stopMessage)
      return
    }
    if (this.process !== undefined) this.appendOutput({ stdout: 0, stderr: 0 })
    const summary = error instanceof StartupFailure ? error.message : `The game could not start: ${String(error)}`
    this.finish('failed', exit, this.failureMessage(summary))
  }

  private finish(phase: 'exited' | 'crashed' | 'failed', exit: ProcessExit | undefined, message: string | undefined): void {
    this.finished = true
    this.phase = phase
    if (exit !== undefined) {
      this.exitCode = exit.exitCode
      this.exitSignal = exit.signal
    }
    if (message !== undefined) this.message = message
    clearTimeout(this.disconnectTimer)
    clearTimeout(this.paceTimer)
    this.connection = undefined
    this.rejectPending(new GodotRunStateError('The game is no longer running.'))
    for (const socket of this.sockets) socket.destroy()
    this.server?.close()
    this.lifetime.abort(new Error('Godot run ended'))
    this.userQueue = []
    for (const sink of [...this.frameSinks]) sink.end()
    this.frameSinks.clear()
    this.recordingSinks.clear()
    this.bump()
    this.emit({ type: 'end' })
    void (this.exit ?? Promise.resolve()).then(() => { this.ended.resolve() })
  }

  private async shutdown(): Promise<void> {
    this.stopRequested = true
    if (this.readHolds.size > 0) {
      this.readHolds.clear()
      this.resumeReading()
    }
    const connection = this.connection
    if (connection !== undefined) {
      connection.write(encodeJsonMessage({ type: 'quit', id: 0, exitCode: 0 }))
      let timer: NodeJS.Timeout | undefined
      const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.spec.stopGraceMs) })
      await Promise.race([this.exit as Promise<ProcessExit>, grace])
      clearTimeout(timer)
    }
    this.lifetime.abort(new Error('Godot run stopped'))
    await this.ended.promise
  }

  private setPhase(phase: GodotRunPhase): void {
    this.phase = phase
    this.bump()
  }

  private bump(): void {
    this.revisionValue += 1
    this.emit({ type: 'view' })
  }

  private emit(event: GodotRunEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
