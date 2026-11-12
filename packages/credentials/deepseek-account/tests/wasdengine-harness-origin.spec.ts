/**
 * WASDEngine fork spec (`wasdengine/FORK.md`): account notifications, which carry the platform's sign-in token, go to
 * the platform itself unless a configuration names another notification origin, and never to DeepSeek's Harness API
 * under another platform.
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
import { DEEPSEEK_HARNESS_ORIGIN, harnessOriginFor } from '../src/wasdengine-harness-origin.ts'

const PLATFORM = 'https://app.wasdengine.example'
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
