/**
 * Decoding a sound in the browser and measuring it as the agent's `audio_review` reports it. WAV, MP3, Ogg Vorbis and
 * Opus, and FLAC files decode with the browser's own decoder through an OfflineAudioContext at the file's own sample
 * rate, so the samples are not resampled; AIFF files, which browsers do not decode, use the audio tools' AIFF reader,
 * which fills the AudioBuffer a slice at a time so a long file neither holds a second copy nor blocks the page. A
 * measurement covers one stretch of the decoded sound and the seam of one loop, wherever that loop lies in the whole
 * sound. The picture is the one the audio tools draw, encoded as PNG on a canvas. Measuring and drawing run a slice at
 * a time, so a long sound does not block the page.
 */
import {
  analyzeAudioSteps, AUDIO_ERROR, drawAudioImageSteps, finish, loopSeam, openAiff, seamFrames, STEP_FRAMES, stereoImageSteps,
  type AudioFormat, type AudioProbe, type AudioSamples, type MeasureSteps, type RgbImage,
} from '@deepseek-ai/dsh-game-audio/audio'
import type { AudioLoop, AudioMeasurements, AudioMeasureRequest, AudioPicture } from '@deepseek-ai/dsh-game-audio/types'

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

/** Longest that measuring or drawing runs before it lets the page handle its events, in milliseconds. */
const SLICE_MS = 10

/** What a decode may cost: the longest sound it decodes, and its cancellation. */
export interface DecodeBounds {
  /** Longest sound in seconds; a longer AIFF file is refused before its samples are copied. */
  readonly maxSeconds: number
  /** Ends the decode: an AIFF decode stops at its next slice, a browser decode before and after it runs. */
  readonly signal: AbortSignal
}

/**
 * Wait for the page to handle its pending events. The wait is a message to the page itself: Chromium throttles the
 * timers of a hidden window, which would hold a decode for an agent past its time limit, but not its messages.
 * @returns settles on a later turn of the event loop.
 */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
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
 * @param seconds - its length, or the least it can be.
 * @param maxSeconds - the longest sound a window decodes.
 * @param atLeast - whether `seconds` is the least the length can be rather than the length.
 * @returns the error, `AUDIO_TOO_LARGE`.
 */
export function tooLong(name: string, seconds: number, maxSeconds: number, atLeast = false): SoundError {
  const length = `${atLeast ? 'at least ' : ''}${seconds.toFixed(1)} s`
  return new SoundError(`${name} is ${length} long, longer than the ${String(maxSeconds)} s a WASD Engine window decodes, so it cannot be measured.`, AUDIO_ERROR.tooLarge)
}

/**
 * The length a sound's headers vouch for before it decodes: the length they state, or, for an MP3 length they only
 * estimate from one frame's bit rate, the shortest the sound can be, so that an estimate that runs long refuses no sound
 * the decode would take.
 * @param probe - what the headers say.
 * @returns the seconds the decoded sound reaches at least, or undefined when the headers do not tell.
 */
