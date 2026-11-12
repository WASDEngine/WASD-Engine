/**
 * The text agents read from the audio tools: the listing of `audio_search` and the report of `audio_review`, with
 * levels in dBFS, loudness in LUFS, lengths in seconds or minutes, and warnings for what a game plays badly: clipping,
 * a DC offset, silence before a sound, and a seam that clicks where Godot loops it.
 * @module @deepseek-ai/dsh-game-audio/src/describe
 */
import type { AudioCategory, AudioCategorySource } from './audio/formats.ts'
import { LATE_START_SECONDS, seamClicks } from './audio/measure.ts'
import { describeAudioImage } from './audio/picture.ts'
import type { AudioProbe } from './audio/probe.ts'
import type { GodotImport } from './files.ts'
import type { AudioMeasurements, AudioPicture } from './types.ts'

/** One listed sound. */
export interface ListedSound {
  readonly path: string
  readonly kind: AudioCategory
  /** How the kind was found. */
  readonly kindFrom: AudioCategorySource
  readonly format: string
  readonly bytes: number
  readonly encoding?: string
  readonly sampleRate?: number
  readonly channels?: number
  readonly seconds?: number
  readonly estimated?: boolean
}

/** Sounds of each kind. */
export interface KindCounts {
  readonly effect: number
  readonly dialogue: number
  readonly music: number
}

/** One folder with its counts. */
export interface ListedFolder extends KindCounts {
  readonly path: string
}

/** The value of one `audio_search` call. */
export interface SearchValue {
  readonly project: string
  readonly query: string
  readonly kind?: AudioCategory
  readonly folder?: string
  readonly total: number
  readonly offset: number
  readonly counts: KindCounts
  readonly sounds: readonly ListedSound[]
  readonly folders: readonly ListedFolder[]
  readonly truncated: boolean
  readonly unreadable: number
}

/** The value of one `audio_review` call, before its picture becomes an image reference. */
export interface ReviewFacts {
  readonly path: string
  readonly kind: AudioCategory
  readonly kindFrom: AudioCategorySource
  readonly bytes: number
  readonly probe?: AudioProbe
  readonly godot?: GodotImport
  readonly measurements: AudioMeasurements
  readonly picture?: AudioPicture['layout']
  readonly pictureOmitted?: boolean
  readonly shown: boolean
}

/** How the kinds read in text, one and many. */
const KIND_NAMES: Readonly<Record<AudioCategory, readonly [string, string]>> = {
  effect: ['sound effect', 'sound effects'],
  dialogue: ['dialogue line', 'dialogue lines'],
  music: ['music track', 'music tracks'],
}

function plural(count: number, kind: AudioCategory): string {
  const [one, many] = KIND_NAMES[kind]
  return `${String(count)} ${count === 1 ? one : many}`
}

/**
 * A linear amplitude as a level in dBFS.
 * @param amplitude - linear amplitude, where 1 is full scale.
 * @returns the level with one decimal, such as `-6.0 dBFS`, or `-inf dBFS` for silence.
 */
export function dbfs(amplitude: number): string {
  return amplitude <= 0 ? '-inf dBFS' : `${(20 * Math.log10(amplitude)).toFixed(1)} dBFS`
}

/**
 * A length as text.
 * @param seconds - the length.
 * @returns seconds with three decimals under a minute, such as `0.620 s`, and minutes and seconds above, such as `2:31.4`.
 */
export function lengthText(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(3)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${String(minutes)}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}

