// @vitest-environment jsdom
/**
 * Decoding and measuring in the window: a sound decodes at its own rate, an AIFF file with the audio tools' reader,
 * a sound past the window's length or memory cap is refused before it decodes, the decoder receives only the audio the
 * plan counted, the measurements match the agent's figures, the picture is a PNG, the window answers an agent's measure
 * request or names why it cannot, and complete reads fall back to byte windows above the Host's cap.
 */
import { AUDIO_ERROR } from '@deepseek-ai/dsh-game-audio/audio'
import { parseMeasureResult } from '@deepseek-ai/dsh-game-audio/src/result.ts'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerMeasure } from '../src/client/agent.ts'
import { decodeSound, measureSound, pictureOf, SoundError, WHOLE_SOUND } from '../src/client/decode.ts'
import { readSound, type ReadBytes, type SoundFile } from '../src/client/read.ts'
import { aiffFile, FakeAudioBuffer, FakeOfflineAudioContext, installWebAudio, vbrMp3File, wavFile } from './webaudio.client.ts'

const WAV = { label: 'WAV', mediaType: 'audio/wav', decoder: 'browser' } as const
const AIFF = { label: 'AIFF', mediaType: 'audio/aiff', decoder: 'aiff' } as const

/** The Audio tab's default caps. */
const LIMITS = { maxSeconds: 1200, maxBytes: 512 * 1024 * 1024 }

/** A decode within the Audio tab's default caps that is never cancelled. */
const BOUNDS = { ...LIMITS, name: 'The sound', signal: new AbortController().signal }