export function lengthBeforeDecoding(probe: AudioProbe | undefined): number | undefined {
  return probe?.estimated === true ? probe.minSeconds : probe?.seconds
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

/** Where one channel of a decoded sound goes in interleaved samples. */
interface Interleaving {
  readonly samples: Float32Array
  readonly channels: number
  /** The sound's frame that becomes the samples' first. */
  readonly first: number
}

/**
 * Copy one channel's frames into interleaved samples.
 * @param plane - the channel's samples in the decoded sound.
 * @param into - the interleaved samples.
 * @param channel - the channel.
 * @param from - first frame of the samples to fill.
 * @param to - frame after the last.
 */
function copyChannel(plane: Float32Array, into: Interleaving, channel: number, from: number, to: number): void {
  const { samples, channels, first } = into
  for (let frame = from; frame < to; frame++) samples[frame * channels + channel] = plane[first + frame] ?? 0
}

/**
 * Interleave the frames between two indices of a decoded sound, in steps.
 * @param buffer - the decoded sound.
 * @param first - first frame.
 * @param last - frame after the last.
 * @returns the steps, which end with the samples.
 */
function* interleaveSteps(buffer: AudioBuffer, first: number, last: number): MeasureSteps<AudioSamples> {
  const channels = buffer.numberOfChannels
  const frames = Math.max(0, last - first)
  const into: Interleaving = { samples: new Float32Array(frames * channels), channels, first }
  for (let channel = 0; channel < channels; channel++) {
    const plane = buffer.getChannelData(channel)
    for (let from = 0; from < frames; from += STEP_FRAMES) {
      copyChannel(plane, into, channel, from, Math.min(frames, from + STEP_FRAMES))
      yield
    }
  }
  return { sampleRate: buffer.sampleRate, channels, frames, samples: into.samples }
}

/**
 * Interleave the frames between two indices of a decoded sound.
 * @param buffer - the decoded sound.
 * @param first - first frame.
 * @param last - frame after the last.
 * @returns the samples.
 */
function interleave(buffer: AudioBuffer, first: number, last: number): AudioSamples {
  return finish(interleaveSteps(buffer, first, last))
}

/**
 * Run measuring or drawing steps, letting the page handle its events whenever they have run for {@link SLICE_MS}.
 * @param steps - the work.
 * @param signal - ends the work before it starts and between slices.
 * @returns the work's result.
 * @throws the signal's reason when it ends the work, or what a step throws.
 */
async function inSlices<T>(steps: MeasureSteps<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let since = performance.now()
  for (;;) {
    const step = steps.next()
    if (step.done === true) return step.value
    if (performance.now() - since >= SLICE_MS) {
      await yieldToEvents()
      signal.throwIfAborted()
      since = performance.now()
    }
  }
}

/** One measured window: its measurements and its samples, for the picture. */
export interface MeasuredWindow {
  readonly measurements: AudioMeasurements
  readonly samples: AudioSamples
}

/**
 * What one measurement of a decoded sound covers, as a measure request names it: the stretch from `start` to `end`,
 * the end of the sound when `end` is absent or later, at most `maxSeconds` long; and the loop whose seam it measures,
 * none when `loop` is absent.
 */
export type SoundStretch = Pick<AudioMeasureRequest, 'start' | 'end' | 'maxSeconds' | 'loop'>

/** The loop of a sound that repeats whole, as the Audio tab's repeat plays it. */
export const WHOLE_SOUND: AudioLoop = { start: 0 }

/**
 * Measure where a loop of a decoded sound meets its start, from the frames on either side of the jump, wherever they
 * lie in the sound.
 * @param buffer - the decoded sound.
 * @param loop - the loop, in seconds.
 * @returns the seam, or undefined for a loop that lies outside the sound or holds fewer than two frames.
 */
function seamOf(buffer: AudioBuffer, loop: AudioLoop): AudioMeasurements['seam'] {
  const first = Math.round(loop.start * buffer.sampleRate)
  const end = loop.end === undefined ? buffer.length : Math.round(loop.end * buffer.sampleRate)
  const frames = first < 0 || end > buffer.length ? undefined : seamFrames(first, end, buffer.sampleRate)
  if (frames === undefined) return undefined
  const seam = loopSeam(interleave(buffer, ...frames.tail), interleave(buffer, ...frames.head))
  if (seam === undefined) return undefined
  return {
    start: first / buffer.sampleRate,
    end: end / buffer.sampleRate,
    jump: seam.jump,
    step: seam.step,
    ...seam.levelChange === undefined ? {} : { levelChange: seam.levelChange },
  }
}

/**
 * Measure a stretch of a decoded sound, and the seam of a loop of the whole sound, in steps.
 * @param buffer - the decoded sound.
 * @param stretch - the stretch to measure and the loop.
 * @returns the steps, which end with the measurements and the stretch's samples.
 * @throws {SoundError} `AUDIO_ARGUMENT` when the stretch starts at or after the end of the sound.
 */
function* measureSteps(buffer: AudioBuffer, stretch: SoundStretch): MeasureSteps<MeasuredWindow> {
  const { start, end, maxSeconds, loop } = stretch
  const seconds = buffer.length / buffer.sampleRate
  if (start > 0 && start >= seconds) {
    throw new SoundError(`start (${start.toFixed(3)} s) is not before the end of the sound, which is ${seconds.toFixed(3)} s long.`, AUDIO_ERROR.argument)
  }
  const from = Math.max(0, start)
  const to = Math.min(end ?? seconds, seconds, from + maxSeconds)
  const first = Math.round(from * buffer.sampleRate)
  const samples = yield* interleaveSteps(buffer, first, Math.max(first, Math.round(to * buffer.sampleRate)))
  const analysis = yield* analyzeAudioSteps(samples)
  const seam = loop === undefined ? undefined : seamOf(buffer, loop)
  const stereo = yield* stereoImageSteps(samples)
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
    channelLevels: analysis.channels.map(level => ({
      peak: level.peak, rms: level.rms, dcOffset: level.dcOffset, clipped: level.clipped, nonFinite: level.nonFinite,
    })),
    ...seam === undefined ? {} : { seam },
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
 * Measure a stretch of a decoded sound, and the seam of a loop of the whole sound, a slice at a time with the page
 * free to handle its events between slices.
 * @param buffer - the decoded sound.
 * @param stretch - the stretch to measure and the loop.
 * @param signal - ends the measurement between slices.
 * @returns the measurements and the stretch's samples.
 * @throws {SoundError} `AUDIO_ARGUMENT` when the stretch starts at or after the end of the sound; the signal's reason
 * when it ends the measurement.
 */
export function measureSound(buffer: AudioBuffer, stretch: SoundStretch, signal: AbortSignal): Promise<MeasuredWindow> {
  return inSlices(measureSteps(buffer, stretch), signal)
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
 * Draw the waveform and spectrogram picture of measured samples, a column at a time with the page free to handle its
 * events between slices.
 * @param samples - the measured window.
 * @param signal - ends the drawing between slices.
 * @returns the picture, as the agent receives it.
 * @throws {SoundError} `AUDIO_MEASURE` when the browser cannot draw or encode it; the signal's reason when it ends the
 * drawing.
 */
export async function pictureOf(samples: AudioSamples, signal: AbortSignal): Promise<AudioPicture> {
  const { image, layout } = await inSlices(drawAudioImageSteps(samples), signal)
  return { data: base64(await encodePng(image)), mediaType: 'image/png', layout }
}
