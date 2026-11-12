/**
 * Reading sounds through `workspaceFiles.readBytes`: a complete file in one read, or, above the Host's complete-file
 * cap, in consecutive byte windows up to the configured cap; and the small windows a header probe asks for.
 */
import type { ByteReader } from '@deepseek-ai/dsh-game-audio/audio'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** A sound file's bytes and identity. */
export interface SoundFile {
  /** The complete file. */
  readonly data: Uint8Array<ArrayBuffer>
  /** The file's version when it was read. */
  readonly version: string
}

/**
 * Read one file or byte window of the Session's workspace.
 * @param path - workspace path.
 * @param options - the window; `{}` reads the complete file.
 * @param signal - cancellation.
 * @returns the bytes with the file's version and size, or the Remote failure.
 */
export type ReadBytes = (
  path: string,
  options: WorkspaceByteReadOptions,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>>

/** Times a windowed read starts over after the file changed between two windows. */
const WINDOW_ATTEMPTS = 2

function tooLarge(path: string, limit: number): RemoteResult<never> {
  return { ok: false, error: new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${String(limit)} byte cap`, { path, limit }) }
}

/**
 * Read a file in byte windows from its start.
 * @returns the file; a failure; or `changed` when its version moved or it ended early.
 */
async function readInWindows(read: ReadBytes, path: string, maxBytes: number, signal: AbortSignal): Promise<RemoteResult<SoundFile> | 'changed'> {
  const pieces: Uint8Array<ArrayBuffer>[] = []
  let filled = 0
  let version: string | undefined
  let size: number | undefined
  for (;;) {
    const window = await read(path, { range: { offset: filled } }, signal)
    if (!window.ok) return window
    if (version === undefined) {
      version = window.value.version
      size = window.value.bytes
      if (size !== undefined && size > maxBytes) return tooLarge(path, maxBytes)
    } else if (window.value.version !== version) {
      return 'changed'
    }
    pieces.push(window.value.data)
    filled += window.value.data.byteLength
    if (filled > maxBytes) return tooLarge(path, maxBytes)
    if (window.value.eof) break
    if (window.value.data.byteLength === 0) return 'changed'
  }
  if (size !== undefined && filled !== size) return 'changed'
  const data = new Uint8Array(filled)
  let at = 0
  for (const piece of pieces) {
    data.set(piece, at)
    at += piece.byteLength
  }
  return { ok: true, value: { data, version } }
}

/**
 * Read a complete sound. A file above the Host's complete-file cap is read window by window; a file larger than
 * `maxBytes` fails with `workspace-file/too-large` naming `maxBytes`, and one that keeps changing while its windows are
 * read fails with `game-audio/changed`.
 * @param read - the bound byte read.
 * @param path - workspace path of the sound.
 * @param maxBytes - the largest file to read.
 * @param signal - cancellation.
 * @returns the file, or the failure to show.
 */
export async function readSound(read: ReadBytes, path: string, maxBytes: number, signal: AbortSignal): Promise<RemoteResult<SoundFile>> {
  const complete = await read(path, {}, signal)
  if (complete.ok) {
    return complete.value.data.byteLength > maxBytes
      ? tooLarge(path, maxBytes)
      : { ok: true, value: { data: complete.value.data, version: complete.value.version } }
  }
  if (complete.error.code !== 'workspace-file/too-large') return complete
  for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt += 1) {
    const windowed = await readInWindows(read, path, maxBytes, signal)
    if (windowed !== 'changed') return windowed
  }
  return { ok: false, error: new RemoteError('game-audio/changed', `"${path}" kept changing while it was read`, { path }) }
}

/**
 * A header probe's reader over byte windows of one workspace file. A failed window reads as no bytes, which ends the
 * probe without facts.
 * @param read - the bound byte read.
 * @param path - workspace path of the sound.
 * @param signal - cancellation.
 * @returns the reader.
 */
export function windowReader(read: ReadBytes, path: string, signal: AbortSignal): ByteReader {
  return async (offset, length) => {
    const window = await read(path, { range: { offset, length } }, signal)
    return window.ok ? window.value.data : new Uint8Array(0)
  }
}

/**
 * A header probe's reader over a file already in memory.
 * @param data - the file.
 * @returns the reader.
 */
export function memoryReader(data: Uint8Array): ByteReader {
  return (offset, length) => Promise.resolve(data.subarray(offset, Math.min(data.byteLength, offset + length)))
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The sound changed between the byte windows of every attempt to read it. */
    'game-audio/changed': { readonly path: string }
  }
}
