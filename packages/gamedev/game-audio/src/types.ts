/**
 * Browser-safe types of the audio tools: what an `audio_review` call asks a WASD Engine window to measure, the
 * measurements and picture the window answers with, and the two forwarded events, the `game-audio/measure` request
 * and the `game-audio/reveal` notification that opens a sound in the window's Audio tab.
 * @module @deepseek-ai/dsh-game-audio/types
 */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AudioImageLayout } from './audio/picture.ts'

/** One measure request as the Host forwards it to a window: JSON fields only. */
export interface AudioMeasureRequest {
  /** Workspace path of the sound: relative to the project folder and `/`-separated. */
  readonly path: string
  /** Seconds from the beginning where the measured window starts. */
  readonly start: number
  /** Seconds from the beginning where it ends; absent for the end of the sound. */
  readonly end?: number
  /** Longest window measured, in seconds; a longer window ends this long after its start. */
  readonly maxSeconds: number
  /** Whether to draw the waveform and spectrogram picture. */
  readonly picture: boolean
  /** Largest file the window reads, in bytes. */
  readonly maxBytes: number
}

/** The `game-audio/measure` request on the Host: the JSON fields, the calling Agent, and the call's cancellation. */
export interface AudioMeasureEvent extends AudioMeasureRequest {
  /** The Agent whose Session's workspace holds the sound; the scope of the request. */
  agent?: Agent
  /** Ends the request when the call ends. */
  signal?: AbortSignal
}

/** Levels of one channel of the measured window, as linear amplitudes where 1 is full scale. */
export interface AudioChannelMeasure {
  readonly peak: number
  readonly rms: number
  readonly dcOffset: number
  /** Samples that reach full scale. */
  readonly clipped: number
}

/** What a window measured in a sound. */
export interface AudioMeasurements {
  /** Samples per second of the decoded sound: the file's own rate. */
  readonly sampleRate: number
  readonly channels: number
  /** Length of the whole decoded sound in seconds. */
  readonly seconds: number
  /** Seconds from the beginning where the measured window starts. */
  readonly start: number
  /** Seconds from the beginning where it ends. */
  readonly end: number
  /** Largest absolute sample of any channel. */
  readonly peak: number
  /** Root mean square over every channel. */
  readonly rms: number
  /** Integrated loudness after ITU-R BS.1770 in LUFS; absent for a window under 0.4 s or without sound above the gates. */
  readonly loudness?: number
  /** Seconds before the first sample above -60 dBFS; the whole window when it is silent. */
  readonly leadingSilence: number
  /** Seconds after the last sample above -60 dBFS. */
  readonly trailingSilence: number
  /** Frequency in Hz of the strongest component of the average spectrum. */
  readonly dominantFrequency?: number
  /** Amplitude-weighted mean frequency in Hz of the average spectrum. */
  readonly spectralCentroid?: number
  readonly channelLevels: readonly AudioChannelMeasure[]
  /** Where the window's end meets its start, as when the sound loops. */
  readonly seam?: {
    /** Largest step of a channel from its last sample to its first, as a fraction of full scale. */
    readonly jump: number
    /** Root mean square of the steps between neighboring samples, of the busiest channel. */
    readonly step: number
    /** RMS level of the last 50 ms minus the first 50 ms, in dB. */
    readonly levelChange?: number
  }
  /** How the two channels of a stereo window relate. */
  readonly stereo?: {
    /** Correlation of left and right, from 1 for the same signal to -1 for opposite phase. */
    readonly correlation?: number
    /** RMS level of left minus right, in dB. */
    readonly balance?: number
    /** Both channels hold the same samples. */
    readonly identical: boolean
  }
}

/** The waveform and spectrogram picture a window drew. */
export interface AudioPicture {
  /** Base64 of the PNG image. */
  readonly data: string
  readonly mediaType: 'image/png'
  /** The picture's panels, size, and grid, which the tool's text describes. */
  readonly layout: AudioImageLayout
}

/** A window's answer to a measure request. */
export interface AudioMeasureResult {
  readonly measurements: AudioMeasurements
  /** The picture, absent when the request asked for none. */
  readonly picture?: AudioPicture
}

/** The `game-audio/reveal` notification: open one sound in a Session's Audio tab. */
export interface AudioReveal {
  readonly sessionId: SessionId
  /** Workspace path of the sound. */
  readonly path: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask the windows that may read a Session to decode one sound of its workspace and measure it as the Audio tab
     * plays it. Return the measurements to claim the request, or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - the sound, the window to measure, the bounds, the calling Agent, and the call's cancellation.
     * @mode waterfall
     */
    'game-audio/measure'(
      this: Scoped<Agent>,
      request: AudioMeasureEvent,
      next: () => Promise<AudioMeasureResult>,
    ): Promise<AudioMeasureResult>
    /**
     * An agent asked to play a sound to the user; the windows that may read the Session open it in the Session's
     * Audio tab.
     * @mode emit
     * @param reveal - the Session and the sound.
     */
    'game-audio/reveal'(reveal: AudioReveal): void
  }
}
