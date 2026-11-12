/**
 * Decoding a sound in the browser and measuring it as the agent's `audio_review` reports it. WAV, MP3, Ogg Vorbis and
 * Opus, and FLAC files decode with the browser's own decoder through an OfflineAudioContext at the file's own sample
 * rate, so the samples are not resampled; AIFF files, which browsers do not decode, use the audio tools' AIFF reader,
 * which fills the AudioBuffer a slice at a time so a long file neither holds a second copy nor blocks the page. The
 * picture is the one the audio tools draw, encoded as PNG on a canvas.
 */
import {
  analyzeAudio, AUDIO_ERROR, drawAudioImage, loopSeam, openAiff, stereoImage, type AudioFormat, type AudioSamples, type RgbImage,
} from '@deepseek-ai/dsh-game-audio/audio'
import type { AudioMeasurements, AudioPicture } from '@deepseek-ai/dsh-game-audio/types'

/** A failure of decoding or measuring a sound, with the audio tools' error code. */
export class SoundError extends Error {
  /**
   * @param message - what went wrong, for the agent.
   * @param code - one of the audio tools' error codes, `AUDIO_ERROR`.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SoundError'
  }
}

/** Sample rates an OfflineAudioContext accepts, and the rate of a file whose headers name none. */
const LOWEST_RATE = 3000
const HIGHEST_RATE = 768_000
const DEFAULT_RATE = 48_000

/** Most channels an AudioBuffer holds. */
const MAX_CHANNELS = 32

/** Samples, over all channels, that an AIFF decode copies before it lets the page handle its events. */
const AIFF_SLICE_SAMPLES = 1 << 20

/** What a decode may cost: the longest sound it decodes, and its cancellation. */
export interface DecodeBounds {
  /** Longest sound in seconds; a longer AIFF file is refused before its samples are copied. */
  readonly maxSeconds: number
  /** Ends the decode: an AIFF decode stops at its next slice, a browser decode before and after it runs. */
  readonly signal: AbortSignal
}

/**
 * Wait for the page to handle its pending events.
 * @returns settles on a later turn of the event loop.
 */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Decode an AIFF file into an AudioBuffer, a slice of samples at a time, after checking that the buffer can hold it.
 * @param data - the complete file.
 * @param bounds - the longest sound and the cancellation.
 * @returns the decoded sound.
 * @throws {SoundError} `AUDIO_UNREADABLE` for a channel count or rate an AudioBuffer cannot hold, `AUDIO_TOO_LARGE`
 * for a sound longer than the bound; the signal's reason when it ends the decode.
 */
async function decodeAiffSound(data: Uint8Array<ArrayBuffer>, bounds: DecodeBounds): Promise<AudioBuffer> {
  const sound = openAiff(data)
  if (sound.channels > MAX_CHANNELS) throw new SoundError(`The AIFF file has ${String(sound.channels)} channels, more than the ${String(MAX_CHANNELS)} the Audio panel plays.`, AUDIO_ERROR.unreadable)
  if (!(sound.sampleRate >= LOWEST_RATE && sound.sampleRate <= HIGHEST_RATE)) {
    throw new SoundError(`The AIFF file's sample rate, ${String(sound.sampleRate)} Hz, is outside the ${String(LOWEST_RATE)} to ${String(HIGHEST_RATE)} Hz the Audio panel plays.`, AUDIO_ERROR.unreadable)
  }
  if (sound.frames / sound.sampleRate > bounds.maxSeconds) throw tooLong('The AIFF file', sound.frames / sound.sampleRate, bounds.maxSeconds)
  const buffer = new AudioBuffer({ length: Math.max(1, sound.frames), numberOfChannels: sound.channels, sampleRate: sound.sampleRate })
  const sliceFrames = Math.max(1, Math.floor(AIFF_SLICE_SAMPLES / sound.channels))
  for (let first = 0; first < sound.frames; first += sliceFrames) {
    bounds.signal.throwIfAborted()
    const last = Math.min(sound.frames, first + sliceFrames)
    for (let channel = 0; channel < sound.channels; channel++) {
      const plane = buffer.getChannelData(channel)
      for (let frame = first; frame < last; frame++) plane[frame] = sound.sample(frame, channel)
    }
    if (last < sound.frames) await yieldToEvents()
  }
  return buffer
}

/**
 * The failure of a sound longer than a window decodes.
 * @param name - what the message names: the sound's path, or its kind of file.
 * @param seconds - its length.
 * @param maxSeconds - the longest sound a window decodes.
 * @returns the error, `AUDIO_TOO_LARGE`.
 */
export function tooLong(name: string, seconds: number, maxSeconds: number): SoundError {
  return new SoundError(`${name} is ${seconds.toFixed(1)} s long, longer than the ${String(maxSeconds)} s a WASD Engine window decodes, so it cannot be measured.`, AUDIO_ERROR.tooLarge)
}

/**
 * Decode a sound file.
 * @param data - the complete file.
 * @param format - its listed format.
 * @param sampleRate - the rate its headers name, which the decoded samples keep.
 * @param bounds - the longest sound and the cancellation.
 * @returns the decoded sound.
 * @throws {SoundError} `AUDIO_UNREADABLE` when the file does not decode, `AUDIO_TOO_LARGE` for an AIFF sound longer than
 * the bound; the signal's reason when it ends the decode.
 */
export async function decodeSound(
  data: Uint8Array<ArrayBuffer>,
  format: AudioFormat,
  sampleRate: number | undefined,
  bounds: DecodeBounds,
): Promise<AudioBuffer> {
  bounds.signal.throwIfAborted()
  try {
    if (format.decoder === 'aiff') return await decodeAiffSound(data, bounds)
    const rate = sampleRate !== undefined && sampleRate >= LOWEST_RATE && sampleRate <= HIGHEST_RATE ? Math.round(sampleRate) : DEFAULT_RATE
    const context = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate })
    // decodeAudioData takes over the buffer it is given, so it receives a copy.
    const decoded = await context.decodeAudioData(data.slice().buffer)
    bounds.signal.throwIfAborted()
    return decoded
  } catch (error) {
    if (bounds.signal.aborted || error instanceof SoundError) throw error
    // decodeAudioData rejects with a DOMException, which is not an Error in every browser.
    const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
    const reason = typeof message === 'string' && message !== '' ? ` (${message})` : ''
    throw new SoundError(`The ${format.label} file could not be decoded${reason}: it may be damaged or use an encoding this browser does not decode.`, AUDIO_ERROR.unreadable)
  }
}

