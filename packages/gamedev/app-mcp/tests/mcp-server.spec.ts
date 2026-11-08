/**
 * The app MCP server in process, bound to injected streams, signals, and exit:
 * tool listing and calls through a real SDK client, result mapping (text,
 * images, notices, bounds), error results, console routing, and shutdown.
 */
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { WorkerError } from '../src/json-line-worker.ts'
import { serveAppMcp, type AppMcpServerOptions, type AppTool } from '../src/mcp-server.ts'
import { SESSION_SCOPE_CAPABILITY, SESSION_SCOPE_META_KEY } from '../src/session-scope.ts'
import { PipeClientTransport, temporaryDirectory, textOf as firstText } from './harness.ts'

const MiB = 1024 * 1024

/** Bytes of a one-pixel PNG. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

/** A tool whose run returns a fixed result. */
function fixed(name: string, run: AppTool<z.ZodRawShape>['run']): AppTool<z.ZodRawShape> {
  return { name, description: `The ${name} tool.`, input: {}, run }
}

const echo: AppTool<{ text: z.ZodString }> = {
  name: 'echo',
  title: 'Echo text',
  description: 'Return the text unchanged.',
  input: { text: z.string().describe('Text to return') },
  async run(args) {
    return { text: args.text }
  },
}

interface Served {
  readonly client: Client
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderrStream: PassThrough
  readonly signals: EventEmitter
  readonly exited: Promise<number>
  /** Everything written to stderr so far. */
  stderr(): string
  /** Every line written to stdout so far. */
  stdoutLines(): string[]
}

/** Serve `tools` on injected streams and, unless told otherwise, connect a client; teardown closes both. */
async function serve(tools: readonly AppTool<z.ZodRawShape>[], extra: Partial<AppMcpServerOptions> = {}, connect = true): Promise<Served> {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let stderrText = ''
  let stdoutText = ''
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => { stderrText += chunk })
  stdout.on('data', (chunk: Buffer) => { stdoutText += chunk.toString('utf8') })
  const signals = new EventEmitter()
  const exit = Promise.withResolvers<number>()
  await serveAppMcp({
    name: 'fake-app',
    version: '1.2.3',
    instructions: 'Fake application tools for the specs.',
    tools,
    process: { stdin, stdout, stderr, signals, exit: (code) => { exit.resolve(code) } },
    ...extra,
  })
  const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  onTestFinished(async () => {
    await client.close()
    if (!stdin.writableEnded) stdin.end()
    await exit.promise
  })
  if (connect) await client.connect(new PipeClientTransport(stdout, stdin))
  return {
    client, stdin, stdout, stderrStream: stderr, signals, exited: exit.promise,
    stderr: () => stderrText,
    stdoutLines: () => stdoutText.split('\n').filter(Boolean),
  }
}

/** The single text block of a result. */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  expect(result.content).toHaveLength(1)
  return firstText(result)
}

describe('listing and calling tools', () => {
  it('lists every tool with its title, description, and input schema, and the server instructions', async () => {
    const served = await serve([echo, fixed('plain', async () => ({ text: '' }))])
    const { tools } = await served.client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'plain'])
    expect(tools[0]).toMatchObject({
      title: 'Echo text',
      description: 'Return the text unchanged.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to return' } }, required: ['text'] },
    })
    expect(tools[1]!.title).toBeUndefined()
    expect(served.client.getInstructions()).toBe('Fake application tools for the specs.')
    expect(served.client.getServerVersion()).toMatchObject({ name: 'fake-app', version: '1.2.3' })
  })

  it('starts nothing until a tool is called', async () => {
    const run = vi.fn(async () => ({ text: 'ran' }))
    const served = await serve([fixed('lazy', run)])
    await served.client.listTools()
    expect(run).not.toHaveBeenCalled()
    expect(textOf(await served.client.callTool({ name: 'lazy', arguments: {} }))).toBe('ran')
    expect(run).toHaveBeenCalledOnce()
  })

  it('passes validated arguments and the call signal to the tool', async () => {
    const run = vi.fn(async (args: Record<string, unknown>, signal: AbortSignal) => ({ text: `${String(args.count)} ${String(signal.aborted)}` }))
    const counted: AppTool<{ count: z.ZodNumber }> = { name: 'count', description: 'Count.', input: { count: z.number().int() }, run }
    const served = await serve([counted, echo])
    expect(textOf(await served.client.callTool({ name: 'count', arguments: { count: 3 } }))).toBe('3 false')
    expect(textOf(await served.client.callTool({ name: 'echo', arguments: { text: 'unchanged' } }))).toBe('unchanged')
    // The SDK refuses arguments that fail the input schema, as an error result or a protocol error.
    const refused = await served.client.callTool({ name: 'count', arguments: { count: 'three' } }).then(result => result.isError === true, () => true)
    expect(refused).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('marks a result the tool flags as an error', async () => {
    const served = await serve([fixed('refuse', async () => ({ text: 'no scene is open', isError: true }))])
    const result = await served.client.callTool({ name: 'refuse', arguments: {} })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'no scene is open' }] })
  })

  it('refuses duplicate tool names before serving and restores the console', async () => {
    const original = globalThis.console
    await expect(serveAppMcp({
      name: 'dup', version: '1', instructions: '', tools: [echo, echo],
      process: {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: new EventEmitter(), exit: () => {},
      },
    })).rejects.toThrow(/already registered/u)
    expect(globalThis.console).toBe(original)
  })
})

