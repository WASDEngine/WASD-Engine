/**
 * Captures of a running game's audio mix: the harness's answer to an `audio` request, the Master bus volume that the
 * harness reports apart from the samples, the stretches of a capture that hold sound, the summary and text that
 * `godot_audio` returns, and the capture as a WAV file. The measurements and the picture are the ones that WASD
 * Engine's Audio tab and the SuperCollider tools share (`@deepseek-ai/dsh-game-audio/audio`).
 * @module @deepseek-ai/dsh-godot/src/audio
 */
import { Buffer } from 'node:buffer'
import type { AudioAnalysis, AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const Count = z.number().int()

const Bus = z.object({
  name: z.string(),
  volumeDb: z.number(),
  mute: z.boolean(),
  solo: z.boolean(),
  bypass: z.boolean(),
  send: z.string(),
  effects: z.array(z.tuple([z.string(), z.boolean()])),
  peakDb: z.number(),
})

const Player = z.object({
  path: z.string(),
  class: z.string(),
  stream: z.string(),
  bus: z.string(),
  volumeDb: z.number(),
  starts: Count,
  firstAt: z.number(),
  lastAt: z.number(),
  playing: z.boolean(),
})

/** The harness's answer to an `audio` request; `runtime/wasd_harness.gd` documents its fields. */
export const AudioReply = z.object({
  sampleRate: z.number().positive(),
  channels: z.literal(2),
  frames: Count,
  seconds: z.number(),
  droppedFrames: Count,
  masterVolumes: z.array(z.tuple([Count, z.number(), z.boolean()])),
  masterBypassed: z.boolean(),
  detached: z.boolean(),
  driver: z.string(),
  outputLatencyMs: z.number(),
  startFrame: Count,
  frame: Count,
  buses: z.array(Bus),
  players: z.array(Player),
  morePlayers: Count,
  timedOut: z.boolean(),
  cancelled: z.boolean(),
})

/** An audio capture as the harness reports it. */
export type AudioReply = z.infer<typeof AudioReply>

/** The audio driver of a muted run, which mixes the game's audio for no device. */
export const MUTED_DRIVER = 'Dummy'

/** Length of the windows whose level decides where a capture holds sound, in seconds. */
const SOUND_WINDOW_SECONDS = 0.01

/** RMS level of a window that holds sound: -50 dBFS. */
const SOUND_LEVEL = 10 ** (-50 / 20)

/** Longest quiet stretch inside one sound, in seconds. */
const SOUND_GAP_SECONDS = 0.15

/** Most sounds a summary lists. */
export const LISTED_SOUNDS = 12

/**
 * The capture as players hear it: the samples scaled by the Master bus volume, which the bus applies after the effect
 * that captured them, piece by piece where the volume changed during the capture. Scales `samples` in place.
 * @param samples - interleaved stereo samples from the harness.
 * @param volumes - the reply's `masterVolumes`: [captured frame, volume dB, muted], from the first frame on.
 * @returns the same samples.
 */
export function applyMasterVolume(samples: Float32Array, volumes: AudioReply['masterVolumes']): Float32Array {
  for (let index = 0; index < volumes.length; index++) {
    const [frame, volumeDb, muted] = volumes[index] as AudioReply['masterVolumes'][number]
    const end = (volumes[index + 1]?.[0] ?? Number.POSITIVE_INFINITY) * 2
    const gain = muted ? 0 : 10 ** (volumeDb / 20)
    if (gain === 1) continue
    for (let sample = frame * 2; sample < Math.min(end, samples.length); sample++) samples[sample] = (samples[sample] ?? 0) * gain
  }
  return samples
}

/** One stretch of a capture that holds sound. */
export interface CapturedSound {
  /** Seconds from the capture's start. */
  readonly start: number
  /** Seconds from the capture's start. */
  readonly end: number
  /** Largest absolute sample, linear. */
  readonly peak: number
}

/**
 * The stretches of audio whose level in 10 ms windows reaches -50 dBFS, with quiet gaps shorter than 150 ms inside one
 * stretch, as a timeline of the sounds that a capture holds.
 * @param audio - the samples.
 * @returns the stretches in time order.
 */
export function findSounds(audio: AudioSamples): CapturedSound[] {
  const window = Math.max(1, Math.round(audio.sampleRate * SOUND_WINDOW_SECONDS))
  const gap = Math.round(SOUND_GAP_SECONDS / SOUND_WINDOW_SECONDS)
  const sounds: { start: number; end: number; peak: number }[] = []
  let quiet = Number.POSITIVE_INFINITY
  for (let first = 0, index = 0; first < audio.frames; first += window, index++) {
    const last = Math.min(audio.frames, first + window)
    let squares = 0
    let peak = 0
    for (let frame = first; frame < last; frame++) {
      for (let channel = 0; channel < audio.channels; channel++) {
        const value = audio.samples[frame * audio.channels + channel] ?? 0
        const sample = Number.isFinite(value) ? Math.abs(value) : 0
        squares += sample * sample
        peak = Math.max(peak, sample)
      }
    }
    if (Math.sqrt(squares / ((last - first) * audio.channels)) < SOUND_LEVEL) {
      quiet += 1
      continue
    }
    const current = sounds.at(-1)
    if (current !== undefined && quiet <= gap) {
      current.end = last
      current.peak = Math.max(current.peak, peak)
    } else {
      sounds.push({ start: first, end: last, peak })
    }
    quiet = 0
  }
  return sounds.map(sound => ({ start: sound.start / audio.sampleRate, end: sound.end / audio.sampleRate, peak: sound.peak }))
}

/**
 * Encode interleaved samples as a 16-bit PCM WAV file, rounding each sample to the nearest step and clipping it to
 * full scale; a NaN or infinite sample writes silence.
 * @param audio - the samples.
 * @returns the file bytes.
 */
export function encodeWav(audio: AudioSamples): Buffer {
  const count = audio.frames * audio.channels
  const file = Buffer.alloc(44 + count * 2)
  file.write('RIFF', 0, 'latin1')
  file.writeUInt32LE(36 + count * 2, 4)
  file.write('WAVEfmt ', 8, 'latin1')
  file.writeUInt32LE(16, 16)
  file.writeUInt16LE(1, 20)
  file.writeUInt16LE(audio.channels, 22)
  file.writeUInt32LE(audio.sampleRate, 24)
  file.writeUInt32LE(audio.sampleRate * audio.channels * 2, 28)
  file.writeUInt16LE(audio.channels * 2, 32)
  file.writeUInt16LE(16, 34)
  file.write('data', 36, 'latin1')
  file.writeUInt32LE(count * 2, 40)
  for (let index = 0; index < count; index++) {
    const value = audio.samples[index] ?? 0
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    file.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
  }
  return file
}

/** Lowest level that a summary reports, in dBFS; quieter audio and silence report it. */
export const FLOOR_DB = -120

/** Decibels of a linear amplitude, rounded to 0.1, at least {@link FLOOR_DB}. */
function decibels(amplitude: number): number {
  return amplitude > 0 ? Math.max(FLOOR_DB, Math.round(200 * Math.log10(amplitude)) / 10) : FLOOR_DB
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const NUMBER = { type: 'number', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const STRING = { type: 'string', required: true } as const

/** Result fields of `godot_audio`, before the saved file, the picture, and the new-error report that the tool adds. */
export const AUDIO_PROPERTIES = {
  seconds: NUMBER,
  sampleRate: NUMBER,
  channels: INTEGER,
  muted: { ...BOOLEAN, description: 'Whether the run uses the Dummy audio driver, which mixes the game\'s audio for no device.' },
  driver: STRING,
  droppedFrames: INTEGER,
  peakDb: { ...NUMBER, description: `Largest sample of both channels in dBFS; ${String(FLOOR_DB)} for silence.` },
  rmsDb: NUMBER,
  loudnessLufs: { type: 'number', description: 'Integrated loudness, when the capture is long and loud enough to measure it.' },
  channelLevels: {
    type: 'array',
    required: true,
    items: { type: 'object', additionalProperties: false, properties: { peakDb: NUMBER, rmsDb: NUMBER, clipped: INTEGER } },
  },
  leadingSilence: NUMBER,
  trailingSilence: NUMBER,
  dominantHz: { type: 'number' },
  centroidHz: { type: 'number' },
  sounds: {
    type: 'array',
    required: true,
    items: { type: 'object', additionalProperties: false, properties: { start: NUMBER, end: NUMBER, peakDb: NUMBER } },
  },
  moreSounds: INTEGER,
  players: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: STRING, class: STRING, stream: STRING, bus: STRING, volumeDb: NUMBER,
        starts: INTEGER, firstAt: NUMBER, lastAt: NUMBER, playing: BOOLEAN,
      },
    },
  },
  morePlayers: INTEGER,
  buses: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: STRING, volumeDb: NUMBER, mute: BOOLEAN, solo: BOOLEAN, bypass: BOOLEAN, send: STRING, peakDb: NUMBER,
        effects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: STRING, enabled: BOOLEAN } } },
      },
    },
  },
  masterVolumes: {
    type: 'array',
    required: true,
    items: { type: 'object', additionalProperties: false, properties: { at: NUMBER, volumeDb: NUMBER, muted: BOOLEAN } },
  },
  masterBypassed: BOOLEAN,
  detached: BOOLEAN,
  timedOut: BOOLEAN,
} as const