/**
 * Interleave the frames between two indices of a decoded sound.
 * @param buffer - the decoded sound.
 * @param first - first frame.
 * @param last - frame after the last.
 * @returns the samples.
 */
export function interleave(buffer: AudioBuffer, first: number, last: number): AudioSamples {
  const channels = buffer.numberOfChannels
  const frames = Math.max(0, last - first)
  const samples = new Float32Array(frames * channels)
  for (let channel = 0; channel < channels; channel++) {
    const plane = buffer.getChannelData(channel)
    for (let frame = 0; frame < frames; frame++) samples[frame * channels + channel] = plane[first + frame] ?? 0
  }
  return { sampleRate: buffer.sampleRate, channels, frames, samples }
}

/** One measured window: its measurements and its samples, for the picture. */
export interface MeasuredWindow {
  readonly measurements: AudioMeasurements
  readonly samples: AudioSamples
}

/**
 * Measure a window of a decoded sound.
 * @param buffer - the decoded sound.
 * @param start - seconds from the beginning where the window starts.
 * @param end - seconds where it ends; the end of the sound when absent or later.
 * @param maxSeconds - longest window; a longer one ends this long after its start.
 * @returns the measurements and the window's samples.
 * @throws {SoundError} `AUDIO_ARGUMENT` when the window starts at or after the end of the sound.
 */
