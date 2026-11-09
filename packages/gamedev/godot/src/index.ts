/**
 * Run, test, and play Godot games: the Host owner of game runs, the `godot_*` tools, the Game tab's `godot`
 * Remote namespace, and the `GET /api/godot.frames` frame stream.
 * @module @deepseek-ai/dsh-godot
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { materializePayload } from '@deepseek-ai/dsh-app-mcp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { untilAborted } from './abort.ts'
import { checkScripts, selectScripts, type CheckReport, type CheckRequest } from './check.ts'
import { followSession } from './follow.ts'
import { serveFrames } from './frames.ts'
import { GodotInputError, parseInputEvents, parseWindowSize } from './input.ts'
import { LogSequence } from './logs.ts'
import { godotMcpProvider } from './mcp.ts'
import { GodotProjectError, resolveGodotProject, resolveScene } from './project.ts'
import { GodotRequestError, GodotRun, GodotRunStateError, MAX_INPUT_EVENTS } from './run.ts'
import { GodotSessionError, GodotSessions, TooManyRunsError } from './runs.ts'
import {
  bundledRuntimeRoot, createRuntimeHost, GodotRuntimeError, GodotRuntimeManager, RUNTIME_MISSING_MESSAGE, type ResolvedGodotRuntime,
} from './runtime.ts'
import { registerGodotTools, type GodotToolHost } from './tools.ts'
import type {
  GodotControlRequest, GodotFollowItem, GodotInputEvent, GodotRunRequest, GodotRunStarter, GodotRunView, GodotRuntimeView,
} from './types.ts'

export type * from './types.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute folder for the managed runtime and copies of the harness scripts. */
  dataRoot: string
  /** Managed LibGodot runtime version. */
  runtimeVersion: string
  /** Release manifest of the managed runtime. */
  runtimeManifestUrl: string
  /** Absolute LibGodot library; set together with `runnerPath`. Empty uses the managed runtime. */
  libgodotPath: string
  /** Absolute `godot_runner`; set together with `libgodotPath`. */
  runnerPath: string
  /** Frames per second streamed to the Game tab. */
  streamFps: number
  /** JPEG quality of streamed JPEG frames, 0.1 to 1. */
  streamQuality: number
  /**
   * Stream lossless PNG frames while PNG encoding keeps up with `streamFps`, and JPEG frames otherwise; `false` streams
   * only JPEG frames.
   */
  streamLossless: boolean
  /** Largest streamed frame width in pixels. */
  streamMaxWidth: number
  /** Import the project's assets before each run. */
  importBeforeRun: boolean
  /** Deadline of the import step and of `godot_check`, in milliseconds. */
  importTimeoutMs: number
  /** Deadline from launch until the game connects, in milliseconds. */
  startTimeoutMs: number
  /**
   * Deadline of instantaneous game requests, the longest silence of a running game while a request waits, and the
   * real time that a wait, a step, or an agent input sequence may take beyond the time it needs, in milliseconds.
   */
  requestTimeoutMs: number
  /** Grace between asking a game to quit and terminating it, in milliseconds. */
  stopGraceMs: number
  /** Bytes of process output kept per stream for diagnostics. */
  processOutputBytes: number
  /** Log entries kept per run. */
  maxLogEntries: number
  /** Games that may run at once across Sessions, each counted until its process ended. */
  maxRuns: number
  /** Whether games the agent starts run without audio unless the call says otherwise. */
  agentRunsMuted: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Godot game runs, tools, and the Game tab Remote. */
    godot: GodotController
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * The Godot release, `major.minor`, of the runtime that the plugin ships or installs: the start of `runtimeVersion`,
 * such as `4.7` for `4.7.2-wasd.1`, which the shipped and managed runtimes must match.
 * @param config - the plugin configuration.
 * @returns the release, or undefined when `libgodotPath` and `runnerPath` name another runtime or `runtimeVersion` does not start with one.
 */
function godotRelease(config: Pick<Config, 'runtimeVersion' | 'libgodotPath'>): string | undefined {
  if (config.libgodotPath !== '') return undefined
  return /^(\d+\.\d+)(?=[.+-]|$)/u.exec(config.runtimeVersion)?.[1]
}

/**
 * The `godot` system prompt section.
 * @param release - the Godot release that the tools run, when known.
 * @returns the section text.
 */
function godotPrompt(release: string | undefined): string {
  const builtIn = release === undefined
    ? 'Godot is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. '
      + 'Do not look for one or download one. For a new game, first write project.godot, a main scene, and its scripts.'
    : `Godot ${release} is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. `
      + `Do not look for one or download one. Write code for Godot ${release}. For a new game, first write project.godot, whose `
      + `config/features starts with "${release}", a main scene, and its scripts.`
  return `# Godot games

${builtIn}

Test a Godot project with the godot_* tools:
1. godot_run starts or restarts the game and reports import and startup errors.
2. godot_screenshot shows the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_performance measures frame times, rendering, and memory; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.
The user can watch and play the running game in the Game panel.`
}

