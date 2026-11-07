/**
 * The app MCP server in a real server process: started as the Host starts it
 * (process.execPath with an entry and encoded options), on real stdio, with
 * real signals and exit, a real supervisor, and the fake worker. The SDK's
 * stdio client also exercises the short-lived probe copy it starts first.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { encodeServerOptions } from '../src/options.ts'
import { FAKE_SERVER, FAKE_WORKER, PipeClientTransport, eventsIn, isAlive, killQuietly, temporaryDirectory, textOf } from './harness.ts'

const TIMEOUT = 60_000

async function serverOptions(workerMode = 'ready'): Promise<{ events: string; encoded: string }> {
  const events = join(await temporaryDirectory('dsh-app-mcp-serve-'), 'events')
  return { events, encoded: encodeServerOptions({ events, worker: [process.execPath, FAKE_WORKER, workerMode] }) }
}

/** Kill every server process recorded in `events` that a failed test left behind. */
function reapRecorded(events: string): void {
  onTestFinished(async () => {
    for (const { pid } of await eventsIn(events)) killQuietly(pid)
  })
}

describe('a served app MCP process', () => {
  it('serves its tools to the SDK stdio client and closes its worker when the client closes', async () => {
    const { events, encoded } = await serverOptions()
    reapRecorded(events)
    const transport = new StdioClientTransport({ command: process.execPath, args: [FAKE_SERVER, encoded], stderr: 'pipe' })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    onTestFinished(() => client.close())
    await client.connect(transport)

    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'image', 'oversize', 'fail', 'noisy', 'worker_echo', 'worker_pid', 'worker_crash'])
    expect(client.getInstructions()).toBe('Fake application tools for the specs.')
    expect((await client.callTool({ name: 'echo', arguments: { text: 'over stdio' } })).content).toEqual([{ type: 'text', text: 'over stdio' }])

    const image = await client.callTool({ name: 'image', arguments: {} })
    const [, png] = image.content as Array<{ type: string; data: string; mimeType: string }>
    expect(png).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(Buffer.from(png!.data, 'base64').toString('base64')).toBe(png!.data)
    expect(Buffer.from(png!.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG')

    const oversize = await client.callTool({ name: 'oversize', arguments: {} })
    expect(oversize.content[1]).toEqual({ type: 'text', text: '[image omitted: as base64 it exceeds the 4 MiB limit for one image; request a smaller image]' })
    expect(await client.callTool({ name: 'fail', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the tool failed' }] })
    expect(textOf(await client.callTool({ name: 'noisy', arguments: {} }))).toBe('quiet')
    await vi.waitFor(() => { expect(stderr).toContain('warn noise\n') })
    expect(stderr).toContain('log noise\ninfo noise\ndebug noise\n')

    expect(JSON.parse(textOf(await client.callTool({ name: 'worker_echo', arguments: { text: 'via worker' } })))).toEqual({ text: 'via worker' })
    const firstWorker = Number(textOf(await client.callTool({ name: 'worker_pid', arguments: {} })))
    expect(isAlive(firstWorker)).toBe(true)
    const crash = await client.callTool({ name: 'worker_crash', arguments: {} })
    expect(crash.isError).toBe(true)
    expect(textOf(crash)).toContain('fake worker: exited with code 3 while handling "crash"; its state (open files, scene, unsaved changes) was lost')
    expect(textOf(crash)).toContain('Recent worker output:\nfatal: crashing on purpose\n')
    expect(textOf(crash)).toMatch(/Error code: WORKER_EXITED$/u)
    const secondWorker = Number(textOf(await client.callTool({ name: 'worker_pid', arguments: {} })))
    expect(secondWorker).not.toBe(firstWorker)
    onTestFinished(() => { killQuietly(firstWorker); killQuietly(secondWorker) })

    await client.close()
    await vi.waitFor(async () => {
      const recorded = await eventsIn(events)
      const started = recorded.filter(item => item.event === 'start').map(item => item.pid)
      // The SDK client probes on a short-lived copy before it starts the serving process.
      expect(started).toHaveLength(2)
      expect(recorded.filter(item => item.event === 'closed').map(item => item.pid).toSorted()).toEqual(started.toSorted())
      for (const pid of [...started, firstWorker, secondWorker]) expect(isAlive(pid)).toBe(false)
    }, { timeout: TIMEOUT })
  }, TIMEOUT)

  describe('on raw stdio', () => {
    interface Launched {
      readonly child: ChildProcessByStdio<Writable, Readable, Readable>
      readonly client: Client
      readonly events: string
      readonly stdout: () => string
      readonly stderr: () => string
      readonly exit: Promise<[number | null, NodeJS.Signals | null]>
    }

    async function launch(workerMode = 'ready'): Promise<Launched> {
      const { events, encoded } = await serverOptions(workerMode)
      const child = spawn(process.execPath, [FAKE_SERVER, encoded], { stdio: ['pipe', 'pipe', 'pipe'] })
      onTestFinished(() => { killQuietly(child.pid!) })
      reapRecorded(events)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      const exit = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => { child.once('exit', (code, signal) => { resolve([code, signal]) }) })
      const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      onTestFinished(() => client.close())
      await client.connect(new PipeClientTransport(child.stdout, child.stdin))
      return { child, client, events, stdout: () => stdout, stderr: () => stderr, exit }
    }

    it('writes nothing but MCP frames to stdout while tools write to the console', async () => {
      const served = await launch()
      expect(textOf(await served.client.callTool({ name: 'noisy', arguments: {} }))).toBe('quiet')
      const lines = served.stdout().split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
      await vi.waitFor(() => { expect(served.stderr()).toContain('log noise\ninfo noise\ndebug noise\nwarn noise\n') })
    }, TIMEOUT)

    it.each(['SIGTERM', 'SIGINT'] as const)('runs the close hook and exits with code 0 on %s, stopping its worker', async (signal) => {
      const served = await launch()
      const worker = Number(textOf(await served.client.callTool({ name: 'worker_pid', arguments: {} })))
      onTestFinished(() => { killQuietly(worker) })
      served.child.kill(signal)
      expect(await served.exit).toEqual([0, null])
      expect((await eventsIn(served.events)).map(item => item.event)).toEqual(['start', 'serving', 'closed'])
      expect(isAlive(worker)).toBe(false)
    }, TIMEOUT)

    it('runs the close hook and exits with code 0 when stdin ends', async () => {
      const served = await launch()
      served.child.stdin.end()
      expect(await served.exit).toEqual([0, null])
      expect((await eventsIn(served.events)).map(item => item.event)).toEqual(['start', 'serving', 'closed'])
    }, TIMEOUT)

    it('stops its worker and exits with code 0 once a result cannot be written, although stdin stays open', async () => {
      const served = await launch()
      const worker = Number(textOf(await served.client.callTool({ name: 'worker_pid', arguments: {} })))
      onTestFinished(() => { killQuietly(worker) })
      // The client stops reading: the next result write fails with EPIPE, and the transport closes itself.
      served.child.stdout.destroy()
      void served.client.callTool({ name: 'echo', arguments: { text: 'unread' } }).catch(() => {})
      expect(await served.exit).toEqual([0, null])
      expect(served.child.stdin.writableEnded).toBe(false)
      expect(served.stderr()).toContain('app MCP server: MCP transport error: write EPIPE')
      expect((await eventsIn(served.events)).map(item => item.event)).toEqual(['start', 'serving', 'closed'])
      expect(isAlive(worker)).toBe(false)
    }, TIMEOUT)

    it('finishes the close hook when SIGTERM repeats during it, so a worker that ignores shutdown still stops', async () => {
      // The immortal worker ignores the shutdown request and SIGTERM, so its close lasts two 1 s grace periods.
      const served = await launch('immortal')
      const worker = Number(textOf(await served.client.callTool({ name: 'worker_pid', arguments: {} })))
      onTestFinished(() => { killQuietly(worker) })
      served.child.kill('SIGTERM')
      // Well inside the close, which takes about 2 s.
      await sleep(300)
      served.child.kill('SIGTERM')
      expect(await served.exit).toEqual([0, null])
      expect((await eventsIn(served.events)).map(item => item.event)).toEqual(['start', 'serving', 'closed'])
      expect(isAlive(worker)).toBe(false)
    }, TIMEOUT)
  })
})