export function measureSound(buffer: AudioBuffer, start: number, end: number | undefined, maxSeconds: number): MeasuredWindow {
  const seconds = buffer.length / buffer.sampleRate
  if (start > 0 && start >= seconds) {
    throw new SoundError(`start (${start.toFixed(3)} s) is not before the end of the sound, which is ${seconds.toFixed(3)} s long.`, AUDIO_ERROR.argument)
  }
  const from = Math.max(0, start)
  const to = Math.min(end ?? seconds, seconds, from + maxSeconds)
  const first = Math.round(from * buffer.sampleRate)
  const samples = interleave(buffer, first, Math.max(first, Math.round(to * buffer.sampleRate)))
  const analysis = analyzeAudio(samples)
  const seam = loopSeam(samples)
  const stereo = stereoImage(samples)
  const measurements: AudioMeasurements = {
    // An AIFF file may state a rate with a fraction, which the decoded samples keep; the figures name whole hertz.
    sampleRate: Math.round(buffer.sampleRate),
    channels: buffer.numberOfChannels,
    seconds,
    start: from,
    end: from + samples.frames / buffer.sampleRate,
    peak: analysis.peak,
    rms: analysis.rms,
    ...analysis.loudness === undefined ? {} : { loudness: analysis.loudness },
    leadingSilence: analysis.leadingSilence,
    trailingSilence: analysis.trailingSilence,
    ...analysis.dominantFrequency === undefined ? {} : { dominantFrequency: analysis.dominantFrequency },
    ...analysis.spectralCentroid === undefined ? {} : { spectralCentroid: analysis.spectralCentroid },
    channelLevels: analysis.channels.map(level => ({ peak: level.peak, rms: level.rms, dcOffset: level.dcOffset, clipped: level.clipped })),
    ...seam === undefined ? {} : {
      seam: { jump: seam.jump, step: seam.step, ...seam.levelChange === undefined ? {} : { levelChange: seam.levelChange } },
    },
    ...stereo === undefined ? {} : {
      stereo: {
        identical: stereo.identical,
        ...stereo.correlation === undefined ? {} : { correlation: stereo.correlation },
        ...stereo.balance === undefined ? {} : { balance: stereo.balance },
      },
    },
  }
  return { measurements, samples }
}

/**
 * Base64 of bytes.
 * @param bytes - the bytes.
 * @returns the base64 text.
 */
function base64(bytes: Uint8Array): string {
  let text = ''
  // Chunks keep each String.fromCharCode call within the engine's argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(text)
}

/**
 * Encode an RGB image as PNG through a canvas.
 * @param image - the image.
 * @returns the PNG file bytes.
 * @throws {SoundError} `AUDIO_MEASURE` when the browser cannot draw or encode it.
 */
async function encodePng(image: RgbImage): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (context === null) throw new SoundError('This WASD Engine window cannot draw the picture.', AUDIO_ERROR.measure)
  const pixels = context.createImageData(image.width, image.height)
  for (let index = 0, at = 0; index < image.pixels.length; index += 3, at += 4) {
    pixels.data[at] = image.pixels[index] ?? 0
    pixels.data[at + 1] = image.pixels[index + 1] ?? 0
    pixels.data[at + 2] = image.pixels[index + 2] ?? 0
    pixels.data[at + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png') })
  if (blob === null) throw new SoundError('This WASD Engine window could not encode the picture.', AUDIO_ERROR.measure)
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Draw the waveform and spectrogram picture of measured samples.
 * @param samples - the measured window.
 * @returns the picture, as the agent receives it.
 */
export async function pictureOf(samples: AudioSamples): Promise<AudioPicture> {
  const { image, layout } = drawAudioImage(samples)
  return { data: base64(await encodePng(image)), mediaType: 'image/png', layout }
}
