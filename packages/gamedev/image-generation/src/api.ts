/**
 * The WASD Engine API's image route, which makes images with Google's Nano Banana 2.1 and prices them against the
 * signed-in account: `POST /v1/images/generate`. Each call sends the account's token in `x-dsh-auth-token` and never
 * follows redirects. A failed call throws {@link ImageRequestError} with a message that says what the agent or the user
 * can do.
 * @module @deepseek-ai/dsh-image-generation/src/api
 */
import { z } from 'zod'
import type { GeneratedImage, ImageAspectRatio, ImageFormat, ImageSize, SentImage } from './types.ts'

/** Largest image file the client reads; a 4K PNG stays well below it. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024

/** Largest error body the client reads. */
const MAX_ERROR_BYTES = 1024 * 1024

/** A request the API refused or could not finish; the message is model-facing. */
export class ImageRequestError extends Error {
  override name = 'ImageRequestError'
  /**
   * @param message - what happened and what to do.
   * @param status - the HTTP status, or undefined when no response arrived.
   */
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** The signed-in account's credential for one request. */
export interface ImageAccess {
  /** The account's token. */
  readonly token: string
  /** Report that the API refused the token, which signs the account out when it is still the stored one. */
  reject(): Promise<void>
}

/** What the client needs from its plugin. */
export interface ImageApiOptions {
  /** Origin of the WASD Engine API, such as `https://api.wasdengine.com`. */
  readonly apiOrigin: string
  /**
   * The signed-in account's credential for a request URL.
   * @param url - the request URL.
   * @returns the credential, or undefined while signed out.
   */
  readonly access: (url: string) => Promise<ImageAccess | undefined>
  /** HTTP client. */
  readonly fetch: typeof fetch
}

/** One generation, as the tool asks for it. */
export interface GenerationRequest {
  readonly prompt: string
  /** Images to edit or to match, in the order the prompt refers to them. */
  readonly images: readonly SentImage[]
  readonly aspectRatio: ImageAspectRatio
  readonly size: ImageSize
}

const ErrorJson = z.object({ error: z.object({ message: z.string() }) })

/** The file type of each image media type the API answers with. */
const FORMATS: Readonly<Record<string, ImageFormat>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }

/**
 * Read a response body up to a size.
 * @throws ImageRequestError when it is larger.
 */
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (declared > limit) {
    await response.body?.cancel()
    throw new ImageRequestError(`WASD Engine answered with ${declared} bytes, more than the ${limit} this tool reads.`, response.status)
  }
  const chunks: Buffer[] = []
  let size = 0
  // Leaving the loop by a throw cancels the body through the iterator; the stream is locked to it meanwhile.
  for await (const chunk of response.body ?? []) {
    signal.throwIfAborted()
    size += chunk.byteLength
    if (size > limit) throw new ImageRequestError(`WASD Engine answered with more than the ${limit} bytes this tool reads.`, response.status)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** A positive integer header, or undefined. */
function dimension(response: Response, name: string): number | undefined {
  const value = Number(response.headers.get(name))
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** The WASD Engine image API as the tool calls it. */
export class ImageApi {
  /** @param options - API origin, credential, and HTTP client. */
  constructor(private readonly options: ImageApiOptions) {}

  /**
   * Make one image.
   * @param request - the prompt, the images to send, and the image's shape and size.
   * @param signal - cancellation; a generation the API finished is still charged.
   * @returns the image file as the API returned it.
   */
  async generate(request: GenerationRequest, signal: AbortSignal): Promise<GeneratedImage> {
    const url = new URL('/v1/images/generate', this.options.apiOrigin).href
    const access = await this.options.access(url)
    if (access === undefined) {
      throw new ImageRequestError('WASD Engine is signed out, and images are made through the signed-in account. Ask the user to sign in to WASD Engine, then try again.')
    }
    const body = {
      prompt: request.prompt,
      images: request.images.map(image => ({ mime_type: image.mimeType, data: image.data.toString('base64') })),
      aspect_ratio: request.aspectRatio,
      size: request.size,
    }
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'x-dsh-auth-token': access.token, 'accept': 'image/*', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new ImageRequestError(`Cannot reach WASD Engine at ${this.options.apiOrigin}: ${(error as Error).message}`, undefined)
    }
    if (!response.ok) {
      if (response.status === 401) await access.reject()
      throw await this.failure(response, signal)
    }
    const format = FORMATS[(response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '']
    const data = await readBounded(response, MAX_IMAGE_BYTES, signal)
    const width = dimension(response, 'x-image-width')
    const height = dimension(response, 'x-image-height')
    if (format === undefined || data.byteLength === 0 || width === undefined || height === undefined) {
      throw new ImageRequestError('WASD Engine answered without an image. Try again.', response.status)
    }
    return { data, format, width, height }
  }

  private async failure(response: Response, signal: AbortSignal): Promise<ImageRequestError> {
    let message: string | undefined
    try {
      const parsed = ErrorJson.safeParse(JSON.parse((await readBounded(response, MAX_ERROR_BYTES, signal)).toString('utf8')))
      if (parsed.success) message = parsed.data.error.message
    } catch (error) {
      signal.throwIfAborted()
      // A body that is not the API's error JSON: the status alone explains the failure.
      if (!(error instanceof SyntaxError || error instanceof ImageRequestError)) throw error
    }
    const status = response.status
    switch (status) {
      case 401:
        return new ImageRequestError('The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.', status)
      case 402:
        return new ImageRequestError(`${message ?? 'Usage limit reached.'} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`, status)
      case 403:
        return new ImageRequestError(message ?? 'WASD Engine refused the signed-in account.', status)
      case 429:
        return new ImageRequestError('Image generation is busy. Wait a few seconds, then try again.', status)
      default:
        // The API's own messages for its failures already say when to try again.
        if (message === undefined) return new ImageRequestError(`WASD Engine could not make this image (HTTP ${status}). Try again later.`, status)
        if (status >= 500) return new ImageRequestError(`WASD Engine could not make this image (HTTP ${status}): ${message}`, status)
        return new ImageRequestError(`Nano Banana could not make this image: ${message}`, status)
    }
  }
}
