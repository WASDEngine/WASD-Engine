// @vitest-environment jsdom
/**
 * Decoding and measuring in the window: a sound decodes at its own rate, an AIFF file with the audio tools' reader,
 * the measurements match the agent's figures, the picture is a PNG, the window answers an agent's measure request or
 * names why it cannot, and complete reads fall back to byte windows above the Host's cap.
 */
import { AUDIO_ERROR } from '@deepseek-ai/dsh-game-audio/audio'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerMeasure } from '../src/client/agent.ts'
import { decodeSound, measureSound, pictureOf, SoundError } from '../src/client/decode.ts'
import { readSound, type ReadBytes, type SoundFile } from '../src/client/read.ts'
import { FakeOfflineAudioContext, installWebAudio, wavFile } from './webaudio.client.ts'

const WAV = { label: 'WAV', mediaType: 'audio/wav', decoder: 'browser' } as const
const AIFF = { label: 'AIFF', mediaType: 'audio/aiff', decoder: 'aiff' } as const

/** A 100 Hz tone at half scale, 0.5 s at 8 kHz in two identical channels. */
function tone(): number[] {
  const samples: number[] = []
  for (let frame = 0; frame < 4000; frame++) {
    const value = 0.5 * Math.sin(2 * Math.PI * 100 * frame / 8000)
    samples.push(value, value)
  }
  return samples
}

beforeEach(() => {
  installWebAudio()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('decodeSound and measureSound', () => {
  it('decodes at the rate the headers name and measures what audio_review reports', async () => {
    const buffer = await decodeSound(wavFile({ sampleRate: 8000, channels: 2, samples: tone() }), WAV, 8000)
    expect(FakeOfflineAudioContext.rates).toEqual([8000])
    const { measurements, samples } = measureSound(buffer, 0, undefined, 300)
    expect(samples).toMatchObject({ sampleRate: 8000, channels: 2, frames: 4000 })
    expect(measurements).toMatchObject({ sampleRate: 8000, channels: 2, seconds: 0.5, start: 0, end: 0.5, stereo: { identical: true } })
    expect(measurements.peak).toBeCloseTo(0.5, 3)
    expect(measurements.dominantFrequency).toBeCloseTo(100, 0)
    expect(measurements.loudness).toBeDefined()
    expect(measurements.seam?.jump).toBeLessThan(0.05)
    expect(measureSound(buffer, 0.1, 0.2, 300).measurements).toMatchObject({ start: 0.1, end: 0.2 })
    expect(measureSound(buffer, 0, undefined, 0.25).measurements.end).toBe(0.25)
    expect(() => measureSound(buffer, 0.5, undefined, 300)).toThrow(SoundError)
  })

  it('decodes at 48 kHz without a rate, AIFF with its own reader, and names a file that does not decode', async () => {
    await decodeSound(wavFile({ sampleRate: 8000, channels: 1, samples: [0] }), WAV, undefined)
    expect(FakeOfflineAudioContext.rates).toEqual([48_000])
    const aiff = Uint8Array.from([
      ...'FORM'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 46, ...'AIFF'.split('').map(character => character.charCodeAt(0)),
      ...'COMM'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 18, 0, 1, 0, 0, 0, 1, 0, 16, 0x40, 0x0b, 0xfa, 0, 0, 0, 0, 0, 0, 0,
      ...'SSND'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0,
    ])
    const decoded = await decodeSound(aiff, AIFF, undefined)
    expect([decoded.sampleRate, decoded.length, decoded.getChannelData(0)[0]]).toEqual([8000, 1, 0.5])
    const failure = await decodeSound(new TextEncoder().encode('not audio'), WAV, undefined).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SoundError)
    expect(failure).toMatchObject({ code: AUDIO_ERROR.unreadable })
    expect(String(failure)).toContain('The WAV file could not be decoded (Unable to decode audio data)')
  })

  it('draws the picture as a PNG with its layout', async () => {
    const drawn: number[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (pixels: { data: Uint8ClampedArray }) => { drawn.push(pixels.data[3] ?? 0) },
    }) as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => { done(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)])) })
    const buffer = await decodeSound(wavFile({ sampleRate: 8000, channels: 2, samples: tone() }), WAV, 8000)
    const picture = await pictureOf(measureSound(buffer, 0, undefined, 300).samples)
    expect(picture).toEqual({ data: 'iVBORw==', mediaType: 'image/png', layout: { width: 1024, height: 536, waveformPanels: 'channels', timeStep: 0.05, nyquist: 4000 } })
    expect(drawn).toEqual([255])
  })
})