function hertz(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`
}

function rate(value: number): string {
  return value % 1000 === 0 ? `${String(value / 1000)} kHz` : `${(value / 1000).toFixed(1)} kHz`
}

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function channelText(count: number): string {
  if (count === 1) return 'mono'
  return count === 2 ? 'stereo' : `${String(count)} channels`
}

/**
 * The format facts of a sound in one phrase.
 * @param format - the format label the path names.
 * @param probe - what the headers say.
 * @param bytes - the file size.
 * @returns the phrase, such as `WAV, 16-bit PCM, mono, 48 kHz, 0.620 s, 58.1 KB`.
 */
function formatPhrase(format: string, probe: Omit<AudioProbe, 'format'> | undefined, bytes: number): string {
  const parts = [format]
  if (probe?.encoding !== undefined) parts.push(probe.encoding)
  if (probe?.channels !== undefined) parts.push(channelText(probe.channels))
  if (probe?.sampleRate !== undefined) parts.push(rate(probe.sampleRate))
  if (probe?.bitrate !== undefined) parts.push(`${String(Math.round(probe.bitrate / 1000))} kbps`)
  if (probe?.seconds !== undefined) parts.push(`${probe.estimated === true ? 'about ' : ''}${lengthText(probe.seconds)}`)
  parts.push(bytesText(bytes))
  return parts.join(', ')
}

function kindPhrase(kind: AudioCategory, from: AudioCategorySource): string {
  const name = KIND_NAMES[kind][0]
  if (from === 'name') return name
  return from === 'length' ? `${name} by its length` : `${name} by default`
}

/**
 * The text of an `audio_search` result.
 * @param value - the call's value.
 * @returns the listing.
 */
export function describeSearch(value: SearchValue): string {
  const lines: string[] = []
  const filters = [
    value.query === '' ? undefined : `matching "${value.query}"`,
    value.kind === undefined ? undefined : `${KIND_NAMES[value.kind][1]} only`,
    value.folder === undefined || value.folder === '' ? undefined : `in ${value.folder}`,
  ].filter(part => part !== undefined)
  const kinds = (['effect', 'dialogue', 'music'] as const).filter(kind => value.counts[kind] > 0).map(kind => plural(value.counts[kind], kind))
  lines.push(value.total === 0
    ? `No sounds${filters.length > 0 ? ` ${filters.join(', ')}` : ''} in ${value.project}.`
    : `${String(value.total)} sound${value.total === 1 ? '' : 's'}${filters.length > 0 ? ` ${filters.join(', ')}` : ''} in ${value.project}: ${kinds.join(', ')}.`)
  for (const sound of value.sounds) lines.push(`- ${sound.path}: ${kindPhrase(sound.kind, sound.kindFrom)}; ${formatPhrase(sound.format, sound, sound.bytes)}`)
  const shown = value.sounds.length
  if (shown > 0 && value.offset + shown < value.total) {
    lines.push(`Listed ${String(value.offset + 1)} to ${String(value.offset + shown)} of ${String(value.total)}; pass offset ${String(value.offset + shown)} for more.`)
  } else if (shown === 0 && value.total > 0) {
    lines.push(`The offset ${String(value.offset)} is past the last of ${String(value.total)} sounds.`)
  }
  if (value.folders.length > 1) {
    lines.push(`Folders: ${value.folders.map((folder) => {
      const counts = (['effect', 'dialogue', 'music'] as const).filter(kind => folder[kind] > 0).map(kind => plural(folder[kind], kind))
      return `${folder.path === '' ? '(project folder)' : folder.path} (${counts.join(', ')})`
    }).join('; ')}.`)
  }
  if (value.truncated) lines.push('The project has more folders or sounds than one search walks, so some sounds are missing; narrow it with folder.')
  if (value.unreadable > 0) lines.push(`${String(value.unreadable)} folder${value.unreadable === 1 ? '' : 's'} could not be read.`)
  if (value.total > 0) lines.push('Pass a path to audio_review to measure a sound and see its waveform.')
  return lines.join('\n')
}

function godotLine(godot: GodotImport | undefined, sampleRate: number, fileLoop: AudioProbe['loop']): string {
  if (godot === undefined) return 'Godot has not imported it yet, so the game plays it with Godot\'s defaults once it does.'
  const extras = [godot.trim === true ? 'trims its silence' : undefined, godot.normalize === true ? 'normalizes its level' : undefined, godot.bpm === undefined ? undefined : `declares ${String(godot.bpm)} BPM`]
    .filter(part => part !== undefined)
  const tail = extras.length > 0 ? `, and ${extras.join(' and ')}` : ''
  switch (godot.loop) {
    case 'off':
      return `Godot imports it (${godot.importer}) to play once, without looping${tail}.`
    case 'file':
      return fileLoop === undefined
        ? `Godot imports it (${godot.importer}) to follow the file's own loop points, and the file stores none, so it plays once${tail}.`
        : `Godot imports it (${godot.importer}) to loop between the points the file stores${tail}.`
    case 'forward':
    case 'ping-pong':
    case 'backward': {
      // WAV imports place the loop in sample frames, Ogg and MP3 imports in seconds.
      const at = (value: number): string => lengthText(godot.importer === 'wav' ? value / sampleRate : value)
      const range = [
        godot.loopStart === undefined ? undefined : `from ${at(godot.loopStart)}`,
        godot.loopEnd === undefined ? undefined : `to ${at(godot.loopEnd)}`,
      ].filter(part => part !== undefined)
      const how = godot.loop === 'forward' ? 'loop' : `loop ${godot.loop}`
      return `Godot imports it (${godot.importer}) to ${how}${range.length > 0 ? ` ${range.join(' ')}` : ''}${tail}.`
    }
  }
}

