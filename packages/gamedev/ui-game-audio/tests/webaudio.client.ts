/**
 * Web Audio stand-ins for jsdom, which has none: an AudioBuffer, an OfflineAudioContext whose decoder reads 16-bit PCM
 * WAV files, an AudioContext with a clock the spec moves, and the bytes of small WAV files.
 */
import { vi } from 'vitest'

/** An AudioBuffer: planar channels of float samples. */
export class FakeAudioBuffer implements AudioBuffer {
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly planes: Float32Array<ArrayBuffer>[]

  /** @param options - frames, channels, and rate. */
  constructor(options: { readonly length: number; readonly numberOfChannels: number; readonly sampleRate: number }) {
    this.length = options.length
    this.numberOfChannels = options.numberOfChannels
    this.sampleRate = options.sampleRate
    this.planes = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length))
  }

  /** @returns seconds of sound. */
  get duration(): number {
    return this.length / this.sampleRate
  }

  /** @param channel - channel index. @returns its samples. */
  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    const plane = this.planes[channel]
    if (plane === undefined) throw new RangeError(`no channel ${String(channel)}`)
    return plane
  }

  /** @param destination - receives the samples. @param channel - channel index. @param start - first frame. */
  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, start = 0): void {
    destination.set(this.getChannelData(channel).subarray(start, start + destination.length))
  }

  /** @param source - the samples. @param channel - channel index. @param start - first frame. */
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, start = 0): void {
    this.getChannelData(channel).set(source, start)
  }
}

/**
 * A 16-bit PCM WAV file.
 * @param options - rate, channels, and the interleaved samples from -1 to 1.
 * @returns the file bytes.
 */
export function wavFile(options: {
  readonly sampleRate: number
  readonly channels: number
  readonly samples: readonly number[]
}): Uint8Array<ArrayBuffer> {
  const data = options.samples.length * 2
  const view = new DataView(new ArrayBuffer(44 + data))
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < 4; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, options.channels, true)
  view.setUint32(24, options.sampleRate, true)
  view.setUint32(28, options.sampleRate * options.channels * 2, true)
  view.setUint16(32, options.channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, data, true)
  options.samples.forEach((value, index) => { view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32_767), true) })
  return new Uint8Array(view.buffer)
}

/** Decode a 16-bit PCM WAV file as the stand-in decoder does: at its own rate, or reject. */
function decodeWav(data: ArrayBuffer): FakeAudioBuffer {
  const view = new DataView(data)
  const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (tag !== 'RIFF' || view.byteLength < 44) throw Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' })
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const frames = view.getUint32(40, true) / 2 / channels
  const buffer = new FakeAudioBuffer({ length: frames, numberOfChannels: channels, sampleRate })
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      buffer.getChannelData(channel)[frame] = view.getInt16(44 + (frame * channels + channel) * 2, true) / 32_767
    }
  }
  return buffer
}

/** An OfflineAudioContext that decodes 16-bit WAV files; it records the rates it was made with. */
export class FakeOfflineAudioContext {
  static readonly rates: number[] = []
  /** @param options - the context's rate. */
  constructor(options: { readonly sampleRate: number }) {
    FakeOfflineAudioContext.rates.push(options.sampleRate)
  }

  /** @param data - the file. @returns the decoded sound. */
  decodeAudioData(data: ArrayBuffer): Promise<FakeAudioBuffer> {
    try {
      return Promise.resolve(decodeWav(data))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/** One source a fake AudioContext made. */
export interface FakeSource {
  buffer: AudioBuffer | null
  loop: boolean
  onended: ((event: Event) => void) | null
  readonly started: (readonly [number, number])[]
  stopped: boolean
  connect(destination: object): unknown
  disconnect(): void
  start(when: number, offset: number): void
  stop(): void
}

/** An AudioContext whose clock the spec sets and whose sources it inspects. */
export class FakeAudioContext {
  static readonly made: FakeAudioContext[] = []
  currentTime = 0
  state: 'suspended' | 'running' | 'closed' = 'running'
  readonly destination = {}
  readonly sources: FakeSource[] = []
  readonly gains: { readonly gain: { value: number } }[] = []
  readonly resume = vi.fn(() => Promise.resolve())
  readonly close = vi.fn(() => {
    this.state = 'closed'
    return Promise.resolve()
  })

  constructor() {
    FakeAudioContext.made.push(this)
  }

  /** @returns a gain node. */
  createGain(): { readonly gain: { value: number }; connect(destination: object): unknown } {
    const gain = { gain: { value: 1 }, connect: (destination: object): unknown => destination }
    this.gains.push(gain)
    return gain
  }

  /** @returns a buffer source. */
  createBufferSource(): FakeSource {
    const source: FakeSource = {
      buffer: null, loop: false, onended: null, started: [], stopped: false,
      connect: destination => destination,
      disconnect() {},
      start(when, offset) { this.started.push([when, offset]) },
      stop() { this.stopped = true },
    }
    this.sources.push(source)
    return source
  }
}

/**
 * Install the stand-ins as browser globals for one spec.
 * @returns the AudioContext class, whose instances the spec reads.
 */
export function installWebAudio(): typeof FakeAudioContext {
  FakeAudioContext.made.length = 0
  FakeOfflineAudioContext.rates.length = 0
  vi.stubGlobal('AudioBuffer', FakeAudioBuffer)
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return FakeAudioContext
}
