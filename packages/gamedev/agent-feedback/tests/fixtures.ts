/**
 * A fake WASD Engine site on loopback HTTP for the agent feedback specs: the feedback and tool usage routes, answering
 * as the site does, or with an error a spec sets. It records each request with its path, token, and JSON body.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string
  /** Path, such as `/api/v1/feedback`. */
  readonly path: string
  /** The `x-dsh-auth-token` header. */
  readonly token: string | undefined
  /** The parsed JSON body. */
  readonly body: Record<string, unknown>
}

/** An error answer: status and the site's error message. */
export interface FakeFailure {
  readonly status: number
  readonly message?: string
}

/** A running fake site. */
export interface FakeSite {
  /** Origin of the fake, such as `http://127.0.0.1:1234`. */
  readonly origin: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** An error answer for every request to a path, until removed. */
  readonly failures: Map<string, FakeFailure>
  /** The requests to a path. */
  to(path: string): FakeRequest[]
  /** Stop listening. */
  close(): Promise<void>
}

/** Path of the feedback route. */
export const FEEDBACK_PATH = '/api/v1/feedback'

/** Path of the tool usage route. */
export const USAGE_PATH = '/api/v1/tool-usage'

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function answer(fake: FakeSite, request: FakeRequest, response: ServerResponse): void {
  const failure = fake.failures.get(request.path)
  if (failure !== undefined) {
    if (failure.message === undefined) {
      response.writeHead(failure.status, { 'content-type': 'text/plain' })
      response.end('oops')
    } else {
      json(response, failure.status, { type: 'error', error: { type: 'invalid_request_error', message: failure.message } })
    }
    return
  }
  if (request.method === 'POST' && request.path === FEEDBACK_PATH) {
    json(response, 201, { id: `feedback-${fake.requests.length}`, created_at: '2026-11-14T03:00:00Z' })
    return
  }
  if (request.method === 'POST' && request.path === USAGE_PATH) {
    json(response, 200, { recorded: Array.isArray(request.body.calls) ? request.body.calls.length : 0 })
    return
  }
  json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not found.' } })
}

/**
 * Start a fake site on a free loopback port.
 * @returns the running fake; close it in teardown.
 */
export async function startFakeSite(): Promise<FakeSite> {
  const fake: FakeSite = {
    origin: '',
    requests: [],
    failures: new Map(),
    to: path => fake.requests.filter(request => request.path === path),
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
