/**
 * A fake WASD Engine API on loopback HTTP for the ElevenLabs specs: the audio routes and the clone routes, answering
 * with canned voices, audio, and clones, or with an error status a spec sets. It records each request with its method,
 * token, and body: the JSON object, or a clone's form fields with each file's name, type, and size.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string
  /** Path, such as `/v1/audio/speech`. */
  readonly path: string
  /** The `x-dsh-auth-token` header. */
  readonly token: string | undefined
  /** The parsed JSON body, or a clone's form fields. */
  readonly body: Record<string, unknown>
}

/** The id of the clone the fake makes. */
export const CLONE_ID = 'CloneRhea00000000000'

/** An error answer: status and the API's error message. */
export interface FakeFailure {
  readonly status: number
  readonly message?: string
}

/** A running fake API. */
export interface FakeAudioApi {
  /** Origin of the fake, such as `http://127.0.0.1:1234`. */
  readonly origin: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** An error answer for every request to a path, until removed. */
  readonly failures: Map<string, FakeFailure>
  /** Stop listening. */
  close(): Promise<void>
}

/** The bytes the fake sends for an MP3 file. */
export const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(509, 1)])

/** The bytes the fake sends for a WAV file. */
export const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(300, 2)])

/** The voices the fake lists. */
export const VOICES = [
  {
    voice_id: 'LvmvHEBEmMJBJw9UuhwO',
    name: 'Eldrin - Wise Ancient Wizard',
    description: 'A deep, resonant, and warm voice infused with centuries of wisdom and subtle magic, perfect for fantasy audiobooks, epic RPG questgivers, game cutscenes, and immersive lore channels.',
    gender: 'male',
    age: 'old',
    accent: 'british',
    language: 'en',
    use_case: 'characters_animation',
    preview_url: 'https://storage.example/eldrin.mp3',
  },
  {
    voice_id: 'JBFqnCBsd6RMkjVDRZzb',
    name: 'George',
    description: '',
    gender: 'male',
    age: '',
    accent: '',
    language: '',
    use_case: '',
    preview_url: '',
  },
]

/** The length the fake reports for each kind of audio, in milliseconds. */
export const DURATIONS: Readonly<Record<string, number>> = {
  '/v1/audio/speech': 1725,
  '/v1/audio/sound-effects': 2000,
  '/v1/audio/music': 30_000,
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks)
  const type = request.headers['content-type'] ?? ''
  if (type.startsWith('multipart/form-data')) {
    const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData()
    const fields: Record<string, unknown> = { files: [] }
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') fields[name] = value
      else (fields.files as unknown[]).push({ name: value.name, type: value.type, size: value.size })
    }
    return fields
  }
  const text = raw.toString('utf8')
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function answer(fake: FakeAudioApi, request: FakeRequest, response: ServerResponse): void {
  const failure = fake.failures.get(request.path)
  if (failure !== undefined) {
    const body = failure.message === undefined ? 'oops' : JSON.stringify({ type: 'error', error: { type: 'api_error', message: failure.message } })
    response.writeHead(failure.status, { 'content-type': failure.message === undefined ? 'text/plain' : 'application/json' })
    response.end(body)
    return
  }
  if (request.path === '/v1/audio/voices/clone') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ voice_id: CLONE_ID, name: request.body.name, clones_used: 1, clones_allowed: 3 }))
    return
  }
  if (request.method === 'DELETE' && request.path.startsWith('/v1/audio/voices/')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ deleted: request.path.slice('/v1/audio/voices/'.length), name: 'Captain Rhea', clones_used: 0, clones_allowed: 3 }))
    return
  }
  if (request.path === '/v1/audio/voices') {
    const page = typeof request.body.page === 'number' ? request.body.page : 0
    const source = request.body.source === 'default' || request.body.source === 'mine' ? request.body.source : 'library'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ source, page, has_more: page === 0, voices: page === 0 ? VOICES : [] }))
    return
  }
  const duration = DURATIONS[request.path]
  if (duration === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found.' } }))
    return
  }
  const wav = request.body.format === 'wav'
  response.writeHead(200, { 'content-type': wav ? 'audio/wav' : 'audio/mpeg', 'x-audio-duration-ms': String(duration) })
  response.end(wav ? WAV : MP3)
}

/**
 * Start a fake API on a free loopback port.
 * @returns the running fake; close it in teardown.
 */
export async function startFakeAudioApi(): Promise<FakeAudioApi> {
  const fake: FakeAudioApi = {
    origin: '',
    requests: [],
    failures: new Map(),
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
