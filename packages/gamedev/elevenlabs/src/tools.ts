/**
 * The model-facing ElevenLabs tools: `elevenlabs_voices` finds voices for characters, `elevenlabs_speech` speaks text
 * in one, `elevenlabs_sound_effect` makes a sound effect, and `elevenlabs_music` composes music, each saved as a file
 * in the game project; `elevenlabs_clone_voice` clones a voice from recordings for the account alone, and
 * `elevenlabs_delete_voice` deletes such a clone. The audio comes from the WASD Engine API, which makes it with
 * ElevenLabs and charges the signed-in account's plan. One set of definitions serves one {@link ElevenLabsToolSurface}:
 * the Session's own agent, whose clones the user confirms in WASD Engine's approval prompt, or agents connected through
 * WASD Engine's MCP server, which confirm with their own user.
 * @module @deepseek-ai/dsh-elevenlabs/src/tools
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AudioRequestError, type AudioApi, type CloneSample, type VoiceQuery } from './api.ts'
import { CONSENT_STATEMENT_VERSION } from './consent.ts'
import type { ElevenLabsAudioFormat, ElevenLabsAudioKind } from './types.ts'

/** Longest text one `elevenlabs_speech` call speaks. */
export const MAX_SPEECH_CHARACTERS = 5000

/** Longest prompt of a sound effect or a piece of music. */
export const MAX_PROMPT_CHARACTERS = 2000

/** Voices `elevenlabs_voices` lists when the call names no limit. */
export const DEFAULT_VOICE_LIMIT = 10

/** Most voices one `elevenlabs_voices` call lists. */
export const MAX_VOICE_LIMIT = 30

/** Longest voice description a search result shows. */
const LISTED_DESCRIPTION = 160

/** ElevenLabs' voice ids: letters and digits. */
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/u

/** Most recordings one clone takes. */
export const MAX_CLONE_SAMPLES = 5

/** Largest recording a clone takes, in bytes. */
export const MAX_CLONE_SAMPLE_BYTES = 10 * 1024 * 1024

/** Longest name of a clone. */
export const MAX_CLONE_NAME = 60

/** The media type of each recording a clone takes, by file extension. */
const SAMPLE_TYPES: Readonly<Record<string, string>> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }

/** What came of asking the user to confirm consent for a clone. */
export type CloneConsent = 'confirmed' | 'declined' | 'cancelled' | 'unavailable'

/** How one set of tool definitions reaches its callers. */
export interface ElevenLabsToolSurface {
  /** How the `path` parameter describes the file a call writes to these callers. */
  readonly pathDescription: string
  /** How the `samples` parameter describes the recordings a clone reads to these callers. */
  readonly samplesDescription: string
  /** Where these callers confirm consent to a clone: in WASD Engine (`app`) or with a connected agent's user (`mcp`). */
  readonly consentChannel: 'app' | 'mcp'
  /** How the clone tool's description tells these callers that the user confirms consent. */
  readonly consentInstruction: string
  /**
   * Have the user confirm the consent statement for one clone.
   * @param exec - the call's execution.
   * @param name - the clone's name.
   * @param files - the recordings' file names.
   * @returns what came of it.
   */
  confirmClone(exec: ToolRunContext, name: string, files: readonly string[]): Promise<CloneConsent>
}

/** The model of each kind of audio, as results name it. */
const MODEL_NAME: Readonly<Record<ElevenLabsAudioKind, string>> = {
  'speech': 'Eleven v4 Turbo',
  'sound-effects': 'SFX v3',
  'music': 'Music v2.5',
}

