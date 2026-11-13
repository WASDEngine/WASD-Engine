/**
 * Measurements of decoded audio for agents, which cannot listen: levels, loudness, clipping, silence, spectrum, how a
 * sound joins its own start when it loops, and how its two channels relate. Every measurement reads interleaved 32-bit
 * float samples, whether SuperCollider wrote them or a browser decoded them, and counts a NaN or infinite sample, which
 * no player can play, as silence, so every figure stays finite. The measurements of a whole window also run in steps,
 * which a browser runs a slice at a time between the page's events.
 *
 * @module
 */

/** Interleaved 32-bit float samples of one audio window. */
export interface AudioSamples {
  readonly sampleRate: number
  readonly channels: number
  /** Sample frames; `samples` holds `frames * channels` values. */
  readonly frames: number
  readonly samples: Float32Array
}

/** Level of a sample that counts as sound for the silence measurement: -60 dBFS. */
export const SILENCE_THRESHOLD = 0.001

/** Samples at or above full scale, which integer formats clip. */
const CLIP_LEVEL = 1

/** A peak far beyond full scale, +40 dBFS, which no recording or mix reaches but an unstable filter or a wrong gain does. */
export const FAR_BEYOND_FULL_SCALE = 100

/** Frames one step of a measurement reads, about a millisecond's work, before it offers a pause. */
export const STEP_FRAMES = 1 << 16

/**
 * A measurement in steps: a generator that yields between slices of its work, each of about {@link STEP_FRAMES}
 * frames or one picture column, and returns its result. {@link finish} runs one to its end at once.
 */
export type MeasureSteps<T> = Generator<undefined, T, undefined>

/**
 * Run a measurement's steps to their end.
 * @param steps - the measurement.
 * @returns its result.
 */
export function finish<T>(steps: MeasureSteps<T>): T {
  for (;;) {
    const step = steps.next()
    if (step.done === true) return step.value
  }
}

/**
 * A sample as the measurements read it.
 * @param value - the stored sample; undefined past the end of the samples.
 * @returns the sample, or 0 for a NaN or infinite one.
 */
