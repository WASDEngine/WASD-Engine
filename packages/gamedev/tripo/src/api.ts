/**
 * The WASD Engine API's 3D routes, which make models, textures, rigs, and animations with Tripo and charge them to the
 * signed-in account. A tool starts a task (`POST /v1/3d/generate`, `/texture`, `/rig-check`, `/rig`, or `/animate`),
 * waits for it by asking how it goes (`GET /v1/3d/tasks/<id>`), and downloads the GLB file it made
 * (`GET /v1/3d/tasks/<id>/model`). Every request sends the account's token in `x-dsh-auth-token` and never follows
 * redirects. A failed request throws {@link TripoRequestError}, worded for the agent.
 * @module @deepseek-ai/dsh-tripo/src/api
 */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { GatewayAccess } from '@deepseek-ai/dsh-game-mcp/kit'
import type { RigType, TripoTask, TripoTaskKind, View } from './types.ts'

/** The skeletons Tripo rigs. */
export const RIG_TYPES = [
  'biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others',
] as const satisfies readonly RigType[]

/** The kinds of task the API starts. */
export const TASK_KINDS = ['generate', 'texture', 'rig_check', 'rig', 'animate'] as const satisfies readonly TripoTaskKind[]

/** Largest model file the client reads; a P2 model with standard textures is a few MB. */
export const MAX_MODEL_BYTES = 256 * 1024 * 1024

/** Largest JSON answer the client reads. */
const MAX_JSON_BYTES = 1024 * 1024

/** How often a wait asks how its task is going. */
export const POLL_INTERVAL_MS = 3_000

/** Starts that the API answers busy (429) are tried again this many times, each after its `retry-after`. */
const BUSY_RETRIES = 6

/** The longest pause before a busy start is tried again. */
const MAX_BUSY_PAUSE_MS = 10_000

/** Status requests in a row that may fail in passing before a wait gives up. */
const STATUS_FAILURES = 5

/** A request the API refused or could not finish; the message is model-facing. */
export class TripoRequestError extends Error {
  override name = 'TripoRequestError'
  /**
   * @param message - what happened and what to do.
   * @param status - the HTTP status, or undefined when no response arrived.
   * @param retryAfterMs - how long a busy API asked the client to wait.
   */
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message)
  }
}

/** What the client needs from its plugin. */
export interface TripoApiOptions {
  /** Origin of the WASD Engine API, such as `https://api.wasdengine.com`. */
  readonly apiOrigin: string
  /**
   * The signed-in account's credential for a request URL.
   * @param url - the request URL.
   * @returns the credential, or undefined while signed out.
   */
  readonly access: (url: string) => Promise<GatewayAccess | undefined>
  /** HTTP client. */
  readonly fetch: typeof fetch
}

/** An image a task starts from: a PNG, JPEG, or WebP file the API takes. */
export interface TaskImage {
  readonly mimeType: string
  readonly data: Buffer
}

/** What each kind of task starts from. */
export type StartRequest =
  | {
    readonly kind: 'generate'
    readonly prompt?: string
    readonly images?: ReadonlyArray<TaskImage & { readonly view: View }>
    readonly faceLimit?: number
    readonly quad?: boolean
  }
  | { readonly kind: 'texture'; readonly taskId: string; readonly prompt?: string; readonly image?: TaskImage }
  | { readonly kind: 'rig_check'; readonly taskId: string }
  | { readonly kind: 'rig'; readonly taskId: string; readonly rigType: RigType }
  | { readonly kind: 'animate'; readonly taskId: string; readonly animations: readonly string[]; readonly inPlace: boolean }

/** The route that starts each kind of task. */
const START_PATHS: Readonly<Record<TripoTaskKind, string>> = {
  generate: '/v1/3d/generate',
  texture: '/v1/3d/texture',
  rig_check: '/v1/3d/rig-check',
  rig: '/v1/3d/rig',
  animate: '/v1/3d/animate',
}