describe('Session scopes', () => {
  /** Tools whose echo answers with the Session it was built for. */
  function sessionTools(session: string | undefined): ReadonlyMap<string, AppTool<z.ZodRawShape>> {
    return new Map([['echo', { ...echo, run: async () => ({ text: session ?? 'none' }) } as AppTool<z.ZodRawShape>]])
  }

  it('lists no Session scope capability without scoped tools', async () => {
    const { client } = await serve([echo])
    expect(client.getServerCapabilities()?.experimental?.[SESSION_SCOPE_CAPABILITY]).toBeUndefined()
  })

  it('runs each call with the tools of the Session that its _meta names', async () => {
    const { client } = await serve([echo], { scopedTools: sessionTools })
    expect(client.getServerCapabilities()?.experimental?.[SESSION_SCOPE_CAPABILITY]).toEqual({})
    const call = async (meta?: Record<string, unknown>): Promise<string> =>
      firstText(await client.callTool({ name: 'echo', arguments: { text: 'x' }, ...meta === undefined ? {} : { _meta: meta } }))
    expect(await call({ [SESSION_SCOPE_META_KEY]: 'session-3' })).toBe('session-3')
    expect(await call()).toBe('none')
    // A value that is not a non-empty string of at most 200 characters names no Session.
    for (const value of [42, '', 'x'.repeat(201)]) expect(await call({ [SESSION_SCOPE_META_KEY]: value })).toBe('none')
    expect(await call({ [SESSION_SCOPE_META_KEY]: 'y'.repeat(200) })).toBe('y'.repeat(200))
  })
})

