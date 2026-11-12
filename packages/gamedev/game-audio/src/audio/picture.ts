/**
 * The picture of a sound that the audio tools return to agents: the waveform of each channel above a spectrogram of
 * the channel mix, on a dark background, with grid lines whose spacing {@link describeAudioImage} states. The image is
 * raw RGB, which the Host encodes as PNG and a browser draws on a canvas.
 *
 * @module
 */

import { magnitudeSpectrum, type AudioSamples } from './measure.ts'

/** An 8-bit RGB image: `width * height` pixels of 3 bytes each, rows from top to bottom. */
export interface RgbImage {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

/** Image width in pixels: one waveform column and one spectrogram column per pixel. */
export const IMAGE_WIDTH = 1024

/** Height of each waveform panel. */
const WAVEFORM_HEIGHT = 112

/** Height of the spectrogram panel. */
const SPECTROGRAM_HEIGHT = 288

/** Space between panels and around the image. */
const GAP = 6

/** Waveform panels drawn: one per channel up to this count, otherwise one panel of the channel mix. */
const MAX_WAVEFORM_PANELS = 2

/** Lowest frequency of the spectrogram's logarithmic axis. */
const LOWEST_FREQUENCY = 20

/** Frequencies of the spectrogram's horizontal grid lines. */
const FREQUENCY_LINES = [100, 1000, 10_000] as const

/** Dynamic range of the spectrogram: levels this far below a full-scale sine draw as background. */
const RANGE_DB = 90

/** FFT size of a spectrogram column. */
const SPECTROGRAM_SIZE = 2048

/** Candidate spacings of the vertical time lines, in seconds; the image uses the first that draws at most 12 lines. */
const TIME_STEPS: readonly number[] = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]

/** Spacing of the time lines for windows too long for every candidate. */
const LONGEST_TIME_STEP = 120

type Color = readonly [number, number, number]

const BACKGROUND: Color = [17, 19, 24]
const PANEL: Color = [24, 27, 34]
const GRID: Color = [52, 58, 70]
const WAVE: Color = [96, 200, 240]
const CLIP: Color = [255, 82, 82]

/** Spectrogram colors from silence to full scale. */
const HEAT: readonly Color[] = [[0, 0, 4], [40, 11, 84], [120, 28, 109], [196, 61, 76], [246, 132, 29], [252, 255, 164]]

/** What the image shows, for the text that accompanies it. */
export interface AudioImageLayout {
  readonly width: number
  readonly height: number
  /** Waveform panels: one per channel, or one of the channel mix. */
  readonly waveformPanels: 'channels' | 'mix'
  /** Seconds between vertical grid lines. */
  readonly timeStep: number
  /** Highest frequency of the spectrogram: half the sample rate. */
  readonly nyquist: number
}

class Canvas {
  readonly pixels: Uint8Array

  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 3)
  }

  set(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.pixels.set(color, (y * this.width + x) * 3)
  }

  fill(x: number, y: number, width: number, height: number, color: Color): void {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) this.set(column, row, color)
  }
}

function timeStep(seconds: number): number {
  return TIME_STEPS.find(step => seconds / step <= 12) ?? LONGEST_TIME_STEP
}

function heat(level: number): Color {
  const position = Math.min(1, Math.max(0, level)) * (HEAT.length - 1)
  const index = Math.min(HEAT.length - 2, Math.floor(position))
  const low = HEAT[index] ?? BACKGROUND
  const high = HEAT[index + 1] ?? BACKGROUND
  const t = position - index
  const mix = (from: number, to: number): number => Math.round(from + (to - from) * t)
  return [mix(low[0], high[0]), mix(low[1], high[1]), mix(low[2], high[2])]
}

/** Sample value of a waveform panel: one channel, or the mean of all channels. */
function sampleAt(audio: AudioSamples, frame: number, channel: number | undefined): number {
  if (channel !== undefined) return audio.samples[frame * audio.channels + channel] ?? 0
  let mix = 0
  for (let index = 0; index < audio.channels; index++) mix += audio.samples[frame * audio.channels + index] ?? 0
  return mix / audio.channels
}

function drawWaveform(canvas: Canvas, audio: AudioSamples, top: number, channel: number | undefined): void {
  const width = canvas.width - 2 * GAP
  canvas.fill(GAP, top, width, WAVEFORM_HEIGHT, PANEL)
  const middle = top + Math.floor(WAVEFORM_HEIGHT / 2)
  const scale = WAVEFORM_HEIGHT / 2 - 1
  for (let column = 0; column < width; column++) canvas.set(GAP + column, middle, GRID)
  for (let column = 0; column < width; column++) {
    const start = Math.floor(column * audio.frames / width)
    const end = Math.max(start + 1, Math.floor((column + 1) * audio.frames / width))
    if (start >= audio.frames) break
    let low = Infinity
    let high = -Infinity
    let clipped = false
    for (let frame = start; frame < Math.min(end, audio.frames); frame++) {
      const value = sampleAt(audio, frame, channel)
      low = Math.min(low, value)
      high = Math.max(high, value)
      if (Math.abs(value) >= 1) clipped = true
    }
    const color = clipped ? CLIP : WAVE
    const y1 = middle - Math.round(Math.min(1, high) * scale)
    const y2 = middle - Math.round(Math.max(-1, low) * scale)
    for (let y = y1; y <= y2; y++) canvas.set(GAP + column, y, color)
  }
}