const TaskJson = z.object({
  task_id: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  status: z.enum(['queued', 'running', 'success', 'failed']),
  progress: z.number().min(0).max(100),
  error: z.string().optional(),
  riggable: z.boolean().optional(),
  rig_type: z.enum(RIG_TYPES).optional(),
  animations: z.array(z.string()).optional(),
})

const ErrorJson = z.object({ error: z.object({ message: z.string() }) })

/** The JSON body of a start. */
function startBody(request: StartRequest): Record<string, unknown> {
  const file = (image: TaskImage) => ({ mime_type: image.mimeType, data: image.data.toString('base64') })
  switch (request.kind) {
    case 'generate':
      return {
        ...request.prompt === undefined ? {} : { prompt: request.prompt },
        ...request.images === undefined ? {} : { images: request.images.map(image => ({ view: image.view, ...file(image) })) },
        ...request.faceLimit === undefined ? {} : { face_limit: request.faceLimit },
        ...request.quad === true ? { quad: true } : {},
      }
    case 'texture':
      return {
        task_id: request.taskId,
        ...request.prompt === undefined ? {} : { prompt: request.prompt },
        ...request.image === undefined ? {} : { image: file(request.image) },
      }
    case 'rig_check':
      return { task_id: request.taskId }
    case 'rig':
      return { task_id: request.taskId, rig_type: request.rigType }
    case 'animate':
      return { task_id: request.taskId, animations: [...request.animations], in_place: request.inPlace }
  }
}

/**
 * Read a response body, refusing one larger than `limit` bytes.
 * @throws TripoRequestError when it is larger.
 */
async function bodyBytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const tooLarge = () => new TripoRequestError(`WASD Engine answered with more than the ${limit} bytes this tool reads.`, response.status)
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw tooLarge()
      parts.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(parts, total)
}

/** The refusal of a request the API answered with an error status, worded for the agent by status. */
async function refusal(response: Response, signal: AbortSignal): Promise<TripoRequestError> {
  const status = response.status
  let said: string | undefined
  try {
    const parsed = ErrorJson.safeParse(JSON.parse((await bodyBytes(response, MAX_JSON_BYTES, signal)).toString('utf8')))
    said = parsed.success ? parsed.data.error.message : undefined
  } catch (error) {
    signal.throwIfAborted()
    // A body that is not the API's error JSON: the status alone explains the failure.
    if (!(error instanceof SyntaxError || error instanceof TripoRequestError)) throw error
  }
  if (status === 401) return new TripoRequestError('The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.', status)
  if (status === 402) {
    return new TripoRequestError(`${said ?? 'Usage limit reached.'} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`, status)
  }
  if (status === 429) {
    const seconds = Number(response.headers.get('retry-after'))
    return new TripoRequestError(said ?? 'Tripo is busy. Wait a few seconds, then try again.', status, seconds > 0 ? seconds * 1000 : undefined)
  }
  if (said === undefined) return new TripoRequestError(`WASD Engine's 3D service failed (HTTP ${status}). Try again later.`, status)
  return new TripoRequestError(status >= 500 ? `WASD Engine's 3D service failed (HTTP ${status}): ${said}` : said, status)
}

/** A task from the API's answer. */
function taskOf(json: unknown, status: number): TripoTask {
  const parsed = TaskJson.safeParse(json)
  if (!parsed.success) throw new TripoRequestError('WASD Engine answered about a 3D task in an unexpected way.', status)
  const { task_id: taskId, kind, progress, error, riggable, rig_type: rigType, animations } = parsed.data
  return {
    taskId, kind, status: parsed.data.status, progress,
    ...error === undefined ? {} : { error },
    ...riggable === undefined ? {} : { riggable },
    ...rigType === undefined ? {} : { rigType },
    ...animations === undefined ? {} : { animations },
  }
}

/** Whether a failed status request may succeed when tried again: no answer, a busy API, or a server error. */
function passing(error: unknown): boolean {
  return error instanceof TripoRequestError && (error.status === undefined || error.status === 429 || error.status >= 500)
}

