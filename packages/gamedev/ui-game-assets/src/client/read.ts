/**
 * Reading an asset and naming the files it refers to. The viewed file arrives through `workspaceFiles.readBytes`: one
 * complete read, or, for a file above the Host's complete-file cap, consecutive byte windows up to the configured
 * preview cap. Files a model or material names, such as textures, glTF buffers, and OBJ material libraries, load by URL
 * from the authenticated `/api/file` route, resolved against the viewed file's absolute path.
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

/**
 * Resolve a file a model or material names against the viewed file. A relative name resolves against the viewed file's
 * folder; an absolute name, often a path on the computer that authored the asset, resolves to its file name in that
 * folder, where game projects keep their textures.
 * @param base - absolute path of the viewed file, in either separator spelling.
 * @param reference - the name as the asset stores it, URL-decoded.
 * @returns the absolute path to load, in the base's separator spelling.
 */
export function resolveRelated(base: string, reference: string): string {
  const windows = /^[A-Za-z]:[\\/]/u.test(base) || base.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  const normalizedBase = base.replaceAll('\\', '/')
  const folder = normalizedBase.slice(0, normalizedBase.lastIndexOf('/'))
  const normalizedReference = reference.replaceAll('\\', '/')
  const relative = isAbsolutePath(reference)
    ? normalizedReference.slice(normalizedReference.lastIndexOf('/') + 1)
    : normalizedReference
  const prefix = folder.startsWith('//') ? '//' : folder.startsWith('/') ? '/' : ''
  const segments = folder.slice(prefix.length).split('/').filter(segment => segment !== '')
  // The first segment of a Windows path is its drive, which `..` never removes.
  const floor = windows && prefix === '' ? 1 : 0
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > floor) segments.pop()
      continue
    }
    segments.push(segment)
  }
  const joined = `${prefix}${segments.join('/')}`
  return windows ? joined.replaceAll('/', separator) : joined
}

/**
 * The URL of a file a model or material names, served by the authenticated `/api/file` route.
 * @param baseUri - the page's base URI, which carries the deployment prefix or the Desktop scheme.
 * @param base - absolute path of the viewed file.
 * @param reference - the name as the loader requested it; `data:` and `blob:` URLs pass through.
 * @returns the URL to fetch, or the reference itself when it is already loadable or cannot be served.
 */
export function relatedUrl(baseUri: string, base: string, reference: string): string {
  if (/^(?:data|blob):/iu.test(reference)) return reference
  let decoded = reference
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    // URIError: a reference with a stray `%` is a literal file name, so it resolves as written.
  }
  return fileMediaUrl(baseUri, resolveRelated(base, decoded)) ?? reference
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The viewed file changed between the byte windows of every attempt to read it. */
    'game-assets/changed': { readonly path: string }
  }
}
