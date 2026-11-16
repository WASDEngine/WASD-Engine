/**
 * WASD Engine drift spec: once the account's AI usage is used up, the WASD Engine account service refuses web requests
 * that carry the account token with HTTP 402 and a message that names the account page where the user pays. The
 * failure gives that message with a request to pass it on, and no endpoint guidance, which would send the user to
 * settings that are not at fault. The service's HTTP 429 and 5xx answers to the account token, such as a busy search
 * service or an auto recharge payment still processing, likewise give the service's own message, with no endpoint
 * guidance and no DeepSeek name, and so do the account token's other failures: a rejected sign-in (HTTP 401), which
 * asks the user to sign in to WASD Engine again, any other refusal, such as the 403 of a waitlisted account, a service
 * that cannot be reached, and an answer that cannot be read. A token that cannot be read names the WASD Engine
 * sign-in, and a cancelled request names no provider. An API key's failures keep upstream's wording and endpoint
 * guidance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import { customGuidance } from './guidance.ts'
import { dispatchDeepSeekWeb, invalidResponse, searchAborted, type DeepSeekWebAuthSource } from '../src/transport.ts'

const ACCOUNT_BASE = 'https://api.wasdengine.test/v1/tools'

/** The account service's refusal, as the WASD Engine backend's `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

const PASS_ON = 'Pass this on to the user, then try again once the account has usage left.'

afterEach(() => {
  vi.unstubAllGlobals()
})

function accountSource(
  rejectToken: (token: string) => Promise<void> = async () => {}, resolveToken: () => Promise<string | undefined> = async () => 'account-token',
): DeepSeekWebAuthSource {
  return { kind: 'account', baseURL: ACCOUNT_BASE, resolveToken, rejectToken }
}

const API_BASE = 'https://api.deepseek.test/v1/tools'
const API_KEY: DeepSeekWebAuthSource = { kind: 'api-key', baseURL: API_BASE, key: 'ds-key' }

/** How one search runs: its response decoder, its cancellation, and a wait before it is sent, as the Search provider paces. */
interface SearchOptions {
  readonly decode?: (value: unknown) => unknown
  readonly signal?: AbortSignal
  readonly waitToSend?: (signal?: AbortSignal) => Promise<void>
}

function search(sources: readonly DeepSeekWebAuthSource[], options: SearchOptions = {}): Promise<unknown> {
  const { decode = value => value, signal, waitToSend } = options
  return dispatchDeepSeekWeb({ sources }, {
    path: '/search', body: { query: 'castle' }, decode,
    apiKeyHeaders: key => ({ 'x-api-key': key }),
    guidance: customGuidance('search'),
    ...waitToSend === undefined ? {} : { waitToSend },
  }, signal)
}

async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try { await operation } catch (error) { if (error instanceof WebError) return error; throw error }
  throw new Error('expected the request to reject')
}

describe('a web request refused for used-up AI usage', () => {
  it('gives the account service\'s message, which names where the user pays, with a request to pass it on', async () => {
    const rejectToken = vi.fn(async () => {})
    // The gateway's billing_error body, in the Anthropic flavor that its tool routes use.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { type: 'billing_error', message: LIMIT } }, { status: 402 })))
    const error = await rejectedWebError(search([accountSource(rejectToken)]))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `${LIMIT} ${PASS_ON}` })
    expect(error.message).not.toContain('DeepSeek')
    expect(error.message).not.toContain('endpoint')
    // The token is still good: the account has no usage left, it is not signed out.
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('says so on its own when the refusal carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Payment Required', { status: 402 })))
    const error = await rejectedWebError(search([accountSource()]))
    expect(error.message).toBe(`The account used for this web request has no usage left (HTTP 402). ${PASS_ON}`)
  })

  it('keeps endpoint guidance for an API key\'s 402, which the user settles with that key\'s provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 })))
    const error = await rejectedWebError(search([{ kind: 'api-key', baseURL: 'https://api.deepseek.test/v1/tools', key: 'ds-key' }]))
    expect(error.message).toContain('DeepSeek API error (HTTP 402): Insufficient Balance')
    expect(error.message).toContain('If that endpoint is not intended')
  })
})

