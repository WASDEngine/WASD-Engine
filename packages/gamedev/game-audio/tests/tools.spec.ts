/**
 * The audio tools in a real tool runtime: `audio_search` walks the project folder and reads each sound's headers, and
 * `audio_review` resolves the sound, asks the open window to measure it through the scoped `game-audio/measure`
 * request, validates the answer, stores the picture for a model that accepts images, reports the figures with how
 * Godot imports the sound, and opens it in the Audio tab.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describeAudioImage } from '../src/audio/picture.ts'
import { Config } from '../src/index.ts'
import { NO_WINDOW_MESSAGE } from '../src/tools.ts'
import { callTool, compose, JUMP, PIXEL_PNG, text, type Composition } from './composition.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(config: Partial<Config> = {}): Promise<Composition> {
  composition = await compose(config)
  return composition
}

function failure(result: ToolExecutionResult): { readonly message: string; readonly code: unknown } {
  if (!result.isError) throw new Error('the call succeeded')
  const info: unknown = result.error.info
  return { message: result.error.message, code: typeof info === 'object' && info !== null ? Reflect.get(info, 'code') : undefined }
}

const LAYOUT = { width: 1024, height: 536, waveformPanels: 'channels', timeStep: 0.05, nyquist: 22_050 } as const

describe('audio_search', () => {
  it('lists the project\'s sounds folder by folder with their kinds and header facts, skipping hidden folders and node_modules', async () => {
    const c = await composed()
    const result = await callTool(c, 'audio_search')
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe([
      `4 sounds in ${c.work}: 2 sound effects, 1 dialogue line, 1 music track.`,
      '- audio/score.wav: music track by its length; WAV, 16-bit PCM, mono, 8 kHz, 45.000 s, 703.2 KB',
      '- audio/sfx/coin.wav: sound effect; WAV, 16-bit PCM, stereo, 44.1 kHz, 0.400 s, 68.9 KB',
      '- audio/sfx/jump.wav: sound effect; WAV, 16-bit PCM, mono, 48 kHz, 0.620 s, 58.2 KB',
      '- audio/voice/hero_hello.wav: dialogue line; WAV, 16-bit PCM, mono, 22.1 kHz, 1.500 s, 64.6 KB',
      'Folders: audio (1 music track); audio/sfx (2 sound effects); audio/voice (1 dialogue line).',
      'Pass a path to audio_review to measure a sound and see its waveform.',
    ].join('\n'))
    expect(result.value).toMatchObject({ counts: { effect: 2, dialogue: 1, music: 1 }, total: 4, truncated: false, unreadable: 0 })
  })

  it('filters by kind and folder, ranks a query by name then path, and pages', async () => {
    const c = await composed()
    expect(text(await callTool(c, 'audio_search', { kind: 'music' }))).toContain(`1 sound music tracks only in ${c.work}: 1 music track.`)
    expect(text(await callTool(c, 'audio_search', { folder: 'audio/sfx/' })).split('\n')[0]).toBe(`2 sounds in audio/sfx in ${c.work}: 2 sound effects.`)
    const query = await callTool(c, 'audio_search', { query: 'co' })
    expect(text(query).split('\n').slice(0, 3)).toEqual([
      // The dialogue line holds the letters in order in its path: voice/hero.
      `3 sounds matching "co" in ${c.work}: 1 sound effect, 1 dialogue line, 1 music track.`,
      '- audio/sfx/coin.wav: sound effect; WAV, 16-bit PCM, stereo, 44.1 kHz, 0.400 s, 68.9 KB',
      '- audio/score.wav: music track by its length; WAV, 16-bit PCM, mono, 8 kHz, 45.000 s, 703.2 KB',
    ])
    const paged = await callTool(c, 'audio_search', { limit: 1, offset: 1 })
    expect(text(paged)).toContain('Listed 2 to 2 of 4; pass offset 2 for more.')
    expect(text(await callTool(c, 'audio_search', { query: 'nothing-matches' }))).toBe(`No sounds matching "nothing-matches" in ${c.work}.`)
  })

  it('refuses limits out of range and folders outside the project', async () => {
    const c = await composed()
    expect(failure(await callTool(c, 'audio_search', { limit: 0 }))).toEqual({ message: 'limit must be an integer from 1 to 200.', code: 'AUDIO_ARGUMENT' })
    expect(failure(await callTool(c, 'audio_search', { folder: '../elsewhere' })).code).toBe('AUDIO_OUTSIDE_PROJECT')
  })

  it('says when the walk stopped at its caps', async () => {
    const c = await composed({ maxSounds: 2 })
    expect(text(await callTool(c, 'audio_search'))).toContain('some sounds are missing; narrow it with folder.')
  })
})

describe('audio_review', () => {
  it('asks the window to measure the sound and reports its figures, warnings, Godot import, and picture', async () => {
    const c = await composed()
    c.openWindow({ measurements: JUMP, picture: { data: PIXEL_PNG, mediaType: 'image/png', layout: LAYOUT } })
    const result = await callTool(c, 'audio_review', { path: 'audio/sfx/coin.wav' })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    expect(c.requests).toHaveLength(1)
    expect(c.requests[0]).toMatchObject({ path: 'audio/sfx/coin.wav', start: 0, maxSeconds: 300, picture: true, maxBytes: 256 * 1024 * 1024 })
    expect(c.requests[0]?.end).toBeUndefined()
    expect(c.requests[0]?.agent?.id).toBe('owner')
    expect(text(result)).toBe([
      'audio/sfx/coin.wav: sound effect; WAV, 16-bit PCM, stereo, 44.1 kHz, 0.400 s, 68.9 KB.',
      'Godot imports it (wav) to loop from 0.010 s, and trims its silence.',
      'Measured the whole sound: 0.400 s at 44.1 kHz, stereo.',
      'Levels: peak 0.0 dBFS (left 0.0 dBFS peak, right -6.0 dBFS peak), RMS -14.0 dBFS, loudness -14.3 LUFS.',
      'Silence below -60 dBFS: 0.080 s at the start, 0.020 s at the end.',
      'Warning: the sound starts 0.080 s into the file, so it plays late when the game triggers it; trim the start.',
      'Spectrum: strongest component 440.0 Hz, centroid 2.31 kHz.',
      'Loop seam: the end meets the start with a step of 0.420 of full scale, 14 times the usual step between samples, so it clicks at every repeat.',
      'The last 50 ms are 9.5 dB quieter than the first 50 ms, so a repeat jumps up in level.',
      'Warning: Godot loops this sound, so the click plays in the game; cross-fade the ends or cut at zero crossings.',
      'Stereo: correlation -0.60, 6.0 dB louder on the left. Warning: the channels are largely out of phase, so the sound cancels itself when mixed to mono.',
      'Warning: 12 samples of the left channel reach full scale and clip; lower the level and export it again.',
      'Warning: the samples of the left channel have a DC offset of 0.020, which thumps when the sound starts and stops; filter it out with a high-pass.',
      describeAudioImage(LAYOUT),
    ].join('\n'))
    expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
    expect(c.saved).toHaveLength(1)
    expect(c.saved[0]).toMatchObject({ mediaType: 'image/png', name: 'coin-waveform.png' })
    expect(c.reveals).toEqual([])
  })

  it('passes the window and the picture choice on, leaves the picture out for a model without images, and opens the sound when asked', async () => {
    const c = await composed({ maxReviewSeconds: 60 })
    const silent = {
      ...JUMP, channels: 1, peak: 0, rms: 0, leadingSilence: 0.4, trailingSilence: 0.4,
      channelLevels: [{ peak: 0, rms: 0, dcOffset: 0, clipped: 0 }],
    }
    const { loudness: _loudness, dominantFrequency: _dominant, spectralCentroid: _centroid, seam: _seam, stereo: _stereo, ...plain } =
      silent
    c.openWindow(request => ({ measurements: { ...plain, start: request.start, end: request.end ?? 0.4 } }))
    const blind = await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav', start: 0.1, end: 0.3, show: true }, c.blind)
    expect(blind.isError).toBeFalsy()
    expect(c.requests[0]).toMatchObject({ start: 0.1, end: 0.3, maxSeconds: 60, picture: false })
    expect(text(blind)).toContain('Measured 0.100 s to 0.300 s of 0.400 s at 44.1 kHz, mono.')
    expect(text(blind)).toContain('loudness not measured (shorter than 0.4 s)')
    expect(text(blind)).toContain('Silence: the sound is completely silent.')
    expect(text(blind)).toContain('Godot has not imported it yet')
    expect(text(blind)).toContain('Your model does not accept images, so no picture was drawn.')
    expect(text(blind).split('\n').at(-1)).toBe('It is open in the user\'s Audio panel, ready for them to play.')
    expect(c.reveals).toEqual([{ sessionId: 'blind', path: 'audio/sfx/jump.wav' }])
    const figures = await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav', picture: false })
    expect(c.requests[1]?.picture).toBe(false)
    expect(text(figures)).not.toContain('Your model does not accept images')
  })

  it('says when a WAV import follows loop points the file lacks, and leaves the seam\'s level change out for a one-shot sound', async () => {
    const c = await composed()
    c.openWindow({ measurements: JUMP })
    const text_ = text(await callTool(c, 'audio_review', { path: 'audio/voice/hero_hello.wav', picture: false }))
    expect(text_).toContain('Godot imports it (wav) to follow the file\'s own loop points, and the file stores none, so it plays once.')
    expect(text_).toContain('Loop seam: the end meets the start with a step of 0.420 of full scale')
    expect(text_).not.toContain('The last 50 ms are')
    expect(text_).not.toContain('Warning: Godot loops this sound')
  })

  it('names the sound\'s place in the project, its format, and its existence before asking a window', async () => {
    const c = await composed()
    c.openWindow({ measurements: JUMP })
    expect(failure(await callTool(c, 'audio_review', { path: '../outside.wav' })).code).toBe('AUDIO_OUTSIDE_PROJECT')
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/missing.wav' }))).toEqual({
      message: `No file at audio/missing.wav in ${c.work}. List the project's sounds with audio_search.`, code: 'AUDIO_NOT_FOUND',
    })
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/notes.txt' })).code).toBe('AUDIO_FORMAT')
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav', start: 1, end: 0.5 }))).toEqual({
      message: 'end must be a number of seconds later than start.', code: 'AUDIO_ARGUMENT',
    })
    expect(c.requests).toEqual([])
  })

  it('fails without a window, keeps a window\'s failure and code, and refuses an invalid answer', async () => {
    const c = await composed()
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' }))).toEqual({ message: NO_WINDOW_MESSAGE, code: 'AUDIO_NO_WINDOW' })
    const close = c.openWindow(() => { throw Object.assign(new Error('The MP3 file could not be decoded.'), { code: 'AUDIO_UNREADABLE' }) })
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' }))).toEqual({ message: 'The MP3 file could not be decoded.', code: 'AUDIO_UNREADABLE' })
    close()
    c.openWindow({ measurements: { ...JUMP, peak: Number.NaN } })
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' }))).toEqual({
      message: 'The WASD Engine window measured the sound but answered with an invalid measurements.peak.', code: 'AUDIO_MEASURE',
    })
  })
})

describe('the window round-trip', () => {
  it('ends a review whose window never answers at the time limit, also without a tool time limit', async () => {
    const c = await composed({ measureTimeoutMs: 50 })
    c.openWindow(() => new Promise<never>(() => {}))
    const result = await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' })
    expect(failure(result)).toEqual({
      message: 'No WASD Engine window measured the sound within 0 s. Ask the user to keep WASD Engine\'s window open, then call audio_review again.',
      code: 'AUDIO_NO_WINDOW',
    })
  })
})
