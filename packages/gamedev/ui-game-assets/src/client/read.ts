/**
 * Reading an asset and naming the files it refers to. The viewed file arrives through `workspaceFiles.readBytes`: one
 * complete read, or, for a file above the Host's complete-file cap, consecutive byte windows up to the configured
 * preview cap. Files a model or material names, such as textures, glTF buffers, and OBJ material libraries, load by URL
 * from the authenticated `/api/file` route, resolved against the viewed file's absolute path and only inside the
 * project folder; a name that leaves the project, a web address, and any path the route does not serve load nothing.
 */
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'

/** The viewed file's bytes and identity. */
export interface AssetFile {
  /** The complete file. */
  readonly data: Uint8Array<ArrayBuffer>
  /** Absolute path in the Host's filesystem, which related files resolve against. */
  readonly absolutePath: string
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
const WINDOWED_ATTEMPTS = 2

/**
 * A workspace path as the Host's `workspaceFiles.readBytes` reads it inside the workspace. The Host reads a path whose
 * first segment is `~` in the home folder, so a relative path through a folder named `~` is sent as `./~/…`.
 * @param path - workspace path, relative to the workspace folder or absolute.
 * @returns the path to send.
 */
export function readablePath(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? `./${path}` : path
}

/**
 * Read a complete asset. A file above the Host's complete-file cap is read window by window; a file larger than
 * `maxBytes` fails with `workspace-file/too-large` naming `maxBytes`, and one that keeps changing while its windows
 * are read fails with `game-assets/changed`.
 * @param read - the bound byte read.
 * @param path - workspace path of the asset.
 * @param maxBytes - the largest file the viewer reads.
 * @param signal - cancellation.
 * @returns the file, or the failure to show.
 */
export async function readAsset(read: ReadBytes, path: string, maxBytes: number, signal: AbortSignal): Promise<RemoteResult<AssetFile>> {
  const whole = await read(path, {}, signal)
  if (whole.ok) {
    if (whole.value.data.byteLength > maxBytes) return tooLarge(path, maxBytes)
    return { ok: true, value: { data: whole.value.data, absolutePath: whole.value.absolutePath, version: whole.value.version } }
  }
  if (whole.error.code !== 'workspace-file/too-large') return whole
  for (let attempt = 0; attempt < WINDOWED_ATTEMPTS; attempt += 1) {
    const result = await readWindows(read, path, maxBytes, signal)
    if (result !== 'changed') return result
  }
  return { ok: false, error: new RemoteError('game-assets/changed', `"${path}" kept changing while it was read`, { path }) }
}

function tooLarge(path: string, limit: number): RemoteResult<never> {
  return { ok: false, error: new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${limit} byte preview cap`, { path, limit }) }
}

/**
 * Read a file window by window from its start.
 * @returns the file; a failure; or `changed` when the version moved between windows or the file ended early.
 */
async function readWindows(
  read: ReadBytes,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<RemoteResult<AssetFile> | 'changed'> {
  const first = await read(path, { range: {} }, signal)
  if (!first.ok) return first
  const { version, absolutePath, bytes: size } = first.value
  if (size !== undefined && size > maxBytes) return tooLarge(path, maxBytes)
  const chunks: Uint8Array<ArrayBuffer>[] = [first.value.data]
  let total = first.value.data.byteLength
  let eof = first.value.eof
  while (!eof) {
    const window = await read(path, { range: { offset: total } }, signal)
    if (!window.ok) return window
    if (window.value.version !== version || window.value.data.byteLength === 0) return 'changed'
    chunks.push(window.value.data)
    total += window.value.data.byteLength
    if (total > maxBytes) return tooLarge(path, maxBytes)
    eof = window.value.eof
  }
  if (size !== undefined && total !== size) return 'changed'
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, value: { data, absolutePath, version } }
}

/** Whether a path is absolute on POSIX, on Windows with a drive, or as a UNC path. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

/** Whether a path is spelled for Windows: with a drive or as a UNC path. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

/** A URL scheme of two letters or more, which a Windows drive such as `C:` is not. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]+:/u

/**
 * The project folder a file was read from: its absolute path without the segments of its workspace path, compared
 * without regard to case, as a case-insensitive filesystem may report them. A workspace path that is absolute, that
 * steps through `.` or `..`, or whose segments the absolute path does not end with, as when a link inside the project
 * leads elsewhere, gives the file's own folder.
 * @param absolutePath - the file's absolute path as the Host resolved it, in either separator spelling.
 * @param path - the workspace path it was read by.
 * @returns the folder, in the absolute path's spelling.
 */
export function projectRootOf(absolutePath: string, path: string): string {
  const separator = isWindowsPath(absolutePath) ? '\\' : '/'
  const segments = absolutePath.split(/[\\/]/u)
  const own = segments.slice(0, -1).join(separator)
  const relative = path.split(/[\\/]/u).filter(segment => segment !== '')
  if (isAbsolutePath(path) || relative.length === 0 || relative.some(segment => segment === '.' || segment === '..')) return own
  const tail = segments.slice(-relative.length)
  if (tail.length !== relative.length || tail.some((segment, index) => segment.toLowerCase() !== relative[index]?.toLowerCase())) return own
  return segments.slice(0, -relative.length).join(separator)
}

/**
 * Resolve a file a model or material names against the viewed file, inside the project folder. A relative name
 * resolves against the viewed file's folder; an absolute name, often a path on the computer that authored the asset,
 * resolves to its file name in that folder, where game projects keep their textures.
 * @param base - absolute path of the viewed file, in either separator spelling.
 * @param reference - the name as the asset stores it, URL-decoded.
 * @param root - the project folder, which holds the viewed file.
 * @returns the absolute path to load, in the base's separator spelling, or undefined for a name that `..` leads out of
 * the project folder.
 */
export function resolveRelated(base: string, reference: string, root: string): string | undefined {
  const separator = isWindowsPath(base) ? '\\' : '/'
  const normalizedBase = base.replaceAll('\\', '/')
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '')
  const folder = normalizedBase.slice(0, normalizedBase.lastIndexOf('/'))
  const inside = folder === normalizedRoot ? '' : folder.startsWith(`${normalizedRoot}/`) ? folder.slice(normalizedRoot.length + 1) : undefined
  if (inside === undefined) return undefined
  const segments = inside.split('/').filter(segment => segment !== '')
  const normalizedReference = reference.replaceAll('\\', '/')
  const relative = isAbsolutePath(reference)
    ? normalizedReference.slice(normalizedReference.lastIndexOf('/') + 1)
    : normalizedReference
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return [normalizedRoot, ...segments].join('/').replaceAll('/', separator)
}

/**
 * The URL of a file a model or material names, served by the authenticated `/api/file` route from inside the project.
 * @param baseUri - the page's base URI, which carries the deployment prefix or the Desktop scheme.
 * @param base - absolute path of the viewed file.
 * @param path - the viewed file's workspace path, which places the project folder in `base`.
 * @param reference - the name as the loader requested it; `data:` and `blob:` URLs pass through.
 * @returns the URL to fetch, or undefined for a file that does not load: a web address or other URL, a name outside
 * the project, or a path the route does not serve, such as one with a control character or on a UNC share.
 */
export function relatedUrl(baseUri: string, base: string, path: string, reference: string): string | undefined {
  if (/^(?:data|blob):/iu.test(reference)) return reference
  let decoded = reference
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    // URIError: a reference with a stray `%` is a literal file name, so it resolves as written.
  }
  if (URL_SCHEME.test(reference) || URL_SCHEME.test(decoded)) return undefined
  const resolved = resolveRelated(base, decoded, projectRootOf(base, path))
  return resolved === undefined ? undefined : fileMediaUrl(baseUri, resolved)
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The viewed file changed between the byte windows of every attempt to read it. */
    'game-assets/changed': { readonly path: string }
  }
}
