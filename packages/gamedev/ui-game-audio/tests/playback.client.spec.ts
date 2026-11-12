/**
 * The window's player: one sound at a time under the loading tab's key, play from where it paused, positions that
 * wrap while it repeats, seeking and repeat changes that keep its place, volume, the end of a sound, and closing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayback } from '../src/client/playback.ts'
import { FakeAudioBuffer, FakeAudioContext } from './webaudio.client.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function sound(seconds: number): AudioBuffer {
  return new FakeAudioBuffer({ length: seconds * 100, numberOfChannels: 1, sampleRate: 100 })
}

function player(): { readonly playback: AudioPlayback; readonly context: () => FakeAudioContext } {
  let made: FakeAudioContext | undefined
  const playback = new AudioPlayback(() => {
    made = new FakeAudioContext()
    return made
  })
  return {
    playback,
    context: () => {
      if (made === undefined) throw new Error('no context yet')
      return made
    },
  }
}

describe('AudioPlayback', () => {
  it('plays a loaded sound, pauses it in place, and plays on from there', () => {
    const { playback, context } = player()
    playback.load('a', sound(2))
    expect(playback.state.getSnapshot()).toEqual({ key: 'a', playing: false, loop: false, volume: 1 })
    playback.play('b')
    expect(playback.state.getSnapshot().playing).toBe(false)
    playback.play('a')
    expect(context().sources[0]?.started).toEqual([[0, 0]])
    context().currentTime = 0.75
    expect(playback.position('a')).toBe(0.75)
    expect(playback.position('b')).toBe(0)
    playback.pause('a')
    expect(context().sources[0]?.stopped).toBe(true)
    expect(playback.state.getSnapshot().playing).toBe(false)
    expect(playback.position('a')).toBe(0.75)
    context().currentTime = 5
    playback.play('a')
    expect(context().sources[1]?.started).toEqual([[0, 0.75]])
    context().currentTime = 5.5
    expect(playback.position('a')).toBe(1.25)
  })

  it('wraps the position while repeating, and changes repeat and place without losing it', () => {
    const { playback, context } = player()
    playback.load('a', sound(2))
    playback.setLoop(true)
    playback.play('a')
    expect(context().sources[0]?.loop).toBe(true)
    context().currentTime = 2.5
    expect(playback.position('a')).toBeCloseTo(0.5)
    playback.setLoop(false)
    expect(context().sources[1]).toMatchObject({ loop: false, started: [[0, 0.5]] })
    playback.seek('a', 1.5)
    expect(context().sources[2]?.started).toEqual([[0, 1.5]])
    playback.seek('a', 99)
    expect(context().sources[3]?.started).toEqual([[0, 0]])
  })

  it('rewinds when a sound ends, sets the volume, and stops the old sound when another loads', () => {
    const { playback, context } = player()
    playback.setVolume(0.5)
    playback.load('a', sound(1))
    playback.play('a')
    expect(context().gains[0]?.gain.value).toBe(0.5)
    context().sources[0]?.onended?.(new Event('ended'))
    expect(playback.state.getSnapshot().playing).toBe(false)
    expect(playback.position('a')).toBe(0)
    playback.setVolume(2)
    expect(context().gains[0]?.gain.value).toBe(1)
    playback.play('a')
    playback.load('b', sound(1))
    expect(context().sources[1]?.stopped).toBe(true)
    expect(playback.state.getSnapshot()).toMatchObject({ key: 'b', playing: false })
  })

  it('keeps the sound another key loaded, releases its own, and closes the context', async () => {
    const { playback, context } = player()
    playback.load('a', sound(1))
    playback.play('a')
    playback.release('b')
    expect(playback.state.getSnapshot()).toMatchObject({ key: 'a', playing: true })
    playback.release('a')
    expect(playback.state.getSnapshot()).toMatchObject({ key: undefined, playing: false })
    expect(context().sources[0]?.stopped).toBe(true)
    playback.close()
    await Promise.resolve()
    expect(context().close).toHaveBeenCalled()
  })

  it('resumes a context the browser started suspended', () => {
    const { playback, context } = player()
    playback.load('a', sound(1))
    playback.play('a')
    context().state = 'suspended'
    playback.pause('a')
    playback.play('a')
    expect(context().resume).toHaveBeenCalledTimes(1)
  })
})
