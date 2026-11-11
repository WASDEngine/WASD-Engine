/**
 * The SuperCollider tools against real SuperCollider: the headless runtime that the Desktop app ships, when this
 * checkout holds one in the package's `runtime/` folder, through the bridge from source under tsx, behind a real worker
 * pool, and the tools as the agent calls them. The tools never start an installed SuperCollider, so the suite
 * skips without the runtime; it owns a temporary data directory and every process it starts.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JsonLineWorker, WorkerPool, materializePayload } from '@deepseek-ai/dsh-app-mcp'
import type { AppToolDependencies, AppToolResult } from '@deepseek-ai/dsh-app-mcp'
import { bundledRuntimeRoot, findBundledRuntime, nodeSuperColliderSetupHost, SuperColliderWorkers } from '../src/environment.ts'
import { superColliderTools } from '../src/tools.ts'
import type { SuperColliderServerOptions } from '../src/types.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const WORKER_ENTRY = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
const WORKER_CLASS = new URL('../sc/WasdWorker.sc', import.meta.url)
/** Scope of the tool calls, as a Session's calls reach the server. */
const SESSION = 'session:e2e'
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
const host = { ...nodeSuperColliderSetupHost(), env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG } }

const bundled = await findBundledRuntime(bundledRuntimeRoot(PACKAGE), host)
const runtimes = [
  { name: 'shipped runtime', bundledRoot: bundledRuntimeRoot(PACKAGE), sclangPath: '', available: bundled !== undefined },
]

/** Resolve whether no process of group `pgid` is left within `ms`. */
async function groupEnds(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0)
    } catch {
      // ESRCH: no process of the group is left.
      return true
    }
    await sleep(100)
  }
  return false
}

function wavFrames(bytes: Buffer): number {
  // The renders use canonical 44-byte headers: 16-bit samples, the channel count at byte 22, and the data size at byte 40.
  return bytes.readUInt32LE(40) / (2 * bytes.readUInt16LE(22))
}

