/**
 * The project walks that pictures share: a picture uses only a walk that started after its request arrived, so a file
 * written just before the request is in it; requests that arrived before a walk started share it, and requests that
 * arrive while it runs share the next one, which starts when it ends.
 */
import { describe, expect, it } from 'vitest'
import { ProjectWalks } from '../src/client/walks.ts'

/** A project whose files the spec writes, walked by walks the spec lets finish. */
function project() {
  const files: string[] = []
  const walks: { readonly listed: readonly string[]; readonly finish: () => void }[] = []
  const walk = async (_sessionId: string, signal: AbortSignal): Promise<readonly string[] | undefined> => {
    // A walk lists the project when it starts, then waits for the spec.
    const listed = [...files]
    const done = Promise.withResolvers<undefined>()
    walks.push({ listed, finish: () => { done.resolve(undefined) } })
    await done.promise
    return signal.aborted ? undefined : listed
  }
  let now = 0
  return {
    files, walks,
    clock: { get now() { return now }, set now(value: number) { now = value } },
    shared: new ProjectWalks(walk, () => now, new AbortController().signal),
  }
}

/** Let settled promises run their callbacks. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('ProjectWalks', () => {
  it('shares one walk among the requests that arrived before it started', async () => {
    const p = project()
    const [first, second] = [p.shared.ticket(), p.shared.ticket()]
    const answers = [p.shared.get('s', first, new AbortController().signal), p.shared.get('s', second, new AbortController().signal)]
    await flush()
    expect(p.walks).toHaveLength(1)
    p.walks[0]?.finish()
    expect(await Promise.all(answers)).toEqual([[], []])
    // A request that arrived before the walk started is served by it after it ended, while it is fresh.
    expect(await p.shared.get('s', first, new AbortController().signal)).toEqual([])
    expect(p.walks).toHaveLength(1)
  })

  it('walks again for a request that arrived after a walk started, so a file written before the request is found', async () => {
    const p = project()
    const early = p.shared.get('s', p.shared.ticket(), new AbortController().signal)
    await flush()
    // The agent writes a scene and asks while the first walk runs; another asks right after it.
    p.files.push('scenes/walk.tscn')
    const late = p.shared.get('s', p.shared.ticket(), new AbortController().signal)
    const later = p.shared.get('s', p.shared.ticket(), new AbortController().signal)
    await flush()
    expect(p.walks).toHaveLength(1)
    p.walks[0]?.finish()
    expect(await early).toEqual([])
    await flush()
    // The late requests share the next walk, which started once the first ended.
    expect(p.walks).toHaveLength(2)
    p.walks[1]?.finish()
    expect(await Promise.all([late, later])).toEqual([['scenes/walk.tscn'], ['scenes/walk.tscn']])
    // A request after both walks ended starts a walk of its own, even while the last is fresh.
    p.files.push('scenes/run.tscn')
    const fresh = p.shared.get('s', p.shared.ticket(), new AbortController().signal)
    await flush()
    p.walks[2]?.finish()
    expect(await fresh).toEqual(['scenes/walk.tscn', 'scenes/run.tscn'])
  })

  it('lets a caller stop waiting while the walk goes on for the others, and forgets walks once they are stale', async () => {
    const p = project()
    const stopping = new AbortController()
    const [one, two] = [p.shared.ticket(), p.shared.ticket()]
    const stopped = p.shared.get('s', one, stopping.signal)
    const staying = p.shared.get('s', two, new AbortController().signal)
    stopping.abort(new Error('the call ended'))
    await expect(stopped).rejects.toThrow('the call ended')
    await flush()
    p.walks[0]?.finish()
    expect(await staying).toEqual([])
    // Once stale, a walk serves nobody, also a request that arrived before it started.
    p.clock.now = 60_000
    const again = p.shared.get('s', one, new AbortController().signal)
    await flush()
    expect(p.walks).toHaveLength(2)
    p.walks[1]?.finish()
    expect(await again).toEqual([])
    const ended = new AbortController()
    ended.abort(new Error('the call ended'))
    await expect(p.shared.get('s', p.shared.ticket(), ended.signal)).rejects.toThrow('the call ended')
  })
})
