/**
 * The model-facing audio tools: `audio_search` lists the game project's sound effects, dialogue, and music with what
 * their headers say, and `audio_review` has a WASD Engine window decode one sound as its Audio tab plays it, then
 * reports its levels, loudness, silence, spectrum, loop seam, and stereo image with a picture of its waveform and
 * spectrogram, how Godot imports it, and, when asked, opens it in the user's Audio tab. One set of definitions serves
 * one {@link AudioToolSurface}: the Session's own agent, whose picture becomes an attachment for its model, or agents
 * connected through WASD Engine's MCP server, whose picture travels as image bytes.
 * @module @deepseek-ai/dsh-game-audio/src/tools
 */
import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { AUDIO_CATEGORIES, audioCategoryOf, audioFormatOf, type AudioCategory } from './audio/formats.ts'
import type { AudioProbe } from './audio/probe.ts'
import { describeReview, describeSearch, type ListedFolder, type ListedSound } from './describe.ts'
import { AUDIO_ERROR } from './audio/errors.ts'
import { mapLimited, PROBE_CONCURRENCY, readGodotImport } from './files.ts'
import { parseReviewJson } from './result.ts'
import { NAME_ORDER, scanSounds, type SoundFile, type SoundScanLimits } from './scan.ts'
import type { AudioMeasureRequest, AudioMeasureResult, AudioPicture, AudioReveal } from './types.ts'


/** The message of an `audio_review` call that no window answered. */
export const NO_WINDOW_MESSAGE = 'No WASD Engine window is open to decode the sound. Ask the user to open WASD Engine\'s window, then call audio_review again.'

/** Sounds `audio_search` lists when the call names no limit. */
export const DEFAULT_LIMIT = 50

/** Most sounds one `audio_search` call lists. */
export const MAX_LIMIT = 200

/** Time a review's tool time limit leaves past the window's, so the window's more specific failure reaches the agent. */
const WINDOW_GRACE_MS = 5000

/** Most folders `audio_search` lists with their counts. */
const LISTED_FOLDERS = 40

/** What the tools need from the plugin. */
export interface AudioToolHost {
  /** Caps of the project walk. */
  readonly scanLimits: SoundScanLimits
  /** Time limit of one `audio_review` call in milliseconds. */
  readonly measureTimeoutMs: number
  /** Longest window one `audio_review` call measures, in seconds. */
  readonly maxReviewSeconds: number
  /** Largest file a window reads to measure it, in bytes. */
  readonly maxPreviewBytes: number
  /**
   * The project folder of one call: the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute folder.
   */
  project(exec: ToolRunContext): Promise<string>
  /**
   * What a sound's headers say, read again only when the file changed.
   * @param absolute - absolute path of the file.
   * @param file - the file as the walk found it, or its size and modification time.
   * @returns the facts, or undefined for headers the probe does not read.
   */
  probe(absolute: string, file: Pick<SoundFile, 'bytes' | 'modified'>): Promise<AudioProbe | undefined>
  /**
   * Ask a WASD Engine window that may read the Agent's Session to decode and measure a sound.
   * @param agent - the calling Agent; its Session's workspace holds the sound.
   * @param request - the sound and what to measure.
   * @param signal - the call's cancellation.
   * @returns the window's validated answer.
   * @throws {HarnessError} `AUDIO_NO_WINDOW` when no window answers, or the window's failure.
   */
  measure(agent: Agent, request: AudioMeasureRequest, signal: AbortSignal): Promise<AudioMeasureResult>
  /**
   * Open a sound in the Session's Audio tab of the windows that may read the Session.
   * @param reveal - the Session and the sound.
   */
  reveal(reveal: AudioReveal): void
}