/** The signal of a measurement or drawing that is never cancelled. */
const SIGNAL = BOUNDS.signal

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
    const buffer = await decodeSound(wavFile({ sampleRate: 8000, channels: 2, samples: tone() }), WAV, BOUNDS)
    expect(FakeOfflineAudioContext.rates).toEqual([8000])
    const { measurements, samples } = await measureSound(buffer, { start: 0, maxSeconds: 300, loop: WHOLE_SOUND }, SIGNAL)
    expect(samples).toMatchObject({ sampleRate: 8000, channels: 2, frames: 4000 })
    expect(measurements).toMatchObject({ sampleRate: 8000, channels: 2, seconds: 0.5, start: 0, end: 0.5, stereo: { identical: true } })
    expect(measurements.peak).toBeCloseTo(0.5, 3)
    expect(measurements.dominantFrequency).toBeCloseTo(100, 0)
    expect(measurements.loudness).toBeDefined()
    expect(measurements.seam).toMatchObject({ start: 0, end: 0.5 })
    expect(measurements.seam?.jump).toBeLessThan(0.05)
    const middle = await measureSound(buffer, { start: 0.1, end: 0.2, maxSeconds: 300 }, SIGNAL)
    expect(middle.measurements).toMatchObject({ start: 0.1, end: 0.2 })
    expect((await measureSound(buffer, { start: 0, maxSeconds: 0.25 }, SIGNAL)).measurements.end).toBe(0.25)
    await expect(measureSound(buffer, { start: 0.5, maxSeconds: 300 }, SIGNAL)).rejects.toThrow(SoundError)
  })

  it('measures the seam where the requested loop meets its start in the whole sound, whatever stretch it measures', async () => {
    // A second of 100 Hz at 8 kHz, whole cycles, whose last 10 ms hold 0.8: the sound clicks where it repeats whole,
    // while its first half alone would meet its own start without one.
    const buffer = new FakeAudioBuffer({ length: 8000, numberOfChannels: 1, sampleRate: 8000 })
    const plane = buffer.getChannelData(0)
    for (let frame = 0; frame < 8000; frame++) plane[frame] = frame >= 7920 ? 0.8 : 0.5 * Math.sin(2 * Math.PI * 100 * frame / 8000)
    const firstHalf = { start: 0, maxSeconds: 0.5 }
    const seamOf = async (stretch: Parameters<typeof measureSound>[1]) => (await measureSound(buffer, stretch, SIGNAL)).measurements
    const whole = await seamOf({ ...firstHalf, loop: WHOLE_SOUND })
    expect(whole).toMatchObject({ start: 0, end: 0.5, seam: { start: 0, end: 1 } })
    expect(whole.seam?.jump).toBeCloseTo(0.8, 5)
    // A loop inside the sound, from 0.25 s to 0.75 s: whole cycles, so its ends meet without a jump.
    const inner = await seamOf({ start: 0.9, end: 1, maxSeconds: 300, loop: { start: 0.25, end: 0.75 } })
    expect(inner.seam).toMatchObject({ start: 0.25, end: 0.75 })
    expect(inner.seam?.jump).toBeLessThan(0.05)
    // No seam for no loop, a loop past the end of the sound, or one of fewer than two frames.
    expect((await seamOf(firstHalf)).seam).toBeUndefined()
    expect((await seamOf({ ...firstHalf, loop: { start: 0.5, end: 2 } })).seam).toBeUndefined()
    expect((await seamOf({ ...firstHalf, loop: { start: 0.5, end: 0.5001 } })).seam).toBeUndefined()
  })

  it('decodes at 48 kHz a rate the context does not take, AIFF with its own reader, and names a file that does not decode', async () => {
    await decodeSound(wavFile({ sampleRate: 2000, channels: 1, samples: [0] }), WAV, BOUNDS)
    expect(FakeOfflineAudioContext.rates).toEqual([48_000])
    const aiff = Uint8Array.from([
      ...'FORM'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 46, ...'AIFF'.split('').map(character => character.charCodeAt(0)),
      ...'COMM'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 18, 0, 1, 0, 0, 0, 1, 0, 16, 0x40, 0x0b, 0xfa, 0, 0, 0, 0, 0, 0, 0,
      ...'SSND'.split('').map(character => character.charCodeAt(0)), 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0,
    ])
    const decoded = await decodeSound(aiff, AIFF, BOUNDS)
    expect([decoded.sampleRate, decoded.length, decoded.getChannelData(0)[0]]).toEqual([8000, 1, 0.5])
    // Content without audio the plan counts is refused before the browser sees it.
    const decode = vi.spyOn(FakeOfflineAudioContext.prototype, 'decodeAudioData')
    const failure = await decodeSound(new TextEncoder().encode('not audio'), WAV, BOUNDS).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SoundError)
    expect(failure).toMatchObject({ code: AUDIO_ERROR.unreadable, message: 'The sound could not be decoded: The file holds no MPEG audio frames.' })
    expect(decode).not.toHaveBeenCalled()
    // A file the browser's decoder rejects names its reason.
    decode.mockRejectedValueOnce(Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }))
    const silence = wavFile({ sampleRate: 8000, channels: 1, samples: [0] })
    const rejected = await decodeSound(silence, WAV, BOUNDS).catch((error: unknown) => error)
    expect(String(rejected)).toContain('The WAV file could not be decoded (Unable to decode audio data)')
  })

  it('measures NaN, infinite, and far over full scale samples as finite figures that the audio tools accept', async () => {
    // A float render from a filter that blew up: a tone with a NaN, an infinite, and a huge sample.
    const buffer = new FakeAudioBuffer({ length: 8000, numberOfChannels: 1, sampleRate: 8000 })
    const plane = buffer.getChannelData(0)
    for (let frame = 0; frame < 8000; frame++) plane[frame] = 0.5 * Math.sin(2 * Math.PI * 100 * frame / 8000)
    plane[100] = Number.NaN
    plane[200] = Number.POSITIVE_INFINITY
    plane[300] = 2e6
    const { measurements } = await measureSound(buffer, { start: 0, maxSeconds: 300, loop: WHOLE_SOUND }, SIGNAL)
    expect(measurements.channelLevels[0]).toMatchObject({ nonFinite: 2, peak: 2e6 })
    // The answer crosses the Remote as JSON, which holds no NaN or infinity.
    expect(JSON.parse(JSON.stringify(measurements))).toEqual(measurements)
    expect(parseMeasureResult({ measurements }).measurements).toEqual(measurements)
  })

  it('draws the picture as a PNG with its layout', async () => {
    const drawn: number[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (pixels: { data: Uint8ClampedArray }) => { drawn.push(pixels.data[3] ?? 0) },
    }) as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => { done(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)])) })
    const buffer = await decodeSound(wavFile({ sampleRate: 8000, channels: 2, samples: tone() }), WAV, BOUNDS)
    const picture = await pictureOf((await measureSound(buffer, { start: 0, maxSeconds: 300 }, SIGNAL)).samples, SIGNAL)
    expect(picture).toEqual({ data: 'iVBORw==', mediaType: 'image/png', layout: { width: 1024, height: 536, waveformPanels: 'channels', timeStep: 0.05, nyquist: 4000 } })
    expect(drawn).toEqual([255])
  })

  it('lets the page handle its events between slices of measuring and drawing, and stops between them when asked', async () => {
    // Every step finds its slice used up, so the window lets the page handle its events after each.
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 20))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: () => {},
    }) as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => { done(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)])) })
    const buffer = await decodeSound(wavFile({ sampleRate: 8000, channels: 2, samples: tone() }), WAV, BOUNDS)
    const page = new MessageChannel()
    const handled: string[] = []
    let doing = 'measuring'
    page.port1.onmessage = () => { handled.push(doing) }
    try {
      page.port2.postMessage(undefined)
      const { samples } = await measureSound(buffer, { start: 0, maxSeconds: 300, loop: WHOLE_SOUND }, SIGNAL)
      doing = 'drawing'
      page.port2.postMessage(undefined)
      await pictureOf(samples, SIGNAL)
      doing = 'done'
      expect(handled).toEqual(['measuring', 'drawing'])
    } finally {
      page.port1.close()
    }
    const ended = new AbortController()
    const measuring = measureSound(buffer, { start: 0, maxSeconds: 300 }, ended.signal)
    ended.abort(new Error('the call ended'))
    await expect(measuring).rejects.toThrow('the call ended')
  })
})

