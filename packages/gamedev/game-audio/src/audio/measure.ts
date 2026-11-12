/**
 * Measurements of decoded audio for agents, which cannot listen: levels, loudness, clipping, silence, spectrum, how a
 * sound joins its own start when it loops, and how its two channels relate. Every measurement reads interleaved 32-bit
 * float samples, whether SuperCollider wrote them or a browser decoded them.
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
  /** Frequency in Hz of the strongest component of the average spectrum; undefined for a silent window. */
  readonly dominantFrequency: number | undefined
  /** Amplitude-weighted mean frequency in Hz of the average spectrum; undefined for a silent window. */
  readonly spectralCentroid: number | undefined
}

/**
 * Measure an audio window.
 * @param audio - interleaved samples.
 * @returns levels, loudness, silence, and spectrum figures.
 */
export function analyzeAudio(audio: AudioSamples): AudioAnalysis {
  const { channels, frames, samples, sampleRate } = audio
  const peaks = new Float64Array(channels)
  const squares = new Float64Array(channels)
  const totals = new Float64Array(channels)
  const clipped = new Float64Array(channels)
  let first = -1
  let last = -1
  for (let frame = 0; frame < frames; frame++) {
    let loud = false
    for (let channel = 0; channel < channels; channel++) {
      const value = samples[frame * channels + channel] ?? 0
      const magnitude = Math.abs(value)
      if (magnitude > (peaks[channel] ?? 0)) peaks[channel] = magnitude
      squares[channel] = (squares[channel] ?? 0) + value * value
      totals[channel] = (totals[channel] ?? 0) + value
      if (magnitude >= CLIP_LEVEL) clipped[channel] = (clipped[channel] ?? 0) + 1
      if (magnitude > SILENCE_THRESHOLD) loud = true
    }
    if (loud) {
      if (first < 0) first = frame
      last = frame
    }
  }
  const levels = Array.from({ length: channels }, (_, channel) => ({
    peak: peaks[channel] ?? 0,
    rms: frames === 0 ? 0 : Math.sqrt((squares[channel] ?? 0) / frames),
    dcOffset: frames === 0 ? 0 : (totals[channel] ?? 0) / frames,
    clipped: clipped[channel] ?? 0,
  }))
  const seconds = frames / sampleRate
  const squareSum = squares.reduce((total, value) => total + value, 0)
  const spectrum = first < 0 ? undefined : averageSpectrum(audio)
  return {
    seconds,
    channels: levels,
    peak: Math.max(0, ...levels.map(level => level.peak)),
    rms: frames === 0 ? 0 : Math.sqrt(squareSum / (frames * channels)),
    loudness: integratedLoudness(audio),
    leadingSilence: first < 0 ? seconds : first / sampleRate,
    trailingSilence: first < 0 ? seconds : (frames - 1 - last) / sampleRate,
    dominantFrequency: spectrum?.dominant,
    spectralCentroid: spectrum?.centroid,
  }
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

function filter(input: Float64Array, stage: Biquad): Float64Array {
  const output = new Float64Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < input.length; index++) {
    const x = input[index] ?? 0
    const y = stage.b0 * x + stage.b1 * x1 + stage.b2 * x2 - stage.a1 * y1 - stage.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    output[index] = y
  }
  return output
}

/**
 * Integrated loudness after ITU-R BS.1770-4: K-weighted mean squares of 400 ms blocks that overlap by 75 %, gated
 * at -70 LUFS and then 10 LU below the mean of the remaining blocks. Every channel has weight 1, the weight of the
 * front channels.
 * @param audio - interleaved samples.
 * @returns loudness in LUFS, or undefined without one full block or without blocks above the gates.
 */
export function integratedLoudness(audio: AudioSamples): number | undefined {
  const { channels, frames, samples, sampleRate } = audio
  const block = Math.round(0.4 * sampleRate)
  const step = Math.round(0.1 * sampleRate)
  if (frames < block || block < 1) return undefined
  const [shelf, pass] = kWeighting(sampleRate)
  const energies = new Float64Array(Math.floor((frames - block) / step) + 1)
  for (let channel = 0; channel < channels; channel++) {
    const signal = new Float64Array(frames)
    for (let frame = 0; frame < frames; frame++) signal[frame] = samples[frame * channels + channel] ?? 0
    const weighted = filter(filter(signal, shelf), pass)
    // Running sums of squares give each block's energy in constant time.
    const cumulative = new Float64Array(frames + 1)
    for (let frame = 0; frame < frames; frame++) {
      const value = weighted[frame] ?? 0
      cumulative[frame + 1] = (cumulative[frame] ?? 0) + value * value
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
 * @returns `size / 2 + 1` magnitudes; a full-scale sine reaches about `size / 4`.
 */
export function magnitudeSpectrum(audio: AudioSamples, center: number, size: number): Float64Array {
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  const start = center - size / 2
  for (let index = 0; index < size; index++) {
    const frame = start + index
    if (frame < 0 || frame >= audio.frames) continue
    let mix = 0
    for (let channel = 0; channel < audio.channels; channel++) mix += audio.samples[frame * audio.channels + channel] ?? 0
    real[index] = mix / audio.channels * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / size))
  }
  fft(real, imaginary)
  const magnitudes = new Float64Array(size / 2 + 1)
  for (let bin = 0; bin < magnitudes.length; bin++) magnitudes[bin] = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0)
  return magnitudes
}