function seamLines(measurements: AudioMeasurements, loops: boolean, music: boolean): string[] {
  const seam = measurements.seam
  if (seam === undefined) return []
  const clicks = seamClicks(seam)
  const lines = [clicks
    ? `Loop seam: the end meets the start with a step of ${seam.jump.toFixed(3)} of full scale, ${seam.step === 0 ? 'where the sound is otherwise constant' : `${(seam.jump / seam.step).toFixed(0)} times the usual step between samples`}, so it clicks at every repeat.`
    : 'Loop seam: the end meets the start without a click.']
  // A one-shot sound fades out by design; a level change matters only where the sound repeats.
  if ((loops || music) && seam.levelChange !== undefined && Math.abs(seam.levelChange) >= 6) {
    lines.push(`The last 50 ms are ${Math.abs(seam.levelChange).toFixed(1)} dB ${seam.levelChange < 0 ? 'quieter' : 'louder'} than the first 50 ms, so a repeat ${seam.levelChange < 0 ? 'jumps up' : 'drops'} in level.`)
  }
  if (loops && clicks) lines.push('Warning: Godot loops this sound, so the click plays in the game; cross-fade the ends or cut at zero crossings.')
  return lines
}

function stereoLine(measurements: AudioMeasurements): string | undefined {
  const stereo = measurements.stereo
  if (stereo === undefined) return undefined
  if (stereo.identical) return 'Stereo: both channels hold the same samples, a mono sound stored twice; save it as mono to halve its size.'
  const parts: string[] = []
  if (stereo.correlation !== undefined) parts.push(`correlation ${stereo.correlation.toFixed(2)}`)
  if (stereo.balance !== undefined) parts.push(Math.abs(stereo.balance) < 0.5 ? 'balanced' : `${Math.abs(stereo.balance).toFixed(1)} dB louder on the ${stereo.balance > 0 ? 'left' : 'right'}`)
  const warning = stereo.correlation !== undefined && stereo.correlation < -0.3
    ? ' Warning: the channels are largely out of phase, so the sound cancels itself when mixed to mono.'
    : ''
  return parts.length === 0 ? undefined : `Stereo: ${parts.join(', ')}.${warning}`
}

/**
 * The text of an `audio_review` result, before its image.
 * @param facts - the call's value.
 * @returns the report.
 */
