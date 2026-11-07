/**
 * One run of a Session's game: the optional import step, a loopback server with a token handshake, the Godot
 * process, request and response correlation, logs, status, frame fan-out, and shutdown.
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
import { isErrorEntry, LogRing, type LogSequence } from './logs.ts'
import { crashSummary, describeExit, formatSeconds, lastLines, parseEngineOutput, type EngineOutputLine } from './output.ts'
import type { GodotProject } from './project.ts'
import {
  encodeJsonMessage, HarnessDecoder, HARNESS_PROTOCOL_VERSION, MAX_MESSAGE_BYTES,
  type HarnessFrame, type HarnessHello, type HarnessJsonMessage, type HarnessLogEntry, type HarnessMessage,
  type HarnessResult, type HarnessStatus,
} from './protocol.ts'
import type { ResolvedGodotRuntime } from './runtime.ts'
import type { GodotInputEvent, GodotLogEntry, GodotRunPhase, GodotRunStarter, GodotRunView } from './types.ts'

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
  /** Send PNG frames while PNG encoding keeps up with `fps`, and JPEG frames otherwise. */
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
  /** Run with the Dummy audio driver. */
  readonly muted: boolean
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
   * that a wait, a step, or an agent input sequence may take beyond the time it needs.
   */
  readonly requestTimeoutMs: number
  /** Grace after `quit` or a closed connection before the process is terminated; also the subprocess termination grace. */
  readonly stopGraceMs: number
  /** Collected bytes kept per process output stream. */
  readonly outputBytes: number
  /** Retained log entries. */
  readonly maxLogEntries: number
  /** Frame streaming parameters. */
  readonly stream: StreamSettings
}

/** Services a run uses. */
export interface GodotRunDependencies {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Host-wide log sequence. */
  readonly sequence: LogSequence
  /**
   * Report a Host-side diagnostic that no caller receives.
   * @param message - diagnostic text.
   */
  warn(message: string): void
}

/** Change notifications of a run. */
export type GodotRunEvent = { readonly type: 'view' } | { readonly type: 'logs' } | { readonly type: 'end' }

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

/** Screenshot metadata from the harness. */
export type ScreenshotReply = z.infer<typeof ScreenshotReply>

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

interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

interface OutputOffsets {
  readonly stdout: number
  readonly stderr: number
}

interface Reply {
  readonly result: HarnessResult
  readonly image?: Buffer
}

interface Pending {
  readonly wantsImage: boolean
  /** Whether the harness drops the request on `cancel`: waits, steps, and input sequences. */
  readonly cancelable: boolean
  readonly resolve: (reply: Reply) => void
  readonly reject: (error: unknown) => void
  readonly dispose: () => void
  result?: HarnessResult
  image?: Buffer
}