describe('images', () => {
  it('returns images from files and from bytes as canonical base64 with their media types', async () => {
    const directory = await temporaryDirectory('dsh-app-mcp-image-')
    const path = join(directory, 'render.png')
    await writeFile(path, PIXEL)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
    const served = await serve([fixed('render', async () => ({
      text: 'Rendered 1×1.',
      images: [{ path, mimeType: 'image/png' }, { data: jpeg.subarray(0), mimeType: 'image/jpeg' }],
    }))])
    const result = await served.client.callTool({ name: 'render', arguments: {} })
    expect(result.content).toEqual([
      { type: 'text', text: 'Rendered 1×1.' },
      { type: 'image', data: PIXEL.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' },
    ])
    const [, png] = result.content as Array<{ data: string }>
    expect(Buffer.from(png!.data, 'base64').equals(PIXEL)).toBe(true)
  })

  it('encodes a view of a larger buffer from its own offset', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    const served = await serve([fixed('view', async () => ({ text: '', images: [{ data: backing.subarray(2, 5), mimeType: 'image/png' }] }))])
    const result = await served.client.callTool({ name: 'view', arguments: {} })
    expect(result.content[1]).toEqual({ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' })
  })

  it('replaces unavailable images with text notices', async () => {
    const served = await serve([fixed('broken', async () => ({
      text: 'Two images failed.',
      images: [{ path: '/nonexistent/dsh-app-mcp/render.png', mimeType: 'image/png' }, { mimeType: 'image/png' }],
    }))])
    const result = await served.client.callTool({ name: 'broken', arguments: {} })
    expect(result.content).toEqual([
      { type: 'text', text: 'Two images failed.' },
      { type: 'text', text: expect.stringMatching(/^\[image unavailable: ENOENT: no such file or directory, open '\/nonexistent\/dsh-app-mcp\/render\.png'\]$/u) as string },
      { type: 'text', text: '[image unavailable: the tool returned neither an image file nor image bytes]' },
    ])
  })

  it('includes an image of exactly 4 MiB of base64 and replaces a larger one', async () => {
    const exact = new Uint8Array(3 * MiB)
    const over = new Uint8Array(3 * MiB + 1)
    const served = await serve([fixed('big', async () => ({ text: 'big', images: [{ data: over, mimeType: 'image/png' }, { data: exact, mimeType: 'image/png' }] }))])
    const result = await served.client.callTool({ name: 'big', arguments: {} })
    expect(result.content[1]).toEqual({
      type: 'text',
      text: '[image omitted: as base64 it exceeds the 4 MiB limit for one image; request a smaller image]',
    })
    expect(result.content[2]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((result.content[2] as { data: string }).data).toHaveLength(4 * MiB)
  })

  it('replaces the images that exceed 6 MiB of base64 in total', async () => {
    const image = { data: new Uint8Array(3 * MiB), mimeType: 'image/png' as const }
    const small = { data: PIXEL, mimeType: 'image/png' as const }
    const served = await serve([fixed('many', async () => ({ text: 'many', images: [image, image, small] }))])
    const result = await served.client.callTool({ name: 'many', arguments: {} })
    expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'text', 'image'])
    expect(result.content[2]).toEqual({
      type: 'text',
      text: '[image omitted: as base64 the images of this result exceed their 6 MiB total limit; request fewer or smaller images]',
    })
  })
})

describe('text bounds', () => {
  const textTool = (text: string): AppTool<z.ZodRawShape> => fixed('long', async () => ({ text }))

  it('keeps text whose JSON encoding is exactly 1 MiB', async () => {
    const text = 'x'.repeat(MiB - 2)
    const served = await serve([textTool(text)])
    expect(textOf(await served.client.callTool({ name: 'long', arguments: {} }))).toBe(text)
  })

  it('cuts longer text and notes how much was omitted', async () => {
    const text = 'x'.repeat(MiB - 1)
    const served = await serve([textTool(text)])
    const kept = Math.floor(MiB / 6)
    expect(textOf(await served.client.callTool({ name: 'long', arguments: {} })))
      .toBe(`${'x'.repeat(kept)}\n[output truncated: ${text.length - kept} more characters]`)
  })

  it('never cuts a surrogate pair in half', async () => {
    const kept = Math.floor(MiB / 6)
    const odd = `a${'😀'.repeat(300_000)}`
    const even = '😀'.repeat(300_000)
    const served = await serve([fixed('odd', async () => ({ text: odd })), fixed('even', async () => ({ text: even }))])
    const oddText = textOf(await served.client.callTool({ name: 'odd', arguments: {} }))
    expect(oddText).toBe(`${odd.slice(0, kept - 1)}\n[output truncated: ${odd.length - kept + 1} more characters]`)
    const evenText = textOf(await served.client.callTool({ name: 'even', arguments: {} }))
    expect(evenText).toBe(`${even.slice(0, kept)}\n[output truncated: ${even.length - kept} more characters]`)
  })
})

describe('failures', () => {
  it('turns a thrown error into an error result with its message', async () => {
    const served = await serve([
      fixed('throws', async () => { throw new Error('no object named "Cube"') }),
      fixed('throws-value', async () => { throw 'plain failure' }),
    ])
    expect(await served.client.callTool({ name: 'throws', arguments: {} }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: 'no object named "Cube"' }] })
    expect(await served.client.callTool({ name: 'throws-value', arguments: {} }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: 'plain failure' }] })
  })

  it('adds the code, the end of the traceback, and recent worker output for a worker error', async () => {
    const traceback = `Traceback (most recent call last):\n${'  frame\n'.repeat(1000)}ValueError: boom`
    const served = await serve([
      fixed('remote', async () => { throw new WorkerError('WORKER_REMOTE', 'ValueError: boom', { remoteType: 'ValueError', traceback }) }),
      fixed('crash', async () => { throw new WorkerError('WORKER_EXITED', 'blender worker: exited with code 3', { logTail: `${'w'.repeat(3000)}Segmentation fault` }) }),
      fixed('quiet', async () => { throw new WorkerError('WORKER_TIMEOUT', 'blender worker: did not answer', { logTail: '' }) }),
      fixed('short', async () => {
        throw new WorkerError('WORKER_REMOTE', 'KeyError: x', { traceback: 'Traceback: line 1', logTail: 'Read prefs\n' })
      }),
    ])
    expect(textOf(await served.client.callTool({ name: 'short', arguments: {} })))
      .toBe('KeyError: x\n\nTraceback: line 1\n\nRecent worker output:\nRead prefs\n\n\nError code: WORKER_REMOTE')
    const remote = textOf(await served.client.callTool({ name: 'remote', arguments: {} }))
    expect(remote).toBe(`ValueError: boom\n\n…${traceback.slice(-4000)}\n\nError code: WORKER_REMOTE`)
    const crash = textOf(await served.client.callTool({ name: 'crash', arguments: {} }))
    expect(crash).toBe(`blender worker: exited with code 3\n\nRecent worker output:\n…${'w'.repeat(2000 - 'Segmentation fault'.length)}Segmentation fault\n\nError code: WORKER_EXITED`)
    expect(textOf(await served.client.callTool({ name: 'quiet', arguments: {} }))).toBe('blender worker: did not answer\n\nError code: WORKER_TIMEOUT')
  })

  it('never starts a quoted traceback inside a surrogate pair', async () => {
    const aligned = '😀'.repeat(2500)
    const shifted = `${'😀'.repeat(2500)}a`
    const served = await serve([
      fixed('aligned', async () => { throw new WorkerError('WORKER_REMOTE', 'E: x', { traceback: aligned }) }),
      fixed('shifted', async () => { throw new WorkerError('WORKER_REMOTE', 'E: x', { traceback: shifted }) }),
    ])
    expect(textOf(await served.client.callTool({ name: 'aligned', arguments: {} })))
      .toBe(`E: x\n\n…${'😀'.repeat(2000)}\n\nError code: WORKER_REMOTE`)
    expect(textOf(await served.client.callTool({ name: 'shifted', arguments: {} })))
      .toBe(`E: x\n\n…${'😀'.repeat(1999)}a\n\nError code: WORKER_REMOTE`)
  })
})