describe('answerMeasure', () => {
  const file = (data: Uint8Array<ArrayBuffer>): RemoteResult<SoundFile> => ({ ok: true, value: { data, version: 'v1' } })

  it('reads, decodes, and measures the requested window and loop, with the picture only when asked', async () => {
    const read = vi.fn(async () => file(wavFile({ sampleRate: 8000, channels: 2, samples: tone() })))
    const request = { path: 'sfx/tone.wav', start: 0, maxSeconds: 300, picture: false, maxBytes: 1000, loop: { start: 0.1 } }
    const answer = await answerMeasure(request, read, new AbortController().signal, LIMITS)
    expect(read).toHaveBeenCalledWith('sfx/tone.wav', 1000, expect.any(AbortSignal))
    expect(answer.picture).toBeUndefined()
    expect(answer.measurements).toMatchObject({ sampleRate: 8000, seconds: 0.5, seam: { start: 0.1, end: 0.5 } })
    // The rate comes from the file's own headers.
    expect(FakeOfflineAudioContext.rates).toEqual([8000])
  })

  it('answers for a constant sound and a sine on a DC offset with figures the audio tools accept', async () => {
    const request = { path: 'sfx/hum.wav', start: 0, maxSeconds: 300, picture: false, maxBytes: 1 << 20 }
    const measure = (samples: number[]) =>
      answerMeasure(request, async () => file(wavFile({ sampleRate: 8000, channels: 1, samples })), new AbortController().signal, LIMITS)
    const constant = await measure(new Array<number>(8000).fill(0.5))
    expect(constant.measurements.dominantFrequency).toBeUndefined()
    expect(constant.measurements.channelLevels[0]?.dcOffset).toBeCloseTo(0.5, 3)
    expect(parseMeasureResult(constant).measurements).toEqual(constant.measurements)
    const hum = await measure(Array.from({ length: 8000 }, (_, frame) => 0.4 + 0.05 * Math.sin(2 * Math.PI * 60 * frame / 8000)))
    expect(hum.measurements.dominantFrequency).toBeCloseTo(60, -1)
    expect(parseMeasureResult(hum).measurements.dominantFrequency).toBeGreaterThan(0)
  })

  it('names a sound that is not audio, gone, too large, or unreadable', async () => {
    const fail = (read: Parameters<typeof answerMeasure>[1], path = 'sfx/boom.wav') => answerMeasure({ path, start: 0, maxSeconds: 300, picture: false, maxBytes: 2048 }, read, new AbortController().signal, LIMITS).catch((error: unknown) => error)
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

describe('the bounds of a decode', () => {
  const file = (data: Uint8Array<ArrayBuffer>): RemoteResult<SoundFile> => ({ ok: true, value: { data, version: 'v1' } })
  const request = { path: 'music/ambience.wav', start: 0, maxSeconds: 300, picture: false, maxBytes: 1 << 24 } as const

  it('refuses a sound longer than the window decodes before decoding it, as the Audio tab does', async () => {
    const long = wavFile({ sampleRate: 8000, channels: 1, samples: new Array<number>(16_000).fill(0) })
    const failure = await answerMeasure(request, async () => file(long), new AbortController().signal, { ...LIMITS, maxSeconds: 1 })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SoundError)
    expect(failure).toMatchObject({ code: AUDIO_ERROR.tooLarge, message: 'music/ambience.wav is 2.0 s long, longer than the 1 s a WASD Engine window decodes, so it cannot be measured.' })
    expect(FakeOfflineAudioContext.rates).toEqual([])
    // The same sound within the cap decodes.
    const within = await answerMeasure(request, async () => file(long), new AbortController().signal, { ...LIMITS, maxSeconds: 2 })
    expect(within.measurements.seconds).toBe(2)
  })

  it('drops a request whose call ended before it reads, and stops an AIFF decode at its next slice', async () => {
    const ended = new AbortController()
    ended.abort(new Error('the call ended'))
    const read = vi.fn(async () => file(wavFile({ sampleRate: 8000, channels: 1, samples: [0] })))
    await expect(answerMeasure(request, read, ended.signal, LIMITS)).rejects.toThrow('the call ended')
    expect(read).not.toHaveBeenCalled()
    // Two slices of samples: the first runs, then the decode yields and finds the call ended.
    const stopping = new AbortController()
    const twoSlices = aiffFile({ sampleRate: 48_000, channels: 1, frames: (1 << 20) + 10 })
    const decoding = decodeSound(twoSlices, AIFF, { ...BOUNDS, signal: stopping.signal })
    stopping.abort(new Error('the call ended'))
    await expect(decoding).rejects.toThrow('the call ended')
  })

  it('decodes the frames of an MP3 whose first frame estimates it long, and hands the decoder those frames alone', async () => {
    // A 5.7 MB file of three frames and zeros: its quiet first frame, at 32 kbps, estimates 1425 s.
    const mp3 = vbrMp3File(5_700_000)
    const seconds = (3 * 1152) / 44_100
    const decode = vi.spyOn(FakeOfflineAudioContext.prototype, 'decodeAudioData')
      .mockImplementation(async () => new FakeAudioBuffer({ length: 3 * 1152, numberOfChannels: 2, sampleRate: 44_100 }))
    const answer = await answerMeasure({ ...request, path: 'music/theme.mp3' }, async () => file(mp3), new AbortController().signal, { ...LIMITS, maxSeconds: 1 })
    expect(answer.measurements.seconds).toBeCloseTo(seconds, 9)
    expect(decode.mock.calls[0]?.[0].byteLength).toBe(104 + 626 + 626)
  })

  it('refuses before decoding an MP3 whose frames run past the cap, whatever its frame count states', async () => {
    // An Info frame that counts 2 frames, at the head of a megabyte of 128 kbps frames: 62.6 s.
    const frame = (body: readonly number[] = []) => [0xff, 0xfb, 0x90, 0x00, ...body, ...new Array<number>(413 - body.length).fill(0)]
    const info = frame([...new Array<number>(32).fill(0), ...Array.from('Info', character => character.charCodeAt(0)), 0, 0, 0, 1, 0, 0, 0, 2])
    const mp3 = new Uint8Array(1_000_000)
    mp3.set(info)
    for (let at = 417; at + 417 <= mp3.length; at += 417) mp3.set(frame(), at)
    const decode = vi.spyOn(FakeOfflineAudioContext.prototype, 'decodeAudioData')
    const failure = await answerMeasure({ ...request, path: 'sfx/hum.mp3' }, async () => file(mp3), new AbortController().signal, { ...LIMITS, maxSeconds: 10 }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: AUDIO_ERROR.tooLarge, limit: { seconds: 10 }, message: 'sfx/hum.mp3 is longer than the 10 s a WASD Engine window decodes, so it cannot be measured.',
    })
    expect(decode).not.toHaveBeenCalled()
  })

  it('refuses before decoding a FLAC file whose frames run past the cap, and one without frames', async () => {
    const crc8 = (bytes: readonly number[]) => bytes.reduce((crc, value) => {
      let next = crc ^ value
      for (let bit = 0; bit < 8; bit++) next = (next & 0x80) !== 0 ? ((next << 1) ^ 0x07) & 0xff : (next << 1) & 0xff
      return next
    }, 0)
    // STREAMINFO at 48 kHz stereo stating 1 sample, then frames of 4096 samples: 30 of them hold 2.56 s.
    const info = [0x10, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0x02, 0xf0, 0, 0, 0, 1, ...new Array<number>(16).fill(0)]
    const frames = Array.from({ length: 30 }, (_, index) => {
      const header = [0xff, 0xf8, 0xc0, 0x18, index]
      return [...header, crc8(header), ...new Array<number>(20).fill(0)]
    }).flat()
    const flacFile = Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...info, ...frames])
    const decode = vi.spyOn(FakeOfflineAudioContext.prototype, 'decodeAudioData')
    const theme = { ...request, path: 'music/theme.flac' }
    const capped = { ...LIMITS, maxSeconds: 2 }
    expect(await answerMeasure(theme, async () => file(flacFile), new AbortController().signal, capped).catch((error: unknown) => error))
      .toMatchObject({ code: AUDIO_ERROR.tooLarge, message: 'music/theme.flac is longer than the 2 s a WASD Engine window decodes, so it cannot be measured.' })
    // The review's crafted file: STREAMINFO and a megabyte of zeros, which once passed the length check.
    const zeros = new Uint8Array(1024 * 1024)
    zeros.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...info.map((value, index) => (index >= 14 && index < 18 ? 0 : value))])
    expect(await answerMeasure(theme, async () => file(zeros), new AbortController().signal, LIMITS).catch((error: unknown) => error))
      .toMatchObject({ code: AUDIO_ERROR.unreadable, message: 'music/theme.flac could not be decoded: The FLAC file holds no audio frames.' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('refuses before decoding a sound whose samples take more memory than the window gives one decode', async () => {
    // Two seconds of mono at 8 kHz take 64,000 bytes as floats.
    const long = wavFile({ sampleRate: 8000, channels: 1, samples: new Array<number>(16_000).fill(0) })
    const small = { maxSeconds: 1200, maxBytes: 32_000 }
    const failure = await answerMeasure(request, async () => file(long), new AbortController().signal, small)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: AUDIO_ERROR.tooLarge, limit: { bytes: 32_000 } })
    expect(String(failure)).toContain('music/ambience.wav takes up to 63KB once decoded, more than the 31KB a WASD Engine window decodes one sound into')
    expect(FakeOfflineAudioContext.rates).toEqual([])
  })

  it('decodes a long AIFF file in a hidden window, whose timers Chromium throttles', async () => {
    // A hidden window runs its timers late; these never run, and the decode still lets the page handle its events.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      const frames = (1 << 20) * 2 + 10
      const decoded = await decodeSound(aiffFile({ sampleRate: 48_000, channels: 1, frames }), AIFF, BOUNDS)
      expect(decoded.length).toBe(frames)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an AIFF file that an AudioBuffer cannot hold, or that is too long, before copying its samples', async () => {
    const decode = (data: Uint8Array<ArrayBuffer>, maxSeconds = 1200) =>
      decodeSound(data, AIFF, { ...BOUNDS, maxSeconds, name: 'The AIFF file' }).catch((error: unknown) => error)
    expect(await decode(aiffFile({ sampleRate: 8000, channels: 33, frames: 1 }))).toMatchObject({
      code: AUDIO_ERROR.unreadable, message: 'The AIFF file has 33 channels, more than the 32 the Audio panel plays.',
    })
    expect(await decode(aiffFile({ sampleRate: 1_000_000, channels: 1, frames: 1 }))).toMatchObject({ code: AUDIO_ERROR.unreadable })
    expect(await decode(aiffFile({ sampleRate: 8000, channels: 1, frames: 16_000 }), 1)).toMatchObject({
      code: AUDIO_ERROR.tooLarge, message: 'The AIFF file is 2.0 s long, longer than the 1 s a WASD Engine window decodes, so it cannot be measured.',
    })
  })

  it('decodes an AIFF file at a rate with a fraction and reports whole hertz, which the audio tools accept', async () => {
    const rate = 22_254.545_454_545_45
    const tone = (frame: number): number => 0.5 * Math.sin(2 * Math.PI * 440 * frame / rate)
    const data = aiffFile({ sampleRate: rate, channels: 1, frames: 22_254, sample: tone })
    const buffer = await decodeSound(data, AIFF, BOUNDS)
    expect(buffer.sampleRate).toBeCloseTo(rate, 6)
    const { measurements } = await measureSound(buffer, { start: 0, maxSeconds: 300, loop: WHOLE_SOUND }, SIGNAL)
    expect(measurements.sampleRate).toBe(22_255)
    expect(measurements.seconds).toBeCloseTo(22_254 / rate, 9)
    expect(parseMeasureResult({ measurements }).measurements.sampleRate).toBe(22_255)
    const answer = await answerMeasure({ ...request, path: 'sfx/classic.aif' }, async () => file(data), new AbortController().signal, LIMITS)
    expect(answer.measurements.sampleRate).toBe(22_255)
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
