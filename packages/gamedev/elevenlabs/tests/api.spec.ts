/** The audio API client reads a response within a bound and names a larger one, whether or not it states its length. */
import { describe, expect, it } from 'vitest'
import { AudioApi, AudioRequestError, MAX_AUDIO_BYTES } from '../src/api.ts'

/** A body that never ends, a mebibyte at a time, and states no length. */
function endless(): ReadableStream<Uint8Array> {
  return new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) } })
}

describe('AudioApi', () => {
  it('names an answer larger than it reads that states no length, instead of failing on the stream it reads', async () => {
    const api = new AudioApi({
      apiOrigin: 'https://api.example',
      access: async () => ({ token: 'token', reject: async () => {} }),
      fetch: async () => new Response(endless(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    })
    const call = api.generate('sound-effects', { text: 'boom' }, new AbortController().signal)
    await expect(call).rejects.toBeInstanceOf(AudioRequestError)
    await expect(call).rejects.toThrow(`WASD Engine answered with more than the ${String(MAX_AUDIO_BYTES)} bytes this tool reads.`)
  })
})