describe.each(runtimes)('SuperCollider tools with the $name', ({ bundledRoot, sclangPath, available }) => {
  let dataRoot = ''
  let pool: WorkerPool | undefined
  let run: (name: string, args: Record<string, unknown>) => Promise<AppToolResult> = async () => { throw new Error('not started') }

  beforeAll(async () => {
    if (!available) return
    dataRoot = await mkdtemp(join(tmpdir(), 'dsh-supercollider-e2e-'))
    const options: SuperColliderServerOptions = {
      dataRoot, sclangPath, scsynthPath: '', readyTimeoutMs: 120_000, requestTimeoutMs: 120_000, toolCallTimeoutMs: 150_000, graceMs: 3000,
      maxLogBytes: 65_536, maxWorkers: 4, workerIdleTimeoutMs: 600_000,
    }
    const started = new SuperColliderWorkers<JsonLineWorker>(options, {
      host, bundledRoot, bridge: [process.execPath, '--import', import.meta.resolve('tsx/esm'), WORKER_ENTRY],
      workerScript: async () => await materializePayload(WORKER_CLASS, dataRoot),
      start: async (spec, signal) => await JsonLineWorker.start(spec, signal),
    })
    pool = new WorkerPool({
      app: 'SuperCollider', root: join(dataRoot, 'workers'), start: async (signal, scope) => await started.start(signal, scope),
      takeNotes: () => started.takeNotes(), maxWorkers: options.maxWorkers, idleTimeoutMs: options.workerIdleTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs, closeGraceMs: options.graceMs,
    })
    const active = pool
    const dependencies: AppToolDependencies = {
      call: async (method, params, callOptions) => await active.call(SESSION, method, params, callOptions),
      takeNotes: () => active.takeNotes(SESSION),
      dataRoot,
      requestTimeoutMs: options.requestTimeoutMs,
      maxTimeoutMs: options.toolCallTimeoutMs - 30_000,
    }
    const tools = new Map(superColliderTools(dependencies).map(tool => [tool.name, tool]))
    run = async (name, args) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`missing tool ${name}`)
      return await tool.run(args, new AbortController().signal)
    }
  }, 180_000)

  afterAll(async () => {
    await pool?.close()
    if (dataRoot !== '') await rm(dataRoot, { recursive: true, force: true })
  })

  it.skipIf(!available)('runs code, renders functions, patterns, and scores into every format, and analyzes them', async () => {
    const first = await run('execute_sclang', {
      code: 'SynthDef(\\blip, { |freq = 440, amp = 0.2| Out.ar(0, Pan2.ar(SinOsc.ar(freq) * Env.perc(0.005, 0.2).kr(2) * amp)) }).add; ~x = 7; "added".postln; 1 + 2',
    })
    expect(first.text).toMatch(/^SuperCollider 3\.\d+\.\d+ started \(.+\) with no SynthDefs or variables defined\.\n\n/u)
    expect(first.text).toMatch(/\n\nresult \(Integer\): 3\n\noutput:\nadded$/u)
    await expect(run('execute_sclang', { code: '0.1.wait; ~x * 2' })).resolves.toEqual({ text: 'result (Integer): 14', isError: false })
    await expect(run('execute_sclang', { code: 's.boot' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('real-time server cannot boot') as string })
    await expect(run('execute_sclang', { code: '1.foo' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining("Message 'foo' not understood.") as string })
    await expect(run('execute_sclang', { code: '1 +* ' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('syntax error') as string })

    const wav = join(dataRoot, 'game', 'sfx', 'jump.wav')
    const jump = await run('render_audio', { code: '{ SinOsc.ar(XLine.kr(1200, 300, 0.2)) * Env.perc(0.005, 0.4).kr(2) }', path: wav, duration: 0.5, normalize_db: -1 })
    expect(jump.text).toContain(`Rendered 0.500 s of mono audio at 44100 Hz from the function to ${wav} (WAV, int16,`)
    expect(jump.text).toContain('Levels: peak -1.0 dBFS')
    expect(jump.images).toHaveLength(1)
    expect(wavFrames(await readFile(wav))).toBe(22_050)

    const ogg = join(dataRoot, 'game', 'music', 'loop.ogg')
    const loop = await run('render_audio', { code: 'Pbind(\\instrument, \\blip, \\degree, Pseq([0, 2, 4, 7], inf), \\dur, 0.25)', path: ogg, duration: 2 })
    expect(loop.text).toContain('of stereo audio at 44100 Hz from the pattern')
    expect(loop.text).toContain('(OGG, vorbis,')
    const window = await run('analyze_audio', { path: ogg, start: 0.5, end: 1.5 })
    expect(window.text).toMatch(/: OGG, vorbis, stereo, 44100 Hz, 2\.\d{3} s, .+\. Analyzed 0\.500 s to 1\.500 s\./u)
    expect(window.text).toMatch(/Spectrum: strongest component \d+/u)

    const aiff = join(dataRoot, 'game', 'score.aiff')
    await expect(run('render_audio', { code: 'Score([[0.0, [\\s_new, \\blip, 2000, 0, 0, \\freq, 660]]])', path: aiff, duration: 0.5, channels: 2 }))
      .resolves.toMatchObject({ text: expect.stringContaining('from the Score') as string })
    const flac = join(dataRoot, 'game', 'own-out.flac')
    await expect(run('render_audio', { code: '{ Out.ar(0, Saw.ar(110) * 0.1 ! 2) }', path: flac, duration: 0.25, sample_format: 'int24', sample_rate: 48_000 }))
      .resolves.toMatchObject({ text: expect.stringContaining('(FLAC, int24,') as string })
    for (const file of [aiff, flac]) expect((await stat(file)).size).toBeGreaterThan(1000)
    await expect(run('render_audio', { code: '{ SinOsc.kr(3) }', path: join(dataRoot, 'bad.wav'), duration: 1 }))
      .rejects.toMatchObject({ code: 'WORKER_REMOTE', message: expect.stringContaining('control-rate signals') as string })
    // LocalOut feeds back inside the synth and Out.kr writes a control bus: the returned signal is still what plays.
    const feedback = await run('render_audio', {
      code: '{ var source = Decay.ar(Impulse.ar(4), 0.1) * WhiteNoise.ar(0.2); var local = LocalIn.ar(2) + [source, 0]; '
        + 'local = DelayN.ar(local, 0.2, 0.2); LocalOut.ar(local.reverse * 0.8); Out.kr(0, SinOsc.kr(1)); local }',
      path: join(dataRoot, 'game', 'feedback.wav'), duration: 0.5,
    })
    expect(feedback.text).toContain('of stereo audio at 44100 Hz from the function')
    expect(feedback.text).not.toContain('Silence: the audio is completely silent.')
    await expect(run('render_audio', { code: 'SynthDef(\\inside, { LocalOut.ar(SinOsc.ar(440)) })', path: join(dataRoot, 'inside.wav'), duration: 0.25 }))
      .rejects.toMatchObject({ code: 'WORKER_REMOTE', message: expect.stringContaining('writes no audio to a bus with Out.ar') as string })

    const info = await run('class_info', { names: ['SinOsc', 'NoSuchClass'] })
    expect(info.text).toContain('SinOsc : PureUGen : UGen')
    expect(info.text).toContain('ar(freq: 440.0, phase: 0.0, mul: 1.0, add: 0.0)')
    expect(info.text).toContain('Summary: Interpolating sine wavetable oscillator.')
    expect(info.text).toContain('NoSuchClass: no such class.')
    await expect(run('class_info', { search: 'reverb' })).resolves.toMatchObject({ text: expect.stringContaining('GVerb: A two-channel reverb') as string })
    // Every render and analysis deleted its files, so the scratch folder of the Session's worker is empty.
    expect(await readdir(join(dataRoot, 'workers', String(process.pid), '1', 'scratch'))).toEqual([])
  }, 180_000)

  // Process groups and ps exist on macOS and Linux only.
  it.skipIf(!available || process.platform === 'win32')('reports a stopped interpreter once, starts a fresh one, and leaves no process behind on close', async () => {
    // The bridge leads the worker's process group, and sclang and its scsynth renders belong to it.
    const reply = await run('execute_sclang', { code: '~kept = 1; ("ps -o pgid= -p " ++ thisProcess.pid).unixCmdGetStdOut.stripWhiteSpace' })
    const group = Number(/"(\d+)"/u.exec(reply.text)?.[1])
    expect(group).toBeGreaterThan(0)
    // sclang answers the call that asks it to exit, then quits; the next call reports the stop without running.
    // The terminal client of a runtime built without Qt also posts `main: quit request 0`.
    await expect(run('execute_sclang', { code: '0.exit' })).resolves.toMatchObject({ text: expect.stringMatching(/^result \(Integer\): 0(\n\noutput:\nmain: quit request 0)?$/u) as string })
    expect(await groupEnds(group, 10_000)).toBe(true)
    await expect(run('execute_sclang', { code: '~kept' })).rejects.toMatchObject({ code: 'WORKER_EXITED', message: expect.stringContaining('after the previous call') as string })
    const fresh = await run('execute_sclang', { code: '~kept' })
    expect(fresh.text).toMatch(/started .* with no SynthDefs or variables defined\.\n\nDone\. The code returned nil and posted nothing\.$/u)
    const next = await run('execute_sclang', { code: '("ps -o pgid= -p " ++ thisProcess.pid).unixCmdGetStdOut.stripWhiteSpace' })
    const nextGroup = Number(/"(\d+)"/u.exec(next.text)?.[1])
    await pool?.close()
    expect(await groupEnds(nextGroup, 10_000)).toBe(true)
  }, 180_000)
})