/** How one set of tool definitions hands the drawn picture to its callers. */
export interface AudioToolSurface {
  /**
   * Whether the caller of a call sees images; a caller that does not gets the figures alone.
   * @param exec - the call's execution.
   * @returns true when the caller's model accepts images.
   */
  seesImages(exec: ToolRunContext): Promise<boolean>
  /**
   * Give a call's picture to its caller.
   * @param exec - the call's execution.
   * @param picture - the picture the window drew.
   * @param name - base name for the image, such as the sound's file name.
   * @returns the stored images that the result carries, or none when they reach the caller another way.
   */
  keep(exec: ToolRunContext, picture: AudioPicture, name: string): Promise<ImageAttachmentRef[]>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const KIND = { type: 'string', enum: [...AUDIO_CATEGORIES], required: true } as const
const KIND_FROM = { type: 'string', enum: ['name', 'length', 'default'], required: true } as const

const COUNTS = { effect: INTEGER, dialogue: INTEGER, music: INTEGER } as const

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project: STRING,
    query: STRING,
    kind: { type: 'string', enum: [...AUDIO_CATEGORIES] },
    folder: { type: 'string' },
    total: INTEGER,
    offset: INTEGER,
    counts: { type: 'object', additionalProperties: false, required: true, properties: COUNTS },
    sounds: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: STRING, kind: KIND, kindFrom: KIND_FROM, format: STRING, bytes: INTEGER,
          encoding: { type: 'string' }, sampleRate: { type: 'number' }, channels: { type: 'integer' },
          seconds: { type: 'number' }, estimated: { type: 'boolean' },
        },
      },
    },
    folders: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: STRING, ...COUNTS } } },
    truncated: BOOLEAN,
    unreadable: INTEGER,
  },
} as const

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    width: INTEGER,
    height: INTEGER,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: INTEGER, height: INTEGER } },
  },
} as const

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: STRING,
    kind: KIND,
    kindFrom: KIND_FROM,
    bytes: INTEGER,
    probe: { type: 'json', description: 'What the file\'s headers say.' },
    godot: { type: 'json', description: 'How Godot imports the sound.' },
    measurements: { type: 'json', required: true, description: 'What the window measured.' },
    picture: { type: 'json', description: 'The layout of the waveform and spectrogram picture.' },
    images: { type: 'array', required: true, items: IMAGE_SCHEMA },
    pictureOmitted: { type: 'boolean', description: 'The caller\'s model does not accept images, so no picture was drawn.' },
    shown: BOOLEAN,
  },
} as const

/** Value of one `audio_search` call. */
type SearchValue = InferValue<typeof SEARCH_SCHEMA>

/** Value of one `audio_review` call. */
type ReviewValue = InferValue<typeof REVIEW_SCHEMA>

function fail(message: string, code: string): never {
  throw new HarnessError(message, code)
}

function checkedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const chosen = value ?? fallback
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) fail(`${name} must be an integer from ${String(min)} to ${String(max)}.`, AUDIO_ERROR.argument)
  return chosen
}

/**
 * Place a path the call names inside the project folder.
 * @param project - absolute project folder.
 * @param path - relative to the project folder, or absolute inside it; `.` and an empty path name the folder itself.
 * @returns the absolute path and the `/`-separated workspace path, empty for the project folder.
 * @throws {HarnessError} `AUDIO_OUTSIDE_PROJECT` for a path outside the project folder.
 */
export function insideProject(project: string, path: string): { readonly absolute: string; readonly path: string } {
  const absolute = resolve(project, path.trim())
  const steps = relative(project, absolute)
  const outside = steps === '..' || steps.startsWith(`..${sep}`) || isAbsolute(steps)
  if (outside) fail(`${path} is not inside the project folder ${project}.`, AUDIO_ERROR.outside)
  return { absolute, path: steps.split(sep).join('/') }
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Rank sounds for a query: names that start with it, then names that contain it, then paths that contain it, then
 * paths that hold its characters in order; the rest are left out.
 * @param sounds - the sounds.
 * @param query - lowercase search text.
 * @returns the matching sounds, best first.
 */
function rankSounds(sounds: readonly ListedSound[], query: string): ListedSound[] {
  const rank = (sound: ListedSound): number => {
    const path = sound.path.toLowerCase()
    const name = nameOf(path)
    if (name.startsWith(query)) return 0
    if (name.includes(query)) return 1
    if (path.includes(query)) return 2
    let matched = 0
    for (const character of path) if (character === query[matched]) matched += 1
    return matched === query.length ? 3 : 4
  }
  return sounds
    .map(sound => ({ sound, rank: rank(sound) }))
    .filter(entry => entry.rank < 4)
    .sort((left, right) => left.rank - right.rank || NAME_ORDER.compare(left.sound.path, right.sound.path))
    .map(entry => entry.sound)
}

function emptyCounts(): Record<AudioCategory, number> {
  return { effect: 0, dialogue: 0, music: 0 }
}

function asJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    // ENOENT, ENOTDIR, or EACCES: nothing readable at the path.
    return undefined
  }
}

