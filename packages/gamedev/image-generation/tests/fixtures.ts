/**
 * A fake WASD Engine API on loopback HTTP for the image specs: the image route, answering with an image a spec sets, or
 * with an error status a spec sets. It records each request with its method, token, and JSON body.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string
  /** Path, such as `/v1/images/generate`. */
  readonly path: string
  /** The `x-dsh-auth-token` header. */
  readonly token: string | undefined
  /** The parsed JSON body. */
  readonly body: Record<string, unknown>
}

/** An error answer: status and the API's error message. */
export interface FakeFailure {
  readonly status: number
  readonly message?: string
}

/** The image the fake answers with. */
export interface FakeImage {
  readonly data: Buffer
  readonly type: string
  readonly width: number
  readonly height: number
}

/** A running fake API. */
export interface FakeImageApi {
  /** Origin of the fake, such as `http://127.0.0.1:1234`. */
  readonly origin: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** An error answer for every request to a path, until removed. */
  readonly failures: Map<string, FakeFailure>
  /** The image every generation answers with. */
  image: FakeImage
  /** Stop listening. */
  close(): Promise<void>
}

/**
 * An image of one color.
 * @param width - width in pixels.
 * @param height - height in pixels.
 * @param format - file type.
 * @returns the file's bytes.
 */
export async function solidImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png'): Promise<Buffer> {
  return await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 40 } } }).toFormat(format).toBuffer()
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function answer(fake: FakeImageApi, request: FakeRequest, response: ServerResponse): void {
  const failure = fake.failures.get(request.path)
  if (failure !== undefined) {
    const body = failure.message === undefined ? 'oops' : JSON.stringify({ type: 'error', error: { type: 'api_error', message: failure.message } })
    response.writeHead(failure.status, { 'content-type': failure.message === undefined ? 'text/plain' : 'application/json' })
    response.end(body)
    return
  }
  if (request.method !== 'POST' || request.path !== '/v1/images/generate') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found.' } }))
    return
  }
  response.writeHead(200, {
    'content-type': fake.image.type,
    'x-image-width': String(fake.image.width),
    'x-image-height': String(fake.image.height),
  })
  response.end(fake.image.data)
}

/**
 * Start a fake API on a free loopback port; it answers with a 1024 × 1024 PNG until a spec sets another image.
 * @returns the running fake; close it in teardown.
 */
export async function startFakeImageApi(): Promise<FakeImageApi> {
  const fake: FakeImageApi = {
    origin: '',
    requests: [],
    failures: new Map(),
    image: { data: await solidImage(1024, 1024), type: 'image/png', width: 1024, height: 1024 },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const token = request.headers['x-dsh-auth-token']
      const recorded: FakeRequest = {
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://fake').pathname,
        token: typeof token === 'string' ? token : undefined,
        body: await readBody(request),
      }
      fake.requests.push(recorded)
      answer(fake, recorded, response)
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return Object.assign(fake, { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
}
