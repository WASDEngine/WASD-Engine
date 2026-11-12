/**
 * Decoding a sound in the browser and measuring it as the agent's `audio_review` reports it. WAV, MP3, Ogg Vorbis and
 * Opus, and FLAC files decode with the browser's own decoder through an OfflineAudioContext at the file's own sample
 * rate, so the samples are not resampled; AIFF files, which browsers do not decode, use the audio tools' AIFF reader.
 * The picture is the one the audio tools draw, encoded as PNG on a canvas.
 */
import {
  analyzeAudio, AUDIO_ERROR, decodeAiff, drawAudioImage, loopSeam, stereoImage, type AudioFormat, type AudioSamples, type RgbImage,
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

/**
 * Copy interleaved samples into an AudioBuffer.
 * @param samples - the samples.
 * @returns the buffer.
 */
function bufferOf(samples: AudioSamples): AudioBuffer {
  const buffer = new AudioBuffer({
    length: Math.max(1, samples.frames),
    numberOfChannels: samples.channels,
    sampleRate: samples.sampleRate,
  })
  for (let channel = 0; channel < samples.channels; channel++) {
    const plane = buffer.getChannelData(channel)
    for (let frame = 0; frame < samples.frames; frame++) plane[frame] = samples.samples[frame * samples.channels + channel] ?? 0
  }
  return buffer
}

/**
 * Decode a sound file.
 * @param data - the complete file.
 * @param format - its listed format.
 * @param sampleRate - the rate its headers name, which the decoded samples keep.
 * @returns the decoded sound.
 * @throws {SoundError} `AUDIO_UNREADABLE` when the file does not decode.
 */
export async function decodeSound(
  data: Uint8Array<ArrayBuffer>,
  format: AudioFormat,
  sampleRate: number | undefined,
): Promise<AudioBuffer> {
  try {
    if (format.decoder === 'aiff') return bufferOf(decodeAiff(data))
    const rate = sampleRate !== undefined && sampleRate >= LOWEST_RATE && sampleRate <= HIGHEST_RATE ? Math.round(sampleRate) : DEFAULT_RATE
    const context = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate })
    // decodeAudioData takes over the buffer it is given, so it receives a copy.
    return await context.decodeAudioData(data.slice().buffer)
  } catch (error) {
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
    sampleRate: buffer.sampleRate,
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
