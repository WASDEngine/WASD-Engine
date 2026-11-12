/**
 * The audio formats that WASD Engine's audio tools list, by lowercase file extension, and the kind of game sound a
 * file holds. A file is a sound effect, dialogue, or music by the first word of its name, or of the folders above it
 * from the nearest, that names a kind, such as `sfx`, `voice`, or `music`; a path without such a word is music from
 * {@link MUSIC_MIN_SECONDS} on and a sound effect otherwise.
 *
 * @module
 */

/** How a browser decodes a format: with its own audio decoder, or with {@link decodeAiff} from this module. */
export type AudioDecoder = 'browser' | 'aiff'

/** One listed audio format. */
export interface AudioFormat {
  /** Short display name, such as `WAV`. */
  readonly label: string
  /** Media type of the file, for a browser's decoder. */
  readonly mediaType: string
  readonly decoder: AudioDecoder
}

const WAV: AudioFormat = { label: 'WAV', mediaType: 'audio/wav', decoder: 'browser' }
const OGG: AudioFormat = { label: 'Ogg', mediaType: 'audio/ogg', decoder: 'browser' }
const AIFF: AudioFormat = { label: 'AIFF', mediaType: 'audio/aiff', decoder: 'aiff' }

/** Listed formats by lowercase extension without the dot. */
const FORMATS: Readonly<Record<string, AudioFormat>> = {
  wav: WAV,
  wave: WAV,
  mp3: { label: 'MP3', mediaType: 'audio/mpeg', decoder: 'browser' },
  ogg: OGG,
  oga: OGG,
  opus: { label: 'Opus', mediaType: 'audio/ogg', decoder: 'browser' },
  flac: { label: 'FLAC', mediaType: 'audio/flac', decoder: 'browser' },
  aif: AIFF,
  aiff: AIFF,
  aifc: AIFF,
}

/** Listed extensions, lowercase and without the dot. */
export const AUDIO_EXTENSIONS: readonly string[] = Object.keys(FORMATS)

/**
 * The listed format of a file name or path.
 * @param name - file name or path.
 * @returns the format, or undefined for an extension the tools do not list.
 */
export function audioFormatOf(name: string): AudioFormat | undefined {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? undefined : FORMATS[base.slice(dot + 1).toLowerCase()]
}

/** The kinds of game sound. */
export type AudioCategory = 'effect' | 'dialogue' | 'music'

/** The kinds in the order the tools list them. */
export const AUDIO_CATEGORIES: readonly AudioCategory[] = ['effect', 'dialogue', 'music']

/** Length from which a sound whose path names no kind counts as music, in seconds. */
export const MUSIC_MIN_SECONDS = 30

/** Words of a path that name a kind; a name or folder with words of several kinds takes the first kind here. */
const KIND_WORDS: readonly (readonly [AudioCategory, ReadonlySet<string>])[] = [
  ['dialogue', new Set(['dialogue', 'dialogues', 'dialog', 'dialogs', 'voice', 'voices', 'vo', 'vox', 'voiceover', 'voiceovers', 'speech', 'narration', 'narrator', 'bark', 'barks', 'tts'])],
  ['music', new Set(['music', 'musics', 'bgm', 'ost', 'soundtrack', 'soundtracks', 'song', 'songs', 'jingle', 'jingles'])],
  ['effect', new Set(['sfx', 'fx', 'sound', 'sounds', 'effect', 'effects', 'foley', 'ui', 'ambience', 'ambient', 'amb'])],
]

/** How a file's kind was found: from a word of its path, from its length, or by default without either. */
export type AudioCategorySource = 'name' | 'length' | 'default'

/** The kind of a sound and how it was found. */
export interface AudioCategoryResult {
  readonly category: AudioCategory
  readonly source: AudioCategorySource
}

/**
 * Split a file or folder name into lowercase words at punctuation, spaces, digits, and lower-to-upper case changes,
 * so `MusicLevel1`, `music_level_1`, and `music-level 1` give the same words.
 * @param segment - one file or folder name.
 * @returns the words.
 */
export function pathWords(segment: string): string[] {
  return segment
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter(word => word !== '')
}

/**
 * The kind of a sound.
 * @param path - workspace path of the file, `/`-separated.
 * @param seconds - its length, when known.
 * @returns the kind, from the file name, then its folders from the nearest, then its length.
 */
export function audioCategoryOf(path: string, seconds?: number): AudioCategoryResult {
  const segments = path.split('/').filter(segment => segment !== '')
  const name = segments.pop() ?? ''
  const dot = name.lastIndexOf('.')
  for (const segment of [dot > 0 ? name.slice(0, dot) : name, ...segments.reverse()]) {
    const words = pathWords(segment)
    for (const [category, kindWords] of KIND_WORDS) {
      if (words.some(word => kindWords.has(word))) return { category, source: 'name' }
    }
  }
  if (seconds === undefined) return { category: 'effect', source: 'default' }
  return { category: seconds >= MUSIC_MIN_SECONDS ? 'music' : 'effect', source: 'length' }
}