export function finiteSample(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

/** Levels of one channel, as linear amplitudes. */
export interface ChannelLevels {
  /** Largest absolute sample. */
  readonly peak: number
  /** Root mean square. */
  readonly rms: number
  /** Mean sample value. */
  readonly dcOffset: number
  /** Samples whose absolute value reaches full scale. */
  readonly clipped: number
  /** Samples that are NaN or infinite, which the other figures count as silence. */
  readonly nonFinite: number
}

/** What the agent learns about one audio window. */
export interface AudioAnalysis {
  readonly seconds: number
  readonly channels: readonly ChannelLevels[]
  /** Largest absolute sample of any channel. */
  readonly peak: number
  /** Root mean square over every channel. */
  readonly rms: number
  /**
   * Integrated loudness after ITU-R BS.1770, in LUFS; undefined for windows shorter than one 400 ms block or without
   * sound above the gates.
   */
  readonly loudness: number | undefined
  /** Seconds before the first sample above {@link SILENCE_THRESHOLD}; the whole window when it is silent. */
  readonly leadingSilence: number
  /** Seconds after the last sample above {@link SILENCE_THRESHOLD}; the whole window when it is silent. */
  readonly trailingSilence: number
  /**
   * Frequency in Hz, above 0, of the strongest component of the average spectrum without the DC offset; undefined for a
   * silent window and for one that holds nothing but its DC offset, such as a constant signal.
   */
  readonly dominantFrequency: number | undefined
  /** Amplitude-weighted mean frequency in Hz of the same spectrum; undefined when `dominantFrequency` is. */
  readonly spectralCentroid: number | undefined
}

/** Running sums of the level measurement, by channel, and the first and last frame with sound, -1 before one. */
interface LevelSums {
  readonly peaks: Float64Array
  readonly squares: Float64Array
  readonly totals: Float64Array
  readonly clipped: Float64Array
  readonly nonFinite: Float64Array
  first: number
  last: number
}

/**
 * Add the frames between two indices to the level sums.
 * @param audio - interleaved samples.
 * @param from - first frame.
 * @param to - frame after the last.
 * @param sums - the sums so far, which this updates.
 */
function addLevels(audio: AudioSamples, from: number, to: number, sums: LevelSums): void {
  const { channels, samples } = audio
  const { peaks, squares, totals, clipped, nonFinite } = sums
  for (let frame = from; frame < to; frame++) {
    let loud = false
    for (let channel = 0; channel < channels; channel++) {
      const value = samples[frame * channels + channel] ?? 0
      if (!Number.isFinite(value)) {
        nonFinite[channel] = (nonFinite[channel] ?? 0) + 1
        continue
      }
      const magnitude = Math.abs(value)
      if (magnitude > (peaks[channel] ?? 0)) peaks[channel] = magnitude
      squares[channel] = (squares[channel] ?? 0) + value * value
      totals[channel] = (totals[channel] ?? 0) + value
      if (magnitude >= CLIP_LEVEL) clipped[channel] = (clipped[channel] ?? 0) + 1
      if (magnitude > SILENCE_THRESHOLD) loud = true
    }
    if (loud) {
      if (sums.first < 0) sums.first = frame
      sums.last = frame
    }
  }
}

/**
 * Measure an audio window in steps.
 * @param audio - interleaved samples.
 * @returns the steps, which end with the levels, loudness, silence, and spectrum figures.
 */
export function* analyzeAudioSteps(audio: AudioSamples): MeasureSteps<AudioAnalysis> {
  const { channels, frames, sampleRate } = audio
  const sums: LevelSums = {
    peaks: new Float64Array(channels), squares: new Float64Array(channels), totals: new Float64Array(channels),
    clipped: new Float64Array(channels), nonFinite: new Float64Array(channels), first: -1, last: -1,
  }
  for (let from = 0; from < frames; from += STEP_FRAMES) {
    addLevels(audio, from, Math.min(frames, from + STEP_FRAMES), sums)
    yield
  }
  const { peaks, squares, totals, clipped, nonFinite, first, last } = sums
  const levels = Array.from({ length: channels }, (_, channel) => ({
    peak: peaks[channel] ?? 0,
    rms: frames === 0 ? 0 : Math.sqrt((squares[channel] ?? 0) / frames),
    dcOffset: frames === 0 ? 0 : (totals[channel] ?? 0) / frames,
    clipped: clipped[channel] ?? 0,
    nonFinite: nonFinite[channel] ?? 0,
  }))
  const seconds = frames / sampleRate
  const squareSum = squares.reduce((total, value) => total + value, 0)
  const loudness = yield* integratedLoudnessSteps(audio)
  const spectrum = first < 0 ? undefined : yield* averageSpectrumSteps(audio)
  return {
    seconds,
    channels: levels,
    peak: Math.max(0, ...levels.map(level => level.peak)),
    rms: frames === 0 ? 0 : Math.sqrt(squareSum / (frames * channels)),
    loudness,
    leadingSilence: first < 0 ? seconds : first / sampleRate,
    trailingSilence: first < 0 ? seconds : (frames - 1 - last) / sampleRate,
    dominantFrequency: spectrum?.dominant,
    spectralCentroid: spectrum?.centroid,
  }
}

/**
 * Measure an audio window.
 * @param audio - interleaved samples.
 * @returns levels, loudness, silence, and spectrum figures.
 */
export function analyzeAudio(audio: AudioSamples): AudioAnalysis {
  return finish(analyzeAudioSteps(audio))
}

/** Second-order IIR filter coefficients, normalized so that a0 is 1. */
interface Biquad {
  readonly b0: number
  readonly b1: number
  readonly b2: number
  readonly a1: number
  readonly a2: number
}

/**
 * The two stages of the BS.1770 K-weighting filter at a sample rate: the head shelf and the RLB high-pass. The analog
 * prototypes and the bilinear transform are those of libebur128, so 48 kHz reproduces the coefficients that the
 * recommendation tabulates.
 */
function kWeighting(sampleRate: number): readonly [Biquad, Biquad] {
  const shelfGain = 3.999843853973347
  const shelfFrequency = 1681.974450955533
  const shelfQ = 0.7071752369554196
  let k = Math.tan(Math.PI * shelfFrequency / sampleRate)
  const vh = 10 ** (shelfGain / 20)
  const vb = vh ** 0.4996667741545416
  let a0 = 1 + k / shelfQ + k * k
  const shelf = {
    b0: (vh + vb * k / shelfQ + k * k) / a0, b1: 2 * (k * k - vh) / a0, b2: (vh - vb * k / shelfQ + k * k) / a0,
    a1: 2 * (k * k - 1) / a0, a2: (1 - k / shelfQ + k * k) / a0,
  }
  const passFrequency = 38.13547087602444
  const passQ = 0.5003270373238773
  k = Math.tan(Math.PI * passFrequency / sampleRate)
  a0 = 1 + k / passQ + k * k
  const pass = { b0: 1, b1: -2, b2: 1, a1: 2 * (k * k - 1) / a0, a2: (1 - k / passQ + k * k) / a0 }
  return [shelf, pass]
}

/** One filter stage's last two inputs and outputs, carried from one step to the next. */
interface FilterState {
  x1: number
  x2: number
  y1: number
  y2: number
}

/**
 * K-weight one channel's frames between two indices and extend the running sums of their squares.
 * @param audio - interleaved samples.
 * @param channel - the channel.
 * @param range - the first frame and the frame after the last.
 * @param stages - the shelf and the high-pass, in turn.
 * @param states - each stage's state after the frames before `range`, which this updates.
 * @param cumulative - running sums of squares: entry `frame + 1` receives the sum through `frame`.
 */
function weighSquares(
  audio: AudioSamples,
  channel: number,
  range: readonly [number, number],
  stages: readonly [Biquad, Biquad],
  states: readonly [FilterState, FilterState],
  cumulative: Float64Array,
): void {
  const { channels, samples } = audio
  const [shelf, pass] = stages
  const [first, second] = states
  let { x1, x2, y1, y2 } = first
  let { x1: u1, x2: u2, y1: v1, y2: v2 } = second
  let total = cumulative[range[0]] ?? 0
  for (let frame = range[0]; frame < range[1]; frame++) {
    const x = finiteSample(samples[frame * channels + channel])
    const y = shelf.b0 * x + shelf.b1 * x1 + shelf.b2 * x2 - shelf.a1 * y1 - shelf.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    const v = pass.b0 * y + pass.b1 * u1 + pass.b2 * u2 - pass.a1 * v1 - pass.a2 * v2
    u2 = u1
    u1 = y
    v2 = v1
    v1 = v
    total += v * v
    cumulative[frame + 1] = total
  }
  Object.assign(first, { x1, x2, y1, y2 })
  Object.assign(second, { x1: u1, x2: u2, y1: v1, y2: v2 })
}

/**
 * Integrated loudness after ITU-R BS.1770-4 in steps: K-weighted mean squares of 400 ms blocks that overlap by 75 %,
 * gated at -70 LUFS and then 10 LU below the mean of the remaining blocks. Every channel has weight 1, the weight of
 * the front channels.
 * @param audio - interleaved samples.
 * @returns the steps, which end with the loudness in LUFS, or undefined without one full block or without blocks above
 * the gates.
 */
function* integratedLoudnessSteps(audio: AudioSamples): MeasureSteps<number | undefined> {
  const { channels, frames, sampleRate } = audio
  const block = Math.round(0.4 * sampleRate)
  const step = Math.round(0.1 * sampleRate)
  if (frames < block || block < 1) return undefined
  const stages = kWeighting(sampleRate)
  const energies = new Float64Array(Math.floor((frames - block) / step) + 1)
  // Running sums of squares give each block's energy in constant time; each channel reuses the array.
  const cumulative = new Float64Array(frames + 1)
  for (let channel = 0; channel < channels; channel++) {
    const states: readonly [FilterState, FilterState] = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }]
    for (let from = 0; from < frames; from += STEP_FRAMES) {
      weighSquares(audio, channel, [from, Math.min(frames, from + STEP_FRAMES)], stages, states, cumulative)
      yield
    }
    for (let index = 0; index < energies.length; index++) {
      const start = index * step
      energies[index] = (energies[index] ?? 0) + ((cumulative[start + block] ?? 0) - (cumulative[start] ?? 0)) / block
    }
  }
  const loudness = (energy: number): number => -0.691 + 10 * Math.log10(energy)
  const absolute = Array.from(energies).filter(energy => energy > 0 && loudness(energy) > -70)
  if (absolute.length === 0) return undefined
  const relativeGate = loudness(absolute.reduce((total, energy) => total + energy, 0) / absolute.length) - 10
  const gated = absolute.filter(energy => loudness(energy) > relativeGate)
  return loudness(gated.reduce((total, energy) => total + energy, 0) / gated.length)
}