describe('answerMeasure', () => {
  const file = (data: Uint8Array<ArrayBuffer>): RemoteResult<SoundFile> => ({ ok: true, value: { data, version: 'v1' } })

  it('reads, decodes, and measures the requested window, with the picture only when asked', async () => {
    const read = vi.fn(async () => file(wavFile({ sampleRate: 8000, channels: 2, samples: tone() })))
    const answer = await answerMeasure({ path: 'sfx/tone.wav', start: 0, maxSeconds: 300, picture: false, maxBytes: 1000 }, read, new AbortController().signal)
    expect(read).toHaveBeenCalledWith('sfx/tone.wav', 1000, expect.any(AbortSignal))
    expect(answer.picture).toBeUndefined()
    expect(answer.measurements).toMatchObject({ sampleRate: 8000, seconds: 0.5 })
    // The rate comes from the file's own headers.
    expect(FakeOfflineAudioContext.rates).toEqual([8000])
  })

  it('names a sound that is not audio, gone, too large, or unreadable', async () => {
    const fail = (read: Parameters<typeof answerMeasure>[1], path = 'sfx/boom.wav') => answerMeasure({ path, start: 0, maxSeconds: 300, picture: false, maxBytes: 2048 }, read, new AbortController().signal).catch((error: unknown) => error)
    expect(await fail(async () => file(new Uint8Array(0)), 'notes.txt')).toMatchObject({ code: AUDIO_ERROR.format })
    expect(await fail(async () => ({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: 'x' }) }))).toMatchObject({
      code: AUDIO_ERROR.missing, message: 'sfx/boom.wav is no longer in the project.',
    })
    expect(await fail(async () => ({ ok: false, error: new RemoteError('workspace-file/too-large', 'big', { path: 'x', limit: 2048 }) }))).toMatchObject({
      code: AUDIO_ERROR.tooLarge, message: 'sfx/boom.wav is larger than 2.0KB, more than one review reads.',
    })
    expect(await fail(async () => file(new TextEncoder().encode('junk')))).toMatchObject({ code: AUDIO_ERROR.unreadable })
  })
})

describe('readSound', () => {
  type Window = RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>
  const window = (data: number[], offset: number, total: number, version = 'v1'): Window => ({
    ok: true, value: { absolutePath: '/p/a.wav', version, bytes: total, offset, data: Uint8Array.from(data), eof: offset + data.length >= total },
  })

  it('reads a file whole, or window by window above the Host\'s complete-file cap', async () => {
    const whole = vi.fn<ReadBytes>(async () => window([1, 2, 3], 0, 3))
    expect(await readSound(whole, 'a.wav', 10, new AbortController().signal)).toEqual({ ok: true, value: { data: Uint8Array.of(1, 2, 3), version: 'v1' } })
    const parts = vi.fn<ReadBytes>(async (_path, options) => {
      if (options.range === undefined) return { ok: false, error: new RemoteError('workspace-file/too-large', 'big', { path: 'a.wav', limit: 2 }) }
      const offset = options.range.offset ?? 0
      return window([1, 2, 3, 4].slice(offset, offset + 2), offset, 4)
    })
    expect(await readSound(parts, 'a.wav', 10, new AbortController().signal)).toEqual({ ok: true, value: { data: Uint8Array.of(1, 2, 3, 4), version: 'v1' } })
  })

  it('refuses a file over the cap and one that keeps changing', async () => {
    const big = await readSound(async () => window([1, 2, 3], 0, 3), 'a.wav', 2, new AbortController().signal)
    expect(!big.ok && big.error.code).toBe('workspace-file/too-large')
    let version = 0
    const changing = await readSound(async (_path, options) => {
      if (options.range === undefined) return { ok: false, error: new RemoteError('workspace-file/too-large', 'big', { path: 'a.wav', limit: 2 }) }
      version += 1
      return window([1, 2], options.range.offset ?? 0, 4, `v${String(version)}`)
    }, 'a.wav', 10, new AbortController().signal)
    expect(!changing.ok && changing.error.code).toBe('game-audio/changed')
  })
})