/** A Godot runtime does not resolve. */
class GodotUnavailableError extends Error {
  override name = 'GodotUnavailableError'
}

function validateConfig(config: Config): void {
  if (!isAbsolute(config.dataRoot)) throw new Error(`Godot plugin: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}.`)
  if ((config.libgodotPath === '') !== (config.runnerPath === '')) throw new Error('Godot plugin: set libgodotPath and runnerPath together.')
  for (const [field, value] of [['libgodotPath', config.libgodotPath], ['runnerPath', config.runnerPath]] as const) {
    if (value !== '' && !isAbsolute(value)) throw new Error(`Godot plugin: ${field} must be an absolute path, got ${JSON.stringify(value)}.`)
  }
  if (!URL.canParse(config.runtimeManifestUrl) || !/^https?:$/u.test(new URL(config.runtimeManifestUrl).protocol)) {
    throw new Error(`Godot plugin: runtimeManifestUrl must be an http or https URL, got ${JSON.stringify(config.runtimeManifestUrl)}.`)
  }
}

/** @returns the refusal of a request for a run that the Session does not have, or that does not accept requests. */
function notRunning(): RemoteError<'godot/not-running'> {
  return new RemoteError('godot/not-running', 'The game is not running.', {})
}

/** Map a run failure to the Remote failure the Game tab shows. */
function remoteFailure(error: unknown): unknown {
  if (error instanceof GodotProjectError) return new RemoteError('godot/no-project', error.message, { directory: error.directory }, { cause: error })
  if (error instanceof GodotRuntimeError || error instanceof GodotUnavailableError) {
    return new RemoteError('godot/runtime-unavailable', error.message, { message: error.message }, { cause: error })
  }
  if (error instanceof TooManyRunsError) return new RemoteError('godot/too-many-runs', error.message, { limit: error.limit }, { cause: error })
  if (error instanceof GodotRunStateError || error instanceof GodotSessionError) return new RemoteError('godot/not-running', error.message, {}, { cause: error })
  if (error instanceof GodotRequestError) return new RemoteError('godot/request-failed', error.message, { message: error.message }, { cause: error })
  if (error instanceof GodotInputError) return new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
  return error
}