/**
 * Integrated loudness after ITU-R BS.1770-4: K-weighted mean squares of 400 ms blocks that overlap by 75 %, gated
 * at -70 LUFS and then 10 LU below the mean of the remaining blocks. Every channel has weight 1, the weight of the
 * front channels.
 * @param audio - interleaved samples.
 * @returns loudness in LUFS, or undefined without one full block or without blocks above the gates.
 */
export function integratedLoudness(audio: AudioSamples): number | undefined {
  return finish(integratedLoudnessSteps(audio))
}

/**
 * Replace a complex sequence with its discrete Fourier transform, in place (iterative radix-2 FFT).
 * @param real - real parts; the length must be a power of two.
 * @param imaginary - imaginary parts, as long as `real`.
 */
export function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1
    for (; (reversed & bit) !== 0; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index < reversed) {
      const swapReal = real[index] ?? 0
      real[index] = real[reversed] ?? 0
      real[reversed] = swapReal
      const swapImaginary = imaginary[index] ?? 0
      imaginary[index] = imaginary[reversed] ?? 0
      imaginary[reversed] = swapImaginary
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset
        const odd = even + length / 2
        const evenReal = real[even] ?? 0
        const evenImaginary = imaginary[even] ?? 0
        const oddReal = (real[odd] ?? 0) * twiddleReal - (imaginary[odd] ?? 0) * twiddleImaginary
        const oddImaginary = (real[odd] ?? 0) * twiddleImaginary + (imaginary[odd] ?? 0) * twiddleReal
        real[odd] = evenReal - oddReal
        imaginary[odd] = evenImaginary - oddImaginary
        real[even] = evenReal + oddReal
        imaginary[even] = evenImaginary + oddImaginary
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
        twiddleReal = nextReal
      }
    }
  }
}

