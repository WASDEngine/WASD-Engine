/**
 * The audio tools in a real tool runtime: `audio_search` walks the project folder and reads each sound's headers, and
 * `audio_review` resolves the sound, asks the open window to measure it through the scoped `game-audio/measure`
 * request, validates the answer, stores the picture for a model that accepts images, reports the figures with how
 * Godot imports the sound, and opens it in the Audio tab.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describeAudioImage } from '../src/audio/picture.ts'
import { Config } from '../src/index.ts'
import { NO_WINDOW_MESSAGE, windowPath } from '../src/tools.ts'
import { atLoop, callTool, compose, fakeAgent, JUMP, PIXEL_PNG, text, type Composition } from './composition.ts'
import { aiff, pcmWav } from './signals.ts'

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

  it('lists AIFF files whose headers state no usable rate without their header facts, and the other sounds as before', async () => {
    const c = await composed()
    const samples = new Array<number>(200).fill(0)
    // A rate beyond a double, which reads as NaN, and one so small that 100 frames last forever.
    await writeFile(join(c.work, 'audio/sfx/overflow.aif'), aiff({ sampleRate: 0, channels: 1, bits: 16, frames: 100, samples, rateBytes: [0x7f, 0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0] }))
    await writeFile(join(c.work, 'audio/sfx/tiny.aif'), aiff({ sampleRate: 0, channels: 1, bits: 16, frames: 100, samples, rateBytes: [0x3c, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0] }))
    const result = await callTool(c, 'audio_search', { folder: 'audio/sfx' })
    expect(result.isError, text(result)).toBeFalsy()
    expect(text(result).split('\n').slice(0, 5)).toEqual([
      `4 sounds in audio/sfx in ${c.work}: 4 sound effects.`,
      '- audio/sfx/coin.wav: sound effect; WAV, 16-bit PCM, stereo, 44.1 kHz, 0.400 s, 68.9 KB',
      '- audio/sfx/jump.wav: sound effect; WAV, 16-bit PCM, mono, 48 kHz, 0.620 s, 58.2 KB',
      '- audio/sfx/overflow.aif: sound effect; AIFF, 254 B',
      '- audio/sfx/tiny.aif: sound effect; AIFF, 254 B',
    ])
  })
})

describe('audio_review', () => {
  it('asks the window to measure the sound and reports its figures, warnings, Godot import, and picture', async () => {
    const c = await composed()
    c.openWindow(request => ({ measurements: atLoop(JUMP, request), picture: { data: PIXEL_PNG, mediaType: 'image/png', layout: LAYOUT } }))
    const result = await callTool(c, 'audio_review', { path: 'audio/sfx/coin.wav' })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    expect(c.requests).toHaveLength(1)
    // Godot loops the sound from frame 441, at 44.1 kHz, to its end.
    expect(c.requests[0]).toMatchObject({
      path: 'audio/sfx/coin.wav', start: 0, maxSeconds: 300, picture: true, maxBytes: 256 * 1024 * 1024, loop: { start: 0.01 },
    })
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
      'Loop seam: the loop\'s end at 0.400 s meets its start at 0.010 s with a step of 0.420 of full scale, 14 times the usual step between samples there, so it clicks at every repeat.',
      'The loop\'s last 50 ms are 9.5 dB quieter than its first 50 ms, so a repeat jumps up in level.',
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
      channelLevels: [{ peak: 0, rms: 0, dcOffset: 0, clipped: 0, nonFinite: 0 }],
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
    c.openWindow(request => ({ measurements: atLoop(JUMP, request) }))
    const text_ = text(await callTool(c, 'audio_review', { path: 'audio/voice/hero_hello.wav', picture: false }))
    expect(c.requests[0]?.loop).toEqual({ start: 0 })
    expect(text_).toContain('Godot imports it (wav) to follow the file\'s own loop points, and the file stores none, so it plays once.')
    expect(text_).toContain('Loop seam: the end meets the start with a step of 0.420 of full scale')
    expect(text_).not.toContain('The last 50 ms are')
    expect(text_).not.toContain('Warning: Godot loops this sound')
  })

  it('measures the seam of the loop that plays, wherever the measured stretch lies, or says why it has none', async () => {
    const c = await composed()
    // A six-minute track reviewed for its first five minutes: the seam is still where the track's end meets its start.
    const track = { ...JUMP, seconds: 360, start: 0, end: 300, seam: { start: 0, end: 360, jump: 0.01, step: 0.02 } }
    c.openWindow(request => ({ measurements: atLoop(track, request) }))
    const review = async (path: string, importFile?: string): Promise<string> => {
      if (importFile !== undefined) await writeFile(join(c.work, `${path}.import`), `[remap]\nimporter="${importFile.split('\n')[0] ?? ''}"\n[params]\n${importFile.split('\n').slice(1).join('\n')}\n`)
      const result = await callTool(c, 'audio_review', { path, picture: false })
      expect(result.isError, text(result)).toBeFalsy()
      return text(result).split('\n').filter(line => line.startsWith('Loop seam') || line.includes('Godot loops')).join('\n')
    }
    await writeFile(join(c.work, 'audio/theme.ogg'), 'OggS')
    expect(await review('audio/theme.ogg', 'oggvorbisstr\nloop=true')).toBe('Loop seam: the end meets the start without a click.')
    expect(c.requests.at(-1)?.loop).toEqual({ start: 0 })
    // Godot's loop offset: from 12 s to the end.
    expect(await review('audio/theme.ogg', 'oggvorbisstr\nloop=true\nloop_offset=12.0'))
      .toBe('Loop seam: the loop\'s end at 6:00.0 meets its start at 12.000 s without a click.')
    expect(c.requests.at(-1)?.loop).toEqual({ start: 12 })
    // An offset past the end of the track has no seam to measure.
    expect(await review('audio/theme.ogg', 'oggvorbisstr\nloop=true\nloop_offset=400.0'))
      .toBe('Loop seam: not measured, since the loop Godot imports starts at 6:40.0, not before its end at 6:00.0.')
    // A WAV import's loop end past the end of the sound, in frames at 48 kHz.
    expect(await review('audio/sfx/jump.wav', 'wav\nedit/loop_mode=2\nedit/loop_begin=4800\nedit/loop_end=24000000'))
      .toBe('Loop seam: not measured, since the loop Godot imports ends at 8:20.0, past the end of the sound at 6:00.0.')
    expect(c.requests.at(-1)?.loop).toEqual({ start: 0.1, end: 500 })
    // A ping-pong loop turns at its ends without a jump, so the window measures none.
    expect(await review('audio/sfx/jump.wav', 'wav\nedit/loop_mode=3\nedit/loop_begin=4800'))
      .toBe('Loop seam: none, since Godot plays the loop forward and then backward, turning at its ends without a jump.')
    expect(c.requests.at(-1)?.loop).toBeUndefined()
    // The loop a WAV file's sampler chunk stores, which Godot follows by default.
    await writeFile(join(c.work, 'audio/sfx/hum.wav'), pcmWav({ sampleRate: 48_000, frames: 48_000, loop: [24_000, 47_999] }))
    expect(await review('audio/sfx/hum.wav')).toBe('Loop seam: the loop\'s end at 1.000 s meets its start at 0.500 s without a click.')
    expect(c.requests.at(-1)?.loop).toEqual({ start: 0.5, end: 47_999 / 48_000 })
  })

  it('warns of samples that are NaN, infinite, or far beyond full scale, which a window measures as finite figures', async () => {
    const c = await composed()
    // A float render from a filter that blew up: two NaN samples and one far over full scale on the left, one clipped
    // sample on the right.
    const left = { peak: 2e6, rms: 900, dcOffset: 250, clipped: 40, nonFinite: 2 }
    const right = { peak: 1.5, rms: 0.1, dcOffset: 0, clipped: 1, nonFinite: 1 }
    c.openWindow({ measurements: { ...JUMP, peak: 2e6, rms: 640, channelLevels: [left, right] } })
    const result = await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav', picture: false })
    expect(result.isError, text(result)).toBeFalsy()
    const lines = text(result).split('\n')
    expect(lines).toContain('Levels: peak 126.0 dBFS (left 126.0 dBFS peak, right 3.5 dBFS peak), RMS 56.1 dBFS, loudness -14.3 LUFS.')
    expect(lines.filter(line => line.startsWith('Warning: ') && !line.includes('late') && !line.includes('Godot'))).toEqual([
      'Warning: 2 samples of the left channel are NaN or infinite, which no player can play; the figures count them as silence. Fix what made them, such as an unstable filter, and export the sound again.',
      'Warning: the left channel peaks at 126.0 dBFS, far beyond full scale, as an unstable filter or a wrong gain makes; find the cause and export the sound again.',
      'Warning: the samples of the left channel have a DC offset of 250.000, which thumps when the sound starts and stops; filter it out with a high-pass.',
      'Warning: 1 sample of the right channel is NaN or infinite, which no player can play; the figures count it as silence. Fix what made it, such as an unstable filter, and export the sound again.',
      'Warning: 1 sample of the right channel reaches full scale and clips; lower the level and export it again.',
    ])
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

describe('audio_review below the project folder and for subagents', () => {
  it('names the sound to the window from the Session\'s project folder after the agent\'s working directory moved below it', async () => {
    const c = await composed()
    // A teammate in audio/, or an agent after working_directory, keeps the project folder in its Session header.
    const sounds = await fakeAgent(c.ctx, 'sounds', 'vision', c.work)
    const ensure = c.ctx.workingDirectory.ensure.bind(c.ctx.workingDirectory)
    vi.spyOn(c.ctx.workingDirectory, 'ensure').mockImplementation(async (agent, signal) => (agent === sounds ? join(c.work, 'audio') : await ensure(agent, signal)))
    c.openWindow((request) => {
      if (request.start > 0) throw Object.assign(new Error(`${request.path} is no longer in the project.`), { code: 'AUDIO_NOT_FOUND' })
      return { measurements: JUMP }
    })
    const result = await callTool(c, 'audio_review', { path: 'sfx/jump.wav', picture: false, show: true }, sounds)
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    expect(c.requests[0]).toMatchObject({ path: 'audio/sfx/jump.wav' })
    expect(text(result)).toContain('sfx/jump.wav: sound effect; WAV, 16-bit PCM, mono, 48 kHz, 0.620 s')
    expect(c.reveals).toEqual([{ sessionId: sounds.id, path: 'audio/sfx/jump.wav' }])
    // The window's failure names the sound as the agent named it.
    const failed = await callTool(c, 'audio_review', { path: 'sfx/jump.wav', start: 0.1 }, sounds)
    expect(failure(failed)).toEqual({ message: 'sfx/jump.wav is no longer in the project.', code: 'AUDIO_NOT_FOUND' })
  })

  it('names a sound outside the Session\'s project folder by its absolute path', () => {
    expect(windowPath('/games/knight', '/games/knight/audio/hit.wav')).toBe('audio/hit.wav')
    expect(windowPath('/games/knight/audio', '/games/knight/music/theme.ogg')).toBe('/games/knight/music/theme.ogg')
    expect(windowPath(undefined, '/games/knight/audio/hit.wav')).toBe('/games/knight/audio/hit.wav')
  })

  it('opens what a subagent shows in its lead\'s Session, and what a child without a live lead shows in its own', async () => {
    const c = await composed()
    c.openWindow({ measurements: JUMP })
    const teammate = await fakeAgent(c.ctx, 'teammate', 'vision', c.work)
    const orphan = await fakeAgent(c.ctx, 'orphan', 'vision', c.work)
    c.ctx.provide('subagents', {
      rootOf(agent: Agent): Agent {
        if (agent === orphan) throw Object.assign(new Error('agent has no active runtime owner'), { code: 'UNAUTHORIZED' })
        return agent === teammate ? c.agent : agent
      },
    } as never)
    expect((await callTool(c, 'audio_review', { path: 'audio/sfx/coin.wav', picture: false, show: true }, teammate)).isError).toBeFalsy()
    expect((await callTool(c, 'audio_review', { path: 'audio/sfx/coin.wav', picture: false, show: true }, orphan)).isError).toBeFalsy()
    // Each measures in its own Session; each shows where the user watches.
    expect(c.requests.map(request => request.agent?.id)).toEqual([teammate.id, orphan.id])
    expect(c.reveals).toEqual([
      { sessionId: c.agent.id, path: 'audio/sfx/coin.wav' },
      { sessionId: orphan.id, path: 'audio/sfx/coin.wav' },
    ])
  })
})

describe('the window round-trip', () => {
  it('fails at once while no window is connected, and asks the window once one is', async () => {
    const c = await composed()
    c.openWindow({ measurements: JUMP })
    let connected = false
    c.ctx.provide('typertGateway', { hasLiveClient: () => connected } as never)
    const started = performance.now()
    expect(failure(await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' }))).toEqual({ message: NO_WINDOW_MESSAGE, code: 'AUDIO_NO_WINDOW' })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(c.requests).toEqual([])
    connected = true
    expect((await callTool(c, 'audio_review', { path: 'audio/sfx/jump.wav' })).isError).toBeFalsy()
    expect(c.requests).toHaveLength(1)
  })

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
