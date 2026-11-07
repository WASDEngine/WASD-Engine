/**
 * Shared fixtures of the app-mcp specs: fake worker specs, owned temporary
 * directories, process liveness checks, and an MCP client transport over a
 * pair of streams framed like stdio.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ReadBuffer, serializeMessage, type Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'
import { expect, onTestFinished } from 'vitest'
import { JsonLineWorker, WorkerError, type JsonLineWorkerSpec } from '../src/json-line-worker.ts'

/** The protocol fixture worker. */
export const FAKE_WORKER = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url))

/** The app MCP server fixture: a plain-Node entry that serves fake tools through the package source. */
export const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))

/**
 * Launch spec of the fake worker.
 * @param mode - start or shutdown behavior (see the fixture).
 * @param overrides - spec fields to replace.
 * @returns the spec.
 */
export function workerSpec(mode = 'ready', overrides: Partial<JsonLineWorkerSpec> = {}): JsonLineWorkerSpec {
  return {
    argv: [process.execPath, FAKE_WORKER, mode],
    cwd: tmpdir(),
    env: { ...process.env },
    readyTimeoutMs: 15_000,
    logTailBytes: 4096,
    ...overrides,
  }
}

/**
 * Start a fake worker that the current test owns; teardown closes it.
 * @param mode - start or shutdown behavior.
 * @param overrides - spec fields to replace.
 * @returns the ready worker.
 */
export async function startWorker(mode = 'ready', overrides: Partial<JsonLineWorkerSpec> = {}): Promise<JsonLineWorker> {
  const worker = await JsonLineWorker.start(workerSpec(mode, overrides))
  onTestFinished(() => worker.close(100))
  return worker
}

/**
 * Create a temporary directory that teardown removes.
 * @param prefix - directory name prefix.
 * @returns the directory path.
 */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Read the pids a fixture appended to a file, one per line.
 * @param file - the pid file.
 * @returns the pids, or none when the file does not exist yet.
 */
export async function pidsIn(file: string): Promise<number[]> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return text.split('\n').filter(Boolean).map(Number)
}

/**
 * Capture a rejection as a WorkerError so its fields can be asserted.
 * @param promise - an operation expected to reject with a WorkerError.
 * @returns the rejection.
 */
export async function workerError(promise: Promise<unknown>): Promise<WorkerError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(WorkerError)
  return error as WorkerError
}

/**
 * The text of a tool result's first content block, which must be text.
 * @param result - an MCP tool result.
 * @returns the text.
 */
export function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [block] = result.content as Array<{ type: string; text?: string }>
  expect(block?.type).toBe('text')
  return block!.text!
}

/** One lifecycle event the fixture server recorded. */
export interface ServerEvent {
  readonly event: string
  readonly pid: number
}

/**
 * Read the "<event> <pid>" lines the fixture server appended to its events file.
 * @param file - the events file.
 * @returns the events, or none before the first one.
 */
export async function eventsIn(file: string): Promise<ServerEvent[]> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((line) => {
    const [event = '', pid = ''] = line.split(' ')
    return { event, pid: Number(pid) }
  })
}

/**
 * Whether a process exists.
 * @param pid - process id.
 * @returns false once the process is gone.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process.
    return false
  }
}

/**
 * Kill a process that a failed test may have left behind.
 * @param pid - process id.
 */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // ESRCH: the process already exited.
  }
}

/** MCP client transport over a server's output and input streams, framed like stdio. Closing it ends the server's input. */
export class PipeClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private readonly input: Readable
  private readonly output: Writable

  /**
   * @param input - the server's output, which the client reads.
   * @param output - the server's input, which the client writes.
   */
  constructor(input: Readable, output: Writable) {
    this.input = input
    this.output = output
  }

  /** Start reading server frames. */
  async start(): Promise<void> {
    this.input.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk)
      for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message)
    })
  }

  /**
   * Write one frame to the server.
   * @param message - the JSON-RPC message.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    this.output.write(serializeMessage(message))
  }

  /** End the server's input. */
  async close(): Promise<void> {
    if (!this.output.writableEnded) this.output.end()
    this.onclose?.()
  }
}