/** Analysis frames of the average spectrum: enough frequency resolution to name a pitch within a few hertz. */
const SPECTRUM_SIZE = 8192

/** Most frames that the average spectrum takes, spread evenly over the window. */
const SPECTRUM_FRAMES = 64

/**
 * Hann-windowed magnitude spectrum of the channel mix around one frame.
 * @param audio - interleaved samples.
 * @param center - frame at the middle of the analysis window.
 * @param size - FFT size, a power of two.
 * @param level - subtracted from the mix before the window applies, such as the mix's mean, so that a DC offset
 * neither fills bin 0 nor leaks into the bins beside it; 0 by default.
 * @returns `size / 2 + 1` magnitudes; a full-scale sine reaches about `size / 4`.
 */
export function magnitudeSpectrum(audio: AudioSamples, center: number, size: number, level = 0): Float64Array {
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  const start = center - size / 2
  for (let index = 0; index < size; index++) {
    const frame = start + index
    if (frame < 0 || frame >= audio.frames) continue
    real[index] = (mixAt(audio, frame) - level) * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / size))
  }
  fft(real, imaginary)
  const magnitudes = new Float64Array(size / 2 + 1)
  for (let bin = 0; bin < magnitudes.length; bin++) magnitudes[bin] = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0)
  return magnitudes
}

/**
 * The mean of the channels at one frame.
 * @param audio - interleaved samples.
 * @param frame - frame index.
 * @returns the channel mix.
 */
function mixAt(audio: AudioSamples, frame: number): number {
  let mix = 0
  for (let channel = 0; channel < audio.channels; channel++) mix += finiteSample(audio.samples[frame * audio.channels + channel])
  return mix / audio.channels
}