export function describeReview(facts: ReviewFacts): string {
  const { measurements: m } = facts
  const lines = [`${facts.path}: ${kindPhrase(facts.kind, facts.kindFrom)}; ${formatPhrase(facts.probe?.format ?? 'audio', facts.probe, facts.bytes)}.`]
  lines.push(godotLine(facts.godot, m.sampleRate, facts.probe?.loop))
  const whole = m.start === 0 && Math.abs(m.end - m.seconds) < 0.001
  lines.push(whole
    ? `Measured the whole sound: ${lengthText(m.seconds)} at ${rate(m.sampleRate)}, ${channelText(m.channels)}.`
    : `Measured ${lengthText(m.start)} to ${lengthText(m.end)} of ${lengthText(m.seconds)} at ${rate(m.sampleRate)}, ${channelText(m.channels)}.`)
  const perChannel = m.channelLevels.length > 1
    ? ` (${m.channelLevels.map((level, index) => `${m.channelLevels.length === 2 ? (index === 0 ? 'left' : 'right') : `channel ${String(index + 1)}`} ${dbfs(level.peak)} peak`).join(', ')})`
    : ''
  const window = m.end - m.start
  const loudness = m.loudness === undefined
    ? window < 0.4 ? 'loudness not measured (shorter than 0.4 s)' : 'loudness not measured (no sound above the gate)'
    : `loudness ${m.loudness.toFixed(1)} LUFS`
  lines.push(`Levels: peak ${dbfs(m.peak)}${perChannel}, RMS ${dbfs(m.rms)}, ${loudness}.`)
  if (m.peak === 0 || m.leadingSilence >= window) {
    lines.push(m.peak === 0 ? 'Silence: the sound is completely silent.' : 'Silence: every sample is below -60 dBFS, so it is barely audible.')
  } else {
    lines.push(`Silence below -60 dBFS: ${lengthText(m.leadingSilence)} at the start, ${lengthText(m.trailingSilence)} at the end.`)
    if (facts.kind !== 'music' && m.start === 0 && m.leadingSilence >= LATE_START_SECONDS) {
      lines.push(`Warning: the sound starts ${lengthText(m.leadingSilence)} into the file, so it plays late when the game triggers it; trim the start.`)
    }
  }
  if (m.dominantFrequency !== undefined && m.spectralCentroid !== undefined) {
    lines.push(`Spectrum: strongest component ${hertz(m.dominantFrequency)}, centroid ${hertz(m.spectralCentroid)}.`)
  }
  const loops = facts.godot !== undefined && facts.godot.loop !== 'off' && (facts.godot.loop !== 'file' || facts.probe?.loop !== undefined)
  lines.push(...seamLines(m, loops, facts.kind === 'music'))
  const stereo = stereoLine(m)
  if (stereo !== undefined) lines.push(stereo)
  m.channelLevels.forEach((level, index) => {
    const subject = m.channelLevels.length === 1 ? 'samples' : `samples of ${m.channelLevels.length === 2 ? (index === 0 ? 'the left channel' : 'the right channel') : `channel ${String(index + 1)}`}`
    if (level.clipped > 0) lines.push(`Warning: ${String(level.clipped)} ${subject} reach full scale and clip; lower the level and export it again.`)
    if (Math.abs(level.dcOffset) >= 0.01) lines.push(`Warning: the ${subject} have a DC offset of ${level.dcOffset.toFixed(3)}, which thumps when the sound starts and stops; filter it out with a high-pass.`)
  })
  if (facts.probe?.loop !== undefined) {
    lines.push(`The file stores a loop from frame ${String(facts.probe.loop.start)} to frame ${String(facts.probe.loop.end)}.`)
  }
  if (facts.picture !== undefined) lines.push(describeAudioImage(facts.picture))
  else if (facts.pictureOmitted === true) lines.push('Your model does not accept images, so no picture was drawn.')
  if (facts.shown) lines.push('It is open in the user\'s Audio panel, ready for them to play.')
  return lines.join('\n')
}
