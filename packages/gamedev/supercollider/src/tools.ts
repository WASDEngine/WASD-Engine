/**
 * SuperCollider MCP tools. Each tool validates the agent's arguments, sends one request to the worker method of the
 * same name, validates the worker's reply, and returns compact text plus, for audio, an image. render_audio and
 * analyze_audio measure and draw the 32-bit float WAV copy that the worker leaves in its scratch folder, then delete it.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { defineAppTool, formatBytes, replyParser, withSetupNotes, workerParams } from '@deepseek-ai/dsh-app-mcp'
import type { AppTool, AppToolDependencies } from '@deepseek-ai/dsh-app-mcp'
import { analyzeAudio, describeAudioImage, drawAudioImage, type AudioAnalysis, type AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'
import { applyGain, readFloatWav } from './audio.ts'
import { encodePng } from './png.ts'
import { condenseHelp, helpSummary } from './schelp.ts'

/** Longest code a call accepts, in UTF-16 code units. */
const CODE_MAX = 200_000

/** Longest audio, in seconds, that one render writes. */
export const MAX_RENDER_SECONDS = 600

/** Longest window, in seconds, that one analysis reads. */
export const MAX_ANALYSIS_SECONDS = 600

/** Most characters of one class's help text. */
const HELP_MAX = 4000

/** Most classes one class_info call describes, and most names one search lists. */
const NAMES_MAX = 20
const SEARCH_MAX = 100

/** Most methods listed per class and kind; the rest are counted. */
const METHODS_MAX = 60

const PATH_MAX = 4096

/** Header format of each output extension. */
const FORMATS: Readonly<Record<string, 'WAV' | 'AIFF' | 'FLAC' | 'OGG'>> = { '.wav': 'WAV', '.aif': 'AIFF', '.aiff': 'AIFF', '.flac': 'FLAC', '.ogg': 'OGG' }

const parseReply = replyParser('SuperCollider')

function absolutePath(description: string): z.ZodString {
  return z.string().min(1).max(PATH_MAX).refine(value => isAbsolute(value), 'must be an absolute path').describe(description)
}

function timeoutSeconds(dependencies: AppToolDependencies, what: string): z.ZodOptional<z.ZodInt> {
  const maxSeconds = Math.max(1, Math.floor(dependencies.maxTimeoutMs / 1000))
  return z.int().min(1).max(maxSeconds).optional()
    .describe(`Seconds before ${what} is stopped and SuperCollider restarts (default ${String(Math.round(dependencies.requestTimeoutMs / 1000))}).`)
}

function callOptions(signal: AbortSignal, seconds: number | undefined): { readonly signal: AbortSignal; readonly timeoutMs?: number } {
  return seconds === undefined ? { signal } : { signal, timeoutMs: seconds * 1000 }
}

const WorkerError = z.object({ type: z.string(), message: z.string(), traceback: z.string() })

// sclang leaves keys whose value is nil out of a reply.
const ExecuteReply = z.object({
  result: z.string().optional(),
  resultClass: z.string().optional(),
  seconds: z.number().optional(),
  error: WorkerError.optional(),
  output: z.string(),
})

const RenderReply = z.object({
  path: z.string(),
  raw: z.string(),
  frames: z.int(),
  channels: z.int().min(1),
  sampleRate: z.int().min(1),
  headerFormat: z.string(),
  sampleFormat: z.string(),
  gain: z.number(),
  source: z.string(),
  bytes: z.int(),
  output: z.string(),
})

const DecodeReply = z.object({
  path: z.string(),
  raw: z.string(),
  headerFormat: z.string(),
  sampleFormat: z.string(),
  channels: z.int().min(1),
  sampleRate: z.int().min(1),
  frames: z.int(),
  firstFrame: z.int(),
  lastFrame: z.int(),
  bytes: z.int(),
  output: z.string(),
})

const ClassReply = z.object({
  name: z.string(),
  found: z.boolean(),
  superclasses: z.array(z.string()).nullable().optional(),
  classMethods: z.array(z.string()).optional(),
  instanceMethods: z.array(z.string()).optional(),
  helpFile: z.string().nullable().optional(),
  file: z.string().optional(),
})