/**
 * Sum the channel mix over the frames between two indices.
 * @param audio - interleaved samples.
 * @param from - first frame.
 * @param to - frame after the last.
 * @returns the sum.
 */
function mixSum(audio: AudioSamples, from: number, to: number): number {
  let sum = 0
  for (let frame = from; frame < to; frame++) sum += mixAt(audio, frame)
  return sum
}

/**
 * The farthest the channel mix moves from a level over the frames between two indices.
 * @param audio - interleaved samples.
 * @param from - first frame.
 * @param to - frame after the last.
 * @param level - the level, such as the mix's mean.
 * @returns the largest distance.
 */
function mixSwing(audio: AudioSamples, from: number, to: number, level: number): number {
  let swing = 0
  for (let frame = from; frame < to; frame++) swing = Math.max(swing, Math.abs(mixAt(audio, frame) - level))
  return swing
}

/**
 * Strongest component and centroid of the spectrum averaged over evenly spread frames, in steps. The mix's DC offset
 * carries no pitch, so its mean is removed first, and a mix that never moves more than {@link SILENCE_THRESHOLD} from
 * its mean, such as a constant signal, has no spectrum to report.
 * @param audio - interleaved samples.
 * @returns the steps, which end with the dominant frequency and the centroid in Hz, both positive, or undefined without
 * sound beside the offset.
 */
function* averageSpectrumSteps(audio: AudioSamples): MeasureSteps<{ dominant: number; centroid: number } | undefined> {
  let sumOfMix = 0
  for (let from = 0; from < audio.frames; from += STEP_FRAMES) {
    sumOfMix += mixSum(audio, from, Math.min(audio.frames, from + STEP_FRAMES))
    yield
  }
  const mean = audio.frames === 0 ? 0 : sumOfMix / audio.frames
  let swing = 0
  for (let from = 0; from < audio.frames; from += STEP_FRAMES) {
    swing = Math.max(swing, mixSwing(audio, from, Math.min(audio.frames, from + STEP_FRAMES), mean))
    yield
  }
  if (swing <= SILENCE_THRESHOLD) return undefined
  const count = Math.max(1, Math.min(SPECTRUM_FRAMES, Math.ceil(audio.frames / (SPECTRUM_SIZE / 2))))
  const sum = new Float64Array(SPECTRUM_SIZE / 2 + 1)
  for (let index = 0; index < count; index++) {
    const spectrum = magnitudeSpectrum(audio, Math.round((index + 0.5) * audio.frames / count), SPECTRUM_SIZE, mean)
    for (let bin = 0; bin < sum.length; bin++) sum[bin] = (sum[bin] ?? 0) + (spectrum[bin] ?? 0)
    yield
  }
  const resolution = audio.sampleRate / SPECTRUM_SIZE
  let strongest = 1
  let weighted = 0
  let total = 0
  // Bin 0 is DC, which the dominant frequency and the centroid leave out.
  for (let bin = 1; bin < sum.length; bin++) {
    const magnitude = sum[bin] ?? 0
    if (magnitude > (sum[strongest] ?? 0)) strongest = bin
    weighted += bin * resolution * magnitude
    total += magnitude
  }
  if (total === 0) return undefined
  // A parabola through the strongest bin and its neighbors places a peak between bins. It applies only where that bin
  // rises above both neighbors, and moves the peak at most half a bin, so the frequency stays above 0.
  const left = sum[strongest - 1] ?? 0
  const right = sum[strongest + 1] ?? 0
  const middle = sum[strongest] ?? 0
  const curvature = left - 2 * middle + right
  const peak = middle >= left && middle >= right && curvature < 0
  const shift = peak ? Math.min(0.5, Math.max(-0.5, 0.5 * (left - right) / curvature)) : 0
  return { dominant: (strongest + shift) * resolution, centroid: weighted / total }
}

/** Seconds on either side of a loop's seam whose samples the seam measurement reads. */
const SEAM_SECONDS = 0.05

