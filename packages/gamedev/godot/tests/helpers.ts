/** Shared fixtures for the Godot Host specs: temporary projects, the fake Godot executable, and run specs. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LogSequence } from '../src/logs.ts'
import { GodotRun, type GodotRunSpec } from '../src/run.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-godot.mjs', import.meta.url))

/** Behavior of the fake Godot executable; see tests/fixtures/fake-godot.mjs. */
export interface FakeGodotConfig {
  readonly import?: Record<string, unknown>
  readonly check?: Record<string, unknown>
  readonly game?: Record<string, unknown>
}

/** A temporary folder owned by one spec. */
export interface Scratch {
  readonly root: string
  /** Executable that runs the fake Godot with this process's Node. */
  readonly fakeGodot: string
  cleanup(): Promise<void>
}

/** Quote one word for `sh`. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Create a scratch folder holding an executable that runs the fake Godot. The fixture is a module without a
 * shebang, so a shell script starts it with the Node that runs the spec.
 * @param prefix - folder name prefix.
 * @returns the folder.
 */
export async function scratch(prefix: string): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), `dsh-godot-${prefix}-`))
  const fakeGodot = join(root, 'fake-godot')
  await writeFile(fakeGodot, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(FIXTURE)} "$@"\n`)
  await chmod(fakeGodot, 0o755)
  return { root, fakeGodot, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * Write a Godot project for the fake.
 * @param dir - project folder.
 * @param config - fake behavior.
 * @param settings - project.godot fields.
 * @param settings.name - application/config/name.
 * @returns the folder.
 */
export async function writeProject(dir: string, config: FakeGodotConfig = {}, settings: { readonly name?: string } = { name: 'Fake game' }): Promise<string> {
  await mkdir(dir, { recursive: true })
  const lines = ['config_version=5', '', '[application]', '']
  if (settings.name !== undefined) lines.push(`config/name="${settings.name}"`)
  lines.push('run/main_scene="res://main.tscn"', '')
  await writeFile(join(dir, 'project.godot'), lines.join('\n'))
  await writeFile(join(dir, 'main.tscn'), '[gd_scene format=3]\n')
  await writeFile(join(dir, 'fake-godot.json'), JSON.stringify(config))
  return dir
}

/**
 * Replace the fake behavior of a project.
 * @param dir - project folder.
 * @param config - fake behavior.
 */
export async function configureFake(dir: string, config: FakeGodotConfig): Promise<void> {
  await writeFile(join(dir, 'fake-godot.json'), JSON.stringify(config))
}

/**
 * Read what the fake recorded.
 * @param dir - project folder.
 * @returns recorded entries in order.
 */
export async function fakeLog(dir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, 'fake-godot.log'), 'utf8').catch(() => '')
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Requests the fake game received.
 * @param dir - project folder.
 * @returns request messages in order.
 */
export async function fakeRequests(dir: string): Promise<Array<Record<string, unknown>>> {
  return (await fakeLog(dir)).flatMap(entry => entry.request === undefined ? [] : [entry.request as Record<string, unknown>])
}

/** A Context with the local subprocess service, owned by one spec. */
export interface SubprocessFixture {
  readonly ctx: Context
  readonly subprocess: SubprocessRuntime
}

/**
 * Mount the local subprocess service.
 * @returns the Context and service; dispose the Context's fiber in teardown.
 */
export async function subprocessFixture(): Promise<SubprocessFixture> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, subprocess: ctx.subprocess }
}

/**
 * Build a run spec that launches the fake as a Godot executable.
 * @param fakeGodot - executable path.
 * @param project - project folder.
 * @param overrides - fields to replace.
 * @returns the spec.
 */
export function runSpec(fakeGodot: string, project: string, overrides: Partial<GodotRunSpec> = {}): GodotRunSpec {
  return {
    runId: 'run-1',
    startedBy: 'agent',
    project: { dir: project, name: 'Fake game', mainScene: 'res://main.tscn' },
    muted: true,
    runtime: { kind: 'executable', executable: fakeGodot },
    windowless: false,
    harnessPath: join(project, 'harness.gd'),
    hostPid: process.pid,
    importBeforeRun: false,
    importTimeoutMs: 10_000,
    startTimeoutMs: 10_000,
    requestTimeoutMs: 5000,
    stopGraceMs: 1000,
    outputBytes: 64 * 1024,
    maxLogEntries: 100,
    stream: { fps: 50, quality: 0.5, maxWidth: 320 },
    ...overrides,
  }
}

/**
 * Launch a run of the fake.
 * @param subprocess - local subprocess service.
 * @param spec - run spec.
 * @param warnings - receives Host diagnostics.
 * @param sequence - log sequence shared with other runs.
 * @returns the run.
 */
export function launch(subprocess: SubprocessRuntime, spec: GodotRunSpec, warnings: string[] = [], sequence = new LogSequence()): GodotRun {
  return GodotRun.launch(spec, { subprocess, sequence, warn: (message) => { warnings.push(message) } })
}

/**
 * Wait until a condition holds.
 * @param condition - polled condition.
 * @param timeoutMs - deadline.
 */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('condition did not hold in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
