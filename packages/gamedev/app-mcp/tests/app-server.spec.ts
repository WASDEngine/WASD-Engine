/**
 * runAppMcpServer in process, bound to injected streams, signals, and exit:
 * option validation, the worker script copy, one supervised fake worker
 * behind the definition's tools, setup notes, the tools' budgets, and the
 * worker's shutdown when the client goes away.
 */
import { EventEmitter } from 'node:events'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { runAppMcpServer, type AppMcpServerDefinition } from '../src/app-server.ts'
import type { AppMcpProcess } from '../src/mcp-server.ts'
import { AppServerOptionFields, encodeServerOptions, parseAppServerOptions, type AppServerOptions } from '../src/options.ts'
import { defineAppTool, withSetupNotes } from '../src/tools.ts'
import type { JsonObject } from '../src/types.ts'
import { FAKE_WORKER, PipeClientTransport, isAlive, killQuietly, temporaryDirectory, textOf } from './harness.ts'

const TIMEOUT = 60_000

interface FakeOptions extends AppServerOptions {
  readonly greeting: string
}

const FakeOptions = z.strictObject({ ...AppServerOptionFields, greeting: z.string() })

/** The fake application: one fake worker per start, a note per start, and tools that report what they received. */
function fakeApplication(workerScript: URL): AppMcpServerDefinition<FakeOptions> & { readonly copies: string[] } {
  const copies: string[] = []
  return {
    copies,
    name: 'wasd_fake',
    version: '1.2.3',
    instructions: 'Fake application tools for the specs.',
    workerScript,
    parseOptions: (value: JsonObject) => parseAppServerOptions('Fake', FakeOptions, value),
    workers: (options, dependencies) => {
      const notes: string[] = []
      return {
        async start(signal) {
          const copy = await dependencies.workerScript()
          copies.push(copy)
          const worker = await dependencies.start({
            argv: [process.execPath, FAKE_WORKER], cwd: options.dataRoot, env: { ...process.env },
            readyTimeoutMs: 15_000, logTailBytes: options.maxLogBytes,
          }, signal)
          notes.push(`Fake ${worker.ready.version} started for ${options.greeting}.`)
          return worker
        },
        takeNotes: () => notes.splice(0),
      }
    },
    tools: dependencies => [
      defineAppTool({
        name: 'echo',
        description: 'Echo the text through the worker.',
        input: { text: z.string() },
        async run(args, signal) {
          return withSetupNotes(dependencies, { text: JSON.stringify(await dependencies.call('echo', { text: args.text }, { signal })) })
        },
      }),
      defineAppTool({
        name: 'worker_pid',
        description: 'Report the worker pid.',
        input: {},
        async run(_args, signal) {
          return withSetupNotes(dependencies, { text: JSON.stringify(await dependencies.call('pid', {}, { signal })) })
        },
      }),
      defineAppTool({
        name: 'budgets',
        description: 'Report the dependencies the tools received.',
        input: {},
        run: async () => ({
          text: JSON.stringify({
            dataRoot: dependencies.dataRoot, requestTimeoutMs: dependencies.requestTimeoutMs, maxTimeoutMs: dependencies.maxTimeoutMs,
          }),
        }),
      }),
    ],
  }
}

interface Process extends AppMcpProcess {
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly exited: Promise<number>
}

function fakeProcess(): Process {
  const exit = Promise.withResolvers<number>()
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: new EventEmitter(),
    exit: (code) => { exit.resolve(code) },
    exited: exit.promise,
  }
}

function argv(options: JsonObject): string[] {
  return [process.execPath, '/opt/fake/lib/worker.js', encodeServerOptions(options)]
}

describe('runAppMcpServer', () => {
  it('serves the tools over one supervised worker and stops it when stdin ends', async () => {
    const dataRoot = await temporaryDirectory('dsh-app-mcp-run-')
    const shipped = join(dataRoot, 'shipped-worker.py')
    await writeFile(shipped, 'print("fake worker")\n')
    const application = fakeApplication(pathToFileURL(shipped))
    const io = fakeProcess()
    await runAppMcpServer(application, argv({ dataRoot, requestTimeoutMs: 15_000, toolCallTimeoutMs: 75_000, graceMs: 1000, maxLogBytes: 4096, greeting: 'the specs' }), io)
    const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    onTestFinished(async () => {
      await client.close()
      if (!io.stdin.writableEnded) io.stdin.end()
      await io.exited
    })
    await client.connect(new PipeClientTransport(io.stdout, io.stdin))

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['echo', 'worker_pid', 'budgets'])
    expect(client.getInstructions()).toBe('Fake application tools for the specs.')
    expect(client.getServerVersion()).toMatchObject({ name: 'wasd_fake', version: '1.2.3' })
    expect(application.copies).toEqual([])

    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('Fake 1.2.3 started for the specs.\n\n{"text":"hi"}')
    expect(application.copies).toHaveLength(1)
    expect(relative(await realpath(dataRoot), application.copies[0]!)).toMatch(/^payload\/[0-9a-f]{16}\/shipped-worker\.py$/u)
    await expect(readFile(application.copies[0]!, 'utf8')).resolves.toBe('print("fake worker")\n')
    const worker = Number(textOf(await client.callTool({ name: 'worker_pid', arguments: {} })))
    onTestFinished(() => { killQuietly(worker) })
    expect(isAlive(worker)).toBe(true)
    // A worker request may use the tool-call budget less the 30 s that a worker start and the result keep.
    expect(JSON.parse(textOf(await client.callTool({ name: 'budgets', arguments: {} })))).toEqual({ dataRoot, requestTimeoutMs: 15_000, maxTimeoutMs: 45_000 })

    io.stdin.end()
    await expect(io.exited).resolves.toBe(0)
    await vi.waitFor(() => { expect(isAlive(worker)).toBe(false) }, { timeout: TIMEOUT })
  }, TIMEOUT)

  it('refuses missing or invalid options before it serves', async () => {
    const application = fakeApplication(pathToFileURL('/opt/fake/py/worker.py'))
    const io = fakeProcess()
    await expect(runAppMcpServer(application, [process.execPath, '/opt/fake/lib/worker.js'], io)).rejects.toThrow(TypeError)
    await expect(runAppMcpServer(application, argv({ dataRoot: '/data/fake', greeting: 'x' }), io))
      .rejects.toThrow(/^Fake MCP server options are invalid: [\s\S]*requestTimeoutMs/)
    expect(io.stdout.readableLength).toBe(0)
  })
})
