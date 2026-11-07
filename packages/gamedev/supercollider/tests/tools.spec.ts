/** SuperCollider tool argument bounds, worker request mapping, reply validation, result text, images, and scratch file cleanup. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WorkerReplyError } from '@deepseek-ai/dsh-app-mcp'
import type { AppToolDependencies, JsonObject } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { decibels, describeAnalysis, MAX_ANALYSIS_SECONDS, MAX_RENDER_SECONDS, superColliderTools } from '../src/tools.ts'
import { floatWav, sine } from './wav.ts'

type Reply = JsonValue | ((params: JsonObject) => JsonValue | Promise<JsonValue>)

interface Call { method: string; params: JsonObject; options: { readonly signal: AbortSignal; readonly timeoutMs?: number } }

let directory = ''
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-supercollider-tools-')) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

const signal = new AbortController().signal

function harness(replies: Record<string, Reply>, notes: string[] = []) {
  const calls: Call[] = []
  const dependencies: AppToolDependencies = {
    async call(method, params, options) {
      calls.push({ method, params, options })
      const reply = replies[method]
      if (reply === undefined) throw new Error(`no reply for ${method}`)
      return typeof reply === 'function' ? await reply(params) : reply
    },
    takeNotes: () => notes.splice(0),
    dataRoot: directory,
    requestTimeoutMs: 600_000,
    maxTimeoutMs: 870_000,
  }
  const tools = new Map(superColliderTools(dependencies).map(tool => [tool.name, tool]))
  const tool = (name: string) => {
    const found = tools.get(name)
    if (found === undefined) throw new Error(`missing tool ${name}`)
    return found
  }
  return {
    calls,
    names: [...tools.keys()],
    schema: (name: string) => z.object(tool(name).input),
    run: async (name: string, args: Record<string, unknown> = {}) => await tool(name).run(args, signal),
  }
}

/** Write a float WAV analysis copy and return the reply fields that point at it. */
async function rawCopy(name: string, audio = sine({ frequency: 440, amplitude: 0.5, seconds: 0.5, channels: 2 })): Promise<string> {
  const file = join(directory, 'scratch', name)
  await mkdir(join(directory, 'scratch'), { recursive: true })
  await writeFile(file, floatWav(audio))
  return file
}

function renderReply(raw: string, overrides: JsonObject = {}): JsonObject {
  return {
    path: '/game/sfx/jump.wav', raw, frames: 22_050, channels: 2, sampleRate: 44_100, headerFormat: 'WAV', sampleFormat: 'int16', gain: 1,
    source: 'function', bytes: 88_244, output: '', ...overrides,
  }
}

describe('tool list', () => {
  it('serves render_audio, analyze_audio, execute_sclang, and class_info', () => {
    expect(harness({}).names).toEqual(['render_audio', 'analyze_audio', 'execute_sclang', 'class_info'])
  })
})