/** What the tools need from the plugin. */
export interface ElevenLabsToolHost {
  /** The WASD Engine audio API. */
  readonly api: AudioApi
  /** Time limit of one voice search in milliseconds. */
  readonly searchTimeoutMs: number
  /** Time limit of one speech or sound effect call in milliseconds. */
  readonly generationTimeoutMs: number
  /** Time limit of one music call in milliseconds. */
  readonly musicTimeoutMs: number
  /**
   * The file one call writes.
   * @param requested - the path the call names: absolute, or relative to the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute path.
   */
  file(requested: string, exec: ToolRunContext): Promise<string>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const FORMAT = { type: 'string', enum: ['mp3', 'wav'], required: true } as const

const VOICES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: STRING,
    source: { type: 'string', enum: ['library', 'default', 'mine'], required: true },
    filters: { type: 'array', required: true, items: { type: 'string' }, description: 'The label filters of the search, such as "male" or "british".' },
    page: INTEGER,
    hasMore: BOOLEAN,
    voices: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          voiceId: STRING, name: STRING, description: STRING, gender: STRING, age: STRING, accent: STRING, language: STRING,
          useCase: STRING, previewUrl: STRING,
        },
      },
    },
  },
} as const

const FILE_PROPERTIES = {
  path: { type: 'string', required: true, description: 'Absolute path of the file written.' },
  file: { type: 'string', required: true, description: 'The path as the call named it.' },
  format: FORMAT,
  durationMs: INTEGER,
  bytes: INTEGER,
  replaced: BOOLEAN,
} as const

/** The fields every generated file reports. */
const FILE_SCHEMA = { type: 'object', additionalProperties: false, properties: FILE_PROPERTIES } as const

const SPEECH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...FILE_PROPERTIES, voiceId: STRING, characters: INTEGER },
} as const

const SOUND_EFFECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...FILE_PROPERTIES, loop: BOOLEAN },
} as const

const MUSIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...FILE_PROPERTIES, instrumental: BOOLEAN },
} as const

const CLONE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    voiceId: STRING,
    name: STRING,
    samples: { type: 'array', required: true, items: { type: 'string' }, description: 'The recordings, as the call named them.' },
    clonesUsed: INTEGER,
    clonesAllowed: INTEGER,
  },
} as const

const DELETED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { voiceId: STRING, name: STRING, clonesUsed: INTEGER, clonesAllowed: INTEGER },
} as const

/** The value of `elevenlabs_voices`. */
type VoicesValue = InferValue<typeof VOICES_SCHEMA>

/** The fields every generated file reports. */
type FileValue = InferValue<typeof FILE_SCHEMA>

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function kilobytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`
}

/**
 * Check an optional number from the model.
 * @throws Error when it is not within the range.
 */
function inRange(value: number | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be from ${min} to ${max}.`)
  return value
}

function checkedText(value: string, name: string, max: number): string {
  if (value.trim() === '') throw new Error(`${name} must not be empty.`)
  if (value.length > max) throw new Error(`${name} must be at most ${max} characters; it has ${value.length}. Split it into several calls.`)
  return value
}

function checkedLanguage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const language = value.trim().toLowerCase()
  if (!/^[a-z]{2,3}$/u.test(language)) throw new Error('language must be an ISO 639-1 code, such as "en" or "ja".')
  return language
}

/**
 * The file type of a path, from its extension.
 * @throws Error when the extension is not one of `allowed`.
 */
function formatOf(path: string, allowed: readonly ElevenLabsAudioFormat[]): ElevenLabsAudioFormat {
  const extension = extname(path).toLowerCase().slice(1)
  const format = allowed.find(candidate => candidate === extension)
  if (format === undefined) throw new Error(`path must end in ${allowed.map(candidate => `.${candidate}`).join(' or ')}; it names the file type.`)
  return format
}

/**
 * Whether a path holds a file, refusing one the call may not replace.
 * @throws Error when the path is a folder, or a file and `replace` is false.
 */
async function existing(path: string, file: string, replace: boolean): Promise<boolean> {
  let found
  try {
    found = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!found.isFile()) throw new Error(`${file} is a folder; pass the path of a file.`)
  if (!replace) throw new Error(`${file} already exists. Pass replace: true to overwrite it, or choose another path.`)
  return true
}

