/**
 * Stdio MCP server for the tools of one application worker. It runs in the
 * server process the Host starts through `registerAppMcpServer`. Stdout
 * carries nothing but MCP frames, so console output goes to stderr from the
 * start. The server answers discovery at once and starts nothing else; tools
 * start their worker on first use. The first of these shuts the server down:
 * stdin closing, the transport closing itself after a failed stdout write or
 * an incoming message that overflows its read buffer, SIGTERM, or SIGINT.
 * Shutdown runs the close hook, waits for it at most 10 s, and exits the
 * process with code 0; later signals do not cut it short.
 *
 * @module
 */

import { Console } from 'node:console'
import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import type { CallToolResult, ImageContent, McpServer, TextContent } from '@modelcontextprotocol/server'
import type { StdioServerHandle, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { WorkerError } from './json-line-worker.ts'

const MiB = 1024 * 1024

/** Largest image in a result, in base64 characters; a larger one is replaced by a text notice. */
const MAX_IMAGE_CHARS = 4 * MiB

/**
 * Longest edge, in pixels, of an image that a tool sends to the agent. The
 * server does not resize images, so a worker writes a smaller copy of a
 * larger image.
 */
export const AGENT_IMAGE_MAX_EDGE = 1568

/** Largest image file that a tool sends to the agent: its base64 form fills the 4 MiB that one image may take. */
export const AGENT_IMAGE_MAX_BYTES = MAX_IMAGE_CHARS / 4 * 3

/**
 * Largest total of the images in a result, in base64 characters. With the
 * text bound it keeps every result well under the 10 MiB stdio frame limit.
 */
const MAX_IMAGES_CHARS = 6 * MiB

/** Largest text block, in UTF-8 bytes of its JSON encoding. */
const MAX_TEXT_BYTES = MiB

/** UTF-16 units kept of a longer text: each unit encodes to at most 6 JSON bytes (`\u001f`). */
const KEPT_TEXT_CHARS = Math.floor(MAX_TEXT_BYTES / 6)

/** Characters of a worker traceback quoted in an error result; its end is kept. */
const TRACEBACK_CHARS = 4000

/** Characters of worker output quoted in an error result; its end is kept. */
const LOG_CHARS = 2000

/** How long shutdown waits for the close hook before the process exits anyway. */
const SHUTDOWN_BUDGET_MS = 10_000

/** One image in a tool result: a file the worker wrote, or encoded bytes. */
export interface AppToolImage {
  /** Absolute path of the image file, read when `data` is absent. */
  readonly path?: string | undefined
  /** Encoded image bytes. */
  readonly data?: Uint8Array | undefined
  /** Encoding of the image. */
  readonly mimeType: 'image/png' | 'image/jpeg'
}

/** What a tool returns to the client: text first, then images. */
export interface AppToolResult {
  /** Model-facing text; text beyond 1 MiB of JSON is cut and the cut is noted. */
  readonly text: string
  /** Images, each at most 4 MiB and together at most 6 MiB as base64; others become text notices. */
  readonly images?: readonly AppToolImage[] | undefined
  /** Whether the result reports a failure. */
  readonly isError?: boolean | undefined
}

/** One MCP tool backed by the application worker. */
export interface AppTool<S extends z.ZodRawShape> {
  /** MCP tool name; the model sees it as `mcp__<serverName>__<name>`. */
  readonly name: string
  /** Human-readable title. */
  readonly title?: string | undefined
  /** Model-facing description. */
  readonly description: string
  /** Zod shape of the tool's arguments. */
  readonly input: S
  /**
   * Run the tool. A thrown error becomes an error result whose text carries
   * the message and, for a `WorkerError`, its code, the end of the traceback,
   * and recent worker output.
   * @param args - arguments validated against `input`.
   * @param signal - aborts when the client cancels the call or the server shuts down.
   * @returns the result to send to the client.
   */
  run(args: z.infer<z.ZodObject<S>>, signal: AbortSignal): Promise<AppToolResult>
}

/** The process resources a served app MCP server binds. */
export interface AppMcpProcess {
  /** MCP input; the server shuts down when it ends. */
  readonly stdin: Readable
  /** MCP output; nothing but MCP frames is written to it, and the server shuts down when a write fails. */
  readonly stdout: Writable
  /** Console output and server diagnostics, written best effort: a failed write is ignored. */
  readonly stderr: Writable
  /** Emits `SIGTERM` and `SIGINT`; the first shuts the server down, and the server keeps listening until it exits. */
  readonly signals: NodeJS.EventEmitter
  /**
   * End the process once the server has shut down.
   * @param code - the exit code, always 0.
   */
  exit(code: number): void
}

/** What {@link serveAppMcp} serves. */
export interface AppMcpServerOptions {
  /** Server name reported to the client. */
  readonly name: string
  /** Server version reported to the client. */
  readonly version: string
  /** Server instructions the client shows the model. */
  readonly instructions: string
  /** The tools; their names must be unique. */
  readonly tools: readonly AppTool<z.ZodRawShape>[]
  /** Runs once at shutdown, before the process exits, to stop the worker; awaited at most 10 s. */
  readonly onClose?: (() => Promise<void>) | undefined
  /** Process resources to serve on; omission binds the current process. */
  readonly process?: AppMcpProcess | undefined
}

/**
 * Serve the tools over stdio. Console output moves to stderr first. Each
 * client connection gets its own `McpServer` instance from the same tool
 * list; no tool runs and no worker starts until a client calls a tool.
 * Closing stdin, a failed stdout write or an overflowing incoming message,
 * either of which closes the transport, SIGTERM, or SIGINT closes the
 * connection, runs `onClose` once (at most 10 s), and exits the process with
 * code 0.
 * @param options - server identity, instructions, tools, close hook, and process.
 * @returns once the server is serving.
 * @throws when a tool cannot be registered, such as a duplicate tool name.
 */
export async function serveAppMcp(options: AppMcpServerOptions): Promise<void> {
  /* v8 ignore next -- in-process specs inject the process; serve-process.spec.ts runs this default in a real server process */
  const io: AppMcpProcess = options.process ?? {
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process, exit: (code) => { process.exit(code) },
  }
  const restoreConsole = routeConsole(io.stderr)
  try {
    // Loaded on serve, not on import: the Host imports this package without serving.
    const [{ McpServer }, { serveStdio, StdioServerTransport }] = await Promise.all([
      import('@modelcontextprotocol/server'),
      import('@modelcontextprotocol/server/stdio'),
    ])
    const create = (): McpServer => createServer(McpServer, options)
    // A registration error, such as a duplicate tool name, fails here rather than on the first connection.
    create()
    const shutdown = shutdownOnce(io, options.onClose, restoreConsole)
    shutdown.connect(serveStdio(create, {
      transport: closingTransport(StdioServerTransport, io, shutdown.stop),
      onerror: (error) => { report(io.stderr, 'MCP transport error', error) },
    }))
  } catch (error) {
    restoreConsole()
    throw error
  }
}

/**
 * A stdio transport that calls `onClosed` after each close. The transport closes itself when stdin
 * ends, when a stdout write fails, such as with EPIPE after the client went away, and when an
 * incoming message overflows its read buffer. A transport that closed itself stops reading stdin,
 * which then never ends, so only its close can trigger the shutdown.
 */
function closingTransport(Transport: typeof StdioServerTransport, io: AppMcpProcess, onClosed: () => void): StdioServerTransport {
  return new (class extends Transport {
    override async close(): Promise<void> {
      await super.close()
      onClosed()
    }
  })(io.stdin, io.stdout)
}

/** Point the global console at `stderr`; the returned function restores the previous console. */
function routeConsole(stderr: Writable): () => void {
  const previous = globalThis.console
  globalThis.console = new Console({ stdout: stderr, stderr, colorMode: false })
  return () => { globalThis.console = previous }
}

function createServer(Server: typeof McpServer, options: AppMcpServerOptions): McpServer {
  const server = new Server({ name: options.name, version: options.version }, {
    capabilities: { tools: {} },
    instructions: options.instructions,
  })
  for (const tool of options.tools) {
    server.registerTool(tool.name, {
      ...tool.title === undefined ? {} : { title: tool.title },
      description: tool.description,
      inputSchema: z.object(tool.input),
    }, (args, context) => respond(tool, args, context.mcpReq.signal))
  }
  return server
}

async function respond(
  tool: AppTool<z.ZodRawShape>, args: z.infer<z.ZodObject<z.ZodRawShape>>, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    return await toCallToolResult(await tool.run(args, signal))
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: boundText(describeFailure(error)) }] }
  }
}