describe('render_audio', () => {
  it('validates paths, durations, and formats', () => {
    const schema = harness({}).schema('render_audio')
    const valid = { code: '{ SinOsc.ar }', path: '/game/a.wav', duration: 1 }
    expect(schema.safeParse(valid).success).toBe(true)
    for (const path of ['/game/a.aif', '/game/a.AIFF', '/game/a.flac', '/game/a.ogg']) expect(schema.safeParse({ ...valid, path }).success).toBe(true)
    for (const invalid of [{ path: 'relative.wav' }, { path: '/game/a.mp3' }, { duration: 0 }, { duration: MAX_RENDER_SECONDS + 1 }, { channels: 9 },
      { sample_rate: 4000 }, { sample_format: 'int8' }, { normalize_db: 1 }, { code: '' }, { timeout_seconds: 871 }]) {
      expect(schema.safeParse({ ...valid, ...invalid }).success).toBe(false)
    }
  })

  it('sends the resolved format and defaults, reports the render, returns the image, and deletes the analysis copy', async () => {
    const raw = await rawCopy('render-1.wav')
    const tools = harness({ render_audio: renderReply(raw, { output: 'scsynth: note\n' }) }, ['SuperCollider 3.14.1 started.'])
    const result = await tools.run('render_audio', { code: '{ SinOsc.ar(440) ! 2 }', path: '/game/sfx/jump.wav', duration: 0.5, timeout_seconds: 30 })
    expect(tools.calls).toEqual([{
      method: 'render_audio',
      params: { code: '{ SinOsc.ar(440) ! 2 }', path: '/game/sfx/jump.wav', duration: 0.5, sample_rate: 44_100, header_format: 'WAV', sample_format: 'int16' },
      options: { signal, timeoutMs: 30_000 },
    }])
    expect(result.isError).toBeUndefined()
    expect(result.text.startsWith('SuperCollider 3.14.1 started.\n\nRendered 0.500 s of stereo audio at 44100 Hz from the function to /game/sfx/jump.wav '
      + '(WAV, int16, 86.2 KiB).\nLevels: peak -6.0 dBFS')).toBe(true)
    expect(result.text).toContain('Image (1024 x 536)')
    expect(result.text).toMatch(/\n\noutput:\nscsynth: note$/u)
    expect(result.images).toHaveLength(1)
    expect(result.images?.[0]?.mimeType).toBe('image/png')
    expect([...(result.images?.[0]?.data ?? new Uint8Array()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(existsSync(raw)).toBe(false)
  })

  it('renders .ogg as Vorbis, applies the normalization gain, and passes optional arguments', async () => {
    const raw = await rawCopy('render-2.wav')
    const tools = harness({ render_audio: renderReply(raw, { headerFormat: 'OGG', sampleFormat: 'vorbis', gain: 2, path: '/game/music/loop.ogg' }) })
    const result = await tools.run('render_audio', {
      code: 'Pbind()', path: '/game/music/loop.ogg', duration: 0.5, channels: 2, sample_rate: 48_000, sample_format: 'int24', normalize_db: -1,
    })
    expect(tools.calls[0]?.params).toEqual({
      code: 'Pbind()', path: '/game/music/loop.ogg', duration: 0.5, channels: 2, sample_rate: 48_000, header_format: 'OGG', sample_format: 'vorbis',
      normalize_db: -1,
    })
    expect(tools.calls[0]?.options).toEqual({ signal })
    expect(result.text).toContain('(OGG, vorbis, 86.2 KiB).\nNormalized with a gain of 6.0 dB.\nLevels: peak -0.0 dBFS')
  })

  it('reports no gain for a silent render and refuses float FLAC before rendering', async () => {
    const raw = await rawCopy('render-3.wav', { sampleRate: 44_100, channels: 1, frames: 100, samples: new Float32Array(100) })
    const tools = harness({ render_audio: renderReply(raw, { channels: 1, frames: 100 }) })
    const silent = await tools.run('render_audio', { code: '{ DC.ar(0) }', path: '/game/a.aiff', duration: 1, normalize_db: -1 })
    expect(silent.text).not.toContain('Normalized')
    expect(silent.text).toContain('Silence: the audio is completely silent.')
    expect(tools.calls[0]?.params).toMatchObject({ header_format: 'AIFF', sample_format: 'int16' })
    await expect(tools.run('render_audio', { code: '{ SinOsc.ar }', path: '/game/a.flac', duration: 1, sample_format: 'float' }))
      .rejects.toThrow('FLAC files store integer samples')
    expect(tools.calls).toHaveLength(1)
  })

  it('refuses a reply that does not match and still deletes nothing it did not read', async () => {
    const tools = harness({ render_audio: { path: '/game/a.wav' } })
    await expect(tools.run('render_audio', { code: '{ SinOsc.ar }', path: '/game/a.wav', duration: 1 })).rejects.toBeInstanceOf(WorkerReplyError)
  })
})

describe('analyze_audio', () => {
  function decodeReply(raw: string, overrides: JsonObject = {}): JsonObject {
    return {
      path: '/game/music/loop.ogg', raw, headerFormat: 'OGG', sampleFormat: 'vorbis', channels: 2, sampleRate: 44_100, frames: 44_100,
      firstFrame: 0, lastFrame: 44_100, bytes: 10_240, output: '', ...overrides,
    }
  }

  it('analyzes the whole file or a window and names it', async () => {
    const whole = await rawCopy('decode-1.wav')
    const tools = harness({ decode_audio: decodeReply(whole) })
    const result = await tools.run('analyze_audio', { path: '/game/music/loop.ogg' })
    expect(tools.calls[0]).toEqual({ method: 'decode_audio', params: { path: '/game/music/loop.ogg', max_seconds: MAX_ANALYSIS_SECONDS }, options: { signal } })
    expect(result.text.startsWith('/game/music/loop.ogg: OGG, vorbis, stereo, 44100 Hz, 1.000 s, 10.0 KiB. Analyzed the whole file.\nLevels:')).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(existsSync(whole)).toBe(false)
    const window = await rawCopy('decode-2.wav')
    const windowed = harness({ decode_audio: decodeReply(window, { firstFrame: 22_050, lastFrame: 33_075 }) })
    const part = await windowed.run('analyze_audio', { path: '/game/music/loop.ogg', start: 0.5, end: 0.75 })
    expect(windowed.calls[0]?.params).toEqual({ path: '/game/music/loop.ogg', start: 0.5, end: 0.75, max_seconds: MAX_ANALYSIS_SECONDS })
    expect(part.text).toContain('Analyzed 0.500 s to 0.750 s.')
  })

  it('refuses a window that ends before it starts', async () => {
    const tools = harness({})
    await expect(tools.run('analyze_audio', { path: '/game/a.wav', start: 2, end: 1 })).rejects.toThrow('end must be later than start.')
    expect(harness({}).schema('analyze_audio').safeParse({ path: 'a.wav' }).success).toBe(false)
  })
})

describe('execute_sclang', () => {
  it('reports the result, the output, and errors with their details', async () => {
    const tools = harness({
      execute_sclang: (params) => {
        switch (params.code) {
          case 'value': return { result: '[1, 2]', resultClass: 'Array', seconds: 0.01, output: 'posted\n' }
          case 'nil': return { resultClass: 'Nil', seconds: 0.01, output: '' }
          case 'untyped': return { result: '3', output: '' }
          case 'fails': return { seconds: 0.01, error: { type: 'DoesNotUnderstandError', message: "Message 'foo' not understood.", traceback: 'receiver: 1' }, output: 'x' }
          default: return { error: { type: 'SyntaxError', message: 'The code did not compile; the output shows where.', traceback: '' }, output: 'ERROR: syntax error\n' }
        }
      },
    })
    expect((await tools.run('execute_sclang', { code: 'value' })).text).toBe('result (Array): [1, 2]\n\noutput:\nposted')
    expect((await tools.run('execute_sclang', { code: 'nil' })).text).toBe('Done. The code returned nil and posted nothing.')
    expect((await tools.run('execute_sclang', { code: 'untyped' })).text).toBe('result (Object): 3')
    const failed = await tools.run('execute_sclang', { code: 'fails', timeout_seconds: 5 })
    expect(failed).toEqual({ text: "DoesNotUnderstandError: Message 'foo' not understood.\nreceiver: 1\n\noutput:\nx", isError: true })
    expect(tools.calls[3]?.options).toEqual({ signal, timeoutMs: 5000 })
    expect(await tools.run('execute_sclang', { code: '1 +* ' })).toEqual({
      text: 'SyntaxError: The code did not compile; the output shows where.\n\noutput:\nERROR: syntax error', isError: true,
    })
  })
})

describe('class_info', () => {
  let helpSource = ''
  beforeAll(async () => {
    helpSource = join(directory, 'HelpSource')
    await mkdir(join(helpSource, 'Classes'), { recursive: true })
    await writeFile(join(helpSource, 'Classes', 'SinOsc.schelp'), 'class:: SinOsc\nsummary:: Interpolating sine wavetable oscillator.\n')
    await writeFile(join(helpSource, 'Classes', 'GVerb.schelp'), 'class:: GVerb\nsummary:: A two-channel reverb\n')
    await writeFile(join(helpSource, 'Classes', 'Pan2.schelp'), 'class:: Pan2\n')
    await writeFile(join(helpSource, 'Classes', 'notes.txt'), 'not help')
  })

  it('describes found classes with their methods and help, and names missing ones', async () => {
    const methods = Array.from({ length: 62 }, (_, index) => `m${String(index)}()`)
    const tools = harness({
      class_info: {
        classes: [
          { name: 'SinOsc', found: true, superclasses: ['PureUGen', 'UGen'], classMethods: ['ar(freq: 440.0)', 'kr(freq: 440.0)'], instanceMethods: [],
            helpFile: join(helpSource, 'Classes', 'SinOsc.schelp'), file: '/sc/Osc.sc' },
          { name: 'Object', found: true, superclasses: null, classMethods: methods, helpFile: join(helpSource, 'Classes', 'Missing.schelp') },
          { name: 'Nope', found: false },
        ],
        helpSource, output: '',
      },
    })
    const result = await tools.run('class_info', { names: ['SinOsc', 'Object', 'Nope'] })
    expect(tools.calls[0]?.params).toEqual({ names: ['SinOsc', 'Object', 'Nope'], limit: 100 })
    expect(result.text).toBe([
      'SinOsc : PureUGen : UGen',
      'Class methods: ar(freq: 440.0), kr(freq: 440.0)',
      'Instance methods: none',
      'Help:\nSinOsc\nSummary: Interpolating sine wavetable oscillator.',
      '',
      'Object',
      `Class methods: ${methods.slice(0, 60).join(', ')}, and 2 more`,
      'Instance methods: none',
      'Help: none installed.',
      '',
      'Nope: no such class. Use search to find class names.',
    ].join('\n'))
  })

  it('searches class names and help summaries', async () => {
    const tools = harness({
      class_info: {
        matches: [{ name: 'SinOsc', helpFile: join(helpSource, 'Classes', 'SinOsc.schelp') }, { name: 'SinOscFB' }], total: 3, helpSource, output: '',
      },
    })
    const result = await tools.run('class_info', { search: 'osc' })
    expect(tools.calls[0]?.params).toEqual({ search: 'osc', limit: 100 })
    expect(result.text).toBe('Classes whose name contains "osc", and 1 more:\nSinOsc: Interpolating sine wavetable oscillator.\nSinOscFB')
    const reverb = harness({ class_info: { matches: [], total: 0, helpSource, output: 'note' } })
    expect((await reverb.run('class_info', { search: 'REVERB' })).text)
      .toBe('No class name contains "REVERB".\n\nClasses whose help summary mentions "REVERB":\nGVerb: A two-channel reverb\n\noutput:\nnote')
    const noHelp = harness({ class_info: { matches: [], total: 0, helpSource: join(directory, 'missing'), output: '' } })
    expect((await noHelp.run('class_info', { search: 'x' })).text).toBe('No class name contains "x".')
  })

  it('takes names or search, but not both or neither', async () => {
    const tools = harness({})
    await expect(tools.run('class_info', {})).rejects.toThrow('Pass either names or search.')
    await expect(tools.run('class_info', { names: ['A'], search: 'a' })).rejects.toThrow('Pass either names or search.')
    expect(harness({}).schema('class_info').safeParse({ names: ['lowercase'] }).success).toBe(false)
  })

  it('reports help files it cannot read', async () => {
    const tools = harness({ class_info: { classes: [{ name: 'X', found: true, helpFile: directory }], helpSource, output: '' } })
    await expect(tools.run('class_info', { names: ['X'] })).rejects.toThrow()
    const listing = harness({ class_info: { matches: [], total: 0, helpSource: join(helpSource, 'Classes', 'SinOsc.schelp'), output: '' } })
    await expect(listing.run('class_info', { search: 'x' })).rejects.toThrow()
  })
})

describe('describeAnalysis', () => {
  it('reports mono levels, unmeasurable loudness, silence below the threshold, and DC offset', () => {
    const lines = describeAnalysis({
      seconds: 0.2, channels: [{ peak: 0.0005, rms: 0.0002, dcOffset: 0.02, clipped: 2 }], peak: 0.0005, rms: 0.0002, loudness: undefined,
      leadingSilence: 0.2, trailingSilence: 0.2, dominantFrequency: 1500, spectralCentroid: 900,
    })
    expect(lines).toEqual([
      'Levels: peak -66.0 dBFS, RMS -74.0 dBFS, loudness not measured (shorter than 0.4 s).',
      'Silence: every sample is below -60 dBFS.',
      'Spectrum: strongest component 1.50 kHz, centroid 900.0 Hz.',
      'Warning: 2 samples reach full scale and clip in integer formats; lower the level or use normalize_db.',
      'Warning: the samples have a DC offset of 0.020; remove it with LeakDC.ar.',
    ])
    const quiet = describeAnalysis({
      seconds: 2, channels: [0, 1, 2].map(() => ({ peak: 0.1, rms: 0.05, dcOffset: 0, clipped: 0 })),
      peak: 0.1, rms: 0.05, loudness: undefined,
      leadingSilence: 0, trailingSilence: 0, dominantFrequency: undefined, spectralCentroid: undefined,
    })
    expect(quiet[0]).toContain('(channel 1 -20.0 dBFS peak, -26.0 dBFS RMS; channel 2')
    expect(quiet[0]).toContain('loudness not measured (no sound above the gate).')
    expect(decibels(0)).toBe('-inf dBFS')
  })
})