/** Host owner of Godot runs: tools for the agent, a Remote for the Game tab, and the frame stream. */
export default class GodotController extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'workingDirectory', 'subprocess', 'agents', 'typert']
  static Config: z<Partial<Config> & Pick<Config, 'dataRoot'>, Config> = z.object({
    dataRoot: z.string().required(),
    runtimeVersion: z.string().pattern(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u).default('4.7.2-wasd.1'),
    runtimeManifestUrl: z.string().default('https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.1/manifest.json'),
    libgodotPath: z.string().default(''),
    runnerPath: z.string().default(''),
    streamFps: z.number().min(1).max(60).default(30),
    streamQuality: z.number().min(0.1).max(1).default(0.9),
    streamLossless: z.boolean().default(true),
    streamMaxWidth: z.number().step(1).min(64).max(4096).default(1280),
    importBeforeRun: z.boolean().default(true),
    importTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(180_000),
    startTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(60_000),
    requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(15_000),
    stopGraceMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(3000),
    processOutputBytes: z.number().step(1).min(1024).default(1024 * 1024),
    maxLogEntries: z.number().step(1).min(1).default(5000),
    maxRuns: z.number().step(1).min(1).default(4),
    agentRunsMuted: z.boolean().default(true),
  })

  private readonly sequence = new LogSequence()
  private readonly sessions: GodotSessions
  private readonly runtime: GodotRuntimeManager
  private readonly runtimeWatchers = new Set<() => void>()
  private payload: Promise<{ readonly harness: string; readonly check: string }> | undefined

  /**
   * @param ctx - plugin context with tool, prompt, working-directory, subprocess, and Agent services.
   * @param config - validated configuration; invalid paths fail the plugin load.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'godot', { namespace: 'godot' })
    validateConfig(config)
    this.sessions = new GodotSessions(ctx, config.maxRuns)
    const host = createRuntimeHost(ctx.subprocess, { outputBytes: config.processOutputBytes, graceMs: config.stopGraceMs })
    // The desktop app's packaging puts the runtime it ships in this package's `libgodot` folder.
    const bundledRoot = bundledRuntimeRoot(resolve(fileURLToPath(new URL('..', import.meta.url))))
    this.runtime = new GodotRuntimeManager({ ...config, bundledRoot }, host, () => {
      for (const watcher of [...this.runtimeWatchers]) watcher()
    })
    ctx.effect(() => async () => {
      this.runtime.dispose()
      await this.sessions.dispose()
    }, 'godot.runs')
    const toolHost: GodotToolHost = {
      sessions: this.sessions,
      agentRunsMuted: config.agentRunsMuted,
      run: async (agent, request, signal) => {
        const run = await this.startRun(agent, request, 'agent', signal)
        await untilAborted(run.started(), signal)
        return run
      },
      check: (agent, request, signal) => this.check(agent, request, signal),
    }
    registerGodotTools(ctx, toolHost)
    const release = godotRelease(config)
    // Agents connected through WASD Engine's MCP server get the same tools, for Sessions of their own.
    ctx.inject(['gameMcp'], (inner) => {
      inner.effect(() => inner.gameMcp.provide(godotMcpProvider(toolHost, signal => this.runtime.view(signal), release)), 'godot: game MCP tools')
    })
    ctx.systemPrompt.section({ name: 'godot', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: godotPrompt(release) })
    ctx.inject(['connection'], (inner) => {
      inner.effect(() => inner.connection.fetch.register({
        path: '/api/godot.frames',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: request => Promise.resolve(serveFrames(request, (sessionId, runId) => {
          const run = this.sessions.find(brandString<SessionId>(sessionId))?.run
          return run?.id === runId ? run : undefined
        })),
      }), 'godot: /api/godot.frames')
    })
  }

  /**
   * Follow the Session's game for the Game tab, without resuming the Session: a Session without a live Agent
   * reports no run until its Agent starts one.
   * @param sessionId - followed Session.
   * @param signal - stream cancellation.
   * @returns a snapshot, then run, log, and runtime changes until cancelled or the plugin is disposed.
   */
  @Remote({ mode: 'stream' })
  follow(sessionId: SessionId, signal: AbortSignal): AsyncIterable<GodotFollowItem> {
    return followSession({
      run: () => this.sessions.find(sessionId)?.run,
      watch: watcher => this.sessions.watch(sessionId, watcher),
      runtimeView: viewSignal => this.runtime.view(viewSignal),
      latestRuntime: () => this.runtime.latest(),
      watchRuntime: (listener) => {
        this.runtimeWatchers.add(listener)
        return () => { this.runtimeWatchers.delete(listener) }
      },
    }, signal)
  }

  /**
   * Start or restart the Session's game from the Game tab; audio plays unless `muted` is set. A Session without a
   * live Agent is resumed first, as a prompt resumes it.
   * @param sessionId - Session whose game starts.
   * @param request - project, scene, window size, and audio.
   * @param signal - cancellation before launch; a resume or a launched run continues for the Session.
   * @returns the new run, launched; the follow stream reports its progress.
   */
  @Remote
  async run(sessionId: SessionId, request: GodotRunRequest, signal: AbortSignal): Promise<GodotRunView> {
    try {
      // A malformed size fails before it resumes the Session.
      parseWindowSize(request.width, request.height)
      const agent = await this.activate(sessionId, signal)
      return (await this.startRun(agent, { ...request, muted: request.muted ?? false }, 'user', signal)).view()
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Stop the Session's game.
   * @param sessionId - Session whose run stops.
   * @param signal - cancellation of the wait; stopping continues.
   * @returns after the game ended; `godot/not-running` when the Session has no run.
   */
  @Remote
  async stop(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    const session = this.sessions.find(sessionId)
    if (session?.run === undefined) throw notRunning()
    await untilAborted(this.sessions.stop(session), signal)
  }

  /**
   * Pause, resume, or step the Session's game.
   * @param sessionId - Session whose run changes.
   * @param request - action and step frames.
   * @param signal - cancellation.
   * @returns the run after the change.
   */
  @Remote
  async control(sessionId: SessionId, request: GodotControlRequest, signal: AbortSignal): Promise<GodotRunView> {
    const frames = request.frames ?? 1
    if (!Number.isInteger(frames) || frames < 1 || frames > 100_000) throw new RemoteError('gateway/bad-request', 'frames must be an integer from 1 to 100000.', {})
    const run = this.sessions.find(sessionId)?.run
    if (run === undefined || !run.connected) throw notRunning()
    try {
      if (request.action === 'step') await run.step(frames, signal)
      else await run.setPaused(request.action === 'pause', signal)
    } catch (error) {
      throw remoteFailure(error)
    }
    return run.view()
  }

  /**
   * Send user input to the Session's game without waiting for the game to apply it.
   * @param sessionId - Session whose run receives the input.
   * @param runId - run the input was meant for.
   * @param events - at most 256 events in game window pixels.
   * @param signal - cancellation.
   */
  @Remote
  input(sessionId: SessionId, runId: string, events: GodotInputEvent[], signal: AbortSignal): void {
    signal.throwIfAborted()
    const run = this.sessions.find(sessionId)?.run
    if (run === undefined) throw notRunning()
    if (run.id !== runId) throw new RemoteError('godot/stale-run', 'The input was meant for a game that is no longer current.', { runId })
    try {
      run.sendUserInput(parseInputEvents(events, MAX_INPUT_EVENTS))
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Install the managed LibGodot runtime, or join the install already running.
   * @param signal - stops this wait; the install continues.
   * @returns the runtime view after the install settled.
   */
  @Remote
  async installRuntime(signal: AbortSignal): Promise<GodotRuntimeView> {
    return this.runtime.install(signal)
  }

  /**
   * The Session's live Agent, resumed through the Session controller when the Session has none, as the GUI resumes
   * it for a prompt.
   * @throws the controller's Session failure, such as `session/not-found` or `session/writer-held`.
   */
  private async activate(sessionId: SessionId, signal: AbortSignal): Promise<Agent> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new Error('Godot plugin: starting a game from the Game tab needs the sessionController service, which this Host does not compose.')
    }
    // A cancelled call starts no resume; cancellation stops only this wait for a resume that began.
    signal.throwIfAborted()
    const result = await untilAborted(controller.resolveAgent(sessionId), signal)
    if ('error' in result) throw result.error
    return result.agent
  }

  private scripts(): Promise<{ readonly harness: string; readonly check: string }> {
    this.payload ??= Promise.all([
      materializePayload(new URL('../runtime/wasd_harness.gd', import.meta.url), this.config.dataRoot),
      materializePayload(new URL('../runtime/wasd_check.gd', import.meta.url), this.config.dataRoot),
    ]).then(([harness, check]) => ({ harness, check }), (error: unknown) => {
      this.payload = undefined
      throw error
    })
    return this.payload
  }

  private async requireRuntime(signal: AbortSignal): Promise<ResolvedGodotRuntime> {
    const runtime = await this.runtime.resolve(signal)
    if (runtime === undefined) throw new GodotUnavailableError(RUNTIME_MISSING_MESSAGE)
    return runtime
  }

  private async startRun(
    agent: Agent,
    request: GodotRunRequest & { readonly muted: boolean },
    startedBy: GodotRunStarter,
    signal: AbortSignal,
  ): Promise<GodotRun> {
    const size = parseWindowSize(request.width, request.height)
    const session = this.sessions.session(agent)
    const workingDirectory = await this.ctx.workingDirectory.ensure(agent, signal)
    const project = await resolveGodotProject(workingDirectory, request.project, signal)
    const scene = request.scene === undefined ? undefined : await resolveScene(project, request.scene)
    const runtime = await this.requireRuntime(signal)
    const { harness } = await this.scripts()
    signal.throwIfAborted()
    const config = this.config
    return this.sessions.replace(session, () => GodotRun.launch({
      runId: randomUUID(),
      startedBy,
      project,
      ...scene === undefined ? {} : { scene },
      ...size === undefined ? {} : { size },
      muted: request.muted,
      runtime,
      windowless: this.runtime.windowless(),
      harnessPath: harness,
      hostPid: process.pid,
      importBeforeRun: config.importBeforeRun,
      importTimeoutMs: config.importTimeoutMs,
      startTimeoutMs: config.startTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      stopGraceMs: config.stopGraceMs,
      outputBytes: config.processOutputBytes,
      maxLogEntries: config.maxLogEntries,
      stream: { fps: config.streamFps, quality: config.streamQuality, maxWidth: config.streamMaxWidth, lossless: config.streamLossless },
    }, {
      subprocess: this.ctx.subprocess,
      sequence: this.sequence,
      warn: (message) => { this.ctx.logger.warn(message) },
    }))
  }

  private async check(agent: Agent, request: CheckRequest, signal: AbortSignal): Promise<CheckReport> {
    const session = this.sessions.session(agent)
    const workingDirectory = await this.ctx.workingDirectory.ensure(agent, signal)
    const current = session.run?.project
    const project = request.project === undefined && current !== undefined
      ? current
      : await resolveGodotProject(workingDirectory, request.project, signal)
    const selection = await selectScripts(project.dir, workingDirectory, request.paths, signal)
    if (selection.paths.length === 0) return { projectDir: project.dir, scripts: [], total: 0 }
    const runtime = await this.requireRuntime(signal)
    const { check } = await this.scripts()
    const scripts = await checkScripts({
      subprocess: this.ctx.subprocess,
      runtime,
      projectDir: project.dir,
      checkScript: check,
      paths: selection.paths,
      hostPid: process.pid,
      timeoutMs: this.config.importTimeoutMs,
      graceMs: this.config.stopGraceMs,
      outputBytes: this.config.processOutputBytes,
      signal,
    })
    return { projectDir: project.dir, scripts, total: selection.total }
  }
}