function renderReview(value: ReviewValue): ContentBlock[] {
  const parsed = parseReviewJson(value)
  const text = describeReview({
    path: value.path,
    kind: value.kind,
    kindFrom: value.kindFrom,
    bytes: value.bytes,
    ...parsed,
    ...value.pictureOmitted === true ? { pictureOmitted: true } : {},
    shown: value.shown,
  })
  return [
    { type: 'text', text },
    // The value holds the references that the attachment store returned, so their ids are stored attachment ids.
    ...value.images.map(image => ({ type: 'image' as const, attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } })),
  ]
}

/** Arguments of `audio_review`, as the schema types them. */
interface ReviewArgs {
  readonly path: string
  readonly start?: number
  readonly end?: number
  readonly picture?: boolean
  readonly show?: boolean
}

/**
 * The measured window of one call, validated.
 * @param args - the call's arguments.
 * @returns where the window starts and ends; an end the call does not name is absent.
 */
function measuredWindow(args: ReviewArgs): { readonly start: number; readonly end?: number } {
  const start = args.start ?? 0
  if (!Number.isFinite(start) || start < 0) fail('start must be a number of seconds from 0.', AUDIO_ERROR.argument)
  if (args.end === undefined) return { start }
  if (!Number.isFinite(args.end) || args.end <= start) fail('end must be a number of seconds later than start.', AUDIO_ERROR.argument)
  return { start, end: args.end }
}

/**
 * Build the audio tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how the definitions hand the picture to their callers.
 * @returns the definitions, not registered: `audio_search`, then `audio_review`.
 */