const SUMMARY_SCHEMA = { type: 'object', additionalProperties: false, properties: AUDIO_PROPERTIES } as const

/** A capture as `godot_audio` returns it: seconds, levels in dBFS, and the game's players and buses. */
export type AudioSummary = InferValue<typeof SUMMARY_SCHEMA>

/**
 * Summarize a capture.
 * @param reply - the harness's answer.
 * @param audio - the samples as players hear them.
 * @param analysis - the measurements of `audio`.
 * @returns the summary.
 */
export function summarizeAudio(reply: AudioReply, audio: AudioSamples, analysis: AudioAnalysis): AudioSummary {
  const sounds = findSounds(audio)
  return {
    seconds: round(audio.frames / audio.sampleRate, 3),
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    muted: reply.driver === MUTED_DRIVER,
    driver: reply.driver,
    droppedFrames: reply.droppedFrames,
    peakDb: decibels(analysis.peak),
    rmsDb: decibels(analysis.rms),
    ...analysis.loudness === undefined ? {} : { loudnessLufs: round(analysis.loudness, 1) },
    channelLevels: analysis.channels.map(level => ({ peakDb: decibels(level.peak), rmsDb: decibels(level.rms), clipped: level.clipped })),
    leadingSilence: round(analysis.leadingSilence, 3),
    trailingSilence: round(analysis.trailingSilence, 3),
    ...analysis.dominantFrequency === undefined ? {} : { dominantHz: Math.round(analysis.dominantFrequency) },
    ...analysis.spectralCentroid === undefined ? {} : { centroidHz: Math.round(analysis.spectralCentroid) },
    sounds: sounds.slice(0, LISTED_SOUNDS).map(sound => ({
      start: round(sound.start, 2), end: round(sound.end, 2), peakDb: decibels(sound.peak),
    })),
    moreSounds: Math.max(0, sounds.length - LISTED_SOUNDS),
    players: reply.players.map(player => ({ ...player })),
    morePlayers: reply.morePlayers,
    buses: reply.buses.map(bus => ({ ...bus, effects: bus.effects.map(([name, enabled]) => ({ name, enabled })) })),
    masterVolumes: reply.masterVolumes.map(([frame, volumeDb, muted]) => ({ at: round(frame / reply.sampleRate, 3), volumeDb, muted })),
    masterBypassed: reply.masterBypassed,
    detached: reply.detached,
    timedOut: reply.timedOut,
  }
}

