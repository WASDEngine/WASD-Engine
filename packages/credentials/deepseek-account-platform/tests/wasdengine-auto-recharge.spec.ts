/**
 * WASD Engine's auto recharge switch over the real Host HTTP path (fork-owned drift spec; `wasdengine/FORK.md` lists
 * the fork changes): the provider posts `{ enabled }` with the stored grant and the call's client identity, returns the
 * validated outcome, and treats a rejected grant as every account call does.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account'
import { PlatformAccount } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

const client: AccountClientMetadata = { version: '1.2.3', locale: 'en-US', timezoneOffsetSeconds: 28_800 }

interface Recorded {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly token: string | undefined
  readonly version: string | undefined
  readonly body: string
}

function requestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('error', reject)
    req.on('end', () => { resolve(body) })
  })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auto-recharge-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Recorded[] = []
  let reply: (origin: string) => { status: number; body: unknown } = origin => ({
    status: 200, body: { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { enabled: false, card_url: `${origin}/billing/checkout?session_id=cs_test_1` } } },
  })
  let origin = ''
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests.push({ method: req.method, url: req.url, token: req.headers['x-dsh-auth-token'] as string | undefined,
      version: req.headers['x-client-version'] as string | undefined, body: await requestBody(req) })
    res.setHeader('content-type', 'application/json')
    if (req.url !== '/api/v0/users/set_auto_recharge') { res.writeHead(404).end('{}'); return }
    const answer = reply(origin)
    res.writeHead(answer.status).end(JSON.stringify(answer.body))
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500).end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })
  const ctx = new Context()
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  const provider = ctx.plugin(PlatformAccount, {
    platformOrigin: origin, allowLoopbackHttp: true, requestTimeoutMs: 5_000, desktopPlatform: null,
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose() })
  const key = credentialKey('deepseek-account-platform', 'default')
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { version: 1, token: 'account-token', issuer: origin } }))
  return {
    account: ctx.deepseekAccount, ctx, key, origin, requests,
    reply: (next: (origin: string) => { status: number; body: unknown }) => { reply = next },
  }
}

it('posts the switch with the grant and the client identity, and returns the card page to open', async () => {
  const f = await fixture()
  await expect(f.account.setAutoRecharge(true, client))
    .resolves.toEqual({ enabled: false, cardUrl: `${f.origin}/billing/checkout?session_id=cs_test_1` })
  expect(f.requests).toEqual([{ method: 'POST', url: '/api/v0/users/set_auto_recharge', token: 'account-token', version: '1.2.3', body: '{"enabled":true}' }])
  f.reply(() => ({ status: 200, body: { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { enabled: false, card_url: null } } } }))
  await expect(f.account.setAutoRecharge(false, client)).resolves.toEqual({ enabled: false })
  expect(f.requests.at(-1)?.body).toBe('{"enabled":false}')
})

it('throws a business failure and keeps the sign-in', async () => {
  const f = await fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  f.reply(() => ({ status: 200, body: { code: 0, msg: '', data: { biz_code: 50300, biz_msg: 'Billing is not available right now.', biz_data: null } } }))
  await expect(f.account.setAutoRecharge(true, client)).rejects.toMatchObject({ code: 'protocol' })
  expect(await f.ctx.credentials.readRecord(f.key)).toBeDefined()
  expect(JSON.stringify(error.mock.calls)).not.toContain('Billing is not available')
  error.mockRestore()
})

it('returns null and removes a grant the service rejects, and sends nothing while signed out', async () => {
  const f = await fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  f.reply(() => ({ status: 401, body: { code: 40003, msg: 'Authentication failed. Sign in again.', data: null } }))
  await expect(f.account.setAutoRecharge(true, client)).resolves.toBeNull()
  expect(await f.ctx.credentials.readRecord(f.key)).toBeUndefined()
  const sent = f.requests.length
  await expect(f.account.setAutoRecharge(true, client)).resolves.toBeNull()
  expect(f.requests).toHaveLength(sent)
  error.mockRestore()
})
