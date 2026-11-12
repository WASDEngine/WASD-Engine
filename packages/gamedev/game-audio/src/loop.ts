/**
 * The loop a game plays of a sound, from how Godot imports it and the loop points a WAV file stores: the stretch whose
 * end jumps back to its start at each repeat, whose seam `audio_review` asks the window to measure and its text names.
 * @module @deepseek-ai/dsh-game-audio/src/loop
 */
import type { AudioProbe } from './audio/probe.ts'
import type { GodotImport } from './files.ts'
import type { AudioLoop } from './types.ts'

/** What places a loop: Godot's import settings, the WAV file's sampler chunk, or neither, so the whole sound repeats. */
export type LoopSource = 'import' | 'file' | 'whole'

/** How the game repeats a sound. */
export type PlayedLoop =
  /** At each repeat playback jumps from the stretch's end back to its start; `loops` tells whether Godot repeats it. */
  | { readonly kind: 'jump'; readonly from: LoopSource; readonly loops: boolean; readonly stretch: AudioLoop }
  /** Godot plays the loop forward and backward, so playback turns at its ends without a jump. */
  | { readonly kind: 'ping-pong' }
  /** The loop's points are sample frames, and the file's header names no sample rate to place them. */
  | { readonly kind: 'unplaced'; readonly from: Exclude<LoopSource, 'whole'>; readonly loops: boolean }

/**
 * The loop a game plays of a sound. Godot follows a WAV file's own loop points by default and on its `file` loop mode,
 * jumping back when playback reaches the loop's end frame. A sound that Godot does not repeat, and one that it has not
 * imported and that stores no loop points, repeats whole when it repeats at all.
 * @param godot - how Godot imports the sound, when it has.
 * @param probe - what the sound's headers say: its sample rate and the loop a WAV file stores.
 * @returns the loop.
 */
export function playedLoop(godot: GodotImport | undefined, probe: AudioProbe | undefined): PlayedLoop {
  const whole = (loops: boolean): PlayedLoop => ({ kind: 'jump', from: 'whole', loops, stretch: { start: 0 } })
  const inFrames = (from: Exclude<LoopSource, 'whole'>, loops: boolean, start: number, end: number | undefined): PlayedLoop => {
    const rate = probe?.sampleRate
    if (rate === undefined) return { kind: 'unplaced', from, loops }
    return { kind: 'jump', from, loops, stretch: { start: start / rate, ...end === undefined ? {} : { end: end / rate } } }
  }
  const fileLoop = probe?.loop
  if (godot === undefined || godot.loop === 'file') {
    if (fileLoop === undefined) return whole(false)
    return inFrames('file', godot !== undefined, fileLoop.start, fileLoop.end)
  }
  switch (godot.loop) {
    case 'off':
      return whole(false)
    case 'ping-pong':
      return { kind: 'ping-pong' }
    case 'forward':
    case 'backward':
      // A backward loop jumps between the same two frames as a forward one, the other way.
      if (godot.importer === 'wav') {
        if (godot.loopStart === undefined && godot.loopEnd === undefined) return whole(true)
        return inFrames('import', true, godot.loopStart ?? 0, godot.loopEnd)
      }
      // Ogg and MP3 imports loop to the end of the sound and back to their offset in seconds.
      return godot.loopStart === undefined ? whole(true) : { kind: 'jump', from: 'import', loops: true, stretch: { start: godot.loopStart } }
  }
}
