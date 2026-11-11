/**
 * The WASD Engine API's audio routes, which make audio with ElevenLabs and price it against the signed-in account:
 * `POST /v1/audio/voices`, `/v1/audio/speech`, `/v1/audio/sound-effects`, and `/v1/audio/music`, and the account's
 * voice clones: `POST /v1/audio/voices/clone` and `DELETE /v1/audio/voices/<voice id>`. Each call sends the
 * account's token in `x-dsh-auth-token` and never follows redirects. A failed call throws {@link AudioRequestError}
 * with a message that says what the agent or the user can do.
 * @module @deepseek-ai/dsh-elevenlabs/src/api
 */
import { z } from 'zod'
import type {
  ElevenLabsAudio, ElevenLabsAudioKind, ElevenLabsClone, ElevenLabsCloneChange, ElevenLabsVoicePage, ElevenLabsVoiceSource,
} from './types.ts'

/** Largest audio file the client reads; the API answers at most 64 MiB. */
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024

/** Largest JSON or error body the client reads. */
const MAX_JSON_BYTES = 4 * 1024 * 1024

/** A request the API refused or could not finish; the message is model-facing. */
export class AudioRequestError extends Error {
  override name = 'AudioRequestError'
  /**
   * @param message - what happened and what to do.
   * @param status - the HTTP status, or undefined when no response arrived.
   */
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** The signed-in account's credential for one request. */
export interface AudioAccess {
  /** The account's token. */
  readonly token: string
  /** Report that the API refused the token, which signs the account out when it is still the stored one. */
  reject(): Promise<void>
}

/** What the client needs from its plugin. */
export interface AudioApiOptions {
  /** Origin of the WASD Engine API, such as `https://api.wasdengine.com`. */
  readonly apiOrigin: string
  /**
   * The signed-in account's credential for a request URL.
   * @param url - the request URL.
   * @returns the credential, or undefined while signed out.
   */
  readonly access: (url: string) => Promise<AudioAccess | undefined>
  /** HTTP client. */
  readonly fetch: typeof fetch
}

/** Fields of a voice search, as the API names them. */
export interface VoiceQuery {
  readonly query?: string
  readonly source?: ElevenLabsVoiceSource
  readonly gender?: string
  readonly age?: string
  readonly accent?: string
  readonly language?: string
  readonly use_case?: string
  readonly page?: number
  readonly page_size?: number
}

const VoicesJson = z.object({
  source: z.enum(['library', 'default', 'mine']),
  page: z.number().int().min(0),
  has_more: z.boolean(),
  voices: z.array(z.object({
    voice_id: z.string(),
    name: z.string(),
    description: z.string(),
    gender: z.string(),
    age: z.string(),
    accent: z.string(),
    language: z.string(),
    use_case: z.string(),
    preview_url: z.string(),
  })),
})

const ErrorJson = z.object({ error: z.object({ message: z.string() }) })

const ClonesJson = z.object({ name: z.string(), clones_used: z.number().int().min(0), clones_allowed: z.number().int().min(0) })
const CloneJson = ClonesJson.extend({ voice_id: z.string() })
const DeletedJson = ClonesJson.extend({ deleted: z.string() })

/** One recording sent for a clone. */
export interface CloneSample {
  /** File name, such as `take-1.wav`. */
  readonly name: string
  /** `audio/mpeg` or `audio/wav`. */
  readonly type: string
  readonly data: Buffer
}

/** What one clone sends; the consent fields record what the user confirmed and where. */
export interface CloneRequest {
  readonly name: string
  readonly description?: string
  readonly removeBackgroundNoise: boolean
  /** Version of the consent statement the user confirmed. */
  readonly consentStatement: string
  /** Where the user confirmed it: `app` (WASD Engine's approval prompt) or `mcp` (a connected agent's user). */
  readonly consentChannel: 'app' | 'mcp'
  readonly samples: readonly CloneSample[]
}

/** What a failed call was doing, as its error says. */
type Doing = 'make this audio' | 'search voices' | 'clone this voice' | 'delete this voice'

/** The route of each kind of audio. */
const AUDIO_PATHS: Readonly<Record<ElevenLabsAudioKind, string>> = {
  'speech': '/v1/audio/speech',
  'sound-effects': '/v1/audio/sound-effects',
  'music': '/v1/audio/music',
}

/**
 * Read a response body up to a size.
 * @throws AudioRequestError when it is larger.
 */
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (declared > limit) {
    await response.body?.cancel()
    throw new AudioRequestError(`WASD Engine answered with ${declared} bytes, more than the ${limit} this tool reads.`, response.status)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    signal.throwIfAborted()
    size += chunk.byteLength
    if (size > limit) {
      await response.body?.cancel()
      throw new AudioRequestError(`WASD Engine answered with more than the ${limit} bytes this tool reads.`, response.status)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** The WASD Engine audio API as the tools call it. */
export class AudioApi {
  /** @param options - API origin, credential, and HTTP client. */
  constructor(private readonly options: AudioApiOptions) {}

  private async send(
    method: 'POST' | 'DELETE', path: string, body: { readonly json: object } | { readonly form: FormData } | undefined,
    signal: AbortSignal, accept: string, doing: Doing,
  ): Promise<Response> {
    const url = new URL(path, this.options.apiOrigin).href
    const access = await this.options.access(url)
    if (access === undefined) {
      throw new AudioRequestError('WASD Engine is signed out, and ElevenLabs audio is made through the signed-in account. Ask the user to sign in to WASD Engine, then try again.')
    }
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method,
        redirect: 'error',
        signal,
        headers: { 'x-dsh-auth-token': access.token, 'accept': accept, ...body !== undefined && 'json' in body ? { 'content-type': 'application/json' } : {} },
        ...body === undefined ? {} : { body: 'json' in body ? JSON.stringify(body.json) : body.form },
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new AudioRequestError(`Cannot reach WASD Engine at ${this.options.apiOrigin}: ${(error as Error).message}`, undefined)
    }
    if (response.ok) return response
    if (response.status === 401) await access.reject()
    throw await this.failure(response, signal, doing)
  }

  private async post(path: string, body: object, signal: AbortSignal, accept: string, doing: Doing): Promise<Response> {
    return await this.send('POST', path, { json: body }, signal, accept, doing)
  }

  private async json<T>(response: Response, schema: z.ZodType<T>, signal: AbortSignal, what: string): Promise<T> {
    let json: unknown
    try {
      json = JSON.parse((await readBounded(response, MAX_JSON_BYTES, signal)).toString('utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      json = undefined
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new AudioRequestError(`WASD Engine answered ${what} in an unexpected way.`, response.status)
    return parsed.data
  }

  private async failure(response: Response, signal: AbortSignal, doing: Doing): Promise<AudioRequestError> {
    let message: string | undefined
    try {
      const parsed = ErrorJson.safeParse(JSON.parse((await readBounded(response, MAX_JSON_BYTES, signal)).toString('utf8')))
      if (parsed.success) message = parsed.data.error.message
    } catch (error) {
      signal.throwIfAborted()
      // A body that is not the API's error JSON: the status alone explains the failure.
      if (!(error instanceof SyntaxError || error instanceof AudioRequestError)) throw error
    }
    const status = response.status
    switch (status) {
      case 401:
        return new AudioRequestError('The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.', status)
      case 402:
        return new AudioRequestError(`${message ?? 'Usage limit reached.'} Ask the user to upgrade their WASD Engine plan or turn on auto recharge, then try again.`, status)
      case 403:
        return new AudioRequestError(message ?? 'WASD Engine refused the signed-in account.', status)
      case 429:
        return new AudioRequestError('ElevenLabs is busy. Wait a few seconds, then try again.', status)
      default:
        if (status >= 500 || message === undefined) {
          return new AudioRequestError(`WASD Engine could not ${doing} (HTTP ${status})${message === undefined ? '.' : `: ${message}`} Try again later.`, status)
        }
        return new AudioRequestError(`ElevenLabs could not ${doing}: ${message}`, status)
    }
  }

  /**
   * Find voices.
   * @param query - search fields.
   * @param signal - cancellation.
   * @returns one page of voices.
   */
  async voices(query: VoiceQuery, signal: AbortSignal): Promise<ElevenLabsVoicePage> {
    const response = await this.post('/v1/audio/voices', query, signal, 'application/json', 'search voices')
    const found = await this.json(response, VoicesJson, signal, 'the voice search')
    return {
      source: found.source,
      page: found.page,
      hasMore: found.has_more,
      voices: found.voices.map(voice => ({
        voiceId: voice.voice_id,
        name: voice.name,
        description: voice.description,
        gender: voice.gender,
        age: voice.age,
        accent: voice.accent,
        language: voice.language,
        useCase: voice.use_case,
        previewUrl: voice.preview_url,
      })),
    }
  }

  /**
   * Make one audio file.
   * @param kind - speech, sound effects, or music.
   * @param body - the route's fields.
   * @param signal - cancellation; a generation the API finished is still charged.
   * @returns the file and its length.
   */
  async generate(kind: ElevenLabsAudioKind, body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ElevenLabsAudio> {
    const response = await this.post(AUDIO_PATHS[kind], body, signal, 'audio/*', 'make this audio')
    const data = await readBounded(response, MAX_AUDIO_BYTES, signal)
    const durationMs = Number(response.headers.get('x-audio-duration-ms'))
    if (data.byteLength === 0 || !Number.isInteger(durationMs) || durationMs <= 0) {
      throw new AudioRequestError('WASD Engine answered without audio. Try again.', response.status)
    }
    return { data, durationMs }
  }

  /**
   * Clone a voice from recordings, for the signed-in account only.
   * @param request - name, recordings, and the consent the user confirmed.
   * @param signal - cancellation; a clone the API finished stays in the account.
   * @returns the new voice and how many clones the account keeps.
   */
  async cloneVoice(request: CloneRequest, signal: AbortSignal): Promise<ElevenLabsClone> {
    const form = new FormData()
    form.set('name', request.name)
    if (request.description !== undefined && request.description !== '') form.set('description', request.description)
    form.set('remove_background_noise', String(request.removeBackgroundNoise))
    form.set('consent', 'true')
    form.set('consent_statement', request.consentStatement)
    form.set('consent_channel', request.consentChannel)
    for (const sample of request.samples) form.append('files', new Blob([new Uint8Array(sample.data)], { type: sample.type }), sample.name)
    const response = await this.send('POST', '/v1/audio/voices/clone', { form }, signal, 'application/json', 'clone this voice')
    const clone = await this.json(response, CloneJson, signal, 'the clone')
    return { voiceId: clone.voice_id, name: clone.name, clonesUsed: clone.clones_used, clonesAllowed: clone.clones_allowed }
  }

  /**
   * Delete one of the account's clones, which frees its place.
   * @param voiceId - the clone's voice id.
   * @param signal - cancellation.
   * @returns the deleted voice and how many clones the account keeps.
   */
  async deleteVoice(voiceId: string, signal: AbortSignal): Promise<ElevenLabsCloneChange> {
    const response = await this.send('DELETE', `/v1/audio/voices/${encodeURIComponent(voiceId)}`, undefined, signal, 'application/json', 'delete this voice')
    const deleted = await this.json(response, DeletedJson, signal, 'the deletion')
    return { voiceId: deleted.deleted, name: deleted.name, clonesUsed: deleted.clones_used, clonesAllowed: deleted.clones_allowed }
  }
}