const ClassInfoReply = z.object({
  classes: z.array(ClassReply).optional(),
  matches: z.array(z.object({ name: z.string(), helpFile: z.string().nullable().optional() })).optional(),
  total: z.int().optional(),
  helpSource: z.string(),
  output: z.string(),
})

/**
 * A linear amplitude as a level in dBFS.
 * @param amplitude - linear amplitude, where 1 is full scale.
 * @returns the level with one decimal, such as `-6.0 dBFS`, or `-inf dBFS` for silence.
 */
export function decibels(amplitude: number): string {
  return amplitude <= 0 ? '-inf dBFS' : `${(20 * Math.log10(amplitude)).toFixed(1)} dBFS`
}

function seconds(value: number): string {
  return `${value.toFixed(3)} s`
}

function hertz(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`
}

function channelName(index: number, count: number): string {
  if (count === 2) return index === 0 ? 'left' : 'right'
  return `channel ${String(index + 1)}`
}

/** The subject of a per-channel warning: the samples of one channel, or of the only one. */
function samplesOf(index: number, count: number): string {
  return count === 1 ? 'samples' : `samples of ${channelName(index, count)}`
}

function channelCount(count: number): string {
  if (count === 1) return 'mono'
  return count === 2 ? 'stereo' : `${String(count)}-channel`
}

/**
 * The lines that report an analysis: levels, loudness, silence, spectrum, and warnings about clipping and DC offset.
 * @param analysis - the measurements.
 * @returns lines of text.
 */
export function describeAnalysis(analysis: AudioAnalysis): string[] {
  const lines: string[] = []
  const perChannel = analysis.channels.length > 1
    ? ` (${analysis.channels.map((level, index) => `${channelName(index, analysis.channels.length)} ${decibels(level.peak)} peak, ${decibels(level.rms)} RMS`).join('; ')})`
    : ''
  const loudness = analysis.loudness === undefined
    ? analysis.seconds < 0.4 ? 'loudness not measured (shorter than 0.4 s)' : 'loudness not measured (no sound above the gate)'
    : `loudness ${analysis.loudness.toFixed(1)} LUFS`
  lines.push(`Levels: peak ${decibels(analysis.peak)}, RMS ${decibels(analysis.rms)}${perChannel}, ${loudness}.`)
  if (analysis.peak === 0) lines.push('Silence: the audio is completely silent.')
  else if (analysis.leadingSilence >= analysis.seconds) lines.push('Silence: every sample is below -60 dBFS.')
  else lines.push(`Silence below -60 dBFS: ${seconds(analysis.leadingSilence)} at the start, ${seconds(analysis.trailingSilence)} at the end.`)
  if (analysis.dominantFrequency !== undefined && analysis.spectralCentroid !== undefined) {
    lines.push(`Spectrum: strongest component ${hertz(analysis.dominantFrequency)}, centroid ${hertz(analysis.spectralCentroid)}.`)
  }
  analysis.channels.forEach((level, index) => {
    const count = analysis.channels.length
    if (level.clipped > 0) {
      lines.push(`Warning: ${String(level.clipped)} ${samplesOf(index, count)} reach full scale and clip in integer formats; lower the level or use normalize_db.`)
    }
    if (Math.abs(level.dcOffset) >= 0.01) {
      lines.push(`Warning: the ${samplesOf(index, count)} have a DC offset of ${level.dcOffset.toFixed(3)}; remove it with LeakDC.ar.`)
    }
  })
  return lines
}

/** What {@link inspect} learns about a float WAV copy. */
interface Inspection {
  readonly analysis: AudioAnalysis
  readonly lines: string[]
  readonly png: Buffer
}

/**
 * Read, measure, and draw the first frames of a float WAV copy, then delete it.
 * @param raw - path of the copy.
 * @param gain - factor that every sample is multiplied by.
 * @param frames - sample frames to analyze from the start: a render's copy runs past the frames that the file receives.
 * @returns the analysis, its report lines, and the PNG image.
 */
async function inspect(raw: string, gain: number, frames: number): Promise<Inspection> {
  try {
    const audio = firstFrames(readFloatWav(await readFile(raw)), frames)
    applyGain(audio, gain)
    const analysis = analyzeAudio(audio)
    const { image, layout } = drawAudioImage(audio)
    return { analysis, lines: [...describeAnalysis(analysis), describeAudioImage(layout)], png: encodePng(image) }
  } finally {
    await rm(raw, { force: true })
  }
}

/** The first frames of audio, or all of it when it holds no more. */
function firstFrames(audio: AudioSamples, frames: number): AudioSamples {
  return frames >= audio.frames ? audio : { ...audio, frames, samples: audio.samples.subarray(0, frames * audio.channels) }
}

function withOutput(lines: readonly string[], output: string): string {
  const trimmed = output.trim()
  return trimmed === '' ? lines.join('\n') : `${lines.join('\n')}\n\noutput:\n${trimmed}`
}

function renderAudioTool(dependencies: AppToolDependencies): AppTool<z.ZodRawShape> {
  return defineAppTool({
    name: 'render_audio',
    title: 'Render sound to a file',
    description: 'Evaluate SuperCollider code and render its value offline with scsynth into an audio file of exactly duration seconds, '
      + 'then report its levels, loudness, silence, and spectrum and return a waveform and spectrogram image. The value can be a UGen graph '
      + 'function, a SynthDef, a pattern such as Pbind, or a Score. Folders are created as needed and an existing file is replaced.',
    input: {
      code: z.string().min(1).max(CODE_MAX)
        .describe('SuperCollider code whose last expression is the sound: a UGen graph function such as { SinOsc.ar(440) * Env.perc.kr(2) }, a SynthDef, a pattern, or a Score.'),
      path: absolutePath('Absolute path of the audio file to write. The extension selects the format: .wav, .aif or .aiff, .flac, or .ogg (Ogg Vorbis).')
        .refine(value => Object.hasOwn(FORMATS, extname(value).toLowerCase()), 'must end in .wav, .aif, .aiff, .flac, or .ogg'),
      duration: z.number().gt(0).max(MAX_RENDER_SECONDS).describe('Seconds of audio in the file; sound still playing at the end is cut off.'),
      channels: z.int().min(1).max(8).optional()
        .describe('Channels of the file (default: the channels of a function\'s output, otherwise 2). A mono function plays in every channel.'),
      sample_rate: z.int().min(8000).max(192_000).optional().describe('Samples per second (default 44100).'),
      sample_format: z.enum(['int16', 'int24', 'float']).optional()
        .describe('Sample format of .wav, .aiff, and .flac files (default int16; .flac stores no float). .ogg files are always Vorbis.'),
      normalize_db: z.number().min(-60).max(0).optional().describe('Scale the sound so that its peak reaches this level in dBFS, such as -1.'),
      timeout_seconds: timeoutSeconds(dependencies, 'the render'),
    },
    async run(args, signal) {
      const headerFormat = FORMATS[extname(args.path).toLowerCase()] ?? 'WAV'
      const sampleFormat = headerFormat === 'OGG' ? 'vorbis' : args.sample_format ?? 'int16'
      if (headerFormat === 'FLAC' && sampleFormat === 'float') throw new Error('FLAC files store integer samples: use sample_format int16 or int24.')
      const params = workerParams({
        code: args.code, path: args.path, duration: args.duration, channels: args.channels, sample_rate: args.sample_rate ?? 44_100,
        header_format: headerFormat, sample_format: sampleFormat, normalize_db: args.normalize_db,
      })
      const reply = parseReply(RenderReply, 'render_audio', await dependencies.call('render_audio', params, callOptions(signal, args.timeout_seconds)))
      const { analysis, lines, png } = await inspect(reply.raw, reply.gain, reply.frames)
      const header = `Rendered ${seconds(reply.frames / reply.sampleRate)} of ${channelCount(reply.channels)} audio at ${String(reply.sampleRate)} Hz from the ${reply.source} `
        + `to ${reply.path} (${reply.headerFormat}, ${reply.sampleFormat}, ${formatBytes(reply.bytes)}).`
      const gain = args.normalize_db === undefined || analysis.peak === 0 ? [] : [`Normalized with a gain of ${(20 * Math.log10(reply.gain)).toFixed(1)} dB.`]
      return withSetupNotes(dependencies, { text: withOutput([header, ...gain, ...lines], reply.output), images: [{ data: png, mimeType: 'image/png' }] })
    },
  })
}

function analyzeAudioTool(dependencies: AppToolDependencies): AppTool<z.ZodRawShape> {
  return defineAppTool({
    name: 'analyze_audio',
    title: 'Analyze an audio file',
    description: 'Report the format, levels, loudness, silence, and spectrum of an audio file that SuperCollider can read (such as .wav, .aiff, '
      + `.flac, or .ogg) and return a waveform and spectrogram image. A window between start and end, at most ${String(MAX_ANALYSIS_SECONDS)} s long, is analyzed.`,
    input: {
      path: absolutePath('Absolute path of the audio file.'),
      start: z.number().min(0).optional().describe('Seconds from the beginning where the window starts (default 0).'),
      end: z.number().gt(0).optional().describe('Seconds from the beginning where the window ends (default: the end of the file).'),
    },
    async run(args, signal) {
      if (args.start !== undefined && args.end !== undefined && args.end <= args.start) throw new Error('end must be later than start.')
      const params = workerParams({ path: args.path, start: args.start, end: args.end, max_seconds: MAX_ANALYSIS_SECONDS })
      const reply = parseReply(DecodeReply, 'decode_audio', await dependencies.call('decode_audio', params, { signal }))
      const { lines, png } = await inspect(reply.raw, 1, reply.lastFrame - reply.firstFrame)
      const window = reply.firstFrame === 0 && reply.lastFrame === reply.frames
        ? 'Analyzed the whole file.'
        : `Analyzed ${seconds(reply.firstFrame / reply.sampleRate)} to ${seconds(reply.lastFrame / reply.sampleRate)}.`
      const header = `${reply.path}: ${reply.headerFormat}, ${reply.sampleFormat}, ${channelCount(reply.channels)}, ${String(reply.sampleRate)} Hz, `
        + `${seconds(reply.frames / reply.sampleRate)}, ${formatBytes(reply.bytes)}. ${window}`
      return withSetupNotes(dependencies, { text: withOutput([header, ...lines], reply.output), images: [{ data: png, mimeType: 'image/png' }] })
    },
  })
}

function executeSclangTool(dependencies: AppToolDependencies): AppTool<z.ZodRawShape> {
  return defineAppTool({
    name: 'execute_sclang',
    title: 'Run SuperCollider code',
    description: 'Run SuperCollider language code in the persistent interpreter, inside a Routine so that .wait works. Returns the value of the last '
      + 'expression as code and the text the code posted (postln). Use it to define SynthDefs with .add, build patterns and data, and inspect state.',
    input: {
      code: z.string().min(1).max(CODE_MAX).describe('SuperCollider code; declare var variables at its start.'),
      timeout_seconds: timeoutSeconds(dependencies, 'the code'),
    },
    async run(args, signal) {
      const reply = parseReply(ExecuteReply, 'execute_sclang', await dependencies.call('execute_sclang', { code: args.code }, callOptions(signal, args.timeout_seconds)))
      const parts: string[] = []
      if (reply.error !== undefined) parts.push([`${reply.error.type}: ${reply.error.message}`, reply.error.traceback.trim()].filter(part => part !== '').join('\n'))
      if (reply.result !== undefined) parts.push(`result (${reply.resultClass ?? 'Object'}): ${reply.result}`)
      if (reply.output.trim() !== '') parts.push(`output:\n${reply.output.trim()}`)
      if (parts.length === 0) parts.push('Done. The code returned nil and posted nothing.')
      return withSetupNotes(dependencies, { text: parts.join('\n\n'), isError: reply.error !== undefined })
    },
  })
}

async function readHelp(file: string | null | undefined): Promise<string | undefined> {
  if (file === null || file === undefined) return undefined
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function methodList(label: string, methods: readonly string[] | undefined): string {
  if (methods === undefined || methods.length === 0) return `${label}: none`
  const shown = methods.slice(0, METHODS_MAX).join(', ')
  return methods.length > METHODS_MAX ? `${label}: ${shown}, and ${String(methods.length - METHODS_MAX)} more` : `${label}: ${shown}`
}

/** Help files whose summary mentions the query, by class name; reads `<helpSource>/Classes/*.schelp`. */
async function summaryMatches(helpSource: string, query: string, exclude: ReadonlySet<string>): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(join(helpSource, 'Classes'))).filter(name => name.endsWith('.schelp'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lower = query.toLowerCase()
  const matches: string[] = []
  for (const name of names.sort()) {
    const className = name.slice(0, -'.schelp'.length)
    if (exclude.has(className)) continue
    const summary = helpSummary(await readFile(join(helpSource, 'Classes', name), 'utf8'))
    if (summary?.toLowerCase().includes(lower) === true) matches.push(`${className}: ${summary}`)
    if (matches.length >= SEARCH_MAX) break
  }
  return matches
}

async function describeClasses(reply: z.infer<typeof ClassInfoReply>): Promise<string> {
  const sections: string[] = []
  for (const entry of reply.classes ?? []) {
    if (!entry.found) {
      sections.push(`${entry.name}: no such class. Use search to find class names.`)
      continue
    }
    const help = await readHelp(entry.helpFile)
    sections.push([
      [entry.name, ...entry.superclasses ?? []].join(' : '),
      methodList('Class methods', entry.classMethods),
      methodList('Instance methods', entry.instanceMethods),
      help === undefined ? 'Help: none installed.' : `Help:\n${condenseHelp(help, HELP_MAX)}`,
    ].join('\n'))
  }
  return sections.join('\n\n')
}

function classInfoTool(dependencies: AppToolDependencies): AppTool<z.ZodRawShape> {
  return defineAppTool({
    name: 'class_info',
    title: 'Look up SuperCollider classes',
    description: 'Describe SuperCollider classes, such as UGens, patterns, and Env: their superclasses, the methods each class defines with '
      + 'argument names and defaults, and their help text. With search instead of names, list the classes whose name or help summary contains the text.',
    input: {
      names: z.array(z.string().regex(/^[A-Z]\w*$/u)).min(1).max(NAMES_MAX).optional().describe('Class names to describe, such as ["SinOsc", "Pbind"].'),
      search: z.string().min(1).max(100).optional().describe('Text to find in class names and help summaries, such as "reverb".'),
    },
    async run(args, signal) {
      if ((args.names === undefined) === (args.search === undefined)) throw new Error('Pass either names or search.')
      const params = args.search === undefined ? { names: args.names ?? [], limit: SEARCH_MAX } : { search: args.search, limit: SEARCH_MAX }
      const reply = parseReply(ClassInfoReply, 'class_info', await dependencies.call('class_info', params, { signal }))
      let text: string
      if (args.search === undefined) text = await describeClasses(reply)
      else {
        const matches = reply.matches ?? []
        const named = await Promise.all(matches.map(async (match) => {
          const help = await readHelp(match.helpFile)
          const summary = help === undefined ? undefined : helpSummary(help)
          return summary === undefined ? match.name : `${match.name}: ${summary}`
        }))
        const more = (reply.total ?? matches.length) > matches.length ? `, and ${String((reply.total ?? 0) - matches.length)} more` : ''
        const bySummary = await summaryMatches(reply.helpSource, args.search, new Set(matches.map(match => match.name)))
        text = [
          named.length === 0 ? `No class name contains "${args.search}".` : `Classes whose name contains "${args.search}"${more}:\n${named.join('\n')}`,
          ...bySummary.length === 0 ? [] : [`Classes whose help summary mentions "${args.search}":\n${bySummary.join('\n')}`],
        ].join('\n\n')
      }
      return withSetupNotes(dependencies, { text: withOutput([text], reply.output) })
    },
  })
}

/**
 * The SuperCollider tools, in the order the server lists them.
 * @param dependencies - worker access, setup notes, the data directory, and request budgets.
 * @returns render_audio, analyze_audio, execute_sclang, and class_info.
 */
export function superColliderTools(dependencies: AppToolDependencies): readonly AppTool<z.ZodRawShape>[] {
  return [renderAudioTool(dependencies), analyzeAudioTool(dependencies), executeSclangTool(dependencies), classInfoTool(dependencies)]
}