async function toCallToolResult(result: AppToolResult): Promise<CallToolResult> {
  const content: Array<TextContent | ImageContent> = [{ type: 'text', text: boundText(result.text) }]
  let budget = MAX_IMAGES_CHARS
  for (const image of result.images ?? []) {
    const block = await imageContent(image, budget)
    if (block.type === 'image') budget -= block.data.length
    content.push(block)
  }
  return result.isError === true ? { content, isError: true } : { content }
}

/** The image as base64 content, or a text notice saying why it is not included. */
async function imageContent(image: AppToolImage, budget: number): Promise<ImageContent | TextContent> {
  let bytes: Uint8Array
  if (image.data !== undefined) {
    bytes = image.data
  } else if (image.path === undefined) {
    return notice('[image unavailable: the tool returned neither an image file nor image bytes]')
  } else {
    try {
      bytes = await readFile(image.path)
    } catch (error) {
      return notice(`[image unavailable: ${messageOf(error)}]`)
    }
  }
  const size = 4 * Math.ceil(bytes.byteLength / 3)
  if (size > MAX_IMAGE_CHARS) {
    return notice(`[image omitted: as base64 it exceeds the ${MAX_IMAGE_CHARS / MiB} MiB limit for one image; request a smaller image]`)
  }
  if (size > budget) {
    return notice(`[image omitted: as base64 the images of this result exceed their ${MAX_IMAGES_CHARS / MiB} MiB total limit; request fewer or smaller images]`)
  }
  return { type: 'image', data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), mimeType: image.mimeType }
}

