/**
 * Reads of one sound file on the Host: what its headers say, through {@link probeAudio} over a file handle, and how
 * Godot imports it, from the `.import` file Godot writes beside it.
 * @module @deepseek-ai/dsh-game-audio/src/files
 */
import { open, readFile } from 'node:fs/promises'
import { probeAudio, type AudioProbe } from './audio/probe.ts'

/** Sounds probed at once by one call. */
export const PROBE_CONCURRENCY = 8

/**
 * Read what a sound file's headers say.
 * @param path - absolute path of the file.
 * @param bytes - the file's size.
 * @returns the facts; undefined when the file cannot be read or its headers name no format the probe reads.
 */
export async function probeFile(path: string, bytes: number): Promise<AudioProbe | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    // ENOENT or EACCES: a file removed or locked since the walk has nothing to report.
    return undefined
  }
  try {
    return await probeAudio(async (offset, length) => {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, bytes - offset)))
      if (buffer.length === 0) return buffer
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, bytesRead)
    }, bytes)
  } catch {
    // EIO or a file cut short while it was read: report no facts rather than fail the listing.
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Run a function over items with a fixed number running at once.
 * @param items - the inputs.
 * @param limit - most calls in flight.
 * @param run - the function; it must not reject.
 * @returns the results in input order.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** How Godot repeats a sound. */
export type GodotLoop = 'off' | 'forward' | 'ping-pong' | 'backward' | 'file'

/** How Godot imports a sound, from its `.import` file. */
export interface GodotImport {
  /** The importer, such as `wav`, `oggvorbisstr`, or `mp3`. */
  readonly importer: string
  /** `file` follows the loop points the WAV file stores, and loops off without any. */
  readonly loop: GodotLoop
  /** Where the loop starts, in seconds for Ogg and MP3 or in sample frames for WAV, when it does not start at 0. */
  readonly loopStart?: number
  /** WAV: the sample frame where the loop ends, when it ends before the last frame. */
  readonly loopEnd?: number
  /** Beats per minute an Ogg or MP3 import declares for interactive music. */
  readonly bpm?: number
  /** WAV: the import trims silence from both ends. */
  readonly trim?: boolean
  /** WAV: the import normalizes the level. */
  readonly normalize?: boolean
}

/** WAV import loop modes by `edit/loop_mode` value. */
const WAV_LOOPS: readonly GodotLoop[] = ['file', 'off', 'forward', 'ping-pong', 'backward']

/**
 * Read how Godot imports a sound.
 * @param path - absolute path of the sound; Godot keeps `<path>.import` beside it.
 * @returns the import settings, or undefined when Godot has not imported the file.
 */
export async function readGodotImport(path: string): Promise<GodotImport | undefined> {
  let text: string
  try {
    text = await readFile(`${path}.import`, 'utf8')
  } catch {
    // ENOENT: the project has not been opened in Godot since the sound was added, or it is not a Godot project.
    return undefined
  }
  const values = new Map<string, string>()
  let section = ''
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] ?? ''
      continue
    }
    const assignment = /^([^=;\s][^=]*)=(.*)$/u.exec(line)
    if (assignment !== null) values.set(`${section}/${(assignment[1] ?? '').trim()}`, (assignment[2] ?? '').trim().replace(/^"(.*)"$/u, '$1'))
  }
  const importer = values.get('remap/importer')
  if (importer === undefined) return undefined
  const number = (key: string): number | undefined => {
    const value = Number(values.get(`params/${key}`))
    return Number.isFinite(value) ? value : undefined
  }
  if (importer === 'wav') {
    const mode = number('edit/loop_mode') ?? 0
    const begin = number('edit/loop_begin') ?? 0
    const end = number('edit/loop_end') ?? -1
    const loop = WAV_LOOPS[mode] ?? 'off'
    return {
      importer,
      loop,
      ...loop !== 'off' && loop !== 'file' && begin > 0 ? { loopStart: begin } : {},
      ...loop !== 'off' && loop !== 'file' && end >= 0 ? { loopEnd: end } : {},
      ...values.get('params/edit/trim') === 'true' ? { trim: true } : {},
      ...values.get('params/edit/normalize') === 'true' ? { normalize: true } : {},
    }
  }
  const offset = number('loop_offset') ?? 0
  const bpm = number('bpm') ?? 0
  const looping = values.get('params/loop') === 'true'
  return {
    importer,
    loop: looping ? 'forward' : 'off',
    ...looping && offset > 0 ? { loopStart: offset } : {},
    ...bpm > 0 ? { bpm } : {},
  }
}
