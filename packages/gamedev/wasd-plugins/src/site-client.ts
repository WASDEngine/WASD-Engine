/**
 * The WASD Engine site as the plugins call it: requests to its API that never follow a redirect and carry the
 * signed-in account's token in `x-dsh-auth-token` when there is one, and its JSON answers and error bodies, which every
 * caller reads alike. Each caller names how its failures read ({@link SiteFailures}), so they keep its error class and
 * words.
 * @module @deepseek-ai/dsh-wasd-plugins/src/site-client
 */
import { z } from 'zod'

/** The signed-in site: its origin and the account's token. */
export interface SiteAccess {
  /** Origin of the WASD Engine site, such as `https://app.wasdengine.com`. */
  readonly origin: string
  /** The signed-in account's token; empty for a public route. */
  readonly token: string
  /** `accountKey` of the signed-in account (`game-link.ts`), when the app knows the account's ID. */
  readonly account?: string
}

/** How a caller's failures read. */
export interface SiteFailures {
  /**
   * Builds the caller's error.
   * @param message - what went wrong and what to do.
   * @param code - the site's error code, when it sent one.
   * @param options - the cause.
   * @returns the error.
   */
  readonly error: (message: string, code?: string, options?: ErrorOptions) => Error
  /** What the user does once signed in again, such as `try again`. */
  readonly again: string
  /** The site's error codes that read as messages of their own, with those messages. */
  readonly codes?: Readonly<Record<string, string>>
}

/** A request body and its media type. */
export interface SiteBody {
  /** The body. */
  readonly data: BodyInit
  /** Its `content-type`. */
  readonly type: string
}

const ErrorJson = z.object({ error: z.object({ message: z.string(), type: z.string().optional(), code: z.string().optional() }) })

/** One caller's view of the site's API. */
export class SiteClient {
  /**
   * @param access - the signed-in site.
   * @param fetchUrl - HTTP client.
   * @param signal - cancellation of every call.
   * @param failures - how the caller's failures read.
   */
  constructor(
    private readonly access: SiteAccess,
    private readonly fetchUrl: typeof fetch,
    private readonly signal: AbortSignal,
    private readonly failures: SiteFailures,
  ) {}

  /**
   * Send one request to the site's API.
   * @param method - HTTP method.
   * @param path - path on the site, with any query.
   * @param body - the request body, if any.
   * @returns the response, whatever its status.
   * @throws {Error} the caller's, when the site cannot be reached; the abort reason when the signal aborts.
   */
  async call(method: string, path: string, body?: SiteBody): Promise<Response> {
    const url = new URL(path, this.access.origin)
    try {
      return await this.fetchUrl(url, {
        method,
        redirect: 'error',
        signal: this.signal,
        headers: {
          ...this.access.token === '' ? {} : { 'x-dsh-auth-token': this.access.token },
          ...body === undefined ? {} : { 'content-type': body.type },
        },
        ...body === undefined ? {} : { body: body.data },
      })
    } catch (error) {
      if (this.signal.aborted) throw error
      throw this.failures.error(`Cannot reach WASD Engine at ${this.access.origin}: ${(error as Error).message}`, undefined, { cause: error })
    }
  }

  /**
   * The caller's error for a response that failed: an expired sign-in, one of the site's codes that reads as a message
   * of its own, the site's message, or its status when it sent none or failed itself.
   * @param response - the failed response, whose body this reads.
   * @param doing - what the request did, such as `list the game's servers`.
   * @returns the error.
   */
  async failure(response: Response, doing: string): Promise<Error> {
    let message: string | undefined
    let code: string | undefined
    try {
      const parsed = ErrorJson.safeParse(await response.json())
      if (parsed.success) {
        message = parsed.data.error.message
        code = parsed.data.error.code ?? parsed.data.error.type
      }
    } catch {
      // Not a JSON error body: the status alone explains it.
    }
    const { error, again, codes } = this.failures
    if (response.status === 401) return error(`The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then ${again}.`, code)
    const coded = code === undefined ? undefined : codes?.[code]
    if (coded !== undefined) return error(coded, code)
    if (response.status >= 500 || message === undefined) return error(`WASD Engine could not ${doing} (HTTP ${response.status}). Try again later.`, code)
    return error(`WASD Engine could not ${doing}: ${message}`, code)
  }

  /**
   * A successful response's JSON body.
   * @param response - the response.
   * @param schema - what the body must be.
   * @param doing - what the request did.
   * @returns the body.
   * @throws {Error} the caller's {@link failure} for a failed response, or one saying the site answered unexpectedly.
   */
  async json<T>(response: Response, schema: z.ZodType<T>, doing: string): Promise<T> {
    if (!response.ok) throw await this.failure(response, doing)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw this.failures.error(`WASD Engine answered in an unexpected way while trying to ${doing}.`)
    return parsed.data
  }
}