/** Where a loop's end meets its start each time it repeats. */
export interface LoopSeam {
  /** Largest step of any channel from the loop's last sample to its first, as a fraction of full scale (0 to 2). */
  readonly jump: number
  /**
   * Root mean square of the steps between neighboring samples on either side of the seam, up to {@link SEAM_SECONDS}
   * each, of the busiest channel: the usual step there, which a jump must stand out from to click.
   */
  readonly step: number
  /**
   * RMS level of the loop's last {@link SEAM_SECONDS} minus that of its first, in dB, over every channel; undefined
   * when either is silent or the loop is shorter than both together.
   */
  readonly levelChange: number | undefined
}

/** The frames whose samples {@link loopSeam} reads: the loop's last frames and its first, each `[first, end)`. */
export interface SeamFrames {
  readonly tail: readonly [number, number]
  readonly head: readonly [number, number]
}

/**
 * The frames on either side of a loop's seam: up to {@link SEAM_SECONDS} before the frame playback jumps from and as
 * many from the frame it jumps to, without overlapping.
 * @param first - the loop's first frame, which playback jumps back to.
 * @param end - the frame after its last.
 * @param sampleRate - frames per second.
 * @returns the frames, or undefined for a loop of fewer than two frames.
 */
export function seamFrames(first: number, end: number, sampleRate: number): SeamFrames | undefined {
  if (end - first < 2) return undefined
  const span = Math.max(1, Math.min(Math.round(SEAM_SECONDS * sampleRate), Math.floor((end - first) / 2)))
  return { tail: [end - span, end], head: [first, first + span] }
}

/**
 * Root mean square of one channel's samples.
 * @param audio - interleaved samples.
 * @param channel - the channel.
 * @returns the level, 0 without frames.
 */
function channelLevel(audio: AudioSamples, channel: number): number {
  let squares = 0
  for (let frame = 0; frame < audio.frames; frame++) squares += finiteSample(audio.samples[frame * audio.channels + channel]) ** 2
  return audio.frames === 0 ? 0 : Math.sqrt(squares / audio.frames)
}

/**
 * Sum of the squared steps between one channel's neighboring samples.
 * @param audio - interleaved samples.
 * @param channel - the channel.
 * @returns the sum, over `frames - 1` steps.
 */
function stepSquares(audio: AudioSamples, channel: number): number {
  const { channels, frames, samples } = audio
  let squares = 0
  for (let frame = 1; frame < frames; frame++) {
    const difference = finiteSample(samples[frame * channels + channel]) - finiteSample(samples[(frame - 1) * channels + channel])
    squares += difference * difference
  }
  return squares
}

/**
 * Measure where a loop's end meets its start, as each repeat plays the frame before the jump and then the frame after
 * it. A jump well above the usual step between neighboring samples there sounds as a click at every repeat, and a
 * level change as a sudden swell or drop.
 * @param tail - the loop's last samples, which end with the frame playback jumps from: the {@link seamFrames} tail.
 * @param head - its first samples, which begin with the frame playback jumps to: the {@link seamFrames} head.
 * @returns the seam, or undefined when a stretch is empty or the two differ in channels or rate.
 */
export function loopSeam(tail: AudioSamples, head: AudioSamples): LoopSeam | undefined {
  const { channels, sampleRate } = tail
  if (tail.frames < 1 || head.frames < 1 || head.channels !== channels || head.sampleRate !== sampleRate) return undefined
  const steps = tail.frames - 1 + head.frames - 1
  let jump = 0
  let step = 0
  let endSquares = 0
  let startSquares = 0
  for (let channel = 0; channel < channels; channel++) {
    const last = finiteSample(tail.samples[(tail.frames - 1) * channels + channel])
    const first = finiteSample(head.samples[channel])
    jump = Math.max(jump, Math.abs(first - last))
    if (steps > 0) step = Math.max(step, Math.sqrt((stepSquares(tail, channel) + stepSquares(head, channel)) / steps))
    endSquares += channelLevel(tail, channel) ** 2
    startSquares += channelLevel(head, channel) ** 2
  }
  const span = Math.round(SEAM_SECONDS * sampleRate)
  let levelChange: number | undefined
  if (span >= 1 && tail.frames >= span && head.frames >= span) {
    const end = Math.sqrt(endSquares / channels)
    const start = Math.sqrt(startSquares / channels)
    if (start > SILENCE_THRESHOLD && end > SILENCE_THRESHOLD) levelChange = 20 * Math.log10(end / start)
  }
  return { jump, step, levelChange }
}