describe('the protocol stream', () => {
  it('routes console output to stderr so stdout carries only MCP frames, and restores the console at shutdown', async () => {
    const original = globalThis.console
    const served = await serve([fixed('noisy', async () => {
      console.log('log line')
      console.info('info line')
      console.debug('debug line')
      console.warn('warn line')
      console.error('error line')
      return { text: 'done' }
    })])
    expect(globalThis.console).not.toBe(original)
    expect(textOf(await served.client.callTool({ name: 'noisy', arguments: {} }))).toBe('done')
    for (const line of ['log line', 'info line', 'debug line', 'warn line', 'error line']) expect(served.stderr()).toContain(`${line}\n`)
    for (const line of served.stdoutLines()) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    served.stdin.end()
    await served.exited
    expect(globalThis.console).toBe(original)
  })

  it('reports transport errors on stderr', async () => {
    const served = await serve([echo], {}, false)
    served.stdin.write('{"jsonrpc":"2.0","id":7,"result":{}}\n')
    await vi.waitFor(() => {
      expect(served.stderr()).toContain('app MCP server: MCP transport error: Discarded a JSON-RPC response')
    })
  })
})

describe('shutdown', () => {
  it.each([
    ['stdin ends', (served: Served) => { served.stdin.end() }],
    ['SIGTERM arrives', (served: Served) => { served.signals.emit('SIGTERM') }],
    ['SIGINT arrives', (served: Served) => { served.signals.emit('SIGINT') }],
  ])('runs the close hook once and exits with code 0 when %s', async (_case, trigger) => {
    const onClose = vi.fn(async () => {})
    const served = await serve([echo], { onClose })
    trigger(served)
    expect(await served.exited).toBe(0)
    served.signals.emit('SIGTERM')
    served.signals.emit('SIGINT')
    expect(onClose).toHaveBeenCalledOnce()
    // The listeners stay until the process exits, so a repeated signal never gets its default action.
    expect([served.signals.listenerCount('SIGTERM'), served.signals.listenerCount('SIGINT')]).toEqual([1, 1])
  })

  it.each([
    ['a stdout write fails', (served: Served) => { served.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) }],
    ['a message overflows the read buffer', (served: Served) => { served.stdin.write('x'.repeat(10 * MiB + 1)) }],
  ])('shuts down when the transport closes itself because %s, although stdin stays open', async (_case, trigger) => {
    const onClose = vi.fn(async () => {})
    const served = await serve([echo], { onClose })
    trigger(served)
    expect(await served.exited).toBe(0)
    expect(onClose).toHaveBeenCalledOnce()
    expect(served.stdin.writableEnded).toBe(false)
    expect(served.stderr()).toContain('app MCP server: MCP transport error: ')
  })

  it('finishes the close hook when the signal repeats during it', async () => {
    const hook: PromiseWithResolvers<void> = Promise.withResolvers()
    const onClose = vi.fn(async () => { await hook.promise })
    const served = await serve([echo], { onClose })
    let exited = false
    void served.exited.then(() => { exited = true })
    served.signals.emit('SIGTERM')
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    served.signals.emit('SIGTERM')
    served.signals.emit('SIGINT')
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(exited).toBe(false)
    hook.resolve()
    expect(await served.exited).toBe(0)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps serving when a stderr write fails, as when the client closed the pipe', async () => {
    const onClose = vi.fn(async () => {})
    const served = await serve([echo], { onClose })
    expect(() => { served.stderrStream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) }).not.toThrow()
    expect(textOf(await served.client.callTool({ name: 'echo', arguments: { text: 'still serving' } }))).toBe('still serving')
    served.stdin.end()
    expect(await served.exited).toBe(0)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cancels running tool calls before the close hook runs', async () => {
    const events: string[] = []
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const served = await serve([fixed('wait', async (_args, signal) => {
      entered.resolve()
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
      events.push('tool cancelled')
      return { text: 'cancelled' }
    })], { onClose: async () => { events.push('close hook') } })
    const call = served.client.callTool({ name: 'wait', arguments: {} }).catch((error: unknown) => error)
    await entered.promise
    served.stdin.end()
    expect(await served.exited).toBe(0)
    expect(events).toEqual(['tool cancelled', 'close hook'])
    await served.client.close()
    await call
  })

  it('exits and reports a failing close hook', async () => {
    const served = await serve([echo], { onClose: async () => { throw new Error('the worker did not stop') } })
    served.signals.emit('SIGTERM')
    expect(await served.exited).toBe(0)
    expect(served.stderr()).toContain('app MCP server: the close hook failed; exiting anyway: the worker did not stop\n')
  })

  it('reports a close hook that rejects with a non-Error value', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a hook may reject with a non-Error value
    const served = await serve([echo], { onClose: () => Promise.reject('stuck') })
    served.stdin.end()
    expect(await served.exited).toBe(0)
    expect(served.stderr()).toContain('the close hook failed; exiting anyway: stuck\n')
  })

  it('exits when the close hook does not finish within 10 s', async () => {
    const onClose = vi.fn((): Promise<never> => new Promise(() => {}))
    const served = await serve([echo], { onClose }, false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
    let exited = false
    void served.exited.then(() => { exited = true })
    served.signals.emit('SIGTERM')
    await turn()
    expect(onClose).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(9_999)
    await turn()
    expect(exited).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await served.exited).toBe(0)
    expect(served.stderr()).toContain('app MCP server: the close hook did not finish within 10000 ms; exiting anyway\n')
  })

  it('exits without a close hook', async () => {
    const served = await serve([echo])
    served.stdin.end()
    expect(await served.exited).toBe(0)
  })
})