export function audioToolDefinitions(host: AudioToolHost, surface: AudioToolSurface): ToolDefinition[] {
  return [defineTool({
    name: 'audio_search',
    description: 'List the game project\'s sounds: sound effects, dialogue, and music in WAV, MP3, Ogg Vorbis and Opus, FLAC, and AIFF files, with each one\'s kind, format, channels, sample rate, and length, and how many of each kind each folder holds. '
      + 'A sound\'s kind comes from a word of its file or folder names, such as sfx, voice, or music, or else from its length: music from 30 seconds. '
      + 'Without a query, lists them folder by folder; with one, the sounds whose name or path contains it, best match first. Pass a path to audio_review to measure one.',
    parameters: {
      query: { type: 'string', description: 'Text in the sound\'s name or path, such as "jump" or "music/boss". Default: every sound.' },
      kind: { type: 'string', enum: [...AUDIO_CATEGORIES], description: 'Only sound effects (effect), dialogue, or music. Default: all three.' },
      folder: { type: 'string', description: 'Only sounds in this folder or below it, relative to the project folder.' },
      limit: { type: 'integer', description: `Most sounds to list, from 1 to ${String(MAX_LIMIT)}. Default: ${String(DEFAULT_LIMIT)}.` },
      offset: { type: 'integer', description: 'Sounds to skip, to list more. Default: 0.' },
    },
    output: {
      schema: SEARCH_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: describeSearch(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<SearchValue> {
      const limit = checkedInteger(args.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT)
      const offset = checkedInteger(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const project = await host.project(exec)
      const named = args.folder?.trim().replace(/[\\/]+$/u, '') ?? ''
      const folder = named === '' || named === '.' ? '' : insideProject(project, named).path
      const scan = await scanSounds(project, host.scanLimits, exec.signal)
      const candidates = scan.sounds.filter(sound => folder === '' || sound.folder === folder || sound.folder.startsWith(`${folder}/`))
      const listed = await mapLimited(candidates, PROBE_CONCURRENCY, async (sound): Promise<ListedSound> => {
        const probe = await host.probe(resolve(project, ...sound.path.split('/')), sound)
        const { category, source } = audioCategoryOf(sound.path, probe?.seconds)
        return {
          path: sound.path, kind: category, kindFrom: source, format: probe?.format ?? sound.format.label, bytes: sound.bytes,
          ...probe?.encoding === undefined ? {} : { encoding: probe.encoding },
          ...probe?.sampleRate === undefined ? {} : { sampleRate: probe.sampleRate },
          ...probe?.channels === undefined ? {} : { channels: probe.channels },
          ...probe?.seconds === undefined ? {} : { seconds: probe.seconds },
          ...probe?.estimated === true ? { estimated: true } : {},
        }
      })
      exec.signal.throwIfAborted()
      const ofKind = args.kind === undefined ? listed : listed.filter(sound => sound.kind === args.kind)
      const query = args.query?.trim() ?? ''
      const matching = query === '' ? ofKind : rankSounds(ofKind, query.toLowerCase())
      const counts = emptyCounts()
      const byFolder = new Map<string, Record<AudioCategory, number>>()
      for (const sound of matching) {
        counts[sound.kind] += 1
        const key = folderOf(sound.path)
        const entry = byFolder.get(key) ?? emptyCounts()
        entry[sound.kind] += 1
        byFolder.set(key, entry)
      }
      const folders: ListedFolder[] = [...byFolder.entries()]
        .sort(([left], [right]) => NAME_ORDER.compare(left, right))
        .slice(0, LISTED_FOLDERS)
        .map(([path, entry]) => ({ path, ...entry }))
      return {
        project,
        query,
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...folder === '' ? {} : { folder },
        total: matching.length,
        offset,
        counts,
        sounds: matching.slice(offset, offset + limit),
        folders,
        truncated: scan.truncated,
        unreadable: scan.unreadable,
      }
    },
  }), defineTool({
    name: 'audio_review',
    description: 'Measure one sound of the game project as the user hears it in WASD Engine\'s Audio panel, since you cannot listen to it: its length and format, peak and RMS levels, loudness in LUFS, clipping, DC offset, silence at the start and end, strongest frequency and spectral centroid, whether its end joins its start without a click when it repeats, how its stereo channels relate, and how Godot imports it, with a picture of its waveform and spectrogram. '
      + `Pass start and end to measure part of a long track; one call measures at most ${String(host.maxReviewSeconds)} seconds. Set show to open the sound in the user's Audio panel so they can listen to it.`,
    parameters: {
      path: { type: 'string', required: true, description: 'The sound, relative to the project folder or absolute inside it, such as "audio/sfx/jump.wav".' },
      start: { type: 'number', description: 'Seconds into the sound where the measurement starts. Default: 0.' },
      end: { type: 'number', description: `Seconds into the sound where it ends. Default: the end of the sound, at most ${String(host.maxReviewSeconds)} seconds after start.` },
      picture: { type: 'boolean', description: 'Draw the waveform and spectrogram picture. Default: true; false returns the figures alone, to compare many sounds quickly.' },
      show: { type: 'boolean', description: 'Also open the sound in the user\'s Audio panel, ready for them to play. Default: false.' },
    },
    output: {
      schema: REVIEW_SCHEMA,
      render: (_args, value) => renderReview(value),
    },
    timeoutMs: host.measureTimeoutMs + WINDOW_GRACE_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ReviewValue> {
      const agent = exec.agent
      if (agent === undefined) fail('audio_review needs a Session: the window decodes the sound from a Session\'s project.', AUDIO_ERROR.window)
      const window = measuredWindow(args)
      const project = await host.project(exec)
      const target = insideProject(project, args.path)
      const format = audioFormatOf(target.path)
      if (target.path === '' || format === undefined) {
        fail(`${args.path} is not a sound the Audio panel plays. It plays WAV, MP3, Ogg Vorbis and Opus, FLAC, and AIFF files; list them with audio_search.`, AUDIO_ERROR.format)
      }
      const info = await statOf(target.absolute)
      if (info === undefined) fail(`No file at ${target.path} in ${project}. List the project's sounds with audio_search.`, AUDIO_ERROR.missing)
      if (!info.isFile()) fail(`${target.path} is a folder, not a sound. List its sounds with audio_search and folder.`, AUDIO_ERROR.missing)
      const [probe, godot, images] = await Promise.all([
        host.probe(target.absolute, { bytes: info.size, modified: info.mtimeMs }),
        readGodotImport(target.absolute),
        args.picture === false ? Promise.resolve(false) : surface.seesImages(exec),
      ])
      const answer = await host.measure(agent, {
        path: target.path,
        ...window,
        maxSeconds: host.maxReviewSeconds,
        picture: images,
        maxBytes: host.maxPreviewBytes,
      }, exec.signal)
      const kept = answer.picture === undefined ? [] : await surface.keep(exec, answer.picture, nameOf(target.path))
      const { category, source } = audioCategoryOf(target.path, answer.measurements.seconds)
      const shown = args.show === true
      if (shown) host.reveal({ sessionId: agent.id, path: target.path })
      return {
        path: target.path,
        kind: category,
        kindFrom: source,
        bytes: info.size,
        ...probe === undefined ? {} : { probe: asJson(probe) },
        ...godot === undefined ? {} : { godot: asJson(godot) },
        measurements: asJson(answer.measurements),
        ...answer.picture === undefined ? {} : { picture: asJson(answer.picture.layout) },
        images: kept,
        ...args.picture !== false && !images ? { pictureOmitted: true } : {},
        shown,
      }
    },
  })]
}