function drawSpectrogram(canvas: Canvas, audio: AudioSamples, top: number): void {
  const width = canvas.width - 2 * GAP
  const nyquist = audio.sampleRate / 2
  const binWidth = audio.sampleRate / SPECTROGRAM_SIZE
  const full = SPECTROGRAM_SIZE / 4
  const span = Math.log(nyquist / LOWEST_FREQUENCY)
  // Each row covers a band of the logarithmic axis; it shows the strongest bin inside the band, or the nearest bin.
  const rows = Array.from({ length: SPECTROGRAM_HEIGHT }, (_, row) => {
    const upper = LOWEST_FREQUENCY * Math.exp(span * (1 - row / SPECTROGRAM_HEIGHT))
    const lower = LOWEST_FREQUENCY * Math.exp(span * (1 - (row + 1) / SPECTROGRAM_HEIGHT))
    const first = Math.round(lower / binWidth)
    return { first, last: Math.max(first, Math.round(upper / binWidth)) }
  })
  for (let column = 0; column < width; column++) {
    const spectrum = magnitudeSpectrum(audio, Math.floor((column + 0.5) * audio.frames / width), SPECTROGRAM_SIZE)
    rows.forEach(({ first, last }, row) => {
      let magnitude = 0
      for (let bin = first; bin <= last; bin++) magnitude = Math.max(magnitude, spectrum[bin] ?? 0)
      const level = magnitude <= 0 ? 0 : 1 + 20 * Math.log10(magnitude / full) / RANGE_DB
      canvas.set(GAP + column, top + row, heat(level))
    })
  }
  for (const frequency of FREQUENCY_LINES) {
    if (frequency >= nyquist) continue
    const row = Math.round(SPECTROGRAM_HEIGHT * (1 - Math.log(frequency / LOWEST_FREQUENCY) / span))
    for (let column = 0; column < width; column += 4) canvas.set(GAP + column, top + row, GRID)
  }
}

/**
 * Draw the waveform and spectrogram of an audio window.
 * @param audio - interleaved samples.
 * @returns the RGB image and what it shows.
 */
export function drawAudioImage(audio: AudioSamples): { readonly image: RgbImage; readonly layout: AudioImageLayout } {
  const panels = audio.channels <= MAX_WAVEFORM_PANELS ? audio.channels : 1
  const height = GAP + panels * (WAVEFORM_HEIGHT + GAP) + SPECTROGRAM_HEIGHT + GAP
  const canvas = new Canvas(IMAGE_WIDTH, height)
  canvas.fill(0, 0, IMAGE_WIDTH, height, BACKGROUND)
  for (let panel = 0; panel < panels; panel++) {
    drawWaveform(canvas, audio, GAP + panel * (WAVEFORM_HEIGHT + GAP), panels === audio.channels ? panel : undefined)
  }
  const spectrogramTop = GAP + panels * (WAVEFORM_HEIGHT + GAP)
  drawSpectrogram(canvas, audio, spectrogramTop)
  const seconds = audio.frames / audio.sampleRate
  const step = timeStep(seconds)
  const width = IMAGE_WIDTH - 2 * GAP
  for (let time = step; time < seconds; time += step) {
    const column = GAP + Math.round(time / seconds * width)
    for (let y = GAP; y < height - GAP; y += 3) canvas.set(column, y, GRID)
  }
  return {
    image: { width: IMAGE_WIDTH, height, pixels: canvas.pixels },
    layout: { width: IMAGE_WIDTH, height, waveformPanels: panels === audio.channels ? 'channels' : 'mix', timeStep: step, nyquist: audio.sampleRate / 2 },
  }
}

function formatFrequency(hertz: number): string {
  return hertz >= 1000 ? `${String(Number((hertz / 1000).toFixed(2)))} kHz` : `${String(Math.round(hertz))} Hz`
}

function formatStep(seconds: number): string {
  return seconds < 1 ? `${String(Math.round(seconds * 1000))} ms` : `${String(seconds)} s`
}

/**
 * The sentence that tells the agent how to read the image.
 * @param layout - what {@link drawAudioImage} drew.
 * @returns one paragraph.
 */
export function describeAudioImage(layout: AudioImageLayout): string {
  const waveforms = layout.waveformPanels === 'channels' ? 'the waveform of each channel' : 'the waveform of the channel mix'
  const lines = FREQUENCY_LINES.filter(frequency => frequency < layout.nyquist).map(formatFrequency)
  return `Image (${String(layout.width)} x ${String(layout.height)}): ${waveforms} at the top (full scale is the panel height; red columns reach full scale), `
    + `and below it the spectrogram of the channel mix (time runs left to right; frequency rises from ${String(LOWEST_FREQUENCY)} Hz at the bottom `
    + `to ${formatFrequency(layout.nyquist)} at the top on a logarithmic axis${lines.length === 0 ? '' : `, with dotted lines at ${lines.join(', ')}`}; `
    + `brighter is louder over a ${String(RANGE_DB)} dB range). Dotted vertical lines mark every ${formatStep(layout.timeStep)}.`
}
