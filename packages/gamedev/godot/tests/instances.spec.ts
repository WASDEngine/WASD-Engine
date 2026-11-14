/** The plugin runs groups of headless instances of a project, each with its own environment, and exports dedicated servers. */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVER_EXPORT_BINARY } from '../src/export.ts'
import { GodotInstancesError } from '../src/index.ts'
import type { GodotInstanceSpec } from '../src/types.ts'
import { compose, type Composition, type CompositionOptions } from './composition.ts'
import { fakeLog } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

const compositions: Composition[] = []
afterEach(async () => {
  await Promise.all(compositions.splice(0).map(composition => composition.cleanup()))
})

async function setup(options: CompositionOptions): Promise<Composition> {
  const composition = await compose({ ...options, config: { instanceMemoryBytes: 0, instanceCores: 0, ...options.config } })
  compositions.push(composition)
  return composition
}

function instance(name: string, delayMs: number, env: Record<string, string> = {}): GodotInstanceSpec {
  return { name, delayMs, env: { WASD_TEST_NAME: name, ...env } }
}

posix('runInstances', () => {
  it('starts every instance headless after its own delay, with its own environment, and reports how each ended', async () => {
    const c = await setup({ game: { instance: { server: { stdout: 'WASD_TEST_STATS {"peers":1}\n' }, player1: { stderr: 'lost the server\n', exitCode: 3 } } } })
    const report = await c.godot.runInstances({
      projectDir: c.project,
      timeoutMs: 20_000,
      instances: [
        instance('server', 0, { WASD_MULTIPLAYER_TEST: 'server', WASD_TEST_PORT: '4100' }),
        instance('player1', 1500, { WASD_MULTIPLAYER_TEST: 'client', WASD_TEST_TICKET: 'wjt1.payload.signature' }),
      ],
    }, signal)
    expect(report).toEqual({
      projectDir: c.project,
      importIssues: [],
      instances: [
        { name: 'server', exitCode: 0, timedOut: false, stdout: 'WASD_TEST_STATS {"peers":1}\n', stderr: '' },
        { name: 'player1', exitCode: 3, timedOut: false, stdout: '', stderr: 'lost the server\n' },
      ],
    })
    const log = await fakeLog(c.project)
    expect(log.filter(entry => entry.argv !== undefined)).toEqual([{ argv: ['--headless', '--path', c.project] }, { argv: ['--headless', '--path', c.project] }])
    expect(log.filter(entry => entry.instance !== undefined).map(entry => [entry.instance, entry.role, entry.port, entry.ticket])).toEqual([
      ['server', 'server', '4100', null],
      ['player1', 'client', null, 'wjt1.payload.signature'],
    ])
  })

  it('stops the instances that outlive the group\'s deadline', async () => {
    const c = await setup({ game: { instance: { quick: { stdout: 'done\n' }, slow: { delayMs: 10_000 } } } })
    const report = await c.godot.runInstances({ projectDir: c.project, timeoutMs: 1500, instances: [instance('quick', 0), instance('slow', 0)] }, signal)
    expect(report.instances.map(entry => [entry.name, entry.exitCode, entry.timedOut])).toEqual([['quick', 0, false], ['slow', null, true]])
  })

  it('refuses a group larger than the computer runs at once, and an empty one, before starting any instance', async () => {
    const c = await setup({ game: { instance: {} }, config: { maxInstances: 2 } })
    const tooMany = c.godot.runInstances({ projectDir: c.project, timeoutMs: 1000, instances: [instance('a', 0), instance('b', 0), instance('c', 0)] }, signal)
    await expect(tooMany).rejects.toBeInstanceOf(GodotInstancesError)
    await expect(tooMany).rejects.toThrow('This computer runs at most 2 headless instances of a game at once; 3 were asked for.')
    const none = c.godot.runInstances({ projectDir: c.project, timeoutMs: 1000, instances: [] }, signal)
    await expect(none).rejects.toThrow(/at least one instance/u)
    expect(await fakeLog(c.project)).toEqual([])
  })
})

posix('exportServer', () => {
  it('exports the dedicated server with the configured Linux template', async () => {
    // The fake export does not read the template, so any existing file stands in for it.
    const c = await setup({ game: { export: { files: { [SERVER_EXPORT_BINARY]: 'ELF' } } }, config: { serverTemplatePath: fileURLToPath(import.meta.url) } })
    const outputDir = join(c.dir.root, 'server')
    const exported = await c.godot.exportServer({ projectDir: c.project, outputDir }, signal)
    expect(exported).toMatchObject({
      projectDir: c.project, outputDir, binary: SERVER_EXPORT_BINARY, bytes: 3, files: [{ path: SERVER_EXPORT_BINARY, bytes: 3 }],
    })
    expect((await stat(join(outputDir, SERVER_EXPORT_BINARY))).mode & 0o111).toBe(0o111)
    const seen = (await fakeLog(c.project)).find(entry => entry.presets !== undefined) as { presets: string }
    expect(seen.presets).toContain(`custom_template/release="${fileURLToPath(import.meta.url)}"`)
  })
})
