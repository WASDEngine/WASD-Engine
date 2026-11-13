/**
 * WASDEngine fork spec (`wasdengine/FORK.md`): account notifications, which carry the platform's sign-in token, go to
 * the platform itself unless a configuration names another notification origin, and never to DeepSeek's Harness API
 * under another platform; model, file, and web search requests receive the token only on the inference origin, which
 * defaults to the platform itself under another platform, and never on a DeepSeek origin when another platform issued
 * it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { DeepSeekAccount, type Config } from '../src/index.ts'
import {
  DEEPSEEK_API_ORIGIN, DEEPSEEK_HARNESS_ORIGIN, carriesForeignGrantToDeepSeek, harnessOriginFor, inferenceOriginFor,
} from '../src/wasdengine-harness-origin.ts'

const PLATFORM = 'https://app.wasdengine.example'
/** The Messages endpoint of web-search-deepseek's default base URL, which dsh-base mounts. */
const DEEPSEEK_SEARCH = 'https://api.deepseek.com/anthropic/v1/messages'
const CLIENT = { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function signedIn(issuer: string, config: Config) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-harness-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'fixture-token', issuer },
  }))
  await ctx.plugin(DeepSeekAccount, config)
  return ctx.deepseekAccount
}

/** The URL of the notification list request that one poll sends. */
async function notificationListUrl(account: Awaited<ReturnType<typeof signedIn>>): Promise<string> {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (typeof input !== 'string') throw new Error('expected a URL string')
    urls.push(input)
    return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { notifications: [], next_poll_after: 600 } } }))
  })
  await account.getNotifications(CLIENT)
  expect(urls).toHaveLength(1)
  return urls[0]!
}

describe('the notification origin of a signed-in account', () => {
  it('is the platform when a configuration names the platform but no notification origin', async () => {
    const account = await signedIn(PLATFORM, { platformOrigin: PLATFORM })
    expect(await notificationListUrl(account)).toBe(`${PLATFORM}/api/v0/users/notifications/list`)
  })

  it('stays DeepSeek\'s Harness API under DeepSeek\'s own platform', async () => {
    const account = await signedIn('https://platform.deepseek.com', {})
    expect(await notificationListUrl(account)).toBe(`${DEEPSEEK_HARNESS_ORIGIN}/api/v0/users/notifications/list`)
  })

  it('refuses DeepSeek\'s Harness API under another platform before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(signedIn(PLATFORM, { platformOrigin: PLATFORM, harnessOrigin: DEEPSEEK_HARNESS_ORIGIN }))
      .rejects.toThrow(/harnessOrigin https:\/\/harness\.deepseek\.com is a DeepSeek origin/)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('harnessOriginFor', () => {
  it.each([
    ['DeepSeek\'s platform', 'https://platform.deepseek.com', DEEPSEEK_HARNESS_ORIGIN],
    ['another platform', PLATFORM, PLATFORM],
    ['a loopback development platform', 'http://127.0.0.1:8003', 'http://127.0.0.1:8003'],
  ])('defaults the notification origin under %s', (_name, platform, expected) => {
    expect(harnessOriginFor(platform, undefined, true)).toBe(expected)
  })

  it.each([
    'https://harness.deepseek.com',
    'https://deepseek.com',
    'https://HARNESS.DeepSeek.com/',
  ])('refuses %s under another platform', (configured) => {
    expect(() => harnessOriginFor(PLATFORM, configured, false)).toThrow('is a DeepSeek origin')
  })

  it.each([
    ['another notification origin', PLATFORM, 'https://notifications.example', 'https://notifications.example'],
    ['a name that only contains deepseek.com', PLATFORM, 'https://deepseek.com.example', 'https://deepseek.com.example'],
    ['a DeepSeek origin under DeepSeek\'s platform', 'https://platform.deepseek.com', 'https://harness.deepseek.com/', DEEPSEEK_HARNESS_ORIGIN],
  ])('keeps %s', (_name, platform, configured, expected) => {
    expect(harnessOriginFor(platform, configured, false)).toBe(expected)
  })

  it('reports an invalid notification origin under its field name', () => {
    expect(() => harnessOriginFor(PLATFORM, 'http://notifications.example', false)).toThrow('harnessOrigin')
  })
})

describe('the inference origin of a signed-in account', () => {
  it('is the platform when a configuration names the platform but no inference origin', async () => {
    const account = await signedIn(PLATFORM, { platformOrigin: PLATFORM, harnessOrigin: PLATFORM })
    expect(await account.resolveToken(`${PLATFORM}/v1/messages`)).toBe('fixture-token')
    expect(await account.resolveToken(DEEPSEEK_SEARCH)).toBeUndefined()
    expect(await account.resolveToken(`${DEEPSEEK_API_ORIGIN}/v1/messages`)).toBeUndefined()
  })

  it('stays DeepSeek\'s API under DeepSeek\'s own platform', async () => {
    const account = await signedIn('https://platform.deepseek.com', {})
    expect(await account.resolveToken(DEEPSEEK_SEARCH)).toBe('fixture-token')
  })

  it.each([DEEPSEEK_API_ORIGIN, 'https://api2.deepseek.com'])(
    'never releases another platform\'s token to %s, even when the configuration names it', async (inferenceOrigin) => {
      const account = await signedIn(PLATFORM, { platformOrigin: PLATFORM, inferenceOrigin })
      expect(await account.resolveToken(`${inferenceOrigin}/anthropic/v1/messages`)).toBeUndefined()
    },
  )

  it('keeps another configured inference origin', async () => {
    const account = await signedIn(PLATFORM, { platformOrigin: PLATFORM, inferenceOrigin: 'https://api.wasdengine.example' })
    expect(await account.resolveToken('https://api.wasdengine.example/v1/messages')).toBe('fixture-token')
    expect(await account.resolveToken(`${PLATFORM}/v1/messages`)).toBeUndefined()
  })
})

describe('inferenceOriginFor', () => {
  it.each([
    ['DeepSeek\'s platform', 'https://platform.deepseek.com', DEEPSEEK_API_ORIGIN],
    ['another platform', PLATFORM, PLATFORM],
    ['a loopback development platform', 'http://127.0.0.1:8003', 'http://127.0.0.1:8003'],
  ])('defaults the inference origin under %s', (_name, platform, expected) => {
    expect(inferenceOriginFor(platform, undefined)).toBe(expected)
  })

  it('keeps a configured inference origin, which the provider validates', () => {
    expect(inferenceOriginFor(PLATFORM, 'https://api.wasdengine.example')).toBe('https://api.wasdengine.example')
    expect(inferenceOriginFor('https://platform.deepseek.com', 'http://127.0.0.1:8094')).toBe('http://127.0.0.1:8094')
  })
})

describe('carriesForeignGrantToDeepSeek', () => {
  it.each([
    ['another platform\'s token to DeepSeek\'s API', 'https://api.deepseek.com/v1', PLATFORM, true],
    ['a loopback token to a DeepSeek host', 'https://api2.deepseek.com', 'http://127.0.0.1:8003', true],
    ['DeepSeek\'s token to DeepSeek\'s API', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com', false],
    ['another platform\'s token to its own API', 'https://api.wasdengine.example', PLATFORM, false],
    ['a token to a name that only contains deepseek.com', 'https://api.deepseek.com.example', PLATFORM, false],
  ])('answers %s', (_name, destination, issuer, expected) => {
    expect(carriesForeignGrantToDeepSeek(new URL(destination), new URL(issuer))).toBe(expected)
  })
})