interface RequestOptions {
  readonly signal: AbortSignal
  /**
   * Whether the answer is due within `requestTimeoutMs`. Waits, steps, and input sequences end by the `timeoutMs`
   * limit that they carry, Game tab input carries none, and the harness drops one that the Host abandons.
   */
  readonly bounded: boolean
  readonly image?: boolean
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
 * Prefix a Godot command line with its launcher.
 * @param runtime - resolved runtime.
 * @param hostPid - Host process id for the runner's parent watch.
 * @param godotArgs - Godot command line arguments.
 * @returns the complete argv.
 */
export function launcherArgv(runtime: ResolvedGodotRuntime, hostPid: number, godotArgs: readonly string[]): string[] {
  return runtime.kind === 'libgodot'
    ? [runtime.runner, '--libgodot', runtime.library, '--parent-pid', String(hostPid), '--', ...godotArgs]
    : [runtime.executable, ...godotArgs]
}

/**
 * Build the import step's argv.
 * @param spec - run parameters.
 * @returns the argv of a headless `--import`.
 */
export function importArgv(spec: GodotRunSpec): string[] {
  return launcherArgv(spec.runtime, spec.hostPid, ['--headless', '--path', spec.project.dir, '--import'])
}

/**
 * Build the game's argv.
 * @param spec - run parameters.
 * @param port - loopback port of the run's server.
 * @param token - handshake token.
 * @returns the argv running the project with the harness as main loop.
 */
export function gameArgv(spec: GodotRunSpec, port: number, token: string): string[] {
  return launcherArgv(spec.runtime, spec.hostPid, [
    '--path', spec.project.dir,
    ...spec.windowless ? ['--embedded'] : [],
    '--script', spec.harnessPath,
    ...spec.muted ? ['--audio-driver', 'Dummy'] : [],
    ...spec.size === undefined ? [] : ['--resolution', `${spec.size.width}x${spec.size.height}`],
    '--', `--wasd-port=${port}`, `--wasd-token=${token}`,
    ...spec.scene === undefined ? [] : [`--wasd-scene=${spec.scene}`],
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
  private silenceTimer: NodeJS.Timeout | undefined
  private disconnectTimer: NodeJS.Timeout | undefined
  private userInputInFlight = false
  private userQueue: GodotInputEvent[] = []
  private exitCode: number | null | undefined
  private exitSignal: string | null | undefined
  private message: string | undefined

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
        ...this.spec.size,
      },
      ...scene === undefined ? {} : { scene },
      ...this.window,
      ...this.progress,
      ...this.renderer === undefined ? {} : { renderer: this.renderer },
      muted: this.spec.muted,
      windowless: this.windowless,
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
   * Stream frames to a sink while it is subscribed; the harness streams only while at least one sink exists.
   * @param sink - frame receiver; an ended run calls `end` at once.
   * @returns the unsubscriber; it never throws, so an abort listener may call it.
   */
  subscribeFrames(sink: FrameSink): () => void {
    if (this.finished) {
      sink.end()
      return () => {}
    }
    this.frameSinks.add(sink)
    if (this.frameSinks.size === 1 && this.connected) this.setStreaming(true)
    return () => {
      if (this.frameSinks.delete(sink) && this.frameSinks.size === 0 && this.connected) this.setStreaming(false)
    }
  }

  /**
   * Capture the game window.
   * @param maxWidth - largest image width; wider windows are scaled down.
   * @param signal - cancellation.
   * @returns metadata and PNG bytes.
   */
  async screenshot(maxWidth: number, signal: AbortSignal): Promise<{ readonly meta: ScreenshotReply; readonly png: Buffer }> {
    const reply = await this.send('screenshot', { format: 'png', maxWidth }, { signal, bounded: true, image: true })
    return { meta: ScreenshotReply.parse(reply.result), png: reply.image as Buffer }
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
    const timeout = AbortSignal.timeout(this.spec.importTimeoutMs)
    const handle = this.deps.subprocess.spawn({
      argv: importArgv(this.spec),
      cwd: this.spec.project.dir,
      stdio: this.collectedStdio(),
      graceMs: this.spec.stopGraceMs,
      signal: AbortSignal.any([this.lifetime.signal, timeout]),
      env: CHILD_ENV,
    })
    let exit: ProcessExit
    try {
      exit = await handle.done
    } catch (error) {
      throw new StartupFailure(`The Godot import step could not start: ${(error as Error).message}`, { cause: error })
    }
    const stdout = reader(handle, 'stdout').readFrom(0).text
    const stderr = reader(handle, 'stderr').readFrom(0).text
    const lines = [...parseEngineOutput(stdout, 'stdout', false), ...parseEngineOutput(stderr, 'stderr', false)]
    const cancelled = this.lifetime.signal.aborted
    const timedOut = !cancelled && timeout.aborted
    if (!cancelled && !timedOut && exit.exitCode !== 0) {
      const crash = crashSummary(stderr) ?? crashSummary(stdout)
      lines.push({
        level: 'warning',
        message: `The Godot import step ended abnormally (${describeExit(exit)}${crash === undefined ? '' : `: ${crash}`}); imported resources may be incomplete.`,
      })
    }
    for (const line of lines) this.append('import', line)
    if (lines.length > 0) this.emit({ type: 'logs' })
    if (timedOut) throw new StartupFailure(`The Godot import step did not finish within ${formatSeconds(this.spec.importTimeoutMs)}.`)
    this.lifetime.signal.throwIfAborted()
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
          if (authenticated) this.logHost(`The game harness sent an invalid message: ${(error as Error).message}`)
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
    this.window = { width: hello.width, height: hello.height }
    this.renderer = `${hello.renderingDriver} / ${hello.renderingMethod}`
    this.godot = hello.godot
    this.windowless = hello.displayServer === 'embedded'
    this.lastActivity = Date.now()
    socket.setNoDelay(true)
    ;(this.server as Server).close()
    for (const other of this.sockets) if (other !== socket) other.destroy()
    this.setPhase('running')
    if (this.frameSinks.size > 0) this.setStreaming(true)
    this.handshake.resolve()
    return true
  }

  private dispatch(message: HarnessMessage): void {
    switch (message.kind) {
      case 'frame':
        for (const sink of this.frameSinks) sink.frame(message.frame)
        return
      case 'image':
        this.receiveImage(message.id, message.data)
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
    if (pending.wantsImage && pending.image === undefined) {
      pending.result = result
      return
    }
    this.settle(result.id, pending)
    pending.resolve({ result, ...pending.image === undefined ? {} : { image: pending.image } })
  }

  private receiveImage(id: number, data: Buffer): void {
    const pending = this.pending.get(id)
    if (pending === undefined || !pending.wantsImage) return
    if (pending.result === undefined) {
      pending.image = data
      return
    }
    this.settle(id, pending)
    pending.resolve({ result: pending.result, image: data })
  }

  private append(source: GodotLogEntry['source'], line: EngineOutputLine | Omit<GodotLogEntry, 'seq' | 'runId' | 'source' | 'time'>): void {
    const message = line.message.length > MAX_LOG_MESSAGE_CHARS ? `${line.message.slice(0, MAX_LOG_MESSAGE_CHARS)}…` : line.message
    const entry: GodotLogEntry = { ...line, message, seq: this.deps.sequence.next(), runId: this.id, source, time: Date.now() }
    this.logs.push(entry)
    if (isErrorEntry(entry)) this.errorCount += 1
    else if (entry.level === 'warning') this.warningCount += 1
  }

  private logHost(message: string): void {
    this.append('process', { level: 'error', message })
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
    const entry: Pending = {
      wantsImage: options.image === true,
      cancelable: !options.bounded,
      resolve,
      reject,
      dispose: () => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
      },
    }
    this.pending.set(id, entry)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.bounded) {
      timer = setTimeout(() => {
        this.settle(id, entry)
        reject(new GodotRequestError(`The game did not answer ${type} within ${formatSeconds(this.spec.requestTimeoutMs)}.`))
      }, this.spec.requestTimeoutMs)
    }
    this.armSilence()
    connection.write(encodeJsonMessage({ ...params, type, id }))
    return promise
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
    const connection = this.connection
    if (!entry.cancelable || connection === undefined || this.stopRequested) return
    this.nextRequestId += 1
    connection.write(encodeJsonMessage({ type: 'cancel', id: this.nextRequestId, request: id }))
  }

  private rejectPending(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.abandon(id, entry)
      entry.reject(error)
    }
  }

