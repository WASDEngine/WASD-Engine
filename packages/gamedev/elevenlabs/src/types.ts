/**
 * Types of the ElevenLabs plugin: the voices a search lists and the audio a generation returns.
 * @module @deepseek-ai/dsh-elevenlabs/src/types
 */

/** Where a voice search looks: ElevenLabs' Voice Library, its default voices, or the account's own clones. */
export type ElevenLabsVoiceSource = 'library' | 'default' | 'mine'

/** One voice as a search lists it. */
export interface ElevenLabsVoice {
  /** The id that `elevenlabs_speech` takes. */
  readonly voiceId: string
  /** Display name, such as `George - Warm, Captivating Storyteller`. */
  readonly name: string
  /** The owner's description; may be empty. */
  readonly description: string
  /** Label values; each may be empty. */
  readonly gender: string
  readonly age: string
  readonly accent: string
  readonly language: string
  readonly useCase: string
  /** URL of a sample recording; may be empty. */
  readonly previewUrl: string
}

/** One page of a voice search. */
export interface ElevenLabsVoicePage {
  readonly source: ElevenLabsVoiceSource
  readonly page: number
  readonly voices: readonly ElevenLabsVoice[]
  /** Whether a later page holds more voices. */
  readonly hasMore: boolean
}

/** The file types the plugin writes. */
export type ElevenLabsAudioFormat = 'mp3' | 'wav'

/** The kinds of audio the plugin makes, by WASD Engine API route. */
export type ElevenLabsAudioKind = 'speech' | 'sound-effects' | 'music'

/** One generated audio file. */
export interface ElevenLabsAudio {
  readonly data: Buffer
  /** Length of the audio in milliseconds, as WASD Engine measured it. */
  readonly durationMs: number
}

/** A clone, or a deleted one, and how many clones the account keeps. */
export interface ElevenLabsCloneChange {
  /** The voice id `elevenlabs_speech` takes. */
  readonly voiceId: string
  readonly name: string
  /** Clones the account keeps now. */
  readonly clonesUsed: number
  /** Most clones the account may keep. */
  readonly clonesAllowed: number
}

/** A new clone. */
export type ElevenLabsClone = ElevenLabsCloneChange
