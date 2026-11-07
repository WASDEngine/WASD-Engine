/**
 * The loopback HTTP listener of the MCP server. It binds `127.0.0.1` only, reads each POST body within
 * {@link MAX_BODY_BYTES}, hands the handler a web-standard `Request` whose signal aborts when the caller goes away,
 * and streams the handler's `Response` back. Closing the listener ends its open connections.
 * @module @deepseek-ai/dsh-game-mcp/src/http
 */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** The only address the listener binds. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Largest request body; the MCP SDK reads bodies within the same bound. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Answer one request.
 * @param request - the request, without its body for methods other than POST.
 * @param body - the POST body bytes.
 * @returns the response to stream back.
 */
export type HttpHandler = (request: Request, body: Uint8Array<ArrayBuffer> | undefined) => Promise<Response>

/** A listening loopback server. */
export interface HttpListener {
  /** Bound port. */
  readonly port: number
  /** Stop listening and end every open connection. @returns once the server closed. */
  close(): Promise<void>
}

/**
 * Listen on a loopback port.
 * @param port - port to bind; 0 binds a free one.
 * @param handler - answers each request.
 * @param report - receives failures of a request after its response began, and server errors after binding.
 * @returns the listener once it is bound.
 * @throws the bind failure, such as `EADDRINUSE`.
 */
export async function listenLoopback(port: number, handler: HttpHandler, report: (error: unknown) => void): Promise<HttpListener> {
  const server = createServer((request, response) => {
    void serve(request, response, handler).catch((error: unknown) => {
      report(error)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening)
      reject(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      resolve()
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(port, LOOPBACK_HOST)
  })
  server.on('error', report)
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    }),
  }
}

/**
 * Read a request body within a bound; the rest of a longer body is drained.
 * @returns the bytes, or undefined when the body exceeds the bound.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size <= limit) chunks.push(chunk)
  }
  return size > limit ? undefined : new Uint8Array(Buffer.concat(chunks))
}

async function serve(incoming: IncomingMessage, outgoing: ServerResponse, handler: HttpHandler): Promise<void> {
  const target = incoming.url ?? '/'
  if (!target.startsWith('/')) {
    outgoing.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request')
    return
  }
  const caller = new AbortController()
  outgoing.on('close', () => { if (!outgoing.writableFinished) caller.abort() })
  let body: Uint8Array<ArrayBuffer> | undefined
  if (incoming.method === 'POST') {
    body = await readBody(incoming, MAX_BODY_BYTES)
    if (body === undefined) {
      outgoing.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('Request body too large')
      return
    }
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const request = new Request(new URL(target, `http://${LOOPBACK_HOST}`), {
    method: incoming.method ?? 'GET',
    headers,
    signal: caller.signal,
    ...body === undefined ? {} : { body },
  })
  const response = await handler(request, body)
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body === null) {
    outgoing.end()
    return
  }
  const reader = response.body.getReader()
  caller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => { /* The caller left; nothing reads the rest. */ }) }, { once: true })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!outgoing.write(value)) await once(outgoing, 'drain', { signal: caller.signal }).catch(() => { /* The caller left mid-write. */ })
    if (caller.signal.aborted) return
  }
  outgoing.end()
}