/** Write a file in place of any earlier one, through a temporary file beside it. */
async function writeAudio(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.part`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Make one audio file and save it: the target is checked before the paid request, so a refused path costs nothing.
 * @returns the fields every generated file reports.
 */
async function generateFile(
  host: ElevenLabsToolHost,
  kind: ElevenLabsAudioKind,
  file: string,
  format: ElevenLabsAudioFormat,
  replace: boolean,
  body: Readonly<Record<string, unknown>>,
  exec: ToolRunContext,
): Promise<FileValue> {
  const path = await host.file(file, exec)
  const replaced = await existing(path, file, replace)
  const audio = await host.api.generate(kind, { ...body, format }, exec.signal)
  await writeAudio(path, audio.data)
  return { path, file, format, durationMs: audio.durationMs, bytes: audio.data.byteLength, replaced }
}

function saved(value: FileValue): string {
  return `${value.file} (${kilobytes(value.bytes)}${value.replaced ? ', replaced' : ''})`
}

/** Text cut at a word boundary to at most `limit` characters, with an ellipsis when cut. */
function shortened(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, '')}…`
}

function renderVoices(value: VoicesValue): string {
  const where = { library: 'ElevenLabs Voice Library voices', default: 'ElevenLabs default voices', mine: 'Voices this account cloned' }[value.source]
  const what = [...value.query === '' ? [] : [`for ${JSON.stringify(value.query)}`], ...value.filters.length === 0 ? [] : [`(${value.filters.join(', ')})`]].join(' ')
  const lines = [`${where}${what === '' ? '' : ` ${what}`}, page ${value.page}:`]
  if (value.voices.length === 0) {
    lines.push(value.page > 0 ? 'No more voices; pass a smaller page.' : value.source === 'mine' ? 'None; elevenlabs_clone_voice clones one.' : 'No voices match; try other words or fewer filters.')
  }
  for (const voice of value.voices) {
    const labels = [voice.gender, voice.age, voice.accent, voice.language, voice.useCase].filter(label => label !== '').join(', ')
    const description = shortened(voice.description, LISTED_DESCRIPTION)
    lines.push(`- ${voice.voiceId}: ${voice.name}${labels === '' ? '' : ` (${labels})`}.${description === '' ? '' : ` ${description}`}`)
  }
  if (value.hasMore) lines.push(`More: pass page ${value.page + 1}.`)
  lines.push('Pass a voice_id to elevenlabs_speech. Give each character one voice and keep using it.')
  return lines.join('\n')
}

/**
 * Read the recordings of one clone.
 * @throws Error when one is missing, too large, or not a WAV or MP3 file.
 */
async function readSamples(host: ElevenLabsToolHost, requested: readonly string[], exec: ToolRunContext): Promise<CloneSample[]> {
  if (requested.length < 1 || requested.length > MAX_CLONE_SAMPLES) throw new Error(`samples must name 1 to ${MAX_CLONE_SAMPLES} recordings.`)
  const samples: CloneSample[] = []
  for (const file of requested) {
    const type = SAMPLE_TYPES[extname(file).toLowerCase()]
    if (type === undefined) throw new Error(`${file} must be a .wav or .mp3 recording.`)
    const path = await host.file(file, exec)
    let size: number
    try {
      const found = await stat(path)
      if (!found.isFile()) throw new Error(`${file} is not a file.`)
      size = found.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} does not exist.`, { cause: error })
      throw error
    }
    if (size > MAX_CLONE_SAMPLE_BYTES) throw new Error(`${file} is larger than ${MAX_CLONE_SAMPLE_BYTES / (1024 * 1024)} MB; trim it or save it as MP3.`)
    samples.push({ name: basename(file), type, data: await readFile(path) })
  }
  return samples
}

/** Refuse a clone the user did not confirm. */
function consentFailure(consent: Exclude<CloneConsent, 'confirmed'>): Error {
  switch (consent) {
    case 'declined': return new Error('The user did not confirm consent to clone this voice, so nothing was cloned. Ask before trying again.')
    case 'cancelled': return new Error('The consent question was cancelled, so nothing was cloned.')
    case 'unavailable': return new Error('WASD Engine cannot ask the user to confirm consent here, so nothing was cloned.')
    default: return assertNever(consent)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`)
}

