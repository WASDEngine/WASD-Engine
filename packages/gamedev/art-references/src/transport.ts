/**
 * How the reference tools reach the web from this computer: host names resolve through the operating system, and each
 * request opens its own connection to an address its caller checked, never to the host name. Without a proxy the
 * connection goes straight to that address; when the harness's proxy policy routes the address's scheme through a
 * proxy, the proxy is asked to connect to that address (HTTP `CONNECT`), so the proxy does not resolve the host name
 * either. HTTPS verifies the site's certificate against its host name. Requests speak HTTP/1.1, accept gzip, deflate,
 * and Brotli bodies, and close their connection when done.
 * @module @deepseek-ai/dsh-art-references/src/transport
 */
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectTcp, isIP, type Socket } from 'node:net'
import type { Readable } from 'node:stream'
import { connect as connectTls } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { bareHostname, type LookupAddress, type ReferenceWeb, type WebResponse } from './net.ts'

/** The parts of a web on this computer, each defaulting to the operating system's and the harness's. */
export interface NodeWebOptions {
  /** `User-Agent` of every request. */
  readonly userAgent: string
  /**
   * Resolve a host name to every address it has; the operating system's resolver by default.
   * @param hostname - the host name.
   * @returns its addresses.
   */
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>
  /**
   * Open a TCP connection to one address; a direct connection by default.
   * @param address - the address, which the caller checked.
   * @param port - the port.
   * @param signal - cancellation.
   * @returns the connected socket.
   */
  readonly openSocket?: (address: LookupAddress, port: number, signal: AbortSignal) => Promise<Socket>
  /**
   * The HTTP or HTTPS proxy a request goes through; the harness's proxy policy by default.
   * @param url - the address requested.
   * @returns the proxy's URL, or undefined for a direct connection.
   */
  readonly proxyFor?: (url: URL) => string | undefined
}

/**
 * The web as the reference tools reach it from this computer.
 * @param options - the user agent, and any part that replaces the operating system's or the harness's.
 * @returns the web.
 */
export function createNodeWeb(options: NodeWebOptions): ReferenceWeb {
  const resolve = options.resolve ?? (async (hostname: string) => await lookup(hostname, { all: true, order: 'verbatim' }))
  const openSocket = options.openSocket ?? openDirect
  const proxyFor = options.proxyFor ?? harnessProxy
  return {
    userAgent: options.userAgent,
    async lookup(hostname, signal) {
      signal.throwIfAborted()
      return await resolve(hostname)
    },
    async request(url, addresses, init) {
      const port = Number(url.port === '' ? url.protocol === 'https:' ? 443 : 80 : url.port)
      const proxy = proxyFor(url)
      let failure: unknown = new Error('no address to connect to')
      for (const address of addresses) {
        let socket: Socket
        try {
          socket = proxy === undefined ? await openSocket(address, port, init.signal) : await tunnel(proxy, address, port, init.signal)
        } catch (error) {
          // The next address may answer; the last failure is the request's.
          init.signal.throwIfAborted()
          failure = error
          continue
        }
        const stream = url.protocol === 'https:' ? await secure(socket, bareHostname(url), init.signal) : socket
        return await send(url, stream, init)
      }
      throw failure
    },
  }
}

/**
 * The proxy the harness routes an address through.
 * @param url - the address.
 * @returns the proxy's URL, or undefined for a direct connection.
 */
function harnessProxy(url: URL): string | undefined {
  const route = proxyRouteFor(url)
  return route.proxied ? route.proxy : undefined
}

/**
 * Settle a promise of a socket that is still connecting: aborting the signal destroys the socket.
 * @param socket - the connecting socket.
 * @param ready - the event that marks it connected.
 * @param signal - cancellation.
 * @returns the connected socket.
 */
