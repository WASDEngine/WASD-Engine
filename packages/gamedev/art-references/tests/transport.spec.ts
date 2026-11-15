/**
 * The reference tools' web on this computer, against servers on loopback: each request connects to an address its
 * caller checked, never to the host name, directly or through a proxy asked to connect to that address, and reads
 * compressed bodies.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { getPublic, type LookupAddress } from '../src/net.ts'
import { createNodeWeb } from '../src/transport.ts'
import { PUBLIC_ADDRESS } from './fixtures.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

/** One request a test server received. */
interface Received {
  readonly host: string | undefined
  readonly path: string | undefined
  readonly userAgent: string | undefined
}

/** Start a server on loopback that answers each request with `answer` and records it. */
async function startServer(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((request, response) => {
    received.push({ host: request.headers.host, path: request.url, userAgent: request.headers['user-agent'] })
    answer(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, received }
}

/** Start an HTTP proxy on loopback that tunnels every `CONNECT` to `port` on loopback, or refuses with `refuse`. */
async function startProxy(
  port: number,
  refuse?: number,
): Promise<{ port: number; targets: string[]; authorizations: (string | undefined)[] }> {
  const targets: string[] = []
  const authorizations: (string | undefined)[] = []
  const proxy = createServer((_request, response) => {
    response.writeHead(405)
    response.end()
  })
  proxy.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    targets.push(request.url ?? '')
    authorizations.push(request.headers['proxy-authorization'])
    if (refuse !== undefined) {
      client.end(`HTTP/1.1 ${refuse} Refused\r\n\r\n`)
      return
    }
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => { client.destroy() })
    client.on('error', () => { upstream.destroy() })
  })
  servers.push(proxy)
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
  return { port: (proxy.address() as AddressInfo).port, targets, authorizations }
}

function options(overrides: Partial<Parameters<typeof getPublic>[2]> = {}): Parameters<typeof getPublic>[2] {
  return { accept: 'image/*', maxBytes: 1024 * 1024, truncate: false, timeoutMs: 10_000, signal: new AbortController().signal, ...overrides }
}

/** A socket opener that connects every address to one loopback port, recording the addresses it was given. */
function toLoopback(port: number, opened: string[]): (address: LookupAddress, _port: number, signal: AbortSignal) => Promise<Socket> {
  return (address, _port, signal) => new Promise<Socket>((resolve, reject) => {
    signal.throwIfAborted()
    opened.push(address.address)
    const socket = connect(port, '127.0.0.1', () => { resolve(socket) })
    socket.once('error', reject)
  })
}

describe('the web on this computer', () => {
  it('connects to the address it is given without resolving the host name, and names the host to the server', async () => {
    const site = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hello')
    })
    const web = createNodeWeb({
      userAgent: 'test-agent',
      resolve: () => Promise.reject(new Error('the request resolved the host name')),
      proxyFor: () => undefined,
    })
    const response = await web.request(new URL(`http://pages.example:${site.port}/a.png?size=2`), [{ address: '127.0.0.1', family: 4 }], {
      headers: { 'user-agent': 'test-agent' }, signal: new AbortController().signal,
    })
    const chunks: Buffer[] = []
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
    expect([response.status, response.header('Content-Type'), Buffer.concat(chunks).toString()]).toEqual([200, 'text/plain', 'hello'])
    expect(site.received).toEqual([{ host: `pages.example:${site.port}`, path: '/a.png?size=2', userAgent: 'test-agent' }])
  })

  it('reaches only the address its lookup checked when the host answers with loopback afterwards', async () => {
    const site = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end('png!')
    })
    const answers = [[PUBLIC_ADDRESS], ['127.0.0.1']]
    const lookups: string[] = []
    const opened: string[] = []
    const web = createNodeWeb({
      userAgent: 'test-agent',
      resolve: (hostname) => {
        lookups.push(hostname)
        return Promise.resolve((answers.shift() ?? ['127.0.0.1']).map(address => ({ address, family: 4 })))
      },
      openSocket: toLoopback(site.port, opened),
      proxyFor: () => undefined,
    })
    const got = await getPublic(web, `http://rebind.example:${site.port}/a.png`, options())
    expect(got.body.toString()).toBe('png!')
    expect([lookups, opened]).toEqual([['rebind.example'], [PUBLIC_ADDRESS]])
    await expect(getPublic(web, `http://rebind.example:${site.port}/a.png`, options())).rejects.toThrow('is on this computer or a local network')
    expect(opened).toEqual([PUBLIC_ADDRESS])
    expect(site.received).toHaveLength(1)
  })

  it('asks a proxy to connect to the checked address rather than the host name, with the proxy\'s credentials', async () => {
    const site = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>page</title>')
    })
    const proxy = await startProxy(site.port)
    const web = createNodeWeb({
      userAgent: 'test-agent',
      resolve: () => Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 }]),
      proxyFor: () => `http://user:p%40ss@127.0.0.1:${proxy.port}`,
    })
    const got = await getPublic(web, `http://pages.example:${site.port}/gallery`, options())
    expect(got.body.toString()).toBe('<title>page</title>')
    expect(proxy.targets).toEqual([`${PUBLIC_ADDRESS}:${site.port}`])
    expect(proxy.authorizations).toEqual([`Basic ${Buffer.from('user:p@ss').toString('base64')}`])
    expect(site.received).toEqual([{ host: `pages.example:${site.port}`, path: '/gallery', userAgent: 'test-agent' }])
  })

  it('reports a proxy that refuses the connection', async () => {
    const proxy = await startProxy(1, 403)
    const web = createNodeWeb({
      userAgent: 'test-agent',
      resolve: () => Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 }]),
      proxyFor: () => `http://127.0.0.1:${proxy.port}`,
    })
    await expect(getPublic(web, 'http://pages.example/', options())).rejects.toThrow(`could not be reached: the proxy 127.0.0.1:${proxy.port} refused the connection (HTTP 403)`)
  })

  it('reads a compressed body and stops a server that does not answer at the time limit', async () => {
    const page = '<html>'.padEnd(20_000, 'x')
    const site = await startServer((request, response) => {
      if (request.url === '/slow') return
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      response.end(gzipSync(page))
    })
    const opened: string[] = []
    const web = createNodeWeb({
      userAgent: 'test-agent',
      resolve: () => Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 }]),
      openSocket: toLoopback(site.port, opened),
      proxyFor: () => undefined,
    })
    const got = await getPublic(web, 'http://pages.example/', options())
    expect(got.body.toString()).toBe(page)
    await expect(getPublic(web, 'http://pages.example/slow', options({ timeoutMs: 200 }))).rejects.toThrow('did not answer within 200 ms.')
  })
})