const KEEPS_FAILING = 'If it keeps failing, pass this on to the user.'

describe('a web request the account service cannot serve right now', () => {
  // The gateway's own bodies, in the Anthropic flavor of its tool routes; it never passes on DeepSeek's words for these.
  it.each([
    [429, 'rate_limit_error', 'The search service is busy. Retry shortly.'],
    [503, 'api_error', 'Your auto recharge payment is still processing. Try again in a moment.'],
    [502, 'api_error', 'Could not reach the tool service.'],
    [500, 'api_error', 'The model service returned an error (HTTP 500). Try again.'],
  ])('gives the service\'s own message for HTTP %i, without endpoint guidance or DeepSeek\'s name', async (status, type, message) => {
    const rejectToken = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { type, message } }, { status })))
    const error = await rejectedWebError(search([accountSource(rejectToken)]))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `${message} ${KEEPS_FAILING}` })
    expect(error.message).not.toMatch(/DeepSeek|endpoint|Models page/u)
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('says so on its own when the answer carries no message, as a proxy\'s page in front of the service does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })))
    const error = await rejectedWebError(search([accountSource()]))
    expect(error.message).toBe(`The account service could not complete this web request (HTTP 502). Try again later. ${KEEPS_FAILING}`)
  })

  it.each([429, 503])('keeps endpoint guidance for an API key\'s HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Server busy' } }, { status })))
    const error = await rejectedWebError(search([API_KEY]))
    expect(error.message).toContain(`DeepSeek API error (HTTP ${String(status)}): Server busy`)
    expect(error.message).toContain('If that endpoint is not intended')
  })
})

describe('the account token\'s other failed web requests', () => {
  it('asks the user to sign in to WASD Engine again when the service rejects the sign-in, and removes the token', async () => {
    const rejectToken = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      type: 'error', error: { type: 'authentication_error', message: 'Missing, invalid, expired or revoked WASD Engine token. Sign in again.' },
    }, { status: 401 })))
    const error = await rejectedWebError(search([accountSource(rejectToken)]))
    expect(error).toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'The account service rejected the WASD Engine sign-in used for this web request (HTTP 401). Ask the user to sign in to WASD Engine again, then try again.',
    })
    expect(rejectToken).toHaveBeenCalledExactlyOnceWith('account-token')
  })

  it('says the account service could not be reached when the request fails before any answer', async () => {
    const cause = new TypeError('fetch failed')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(cause)))
    const error = await rejectedWebError(search([accountSource()]))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `The web request could not reach the account service: TypeError: fetch failed. Try again later. ${KEEPS_FAILING}` })
    expect(error.cause).toBe(cause)
  })

  it('says the answer could not be read when the body is no JSON, as a network sign-in page in front of the service sends', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in to this network</html>', { status: 200 })))
    const error = await rejectedWebError(search([accountSource()]))
    expect(error.message).toMatch(/^The account service's answer to this web request could not be read: SyntaxError: /u)
    expect(error.message.endsWith(`. Try again later. ${KEEPS_FAILING}`)).toBe(true)
    expect(error.message).not.toMatch(/DeepSeek|endpoint|Models page/u)
  })

  it('says the answer could not be read when it holds no results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })))
    const error = await rejectedWebError(search([accountSource()], { decode: () => { throw invalidResponse() } }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `The account service's answer to this web request could not be read. Try again later. ${KEEPS_FAILING}` })
  })

  it('keeps upstream\'s wording and endpoint guidance for an API key that cannot reach its endpoint or read its answer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    const unreachable = await rejectedWebError(search([API_KEY]))
    expect(unreachable.message).toContain('DeepSeek web request failed: TypeError: fetch failed')
    expect(unreachable.message).toContain('If that endpoint is not intended')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })))
    const unreadable = await rejectedWebError(search([API_KEY], { decode: () => { throw invalidResponse() } }))
    expect(unreadable.message).toContain('DeepSeek returned an invalid response body')
    expect(unreadable.message).toContain('If that endpoint is not intended')
  })
})

