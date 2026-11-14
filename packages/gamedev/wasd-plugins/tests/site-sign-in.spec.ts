/**
 * The Play page's sign-in links: the Host asks the site with the app's account token for a one-time link to a page of
 * the site, refuses links to anywhere but the site, and answers nothing once the site no longer takes the sign-in.
 */
import { describe, expect, it } from 'vitest'
import { signInLink } from '../src/site-sign-in.ts'

const ACCESS = { origin: 'https://site.test', token: 'wasd_desktop-token' }
const signal = new AbortController().signal

/** A site that answers the sign-in link route with `answer`, and records each request. */
function site(answer: () => Response) {
  const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  const fetchSite: typeof fetch = (input, init) => {
    requests.push({ url: String(input instanceof Request ? input.url : input), init })
    return Promise.resolve(answer())
  }
  return { fetch: fetchSite, requests }
}

describe('signInLink', () => {
  it('asks the site with the account token for a link to the page, and follows no redirect', async () => {
    const fake = site(() => Response.json({ url: 'https://site.test/app/sign-in#code=wasd_abc', expires_at: '2026-11-13T12:02:00Z' }))
    expect(await signInLink(ACCESS, '/games/sky-keep?v=2', fake.fetch, signal)).toBe('https://site.test/app/sign-in#code=wasd_abc')
    expect(fake.requests).toHaveLength(1)
    const [request] = fake.requests
    expect(request?.url).toBe('https://site.test/api/v1/app/sign-in-links')
    expect(request?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'x-dsh-auth-token': 'wasd_desktop-token', 'content-type': 'application/json' },
      body: JSON.stringify({ next: '/games/sky-keep?v=2' }),
    })
  })

  it('answers nothing once the site no longer takes the sign-in, and fails on other refusals', async () => {
    expect(await signInLink(ACCESS, '/explore', site(() => Response.json({ error: {} }, { status: 401 })).fetch, signal)).toBeUndefined()
    await expect(signInLink(ACCESS, '/explore', site(() => new Response('busy', { status: 429 })).fetch, signal))
      .rejects.toThrow('WASD Engine could not sign the Play page in (HTTP 429).')
    await expect(signInLink(ACCESS, '/explore', site(() => Response.json({ link: 'x' })).fetch, signal))
      .rejects.toThrow('WASD Engine answered the Play page\'s sign-in in an unexpected way.')
  })

  it('opens only pages of the site, through links on the site', async () => {
    const fake = site(() => Response.json({ url: 'https://elsewhere.test/app/sign-in#code=wasd_abc', expires_at: '2026-11-13T12:02:00Z' }))
    await expect(signInLink(ACCESS, '/explore', fake.fetch, signal)).rejects.toThrow('WASD Engine answered with a sign-in link to another site.')
    for (const next of ['https://elsewhere.test/', '//elsewhere.test/explore', 'explore']) {
      await expect(signInLink(ACCESS, next, fake.fetch, signal), next).rejects.toThrow('A sign-in link opens only a path on the WASD Engine site.')
    }
    // Refused pages never reach the site.
    expect(fake.requests).toHaveLength(1)
  })
})