/** Largest difference between the two channels of a sound whose channels count as identical: -90 dBFS. */
const IDENTICAL_LEVEL = 10 ** (-90 / 20)

/** How the two channels of a stereo sound relate. */
export interface StereoImage {
  /** Correlation of left and right, from 1 for the same signal through 0 for unrelated ones to -1 for opposite phase. */
  readonly correlation: number | undefined
  /** RMS level of left minus that of right, in dB; undefined when a channel is silent. */
  readonly balance: number | undefined
  /** Whether both channels hold the same samples, so the file stores a mono sound twice. */
  readonly identical: boolean
}

/** Running sums of the stereo comparison. */
interface StereoSums {
  leftSquares: number
  rightSquares: number
  products: number
  largestDifference: number
}

/**
 * Add the frames between two indices of a two-channel sound to the stereo sums.
 * @param audio - interleaved samples of two channels.
 * @param from - first frame.
 * @param to - frame after the last.
 * @param sums - the sums so far, which this updates.
 */
function addStereo(audio: AudioSamples, from: number, to: number, sums: StereoSums): void {
  const { samples } = audio
  let { leftSquares, rightSquares, products, largestDifference } = sums
  for (let frame = from; frame < to; frame++) {
    const left = finiteSample(samples[frame * 2])
    const right = finiteSample(samples[frame * 2 + 1])
    leftSquares += left * left
    rightSquares += right * right
    products += left * right
    largestDifference = Math.max(largestDifference, Math.abs(left - right))
  }
  Object.assign(sums, { leftSquares, rightSquares, products, largestDifference })
}

/**
 * Compare the channels of a two-channel sound in steps.
 * @param audio - interleaved samples.
 * @returns the steps, which end with how the channels relate, or undefined unless the sound has exactly two channels.
 */
export function* stereoImageSteps(audio: AudioSamples): MeasureSteps<StereoImage | undefined> {
  if (audio.channels !== 2) return undefined
  const { frames } = audio
  const sums: StereoSums = { leftSquares: 0, rightSquares: 0, products: 0, largestDifference: 0 }
  for (let from = 0; from < frames; from += STEP_FRAMES) {
    addStereo(audio, from, Math.min(frames, from + STEP_FRAMES), sums)
    yield
  }
  const { leftSquares, rightSquares, products, largestDifference } = sums
  const leftLevel = frames === 0 ? 0 : Math.sqrt(leftSquares / frames)
  const rightLevel = frames === 0 ? 0 : Math.sqrt(rightSquares / frames)
  const silent = leftLevel <= SILENCE_THRESHOLD || rightLevel <= SILENCE_THRESHOLD
  return {
    correlation: leftSquares === 0 || rightSquares === 0 ? undefined : products / Math.sqrt(leftSquares * rightSquares),
    balance: silent ? undefined : 20 * Math.log10(leftLevel / rightLevel),
    identical: frames > 0 && largestDifference <= IDENTICAL_LEVEL,
  }
}

/**
 * Compare the channels of a two-channel sound.
 * @param audio - interleaved samples.
 * @returns how the channels relate, or undefined unless the sound has exactly two channels.
 */
export function stereoImage(audio: AudioSamples): StereoImage | undefined {
  return finish(stereoImageSteps(audio))
}

/** Smallest jump at a loop seam that clicks, as a fraction of full scale, however busy the sound is. */
const CLICK_JUMP = 0.05

/** How many times the usual step between neighboring samples a seam's jump must exceed to click. */
const CLICK_STEPS = 4

/**
 * Whether a sound clicks where it repeats.
 * @param seam - the jump at the seam and the usual step between samples.
 * @returns true when the jump is audible above the sound itself.
 */
export function seamClicks(seam: Pick<LoopSeam, 'jump' | 'step'>): boolean {
  return seam.jump >= CLICK_JUMP && seam.jump > CLICK_STEPS * seam.step
}

/** Silence before a sound effect or a line from which a game's playback starts noticeably late, in seconds. */
export const LATE_START_SECONDS = 0.05
