/** A Desktop window claims each confirmation page the Host lists once, and opens only the pages it took. */
import { describe, expect, it, vi } from 'vitest'
import { followLinkRequests, type LinkRequestDelivery, type LinkRequestStream } from '../src/client/links.ts'
import type { WasdLinkRequests } from '../src/types.ts'

const URL_ = 'https://site.test/servers/confirm/token-1'

/** A stream that delivers the lists a spec pushes. */
function stream() {
  const queue: WasdLinkRequests[] = []
  let wake: (() => void) | undefined
  let disposed = false
  const follow: LinkRequestStream = {
    async * [Symbol.asyncIterator](): AsyncIterator<LinkRequestDelivery> {
      while (!disposed) {
        const value = queue.shift()
        if (value === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        yield { value, accept: () => {} }
      }
    },
    dispose: () => {
      disposed = true
      wake?.()
      return Promise.resolve()
    },
  }
  return { follow, push: (value: WasdLinkRequests) => { queue.push(value); wake?.() } }
}

describe('followLinkRequests', () => {
  it('claims each new link once and opens only the links this window took', async () => {
    const { follow, push } = stream()
    const claims: string[] = []
    const open = vi.fn<(url: string) => void>()
    const stop = followLinkRequests({
      follow: () => follow,
      claim: (id) => {
        claims.push(id)
        return Promise.resolve(id === 'a')
      },
      open,
      warn: () => {},
    })
    push({ links: [{ id: 'a', url: URL_ }, { id: 'b', url: 'https://site.test/servers/confirm/token-2' }] })
    push({ links: [{ id: 'a', url: URL_ }, { id: 'b', url: 'https://site.test/servers/confirm/token-2' }] })
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(1) })
    expect(open).toHaveBeenCalledWith(URL_)
    expect(claims).toEqual(['a', 'b'])
    stop()
  })
})
