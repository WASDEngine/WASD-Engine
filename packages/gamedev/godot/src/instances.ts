/**
 * Groups of headless instances: several LibGodot processes of one project that run its main scene at once, each with
 * environment entries of its own, such as a multiplayer game's server and its clients in a local test. Every instance
 * runs `--headless --path <project>`, starts after its own delay, and is stopped at the group's deadline; the report
 * keeps each instance's exit and the end of its output.
 * @module @deepseek-ai/dsh-godot/src/instances
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runGodotCommand } from './command.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'
import type { GodotInstanceReport, GodotInstanceSpec } from './types.ts'

/** Most characters of each output stream an instance report keeps: the end, where a game prints its summary. */
export const INSTANCE_OUTPUT_CHARS = 20_000

/** Parameters of one group of instances. */
export interface InstanceGroupOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Runtime to launch. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute project folder. */
  readonly projectDir: string
  /** The instances, in report order. */
  readonly instances: readonly GodotInstanceSpec[]
  /** Deadline of the group from its start, in milliseconds. */
  readonly timeoutMs: number
  /** Host process id for the runner's parent watch. */
  readonly hostPid: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation; it stops every instance. */
  readonly signal: AbortSignal
}

function tail(text: string): string {
  return text.length > INSTANCE_OUTPUT_CHARS ? text.slice(text.length - INSTANCE_OUTPUT_CHARS) : text
}

/** Wait `ms`, or less when `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Run every instance of a group at once, each after its own delay, until each ends or the group's deadline passes.
 * @param options - runtime, project, instances, deadline, and process limits.
 * @returns one report per instance, in request order.
 * @throws the abort reason when `signal` aborts; the subprocess service's error when an instance cannot start.
 */
export async function runInstanceGroup(options: InstanceGroupOptions): Promise<GodotInstanceReport[]> {
  const started = Date.now()
  const reports = await Promise.all(options.instances.map(async (instance): Promise<GodotInstanceReport> => {
    await delay(instance.delayMs, options.signal)
    options.signal.throwIfAborted()
    const remaining = Math.max(1, options.timeoutMs - (Date.now() - started))
    const outcome = await runGodotCommand({
      subprocess: options.subprocess,
      argv: launcherArgv(options.runtime, options.hostPid, ['--headless', '--path', options.projectDir]),
      cwd: options.projectDir,
      timeoutMs: remaining,
      graceMs: options.graceMs,
      outputBytes: options.outputBytes,
      signal: options.signal,
      env: instance.env,
    })
    return {
      name: instance.name,
      exitCode: outcome.timedOut ? null : outcome.exit.exitCode,
      timedOut: outcome.timedOut,
      stdout: tail(outcome.stdout),
      stderr: tail(outcome.stderr),
    }
  }))
  options.signal.throwIfAborted()
  return reports
}