function notice(text: string): TextContent {
  return { type: 'text', text }
}

/** Whether the UTF-16 unit at `index` is a surrogate of the given half (high 0xD800–0xDBFF, low 0xDC00–0xDFFF). */
function isSurrogate(text: string, index: number, half: 'high' | 'low'): boolean {
  const unit = text.charCodeAt(index)
  const first = half === 'high' ? 0xd800 : 0xdc00
  return unit >= first && unit <= first + 0x3ff
}

/** Cut text whose JSON encoding exceeds the text bound, never inside a surrogate pair, and note the cut. */
function boundText(text: string): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= MAX_TEXT_BYTES) return text
  const end = isSurrogate(text, KEPT_TEXT_CHARS - 1, 'high') ? KEPT_TEXT_CHARS - 1 : KEPT_TEXT_CHARS
  return `${text.slice(0, end)}\n[output truncated: ${text.length - end} more characters]`
}

/** The last `limit` characters of `text`, never starting inside a surrogate pair. */
function lastChars(text: string, limit: number): string {
  if (text.length <= limit) return text
  const start = text.length - limit
  return `…${text.slice(isSurrogate(text, start, 'low') ? start + 1 : start)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Model-facing text for a tool failure: the message, plus code, traceback, and worker output for a `WorkerError`. */
function describeFailure(error: unknown): string {
  if (!(error instanceof WorkerError)) return messageOf(error)
  const parts = [error.message]
  if (error.traceback !== undefined) parts.push(lastChars(error.traceback, TRACEBACK_CHARS))
  if (error.logTail !== undefined && error.logTail !== '') parts.push(`Recent worker output:\n${lastChars(error.logTail, LOG_CHARS)}`)
  parts.push(`Error code: ${error.code}`)
  return parts.join('\n\n')
}

function report(stderr: Writable, what: string, error?: unknown): void {
  stderr.write(`app MCP server: ${what}${error === undefined ? '' : `: ${messageOf(error)}`}\n`)
}

/**
 * Diagnostics are best effort: a failed stderr write, such as after the client closed the pipe,
 * must not end the process before the close hook ran.
 */
function ignoreStderrError(): void {}

/** The shutdown of a served process: `connect` binds the connection, and the first `stop` shuts down. */
interface Shutdown {
  /** Bind the connection that shutdown closes; a `stop` before it waits for it. */
  readonly connect: (connection: StdioServerHandle) => void
  /** Shut down: close the connection, run the close hook, and exit; later calls do nothing. */
  readonly stop: () => void
}

/**
 * Shut down once, on the first `stop` or termination signal. The signal listeners stay until the
 * process exits, so a repeated SIGTERM or SIGINT, which the MCP client sends when it escalates, does
 * not end the process with the signal's default action before the close hook finished.
 */
function shutdownOnce(io: AppMcpProcess, onClose: (() => Promise<void>) | undefined, restoreConsole: () => void): Shutdown {
  const connection = Promise.withResolvers<StdioServerHandle>()
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void (async () => {
      // Closing the connection aborts the running tool calls, which stops their worker requests.
      await (await connection.promise).close()
      await runCloseHook(onClose, io.stderr)
      restoreConsole()
      // Exit once earlier diagnostics are flushed: pipe writes are asynchronous on macOS.
      io.stderr.write('', () => { io.exit(0) })
    })()
  }
  io.stderr.on('error', ignoreStderrError)
  io.signals.on('SIGTERM', stop)
  io.signals.on('SIGINT', stop)
  return { connect: connection.resolve, stop }
}

/** Await the close hook for at most the shutdown budget; a failure or overrun is reported, not thrown. */
async function runCloseHook(onClose: (() => Promise<void>) | undefined, stderr: Writable): Promise<void> {
  if (onClose === undefined) return
  const expired = Promise.withResolvers<'expired'>()
  const timer = setTimeout(() => { expired.resolve('expired') }, SHUTDOWN_BUDGET_MS)
  try {
    const outcome = await Promise.race([onClose().then(() => 'closed' as const), expired.promise])
    if (outcome === 'expired') report(stderr, `the close hook did not finish within ${SHUTDOWN_BUDGET_MS} ms; exiting anyway`)
  } catch (error) {
    report(stderr, 'the close hook failed; exiting anyway', error)
  } finally {
    clearTimeout(timer)
  }
}
