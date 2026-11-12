/**
 * Playback of the Audio tab: one AudioContext for the window, playing one sound at a time. A tab loads its decoded
 * sound under a key of its own and plays, pauses, seeks, and loops it; loading under another key stops the sound that
 * played, so two Sessions' tabs never play at once. The context starts on the first play, which follows a click or a
 * key press as browsers require, and a loop repeats the whole sound sample-accurately, so a seam sounds as the game
 * plays it.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What plays, as the tabs follow it. */
export interface PlaybackState {
  /** Key of the loaded sound; undefined before a load and after a release. */
  readonly key: string | undefined
  readonly playing: boolean
  /** Whether the sound repeats from its start when it ends. */
  readonly loop: boolean
  /** Linear volume from 0 to 1. */
  readonly volume: number
}

/** What the player uses of a source node: an AudioBufferSourceNode in the browser. */
export interface PlayerSource {
  buffer: AudioBuffer | null
  loop: boolean
  onended: ((event: Event) => void) | null
  connect(destination: object): unknown
  disconnect(): void
  start(when: number, offset: number): void
  stop(): void
}

/** What the player uses of an AudioContext. */
export interface PlayerContext {
  readonly currentTime: number
  readonly state: string
  readonly destination: object
  createGain(): { readonly gain: { value: number }; connect(destination: object): unknown }
  createBufferSource(): PlayerSource
  resume(): Promise<void>
  close(): Promise<void>
}

/** The window's player. */
export class AudioPlayback {
  /** What plays. */
  readonly state: SnapshotStore<PlaybackState> = createSnapshotStore<PlaybackState>({
    key: undefined, playing: false, loop: false, volume: 1,
  })
  private context: PlayerContext | undefined
  private gain: ReturnType<PlayerContext['createGain']> | undefined
  private source: PlayerSource | undefined
  private buffer: AudioBuffer | undefined
  /** Seconds into the sound where the current source started, or where playback paused. */
  private offset = 0
  /** Context time when the current source started. */
  private startedAt = 0

  /** @param createContext - makes the window's AudioContext on the first play. */
  constructor(private readonly createContext: () => PlayerContext = () => new AudioContext()) {}

  /**
   * Load a sound to play from its start, stopping the sound that played.
   * @param key - the loading tab's key for the sound.
   * @param buffer - the decoded sound.
   */
  load(key: string, buffer: AudioBuffer): void {
    if (this.state.getSnapshot().key === key && this.buffer === buffer) return
    this.stopSource()
    this.buffer = buffer
    this.offset = 0
    this.state.set({ ...this.state.getSnapshot(), key, playing: false })
  }

  /**
   * Play the loaded sound from where it paused, or from its start after it ended.
   * @param key - the key the sound was loaded under; another key does nothing.
   */
  play(key: string): void {
    const buffer = this.buffer
    if (this.state.getSnapshot().key !== key || buffer === undefined) return
    if (this.offset >= buffer.duration) this.offset = 0
    this.startSource(buffer, this.offset)
    this.state.set({ ...this.state.getSnapshot(), playing: true })
  }

  /**
   * Pause the loaded sound where it is.
   * @param key - the key the sound was loaded under; another key does nothing.
   */
  pause(key: string): void {
    if (this.state.getSnapshot().key !== key || this.source === undefined) return
    this.offset = this.position(key)
    this.stopSource()
    this.state.set({ ...this.state.getSnapshot(), playing: false })
  }

  /**
   * Where the loaded sound plays or paused.
   * @param key - the key the sound was loaded under.
   * @returns seconds into the sound; 0 for another key.
   */
  position(key: string): number {
    const buffer = this.buffer
    if (this.state.getSnapshot().key !== key || buffer === undefined) return 0
    if (this.source === undefined || this.context === undefined) return this.offset
    const reached = this.offset + Math.max(0, this.context.currentTime - this.startedAt)
    return this.state.getSnapshot().loop ? reached % buffer.duration : Math.min(reached, buffer.duration)
  }

  /**
   * Move the loaded sound to a time, playing on from there when it plays.
   * @param key - the key the sound was loaded under; another key does nothing.
   * @param seconds - the time, kept within the sound.
   */
  seek(key: string, seconds: number): void {
    const buffer = this.buffer
    if (this.state.getSnapshot().key !== key || buffer === undefined) return
    this.offset = Math.min(Math.max(0, seconds), buffer.duration)
    if (this.source !== undefined) this.startSource(buffer, this.offset >= buffer.duration ? 0 : this.offset)
  }

  /**
   * Choose whether sounds repeat; a playing sound changes at once and keeps its place.
   * @param loop - whether to repeat.
   */
  setLoop(loop: boolean): void {
    const state = this.state.getSnapshot()
    if (state.loop === loop) return
    const buffer = this.buffer
    const at = state.key === undefined ? 0 : this.position(state.key)
    this.state.set({ ...state, loop })
    if (this.source !== undefined && buffer !== undefined) {
      this.offset = at
      this.startSource(buffer, at)
    }
  }

  /**
   * Set the volume of every sound.
   * @param volume - linear volume, kept from 0 to 1.
   */
  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume))
    if (this.gain !== undefined) this.gain.gain.value = clamped
    this.state.set({ ...this.state.getSnapshot(), volume: clamped })
  }

  /**
   * Stop and forget the loaded sound when it is still the one loaded under a key.
   * @param key - the releasing tab's key.
   */
  release(key: string): void {
    if (this.state.getSnapshot().key !== key) return
    this.stopSource()
    this.buffer = undefined
    this.offset = 0
    this.state.set({ ...this.state.getSnapshot(), key: undefined, playing: false })
  }

  /** Stop playback and close the context. */
  close(): void {
    this.stopSource()
    this.buffer = undefined
    const context = this.context
    this.context = undefined
    this.gain = undefined
    this.state.set({ ...this.state.getSnapshot(), key: undefined, playing: false })
    if (context !== undefined) {
      void context.close().catch(() => {
        // InvalidStateError: the context had closed already, so nothing is left to release.
      })
    }
  }

  private startSource(buffer: AudioBuffer, at: number): void {
    this.stopSource()
    let context = this.context
    let gain = this.gain
    if (context === undefined || gain === undefined) {
      context = this.createContext()
      gain = context.createGain()
      gain.gain.value = this.state.getSnapshot().volume
      gain.connect(context.destination)
      this.context = context
      this.gain = gain
    }
    if (context.state === 'suspended') {
      void context.resume().catch(() => {
        // NotAllowedError: the browser keeps audio off until the next click; the next play tries again.
      })
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.loop = this.state.getSnapshot().loop
    source.connect(gain)
    source.onended = () => {
      if (this.source !== source) return
      this.source = undefined
      this.offset = 0
      this.state.set({ ...this.state.getSnapshot(), playing: false })
    }
    this.offset = at
    this.startedAt = context.currentTime
    source.start(0, at)
    this.source = source
  }

  private stopSource(): void {
    const source = this.source
    this.source = undefined
    if (source === undefined) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // InvalidStateError: the source never started or already stopped, which leaves nothing to stop.
    }
    source.disconnect()
  }
}
