/**
 * WASD Engine drift spec: once the account's AI usage is used up, the WASD Engine account service refuses web requests
 * that carry the account token with HTTP 402 and a message that names the account page where the user pays. The
 * failure gives that message with a request to pass it on, and no endpoint guidance, which would send the user to
 * settings that are not at fault. An API key's 402 keeps upstream's endpoint guidance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { customGuidance } from './guidance.ts'
import { dispatchDeepSeekWeb, type DeepSeekWebAuthSource } from '../src/transport.ts'

const ACCOUNT_BASE = 'https://api.wasdengine.test/v1/tools'

/** The account service's refusal, as the WASD Engine backend's `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

const PASS_ON = 'Pass this on to the user, then try again once the account has usage left.'

afterEach(() => {
  vi.unstubAllGlobals()
})

function accountSource(rejectToken: (token: string) => Promise<void> = async () => {}): DeepSeekWebAuthSource {
  return { kind: 'account', baseURL: ACCOUNT_BASE, resolveToken: async () => 'account-token', rejectToken }
}

function search(sources: readonly DeepSeekWebAuthSource[]): Promise<unknown> {
  return dispatchDeepSeekWeb({ sources }, {
    path: '/search', body: { query: 'castle' }, decode: value => value,
    apiKeyHeaders: key => ({ 'x-api-key': key }),
    guidance: customGuidance('search'),
  })
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
