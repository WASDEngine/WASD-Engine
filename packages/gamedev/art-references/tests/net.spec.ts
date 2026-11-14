/**
 * The reference tools' web requests reach only public internet addresses, follow redirects within a limit, and stop
 * at their size and time limits.
 */
import { describe, expect, it } from 'vitest'
import { getPublic, isPublicAddress, MAX_REDIRECTS, parseWebUrl, WebRequestError } from '../src/net.ts'
import { FakeWeb } from './fixtures.ts'

function options(overrides: Partial<Parameters<typeof getPublic>[2]> = {}): Parameters<typeof getPublic>[2] {
  return { accept: 'image/*', maxBytes: 1024, truncate: false, timeoutMs: 5000, signal: new AbortController().signal, ...overrides }
}

describe('isPublicAddress', () => {
  it('accepts public IPv4 and IPv6 addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:93.184.216.34']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('refuses private, loopback, link-local, shared, reserved, multicast, and mapped private addresses', () => {
    for (const address of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '172.31.255.255', '192.0.2.1',
      '192.168.1.1', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::', '::1', '::127.0.0.1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
      'ff02::1', '2001:db8::1', '2002:c0a8:101::1', 'not-an-address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })
})

describe('parseWebUrl', () => {
  it('takes http and https addresses and drops the fragment', () => {
    expect(parseWebUrl('https://example.com/a.png#top').href).toBe('https://example.com/a.png')
  })

  it('refuses other schemes, credentials, unparsable text, and overlong addresses', () => {
    expect(() => parseWebUrl('file:///etc/passwd')).toThrow('is not an http or https address.')
    expect(() => parseWebUrl('https://user:secret@example.com/')).toThrow('carries a user name or password.')
    expect(() => parseWebUrl('not a url')).toThrow('is not a web address.')
    expect(() => parseWebUrl(`https://example.com/${'a'.repeat(2048)}`)).toThrow('is longer than 2048 characters.')
  })
})

describe('getPublic', () => {
  it('returns the body, its type, and the final address, sending the user agent and the accept header', async () => {
    const web = new FakeWeb().serve('https://art.example/a.png', { type: 'image/png; charset=binary', body: Buffer.from('png!') })
    const got = await getPublic(web, 'https://art.example/a.png', options())
    expect(got.body.toString()).toBe('png!')
    expect(got.mediaType).toBe('image/png')
    expect(got.url.href).toBe('https://art.example/a.png')
    expect(web.headers).toEqual([{ 'user-agent': 'test-agent', 'accept': 'image/*' }])
  })

  it('never requests a host that resolves to a private address, an IP literal on this computer, or a host that does not resolve', async () => {
    const web = new FakeWeb().serve('https://router.lan/a.png', { body: 'x' })
    await expect(getPublic(web, 'https://router.lan/a.png', options())).rejects.toThrow('is on this computer or a local network')
    await expect(getPublic(web, 'http://127.0.0.1:9273/mcp', options())).rejects.toThrow('is on this computer or a local network')
    await expect(getPublic(web, 'http://[::1]/', options())).rejects.toThrow('is on this computer or a local network')
    await expect(getPublic(web, 'https://nowhere.missing/', options())).rejects.toThrow('names a host that does not resolve (nowhere.missing).')
    expect(web.requests).toEqual([])
  })

  it('follows redirects, checking each new address, and refuses one into the local network', async () => {
    const web = new FakeWeb()
      .serve('https://a.example/start', { status: 301, headers: { location: '/next' } })
      .serve('https://a.example/next', { status: 302, headers: { location: 'https://cdn.example/final.png' } })
      .serve('https://cdn.example/final.png', { type: 'image/png', body: 'ok' })
      .serve('https://a.example/sneaky', { status: 302, headers: { location: 'http://router.lan/admin' } })
    const got = await getPublic(web, 'https://a.example/start', options())
    expect(got.url.href).toBe('https://cdn.example/final.png')
    expect(web.requests).toEqual(['https://a.example/start', 'https://a.example/next', 'https://cdn.example/final.png'])
    await expect(getPublic(web, 'https://a.example/sneaky', options())).rejects.toThrow('is on this computer or a local network')
    expect(web.requests).not.toContain('http://router.lan/admin')
  })

  it(`stops after ${MAX_REDIRECTS} redirects and refuses a redirect without a location`, async () => {
    const web = new FakeWeb().serve('https://loop.example/', { status: 302, headers: { location: '/' } })
      .serve('https://bare.example/', { status: 307 })
    await expect(getPublic(web, 'https://loop.example/', options())).rejects.toThrow(`redirected more than ${MAX_REDIRECTS} times.`)
    expect(web.requests).toHaveLength(MAX_REDIRECTS + 1)
    await expect(getPublic(web, 'https://bare.example/', options())).rejects.toThrow('answered HTTP 307 without a new address.')
  })

  it('reports error statuses', async () => {
    await expect(getPublic(new FakeWeb(), 'https://art.example/missing.png', options())).rejects.toThrow('answered HTTP 404.')
  })

  it('refuses a larger body, or cuts it when truncating, whether or not the server declares its length', async () => {
    const big = Buffer.alloc(3000, 65)
    const web = new FakeWeb()
      .serve('https://art.example/declared', { body: big, headers: { 'content-length': '3000' } })
      .serve('https://art.example/streamed', { body: big })
    await expect(getPublic(web, 'https://art.example/declared', options())).rejects.toThrow('is larger than 1 KB.')
    await expect(getPublic(web, 'https://art.example/streamed', options())).rejects.toBeInstanceOf(WebRequestError)
    const cut = await getPublic(web, 'https://art.example/streamed', options({ truncate: true }))
    expect(cut.body.byteLength).toBe(1024)
    expect(cut.truncated).toBe(true)
    const declared = await getPublic(web, 'https://art.example/declared', options({ truncate: true }))
    expect(declared.body.byteLength).toBe(1024)
  })

  it('times out a request that does not answer, and rethrows the caller\'s cancellation', async () => {
    const hanging: FakeWeb = Object.assign(new FakeWeb(), {
      fetch: (_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason as Error)
        init.signal.addEventListener('abort', () => { reject(init.signal.reason as Error) }, { once: true })
      }),
    })
    await expect(getPublic(hanging, 'https://slow.example/', options({ timeoutMs: 20 }))).rejects.toThrow('did not answer within 20 ms.')
    const controller = new AbortController()
    const pending = getPublic(hanging, 'https://slow.example/', options({ signal: controller.signal }))
    controller.abort(new Error('stopped by the caller'))
    await expect(pending).rejects.toThrow('stopped by the caller')
  })
})