/** Strongest component and centroid of the spectrum averaged over evenly spread frames. */
function averageSpectrum(audio: AudioSamples): { dominant: number; centroid: number } | undefined {
  const count = Math.max(1, Math.min(SPECTRUM_FRAMES, Math.ceil(audio.frames / (SPECTRUM_SIZE / 2))))
  const sum = new Float64Array(SPECTRUM_SIZE / 2 + 1)
  for (let index = 0; index < count; index++) {
    const spectrum = magnitudeSpectrum(audio, Math.round((index + 0.5) * audio.frames / count), SPECTRUM_SIZE)
    for (let bin = 0; bin < sum.length; bin++) sum[bin] = (sum[bin] ?? 0) + (spectrum[bin] ?? 0)
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
  // A parabola through the strongest bin and its neighbors places the peak between bins.
  const left = sum[strongest - 1] ?? 0
  const right = sum[strongest + 1] ?? 0
  const middle = sum[strongest] ?? 0
  const curvature = left - 2 * middle + right
  const shift = curvature === 0 ? 0 : 0.5 * (left - right) / curvature
  return { dominant: (strongest + shift) * resolution, centroid: weighted / total }
}

/** Seconds at each end of a sound whose levels the loop measurement compares. */
const SEAM_SECONDS = 0.05

/** How a sound joins its own start when it repeats. */
export interface LoopSeam {
  /** Largest step of any channel from its last sample to its first, as a fraction of full scale (0 to 2). */
  readonly jump: number
  /** Root mean square of the steps between neighboring samples over the whole sound, of its busiest channel. */
  readonly step: number
  /**
   * RMS level of the last {@link SEAM_SECONDS} minus that of the first, in dB, over every channel; undefined when
   * either end is silent or the sound is shorter than both ends together.
   */
  readonly levelChange: number | undefined
}

/**
 * Measure where a sound's end meets its start, as it does when the sound loops. A jump well above the usual step
 * between neighboring samples sounds as a click at every repeat, and a level change as a sudden swell or drop.
 * @param audio - interleaved samples.
 * @returns the seam, or undefined for fewer than two frames.
 */
export function loopSeam(audio: AudioSamples): LoopSeam | undefined {
  const { channels, frames, samples, sampleRate } = audio
  if (frames < 2) return undefined
  let jump = 0
  let step = 0
  for (let channel = 0; channel < channels; channel++) {
    const first = samples[channel] ?? 0
    const last = samples[(frames - 1) * channels + channel] ?? 0
    jump = Math.max(jump, Math.abs(first - last))
    let squares = 0
    for (let frame = 1; frame < frames; frame++) {
      const difference = (samples[frame * channels + channel] ?? 0) - (samples[(frame - 1) * channels + channel] ?? 0)
      squares += difference * difference
    }
    step = Math.max(step, Math.sqrt(squares / (frames - 1)))
  }
  const span = Math.round(SEAM_SECONDS * sampleRate)
  let levelChange: number | undefined
  if (span >= 1 && frames >= 2 * span) {
    const level = (from: number): number => {
      let squares = 0
      for (let index = from * channels; index < (from + span) * channels; index++) squares += (samples[index] ?? 0) ** 2
      return Math.sqrt(squares / (span * channels))
    }
    const start = level(0)
    const end = level(frames - span)
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

/**
 * Compare the channels of a two-channel sound.
 * @param audio - interleaved samples.
 * @returns how the channels relate, or undefined unless the sound has exactly two channels.
 */
export function stereoImage(audio: AudioSamples): StereoImage | undefined {
  if (audio.channels !== 2) return undefined
  const { frames, samples } = audio
  let leftSquares = 0
  let rightSquares = 0
  let products = 0
  let largestDifference = 0
  for (let frame = 0; frame < frames; frame++) {
    const left = samples[frame * 2] ?? 0
    const right = samples[frame * 2 + 1] ?? 0
    leftSquares += left * left
    rightSquares += right * right
    products += left * right
    largestDifference = Math.max(largestDifference, Math.abs(left - right))
  }
  const leftLevel = frames === 0 ? 0 : Math.sqrt(leftSquares / frames)
  const rightLevel = frames === 0 ? 0 : Math.sqrt(rightSquares / frames)
  const silent = leftLevel <= SILENCE_THRESHOLD || rightLevel <= SILENCE_THRESHOLD
  return {
    correlation: leftSquares === 0 || rightSquares === 0 ? undefined : products / Math.sqrt(leftSquares * rightSquares),
    balance: silent ? undefined : 20 * Math.log10(leftLevel / rightLevel),
    identical: frames > 0 && largestDifference <= IDENTICAL_LEVEL,
  }
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
