/** Confirmation pages wait for one window to claim and open them, and count as not opened when none does in time. */
import { describe, expect, it } from 'vitest'
import { LinkRequests } from '../src/links.ts'
import type { WasdLinkRequests } from '../src/types.ts'

const URL_ = 'https://site.test/servers/confirm/token-1'

describe('LinkRequests', () => {
  it('lets the first window that claims a link open it, and lists only the links still waiting', async () => {
    const lifetime = new AbortController()
    const links = new LinkRequests(5000, lifetime.signal)
    const following = new AbortController()
    const seen: WasdLinkRequests[] = []
    const opened = links.open(URL_, new AbortController().signal)
    for await (const view of links.follow(following.signal)) {
      seen.push(view)
      const [link] = view.links
      if (link === undefined) break
      expect(links.claim(link.id)).toBe(true)
      expect(links.claim(link.id)).toBe(false)
    }
    expect(await opened).toBe(true)
    expect(seen.map(view => view.links.map(link => link.url))).toEqual([[URL_], []])
    lifetime.abort()
  })

  it('counts a link as not opened when no window claims it in time, when the call stops, or for a non-web address', async () => {
    const lifetime = new AbortController()
    const links = new LinkRequests(30, lifetime.signal)
    expect(await links.open(URL_, new AbortController().signal)).toBe(false)
    const call = new AbortController()
    const waiting = links.open(URL_, call.signal)
    call.abort()
    expect(await waiting).toBe(false)
    expect(await links.open('file:///etc/passwd', new AbortController().signal)).toBe(false)
    const disposed = links.open(URL_, new AbortController().signal)
    lifetime.abort()
    expect(await disposed).toBe(false)
  })
})
