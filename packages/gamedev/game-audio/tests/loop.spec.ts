/** The loop a game plays of a sound, from how Godot imports it and the loop points a WAV file stores. */
import { describe, expect, it } from 'vitest'
import type { AudioProbe } from '../src/audio/probe.ts'
import type { GodotImport } from '../src/files.ts'
import { playedLoop } from '../src/loop.ts'

/** A 48 kHz WAV file's headers, with the loop its sampler chunk stores when given. */
function wav(loop?: { readonly start: number; readonly end: number }): AudioProbe {
  return { format: 'WAV', sampleRate: 48_000, channels: 1, seconds: 2, ...loop === undefined ? {} : { loop } }
}

describe('playedLoop', () => {
  it('repeats the whole sound when Godot does not loop it or has not imported a file without loop points', () => {
    const whole = { kind: 'jump', from: 'whole', loops: false, stretch: { start: 0 } }
    expect(playedLoop(undefined, wav())).toEqual(whole)
    expect(playedLoop(undefined, undefined)).toEqual(whole)
    expect(playedLoop({ importer: 'wav', loop: 'off' }, wav({ start: 4800, end: 9600 }))).toEqual(whole)
    expect(playedLoop({ importer: 'wav', loop: 'file' }, wav())).toEqual(whole)
  })

  it('places the loop a WAV file stores in seconds, which Godot follows by default and on its file loop mode', () => {
    const stored = { kind: 'jump', from: 'file', stretch: { start: 0.1, end: 0.2 } }
    expect(playedLoop(undefined, wav({ start: 4800, end: 9600 }))).toEqual({ ...stored, loops: false })
    expect(playedLoop({ importer: 'wav', loop: 'file' }, wav({ start: 4800, end: 9600 }))).toEqual({ ...stored, loops: true })
  })

  it('places a WAV import\'s loop frames in seconds, and repeats the whole sound for a loop without points', () => {
    const forward: GodotImport = { importer: 'wav', loop: 'forward', loopStart: 441 }
    const probe = { ...wav(), sampleRate: 44_100 }
    expect(playedLoop(forward, probe)).toEqual({ kind: 'jump', from: 'import', loops: true, stretch: { start: 0.01 } })
    expect(playedLoop({ ...forward, loop: 'backward', loopEnd: 44_100 }, probe))
      .toEqual({ kind: 'jump', from: 'import', loops: true, stretch: { start: 0.01, end: 1 } })
    expect(playedLoop({ importer: 'wav', loop: 'forward' }, probe)).toEqual({ kind: 'jump', from: 'whole', loops: true, stretch: { start: 0 } })
  })

  it('loops an Ogg or MP3 import from its offset in seconds to the end of the sound', () => {
    const ogg: GodotImport = { importer: 'oggvorbisstr', loop: 'forward', loopStart: 12.5 }
    expect(playedLoop(ogg, { format: 'Ogg Vorbis', sampleRate: 44_100 })).toEqual({ kind: 'jump', from: 'import', loops: true, stretch: { start: 12.5 } })
    expect(playedLoop({ importer: 'mp3', loop: 'forward' }, undefined)).toEqual({ kind: 'jump', from: 'whole', loops: true, stretch: { start: 0 } })
  })

  it('has no jump for a ping-pong loop, and cannot place loop frames without a sample rate', () => {
    expect(playedLoop({ importer: 'wav', loop: 'ping-pong', loopStart: 100 }, wav())).toEqual({ kind: 'ping-pong' })
    expect(playedLoop({ importer: 'wav', loop: 'forward', loopStart: 100 }, { format: 'WAV' })).toEqual({ kind: 'unplaced', from: 'import', loops: true })
    expect(playedLoop(undefined, { format: 'WAV', loop: { start: 0, end: 10 } })).toEqual({ kind: 'unplaced', from: 'file', loops: false })
  })
})