const ACT_ON_IT = 'Pass this on to the user if they have to act on it.'

describe('an account-token web request the account service refuses for another reason', () => {
  // The gateway's own refusals, in the Anthropic flavor of its tool routes.
  it.each([
    ['a waitlisted account', 403, 'permission_error', 'This account is on the WASD Engine waitlist. You can use WASD Engine once it is approved.'],
    ['an unconfirmed email address', 403, 'permission_error', 'Confirm this account\'s email address before using WASD Engine: open the link we emailed you.'],
    ['a tool the service does not offer', 404, 'not_found_error', 'This tool is not available.'],
  ])('gives the service\'s own message for %s and keeps the token', async (_label, status, type, message) => {
    const rejectToken = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { type, message } }, { status })))
    const error = await rejectedWebError(search([accountSource(rejectToken)]))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `${message} ${ACT_ON_IT}` })
    expect(error.message).not.toMatch(/DeepSeek|endpoint|Models page/u)
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('says so on its own when the refusal carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })))
    const error = await rejectedWebError(search([accountSource()]))
    expect(error.message).toBe(`The account service refused this web request (HTTP 400). ${ACT_ON_IT}`)
  })

  it('keeps upstream\'s wording and endpoint guidance for an API key\'s HTTP 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Forbidden' } }, { status: 403 })))
    const error = await rejectedWebError(search([API_KEY]))
    expect(error.message).toContain('DeepSeek API error (HTTP 403): Forbidden')
    expect(error.message).toContain('If that endpoint is not intended')
  })
})

describe('reading the account token and cancelling a web request', () => {
  it('names the WASD Engine sign-in when the account token cannot be read', async () => {
    const failure = new Error('sign-in store locked')
    const error = await rejectedWebError(search([accountSource(undefined, () => Promise.reject(failure))]))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'The WASD Engine sign-in for this web request could not be read: Error: sign-in store locked' })
    expect(error.cause).toBe(failure)
  })

  it('names no provider when a web request with the account token is cancelled, wherever it stops', async () => {
    const before = search([accountSource()], { signal: AbortSignal.abort(new Error('caller stopped')) })
    const reading = new AbortController()
    const whileReading = search([accountSource(undefined, () => new Promise<string>(() => {}))], { signal: reading.signal })
    reading.abort(new Error('deadline'))
    const pacing = new AbortController()
    const whilePaced = search([accountSource()], {
      signal: pacing.signal,
      waitToSend: (signal) => { pacing.abort(new Error('caller stopped')); return Promise.reject(searchAborted(signal)) },
    })
    const errors = [await rejectedWebError(before), await rejectedWebError(whileReading), await rejectedWebError(whilePaced)]
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    errors.push(await rejectedWebError(search([accountSource()])))
    const errorBody = new Response('', { status: 500 })
    vi.spyOn(errorBody, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => errorBody))
    errors.push(await rejectedWebError(search([accountSource()])))
    expect(errors.map(error => [error.code, error.message])).toEqual(Array.from({ length: 5 }, () => ['WEB_ABORTED', 'Web request aborted']))
  })

  it('keeps upstream\'s wording when an API key cannot be read or its request is cancelled', async () => {
    const locked: DeepSeekWebAuthSource = {
      kind: 'api-key', baseURL: API_BASE, key: { ref: credentialRef('TEST_KEY'), configured: async () => true, resolve: () => Promise.reject(new Error('store locked')) },
    }
    expect((await rejectedWebError(search([locked]))).message).toBe('DeepSeek web credential resolution failed: Error: store locked')
    expect(await rejectedWebError(search([API_KEY], { signal: AbortSignal.abort() }))).toMatchObject({ code: 'WEB_ABORTED', message: 'DeepSeek web request aborted' })
  })
})