function connected<T extends Socket>(socket: T, ready: 'connect' | 'secureConnect', signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      socket.destroy()
      reject(signal.reason instanceof Error ? signal.reason : new Error('The request was stopped.'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    socket.once(ready, () => {
      signal.removeEventListener('abort', abort)
      resolve(socket)
    })
    socket.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/**
 * Open a TCP connection to an IP address; with an address rather than a name, no resolution takes place.
 * @param address - the address.
 * @param port - the port.
 * @param signal - cancellation.
 * @returns the connected socket.
 */
async function openDirect(address: LookupAddress, port: number, signal: AbortSignal): Promise<Socket> {
  return await connected(connectTcp({ host: address.address, port }), 'connect', signal)
}

/**
 * Ask an HTTP or HTTPS proxy for a tunnel to an IP address.
 * @param proxy - the proxy's URL, with its credentials when it has any.
 * @param address - the address the tunnel reaches.
 * @param port - the port the tunnel reaches.
 * @param signal - cancellation.
 * @returns the tunnel's socket.
 * @throws Error when the proxy cannot be reached or refuses the tunnel.
 */
async function tunnel(proxy: string, address: LookupAddress, port: number, signal: AbortSignal): Promise<Socket> {
  const via = new URL(proxy)
  const target = `${address.family === 6 ? `[${address.address}]` : address.address}:${port}`
  const credentials = via.username === '' && via.password === ''
    ? {}
    : { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(via.username)}:${decodeURIComponent(via.password)}`).toString('base64')}` }
  const open = via.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<Socket>((resolve, reject) => {
    const request = open({
      host: bareHostname(via),
      port: Number(via.port === '' ? via.protocol === 'https:' ? 443 : 80 : via.port),
      method: 'CONNECT',
      path: target,
      headers: { host: target, ...credentials },
      agent: false,
      signal,
    })
    request.once('connect', (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`the proxy ${via.host} refused the connection (HTTP ${String(response.statusCode)})`))
        return
      }
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    request.once('error', reject)
    request.end()
  })
}

/**
 * Start TLS on a connection, checking the site's certificate against its host name.
 * @param socket - the connection.
 * @param host - the site's host name, or its IP address for an address written as one.
 * @param signal - cancellation.
 * @returns the secured socket.
 */
async function secure(socket: Socket, host: string, signal: AbortSignal): Promise<Socket> {
  // Server Name Indication carries names only; an address checks against the certificate's addresses.
  const tls = connectTls({ socket, host, ...isIP(host) === 0 ? { servername: host } : {}, ALPNProtocols: ['http/1.1'] })
  try {
    return await connected(tls, 'secureConnect', signal)
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * Send one GET over a connection and wait for the response's head.
 * @param url - the address requested.
 * @param socket - the connection to the address's server.
 * @param init - headers and cancellation.
 * @returns the response, with its body not yet read.
 */
async function send(url: URL, socket: Socket, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<WebResponse> {
  return await new Promise<WebResponse>((resolve, reject) => {
    const request = httpRequest({
      createConnection: () => socket,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { ...init.headers, 'host': url.host, 'accept-encoding': 'gzip, deflate, br', 'connection': 'close' },
      setHost: false,
      signal: init.signal,
    })
    request.once('response', (response: IncomingMessage) => { resolve(webResponse(response)) })
    request.once('error', (error) => {
      socket.destroy()
      reject(error)
    })
    request.end()
  })
}

/**
 * A response as the reference tools read it, decompressing a gzip, deflate, or Brotli body.
 * @param response - the response.
 * @returns the response.
 */
function webResponse(response: IncomingMessage): WebResponse {
  const header = (name: string): string | undefined => {
    const value = response.headers[name.toLowerCase()]
    return Array.isArray(value) ? value.join(', ') : value
  }
  const encoding = (header('content-encoding') ?? '').trim().toLowerCase()
  const decoder = encoding === 'gzip' || encoding === 'x-gzip'
    ? createGunzip()
    : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined
  let body: Readable = response
  if (decoder !== undefined) {
    response.once('error', (error) => { decoder.destroy(error) })
    body = response.pipe(decoder)
  }
  return {
    status: response.statusCode ?? 0,
    header,
    body,
    cancel() {
      decoder?.destroy()
      response.destroy()
    },
  }
}
