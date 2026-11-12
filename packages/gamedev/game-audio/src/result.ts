/**
 * Validation of a window's answer to a measure request. The answer comes from a browser, so its measurements and its
 * picture are checked field by field, with every number finite, every list bounded, and the picture's size capped,
 * before any of it reaches a tool result.
 * @module @deepseek-ai/dsh-game-audio/src/result
 */
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ReviewFacts } from './describe.ts'
import { AUDIO_ERROR } from './audio/errors.ts'
import type { AudioMeasureResult } from './types.ts'

/** Longest base64 text of the picture: 16 MiB of PNG bytes. */
const MAX_PICTURE_BASE64 = Math.ceil((16 * 1024 * 1024) / 3) * 4

/** Most channels a measurement lists. */
const MAX_CHANNELS = 64

const level = z.number().min(0).max(1e6)
const seconds = z.number().min(0).max(1e9)
const finite = z.number().min(-1e9).max(1e9)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const measurements = z.strictObject({
  sampleRate: z.number().int().min(1).max(10_000_000),
  channels: z.number().int().min(1).max(MAX_CHANNELS),
  seconds,
  start: seconds,
  end: seconds,
  peak: level,
  rms: level,
  loudness: finite.exactOptional(),
  leadingSilence: seconds,
  trailingSilence: seconds,
  dominantFrequency: seconds.exactOptional(),
  spectralCentroid: seconds.exactOptional(),
  channelLevels: z.array(z.strictObject({ peak: level, rms: level, dcOffset: finite, clipped: count })).max(MAX_CHANNELS),
  seam: z.strictObject({ jump: level, step: level, levelChange: finite.exactOptional() }).exactOptional(),
  stereo: z.strictObject({
    correlation: z.number().min(-1.000_001).max(1.000_001).exactOptional(),
    balance: finite.exactOptional(),
    identical: z.boolean(),
  }).exactOptional(),
})

const picture = z.strictObject({
  data: z.string().min(1).max(MAX_PICTURE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  mediaType: z.literal('image/png'),
  layout: z.strictObject({
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    waveformPanels: z.enum(['channels', 'mix']),
    timeStep: z.number().positive().max(1e6),
    nyquist: z.number().positive().max(10_000_000),
  }),
})

const answer = z.strictObject({ measurements, picture: picture.exactOptional() })

/**
 * Validate a window's answer.
 * @param value - what the window returned.
 * @returns the answer.
 * @throws {HarnessError} `AUDIO_MEASURE` naming the first field that does not validate.
 */
export function parseMeasureResult(value: unknown): AudioMeasureResult {
  const parsed = answer.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined || issue.path.length === 0 ? 'its answer' : issue.path.join('.')
    throw new HarnessError(`The WASD Engine window measured the sound but answered with an invalid ${where}.`, AUDIO_ERROR.measure)
  }
  return parsed.data
}

const probe = z.object({
  format: z.string(),
  encoding: z.string().exactOptional(),
  sampleRate: z.number().exactOptional(),
  channels: z.number().exactOptional(),
  bitDepth: z.number().exactOptional(),
  bitrate: z.number().exactOptional(),
  seconds: z.number().exactOptional(),
  estimated: z.boolean().exactOptional(),
  loop: z.object({ start: z.number(), end: z.number() }).exactOptional(),
})

const godot = z.object({
  importer: z.string(),
  loop: z.enum(['off', 'forward', 'ping-pong', 'backward', 'file']),
  loopStart: z.number().exactOptional(),
  loopEnd: z.number().exactOptional(),
  bpm: z.number().exactOptional(),
  trim: z.boolean().exactOptional(),
  normalize: z.boolean().exactOptional(),
})

/** The JSON fields of a stored `audio_review` value. */
export interface ReviewJson {
  readonly probe?: JsonValue
  readonly godot?: JsonValue
  readonly measurements: JsonValue
  readonly picture?: JsonValue
}

/**
 * Read the JSON fields of a stored `audio_review` value back into their types, as the result's text renders them.
 * @param value - the value's JSON fields, which `audio_review` wrote from validated answers.
 * @returns the typed fields; a field that no longer validates is left out, and invalid measurements throw.
 * @throws {HarnessError} `AUDIO_MEASURE` when the measurements do not validate.
 */
export function parseReviewJson(value: ReviewJson): Pick<ReviewFacts, 'probe' | 'godot' | 'measurements' | 'picture'> {
  const measured = measurements.safeParse(value.measurements)
  if (!measured.success) throw new HarnessError('The stored audio measurements do not validate.', AUDIO_ERROR.measure)
  const read = <T>(schema: z.ZodType<T>, field: JsonValue | undefined): T | undefined => {
    if (field === undefined) return undefined
    const parsed = schema.safeParse(field)
    return parsed.success ? parsed.data : undefined
  }
  const facts = read(probe, value.probe)
  const imported = read(godot, value.godot)
  const layout = read(picture.shape.layout, value.picture)
  return {
    measurements: measured.data,
    ...facts === undefined ? {} : { probe: facts },
    ...imported === undefined ? {} : { godot: imported },
    ...layout === undefined ? {} : { picture: layout },
  }
}