/**
 * Build the ElevenLabs tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how these definitions reach their callers.
 * @returns the definitions, not registered.
 */
export function elevenLabsToolDefinitions(host: ElevenLabsToolHost, surface: ElevenLabsToolSurface): ToolDefinition[] {
  const pathDescription = surface.pathDescription
  const replaceParameter = { type: 'boolean', description: 'Overwrite the file when it exists. Default: false.' } as const
  return [defineTool({
    name: 'elevenlabs_voices',
    description: 'Find ElevenLabs voices for game characters, narrators, and announcers. Searches ElevenLabs\' Voice Library of thousands of voices by description, such as "gruff dwarf blacksmith", "old British wizard", or "cheerful robot", and by gender, age, accent, language, and use case; lists ElevenLabs\' default voices (source "default"); or lists the voices this account cloned (source "mine"). Lists each voice\'s id, name, labels, and description. Free.',
    parameters: {
      query: { type: 'string', description: 'Words that describe the voice. Default: the most used voices.' },
      source: { type: 'string', enum: ['library', 'default', 'mine'], description: 'library: the Voice Library; default: ElevenLabs\' default voices; mine: the voices this account cloned. Default: library.' },
      gender: { type: 'string', enum: ['male', 'female', 'neutral'] },
      age: { type: 'string', enum: ['young', 'middle_aged', 'old'] },
      accent: { type: 'string', description: 'Accent label, such as "american", "british", or "australian".' },
      language: { type: 'string', description: 'ISO 639-1 language code, such as "en" or "ja".' },
      use_case: { type: 'string', description: 'Use case label, such as "characters_animation", "narrative_story", "conversational", or "entertainment_tv".' },
      page: { type: 'integer', description: 'Page to list, from 0. Default: 0.' },
      limit: { type: 'integer', description: `Most voices, from 1 to ${MAX_VOICE_LIMIT}. Default: ${DEFAULT_VOICE_LIMIT}.` },
    },
    output: {
      schema: VOICES_SCHEMA,
      render: (_args, value) => textBlocks(renderVoices(value)),
    },
    timeoutMs: host.searchTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const page = args.page ?? 0
      if (!Number.isInteger(page) || page < 0 || page > 100) throw new Error('page must be an integer from 0 to 100.')
      const limit = args.limit ?? DEFAULT_VOICE_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VOICE_LIMIT) throw new Error(`limit must be an integer from 1 to ${MAX_VOICE_LIMIT}.`)
      const query = args.query?.trim() ?? ''
      const accent = args.accent?.trim().toLowerCase()
      const useCase = args.use_case?.trim().toLowerCase()
      const language = checkedLanguage(args.language)
      const search: VoiceQuery = {
        source: args.source ?? 'library',
        page,
        page_size: limit,
        ...query === '' ? {} : { query },
        ...args.gender === undefined ? {} : { gender: args.gender },
        ...args.age === undefined ? {} : { age: args.age },
        ...accent === undefined || accent === '' ? {} : { accent },
        ...language === undefined ? {} : { language },
        ...useCase === undefined || useCase === '' ? {} : { use_case: useCase },
      }
      const found = await host.api.voices(search, exec.signal)
      return {
        query,
        source: found.source,
        filters: [search.gender, search.age, search.accent, search.language, search.use_case]
          .filter((filter): filter is string => filter !== undefined),
        page: found.page,
        hasMore: found.hasMore,
        voices: found.voices.map(voice => ({ ...voice })),
      }
    },
  }), defineTool({
    name: 'elevenlabs_speech',
    description: 'Speak text in an ElevenLabs voice with Eleven v4 Turbo and save it as an .mp3 or .wav file, for character dialogue, narration, and announcer lines. Find a voice_id with elevenlabs_voices, and make one file per line. Audio tags in square brackets direct the delivery, such as [whispers], [laughs], [shouting], or [sarcastic]. Each call costs AI usage from the user\'s WASD Engine plan by its characters, so save and reuse lines instead of speaking them again.',
    parameters: {
      text: { type: 'string', required: true, description: `What to say, at most ${MAX_SPEECH_CHARACTERS} characters.` },
      voice_id: { type: 'string', required: true, description: 'Voice id from elevenlabs_voices.' },
      path: { type: 'string', required: true, description: `${pathDescription} Ends in .mp3 or .wav.` },
      language: { type: 'string', description: 'ISO 639-1 code of the text\'s language, such as "en" or "ja". Default: detected.' },
      speed: { type: 'number', description: 'From 0.7 (slower) to 1.2 (faster). Default: the voice\'s own.' },
      stability: { type: 'number', description: 'From 0 (more expressive) to 1 (steadier). Default: the voice\'s own.' },
      similarity: { type: 'number', description: 'From 0 to 1: how closely to keep the original voice. Default: the voice\'s own.' },
      style: { type: 'number', description: 'From 0 to 1: how much to exaggerate the voice\'s style. Default: the voice\'s own.' },
      seed: { type: 'integer', description: 'From 0 to 4294967295, for similar results across calls.' },
      previous_text: { type: 'string', description: 'The line spoken before this one, so the delivery continues it.' },
      next_text: { type: 'string', description: 'The line spoken after this one, so the delivery leads into it.' },
      replace: replaceParameter,
    },
    output: {
      schema: SPEECH_SCHEMA,
      render: (_args, value) => textBlocks(`Saved ${seconds(value.durationMs)} of speech in voice ${value.voiceId} (${MODEL_NAME.speech}, ${value.characters} characters) to ${saved(value)}.`),
    },
    timeoutMs: host.generationTimeoutMs,
    async execute(args, exec) {
      const text = checkedText(args.text, 'text', MAX_SPEECH_CHARACTERS)
      const voiceId = args.voice_id.trim()
      if (!VOICE_ID_PATTERN.test(voiceId)) throw new Error(`${JSON.stringify(args.voice_id)} is not an ElevenLabs voice id; ids are like "JBFqnCBsd6RMkjVDRZzb", as elevenlabs_voices lists them.`)
      if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 4_294_967_295)) throw new Error('seed must be an integer from 0 to 4294967295.')
      const body = {
        text,
        voice_id: voiceId,
        ...optional('language', checkedLanguage(args.language)),
        ...optional('speed', inRange(args.speed, 'speed', 0.7, 1.2)),
        ...optional('stability', inRange(args.stability, 'stability', 0, 1)),
        ...optional('similarity', inRange(args.similarity, 'similarity', 0, 1)),
        ...optional('style', inRange(args.style, 'style', 0, 1)),
        ...optional('seed', args.seed),
        ...optional('previous_text', args.previous_text?.slice(0, 1000)),
        ...optional('next_text', args.next_text?.slice(0, 1000)),
      }
      const value = await generateFile(host, 'speech', args.path, formatOf(args.path, ['mp3', 'wav']), args.replace === true, body, exec)
      return { ...value, voiceId, characters: text.length }
    },
  }), defineTool({
    name: 'elevenlabs_sound_effect',
    description: 'Make a sound effect from a description with ElevenLabs SFX v3 and save it as a .wav file, best for effects, or an .mp3 file, such as "sword strikes a wooden shield", "8-bit coin pickup", "footsteps on gravel", or "rain on a tin roof". Set duration_seconds for a fixed length, or leave it for ElevenLabs to choose; set loop for ambience and hums that repeat without a seam. Each call costs AI usage from the user\'s WASD Engine plan by the length of the sound.',
    parameters: {
      prompt: { type: 'string', required: true, description: `What the sound is, at most ${MAX_PROMPT_CHARACTERS} characters.` },
      path: { type: 'string', required: true, description: `${pathDescription} Ends in .wav or .mp3.` },
      duration_seconds: { type: 'number', description: 'Length from 0.5 to 30 seconds. Default: ElevenLabs chooses.' },
      loop: { type: 'boolean', description: 'Make a sound that loops without a seam. Default: false.' },
      prompt_influence: { type: 'number', description: 'From 0 (freer) to 1 (closer to the prompt). Default: 0.3.' },
      replace: replaceParameter,
    },
    output: {
      schema: SOUND_EFFECT_SCHEMA,
      render: (_args, value) => textBlocks([
        `Saved a ${seconds(value.durationMs)} sound effect (${MODEL_NAME['sound-effects']}${value.loop ? ', looping' : ''}) to ${saved(value)}.`,
        ...value.loop ? [`To loop it in Godot, set ${value.format === 'wav' ? 'edit/loop_mode=2' : 'loop=true'} under [params] in its .import file once Godot has imported it.`] : [],
      ].join('\n')),
    },
    timeoutMs: host.generationTimeoutMs,
    async execute(args, exec) {
      const prompt = checkedText(args.prompt, 'prompt', MAX_PROMPT_CHARACTERS)
      const loop = args.loop === true
      const body = {
        prompt,
        loop,
        ...optional('duration_seconds', inRange(args.duration_seconds, 'duration_seconds', 0.5, 30)),
        ...optional('prompt_influence', inRange(args.prompt_influence, 'prompt_influence', 0, 1)),
      }
      const value = await generateFile(host, 'sound-effects', args.path, formatOf(args.path, ['wav', 'mp3']), args.replace === true, body, exec)
      return { ...value, loop }
    },
  }), defineTool({
    name: 'elevenlabs_music',
    description: 'Compose music from a description with ElevenLabs Music v2.5 and save it as an .mp3 file: genre, mood, instruments, tempo, and structure, such as "tense orchestral boss battle, driving strings and brass, 150 BPM". Set duration_seconds, and instrumental for background music without vocals. ElevenLabs refuses prompts that name artists or songs, and suggests another prompt. Each call costs AI usage from the user\'s WASD Engine plan by the length of the music, more than speech or sound effects, so keep pieces as short as the game needs.',
    parameters: {
      prompt: { type: 'string', required: true, description: `What the music is, at most ${MAX_PROMPT_CHARACTERS} characters.` },
      path: { type: 'string', required: true, description: `${pathDescription} Ends in .mp3.` },
      duration_seconds: { type: 'number', description: 'Length from 3 to 300 seconds. Default: ElevenLabs chooses.' },
      instrumental: { type: 'boolean', description: 'Leave out vocals. Default: false.' },
      replace: replaceParameter,
    },
    output: {
      schema: MUSIC_SCHEMA,
      render: (_args, value) => textBlocks(`Saved ${seconds(value.durationMs)} of music (${MODEL_NAME.music}${value.instrumental ? ', instrumental' : ''}) to ${saved(value)}. To repeat it in Godot, set loop=true under [params] in its .import file once Godot has imported it.`),
    },
    timeoutMs: host.musicTimeoutMs,
    async execute(args, exec) {
      const prompt = checkedText(args.prompt, 'prompt', MAX_PROMPT_CHARACTERS)
      const instrumental = args.instrumental === true
      const body = { prompt, instrumental, ...optional('duration_seconds', inRange(args.duration_seconds, 'duration_seconds', 3, 300)) }
      const value = await generateFile(host, 'music', args.path, formatOf(args.path, ['mp3']), args.replace === true, body, exec)
      return { ...value, instrumental }
    },
  }), defineTool({
    name: 'elevenlabs_clone_voice',
    description: `Clone a voice from 1 to ${MAX_CLONE_SAMPLES} .wav or .mp3 recordings of one speaker, 10 seconds to 5 minutes in all and best 1 to 2 minutes of clear speech without music or noise, as a new voice that only this WASD Engine account can use. Clone only the user's own voice or a voice whose speaker gave the user express permission: ${surface.consentInstruction}. Needs a WASD Engine Pro or Max plan, which keeps up to 3 cloned voices; cloning itself costs nothing, and speech in the voice costs like any voice. Pass the new voice_id to elevenlabs_speech.`,
    parameters: {
      name: { type: 'string', required: true, description: `Name of the voice, at most ${MAX_CLONE_NAME} characters, such as "Captain Rhea".` },
      samples: { type: 'array', required: true, items: { type: 'string' }, description: `${surface.samplesDescription} Each .wav or .mp3, at most ${MAX_CLONE_SAMPLE_BYTES / (1024 * 1024)} MB.` },
      description: { type: 'string', description: 'What the voice sounds like, at most 500 characters.' },
      remove_background_noise: { type: 'boolean', description: 'Clean background noise from the recordings first; it can hurt clean recordings. Default: false.' },
    },
    output: {
      schema: CLONE_SCHEMA,
      render: (_args, value) => textBlocks([
        `Cloned the voice ${JSON.stringify(value.name)} as voice ${value.voiceId} from ${value.samples.length === 1 ? '1 recording' : `${value.samples.length} recordings`} (${value.samples.join(', ')}). Pass it as voice_id to elevenlabs_speech; only this account can use it.`,
        `Cloned voices in use: ${value.clonesUsed} of ${value.clonesAllowed}; elevenlabs_delete_voice frees one.`,
      ].join('\n')),
    },
    timeoutMs: host.generationTimeoutMs,
    async execute(args, exec) {
      const name = args.name.trim()
      if (name === '' || name.length > MAX_CLONE_NAME) throw new Error(`name must be 1 to ${MAX_CLONE_NAME} characters.`)
      const description = args.description?.trim()
      if (description !== undefined && description.length > 500) throw new Error('description must be at most 500 characters.')
      const samples = await readSamples(host, args.samples, exec)
      const consent = await surface.confirmClone(exec, name, samples.map(sample => sample.name))
      if (consent !== 'confirmed') throw consentFailure(consent)
      let clone
      try {
        clone = await host.api.cloneVoice({
          name,
          ...description === undefined || description === '' ? {} : { description },
          removeBackgroundNoise: args.remove_background_noise === true,
          consentStatement: CONSENT_STATEMENT_VERSION,
          consentChannel: surface.consentChannel,
          samples,
        }, exec.signal)
      } catch (error) {
        if (error instanceof AudioRequestError && error.status === 409) {
          throw new AudioRequestError(`${error.message} elevenlabs_voices with source "mine" lists this account's cloned voices, and elevenlabs_delete_voice deletes one.`, 409)
        }
        throw error
      }
      return {
        voiceId: clone.voiceId, name: clone.name, samples: [...args.samples],
        clonesUsed: clone.clonesUsed, clonesAllowed: clone.clonesAllowed,
      }
    },
  }), defineTool({
    name: 'elevenlabs_delete_voice',
    description: 'Delete a voice this account cloned with elevenlabs_clone_voice, which frees its place for another clone. Audio already made with it keeps playing, but no new speech can use it. elevenlabs_voices with source "mine" lists the cloned voices.',
    parameters: {
      voice_id: { type: 'string', required: true, description: 'The cloned voice\'s id.' },
    },
    output: {
      schema: DELETED_SCHEMA,
      render: (_args, value) => textBlocks(`Deleted the cloned voice ${JSON.stringify(value.name)} (${value.voiceId}). Cloned voices in use: ${value.clonesUsed} of ${value.clonesAllowed}.`),
    },
    timeoutMs: host.searchTimeoutMs,
    async execute(args, exec) {
      const voiceId = args.voice_id.trim()
      if (!VOICE_ID_PATTERN.test(voiceId)) throw new Error(`${JSON.stringify(args.voice_id)} is not an ElevenLabs voice id.`)
      const deleted = await host.api.deleteVoice(voiceId, exec.signal)
      return { voiceId: deleted.voiceId, name: deleted.name, clonesUsed: deleted.clonesUsed, clonesAllowed: deleted.clonesAllowed }
    },
  })]
}

/** A one-field object for a defined value, else an empty one. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