function level(db: number): string {
  return db <= FLOOR_DB ? 'silence' : `${db.toFixed(1)} dBFS`
}

function seconds(value: number): string {
  return `${value.toFixed(2)} s`
}

function hertz(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${String(Math.round(value))} Hz`
}

function busDb(db: number): string {
  return db <= -200 ? 'silent' : `${db.toFixed(1)} dB`
}

/**
 * Describe a capture for the model.
 * @param summary - summary from {@link summarizeAudio}.
 * @returns lines of text.
 */
export function describeAudio(summary: AudioSummary): string[] {
  const lines = [
    `Captured ${seconds(summary.seconds)} of the game's audio mix, the Master bus after its effects and volume, at ${String(summary.sampleRate)} Hz in stereo`
      + `${summary.timedOut ? ', ended by its real-time limit' : ''}.`,
  ]
  if (summary.muted) lines.push('The game runs muted (Dummy audio driver): it mixes its audio as usual, but no device plays it.')
  if (summary.masterBypassed) lines.push('The Master bus bypasses its effects, so the capture, an effect at the end of the bus, received no audio; turn the bypass off to capture.')
  if (summary.detached) lines.push('The game replaced its audio bus layout during the capture, which removed the capture from the Master bus; audio after that is missing.')
  if (summary.droppedFrames > 0) lines.push(`The game stalled between frames long enough for the capture to drop ${String(summary.droppedFrames)} audio frames.`)
  if (summary.peakDb <= FLOOR_DB) {
    lines.push(`The mix is silent: no sample reaches ${String(FLOOR_DB)} dBFS.`)
  } else {
    const channels = summary.channelLevels.map((channel, index) => `${index === 0 ? 'left' : 'right'} ${level(channel.peakDb)} peak, ${level(channel.rmsDb)} RMS`)
    const loudness = summary.loudnessLufs === undefined ? '' : `, loudness ${summary.loudnessLufs.toFixed(1)} LUFS`
    lines.push(`Levels: peak ${level(summary.peakDb)}, RMS ${level(summary.rmsDb)} (${channels.join('; ')})${loudness}.`)
    const clipped = summary.channelLevels.reduce((total, channel) => total + channel.clipped, 0)
    if (clipped > 0) lines.push(`Warning: ${String(clipped)} samples reach full scale and clip; lower bus or player volumes, or add an AudioEffectHardLimiter at the end of the Master bus.`)
    lines.push(summary.leadingSilence >= summary.seconds
      ? 'Silence: every sample is below -60 dBFS.'
      : `Silence below -60 dBFS: ${seconds(summary.leadingSilence)} at the start, ${seconds(summary.trailingSilence)} at the end.`)
    if (summary.dominantHz !== undefined && summary.centroidHz !== undefined) {
      lines.push(`Spectrum: strongest component ${hertz(summary.dominantHz)}, centroid ${hertz(summary.centroidHz)}.`)
    }
  }
  if (summary.sounds.length > 0) {
    const more = summary.moreSounds === 0 ? '' : `, and ${String(summary.moreSounds)} more`
    lines.push(`Sounds (stretches above -50 dBFS): ${summary.sounds.map(sound => `${sound.start.toFixed(2)}-${sound.end.toFixed(2)} s peak ${level(sound.peakDb)}`).join(', ')}${more}.`)
  }
  if (summary.players.length === 0) {
    lines.push('No AudioStreamPlayer, AudioStreamPlayer2D, or AudioStreamPlayer3D started playing during the capture.')
  } else {
    const more = summary.morePlayers === 0 ? '' : `; and ${String(summary.morePlayers)} more`
    lines.push(`Players that played: ${summary.players.map((player) => {
      const stream = player.stream === '' ? 'no stream' : player.stream
      const times = player.starts === 1 ? `started at ${seconds(player.firstAt)}` : `started ${String(player.starts)} times from ${seconds(player.firstAt)}`
      return `${player.path} (${player.class}, ${stream}, bus ${player.bus}, ${player.volumeDb.toFixed(1)} dB) ${times}${player.playing ? ', still playing' : ''}`
    }).join('; ')}${more}.`)
  }
  lines.push(`Buses (volume, largest peak): ${summary.buses.map((bus) => {
    const flags = [bus.mute ? 'muted' : '', bus.solo ? 'solo' : '', bus.bypass ? 'effects bypassed' : ''].filter(flag => flag !== '')
    const effects = bus.effects.length === 0 ? '' : `, effects ${bus.effects.map(effect => effect.enabled ? effect.name : `${effect.name} (off)`).join(', ')}`
    const send = bus.send === '' ? '' : ` to ${bus.send}`
    return `${bus.name}${send} ${bus.volumeDb.toFixed(1)} dB, peak ${busDb(bus.peakDb)}${flags.length === 0 ? '' : ` (${flags.join(', ')})`}${effects}`
  }).join('; ')}.`)
  if (summary.masterVolumes.length > 1) {
    lines.push(`The Master volume changed during the capture: ${summary.masterVolumes.map(change => `${seconds(change.at)} ${change.muted ? 'muted' : `${change.volumeDb.toFixed(1)} dB`}`).join(', ')}.`)
  }
  return lines
}