/** The WASD Engine 3D API as the tools call it. */
export class TripoApi {
  /** @param options - API origin, credential, and HTTP client. */
  constructor(private readonly options: TripoApiOptions) {}

  /**
   * Start a task; a busy API is asked again a few times, after the pause it names.
   * @param request - the kind of task and what it starts from.
   * @param signal - cancellation; a task the API started runs on, and is charged once it succeeds.
   * @returns the started task.
   */
  async start(request: StartRequest, signal: AbortSignal): Promise<TripoTask> {
    const body = JSON.stringify(startBody(request))
    for (let busy = 0; ; busy += 1) {
      try {
        return await this.read(await this.send('POST', START_PATHS[request.kind], signal, body), signal)
      } catch (error) {
        if (!(error instanceof TripoRequestError) || error.status !== 429 || busy >= BUSY_RETRIES) throw error
        await delay(Math.min(error.retryAfterMs ?? 2_000, MAX_BUSY_PAUSE_MS), undefined, { signal })
      }
    }
  }

  /**
   * How a task is going.
   * @param taskId - the task.
   * @param signal - cancellation.
   * @returns the task.
   */
  async task(taskId: string, signal: AbortSignal): Promise<TripoTask> {
    return await this.read(await this.send('GET', `/v1/3d/tasks/${encodeURIComponent(taskId)}`, signal), signal)
  }

  /**
   * Wait for a task to end, asking every {@link POLL_INTERVAL_MS}; status requests that fail in passing are tried again.
   * @param taskId - the task.
   * @param until - the time, as `Date.now()` gives it, by which the wait ends.
   * @param signal - cancellation.
   * @returns the task once it succeeded or failed.
   * @throws TripoRequestError when the task still runs at `until`, or the API refuses to report on it.
   */
  async wait(taskId: string, until: number, signal: AbortSignal): Promise<TripoTask> {
    let failures = 0
    let progress: number | undefined
    for (;;) {
      try {
        const task = await this.task(taskId, signal)
        if (task.status === 'success' || task.status === 'failed') return task
        failures = 0
        progress = task.progress
      } catch (error) {
        signal.throwIfAborted()
        failures += 1
        if (!passing(error) || failures >= STATUS_FAILURES) throw error
      }
      if (Date.now() + POLL_INTERVAL_MS >= until) {
        throw new TripoRequestError(`Tripo is still working on task ${taskId}${progress === undefined ? '' : ` (${progress}% done)`}.`)
      }
      await delay(POLL_INTERVAL_MS, undefined, { signal })
    }
  }

  /**
   * Download the GLB file of a finished task.
   * @param taskId - the task.
   * @param signal - cancellation.
   * @returns the file's bytes.
   */
  async model(taskId: string, signal: AbortSignal): Promise<Buffer> {
    const response = await this.send('GET', `/v1/3d/tasks/${encodeURIComponent(taskId)}/model`, signal, undefined, 'model/gltf-binary')
    return await bodyBytes(response, MAX_MODEL_BYTES, signal)
  }

  private async read(response: Response, signal: AbortSignal): Promise<TripoTask> {
    let json: unknown
    try {
      json = JSON.parse((await bodyBytes(response, MAX_JSON_BYTES, signal)).toString('utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    return taskOf(json, response.status)
  }

  private async send(method: 'GET' | 'POST', path: string, signal: AbortSignal, body?: string, accept = 'application/json'): Promise<Response> {
    const url = new URL(path, this.options.apiOrigin).href
    const access = await this.options.access(url)
    if (access === undefined) {
      throw new TripoRequestError('WASD Engine is signed out, and Tripo\'s 3D models are made through the signed-in account. Ask the user to sign in to WASD Engine, then try again.')
    }
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method,
        redirect: 'error',
        signal,
        headers: { 'x-dsh-auth-token': access.token, 'accept': accept, ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body },
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new TripoRequestError(`Cannot reach WASD Engine at ${this.options.apiOrigin}: ${(error as Error).message}`)
    }
    if (response.ok) return response
    if (response.status === 401) await access.reject()
    throw await refusal(response, signal)
  }
}