  /** Fail every waiting request once the harness has sent nothing for `requestTimeoutMs`. */
  private armSilence(): void {
    if (this.silenceTimer !== undefined) return
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined
      const silent = Date.now() - this.lastActivity
      if (silent >= this.spec.requestTimeoutMs) {
        this.rejectPending(new GodotRequestError(`The game stopped responding: it sent nothing for ${formatSeconds(silent)}.`))
        return
      }
      this.armSilence()
    }, Math.max(0, this.spec.requestTimeoutMs - (Date.now() - this.lastActivity)))
  }

  private setStreaming(on: boolean): void {
    const { fps, quality, maxWidth, lossless } = this.spec.stream
    const params = on ? { fps, quality, maxWidth, lossless } : { fps: 0 }
    this.send('stream', params, { signal: this.lifetime.signal, bounded: true }).catch((error: unknown) => {
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
      this.finish('exited', exit, undefined)
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
      this.finish('exited', exit, undefined)
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
    this.connection = undefined
    this.rejectPending(new GodotRunStateError('The game is no longer running.'))
    for (const socket of this.sockets) socket.destroy()
    this.server?.close()
    this.lifetime.abort(new Error('Godot run ended'))
    this.userQueue = []
    for (const sink of [...this.frameSinks]) sink.end()
    this.frameSinks.clear()
    this.bump()
    this.emit({ type: 'end' })
    void (this.exit ?? Promise.resolve()).then(() => { this.ended.resolve() })
  }

  private async shutdown(): Promise<void> {
    this.stopRequested = true
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
