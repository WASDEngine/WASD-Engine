/**
 * Reading an asset and the files it names. Every read goes through the Host's `GET /api/game-assets.file` route, which
 * serves a file inside the project folder the read names and refuses one whose real path lies outside that folder's,
 * so that a link inside the project leads no read out of it: the viewed file, its first bytes, the Godot files and
 * sprite sheets of its animations, and the textures, glTF buffers, and OBJ material libraries a model names, which the
 * loaders fetch by the route's URL. A file a model or material names resolves against the viewed file's folder, an
 * absolute name by its file name in that folder, and only inside the project folder; a web address and any other URL
 * load nothing.
 */
import { RemoteError, type RemoteFailure, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** The viewed file's bytes and identity. */
export interface AssetFile {
  /** The complete file. */
  readonly data: Uint8Array<ArrayBuffer>
  /** The file's version when it was read, as the `file` resource names versions. */
  readonly version: string
}

/** The route the Host serves a project's files on, relative to the page's base URI. */
const ROUTE = 'api/game-assets.file'

/** The response header naming the file's version. */
const VERSION_HEADER = 'X-Asset-Version'

/**
 * A workspace path as the Host reads it inside the project folder. The Host reads a path whose first segment is `~` in
 * the home folder, so a relative path through a folder named `~` is sent as `./~/…`.
 * @param path - workspace path, relative to the project folder or absolute.
 * @returns the path to send.
 */
export function readablePath(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? `./${path}` : path
}

/** Whether a path is absolute on POSIX, on Windows with a drive, or as a UNC path. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

/**
 * The route's URL for one file of a project.
 * @param baseUri - the page's base URI, which carries the deployment prefix or the Desktop scheme.
 * @param root - absolute project folder that the read stays inside.
 * @param path - the file, relative to `root` or absolute.
 * @param options - `max`, the largest file to serve; `length`, to read only the file's first bytes.
 * @returns the URL, or undefined where the route reads nothing: a page that is not served over HTTP or the Desktop
 * scheme, a path with a control character, or a folder or file on a UNC share, which a read would reach over the network.
 */
export function assetFileUrl(
  baseUri: string,
  root: string,
  path: string,
  options: { readonly max?: number; readonly length?: number } = {},
): string | undefined {
  if (!/^https?:/u.test(baseUri) && !baseUri.startsWith('dsh-app://app/')) return undefined
  const unsafe = (value: string): boolean => /^[/\\]{2}/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)
  if (!isAbsolutePath(root) || unsafe(root) || path === '' || unsafe(path)) return undefined
  const params = new URLSearchParams({ root, path: readablePath(path) })
  if (options.max !== undefined) params.set('max', String(options.max))
  if (options.length !== undefined) params.set('length', String(options.length))
  return new URL(`${ROUTE}?${params.toString()}`, baseUri).href
}

/** The JSON body of one of the route's refusals. */
interface Refusal {
  readonly code?: unknown
  readonly message?: unknown
  readonly limit?: unknown
}

/**
 * The failure a refused read names.
 * @param path - the file as the read named it.
 * @param status - the route's status.
 * @param body - the route's JSON body.
 * @returns the failure: `workspace-file/not-found`, `workspace-file/too-large` with the cap, `game-assets/outside`,
 * or `game-assets/unreadable`.
 */
function refusal(path: string, status: number, body: Refusal): RemoteFailure {
  // The route's own words, for the agent; the tab shows its localized notice by the failure's code.
  const why = typeof body.message === 'string' ? body.message : `"${path}" could not be read (${String(status)})`
  if (status === 404) return new RemoteError('workspace-file/not-found', why, { path })
  if (status === 413 && typeof body.limit === 'number') return new RemoteError('workspace-file/too-large', why, { path, limit: body.limit })
  if (body.code === 'outside-project') return new RemoteError('game-assets/outside', why, { path })
  return new RemoteError('game-assets/unreadable', why, { path })
}

/**
 * Fetch one file or its first bytes from the route.
 * @returns the response, or the failure to show; rejects with the signal's reason once it aborts.
 */
async function fetchFile(url: string | undefined, path: string, signal: AbortSignal): Promise<RemoteResult<Response>> {
  if (url === undefined) return { ok: false, error: new RemoteError('game-assets/unreadable', `"${path}" is not a file the viewer reads from this page`, { path }) }
  let response: Response
  try {
    response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store' })
  } catch (error) {
    signal.throwIfAborted()
    // TypeError: the request failed, as when the Host is gone.
    return { ok: false, error: new RemoteError('game-assets/unreadable', `"${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`, { path }) }
  }
  if (response.ok) return { ok: true, value: response }
  let body: Refusal = {}
  try {
    body = await response.json() as Refusal
  } catch {
    // SyntaxError: a refusal without a JSON body names its status alone.
  }
  return { ok: false, error: refusal(path, response.status, body) }
}

/**
 * Read a complete asset of a project.
 * @param baseUri - the page's base URI.
 * @param root - absolute project folder that the read stays inside.
 * @param path - workspace path of the asset, relative to `root` or absolute.
 * @param maxBytes - the largest file the viewer reads; a larger one fails with `workspace-file/too-large`.
 * @param signal - cancellation.
 * @returns the file, or the failure to show.
 */
export async function readAsset(
  baseUri: string,
  root: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<RemoteResult<AssetFile>> {
  const response = await fetchFile(assetFileUrl(baseUri, root, path, { max: maxBytes }), path, signal)
  if (!response.ok) return response
  let data: Uint8Array<ArrayBuffer>
  try {
    data = new Uint8Array(await response.value.arrayBuffer())
  } catch (error) {
    signal.throwIfAborted()
    // TypeError: the file changed or the connection ended while it streamed.
    return { ok: false, error: new RemoteError('game-assets/unreadable', `"${path}" could not be read whole: ${error instanceof Error ? error.message : String(error)}`, { path }) }
  }
  if (data.byteLength > maxBytes) return { ok: false, error: new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${String(maxBytes)} byte preview cap`, { path, limit: maxBytes }) }
  return { ok: true, value: { data, version: response.value.headers.get(VERSION_HEADER) ?? '' } }
}

/**
 * Read the first bytes of a project's file.
 * @param baseUri - the page's base URI.
 * @param root - absolute project folder that the read stays inside.
 * @param path - workspace path, relative to `root` or absolute.
 * @param length - most bytes to read.
 * @param signal - cancellation.
 * @returns the bytes, or undefined when the file cannot be read.
 */
export async function readHead(
  baseUri: string,
  root: string,
  path: string,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const response = await fetchFile(assetFileUrl(baseUri, root, path, { length }), path, signal)
  if (!response.ok) return undefined
  try {
    return new Uint8Array(await response.value.arrayBuffer())
  } catch {
    // TypeError: the connection ended; a cancelled read rejects at its next step.
    return undefined
  }
}

/** A URL scheme of two letters or more, which a Windows drive such as `C:` is not. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]+:/u

/**
 * The path, relative to the project folder, of a file a model or material names. A relative name resolves against the
 * viewed file's folder; an absolute name, often a path on the computer that authored the asset, resolves to its file
 * name in that folder, where game projects keep their textures.
 * @param root - absolute project folder.
 * @param path - the viewed file, relative to `root` or absolute inside it.
 * @param reference - the name as the asset stores it, URL-decoded.
 * @returns the `/`-separated path relative to `root`, or undefined for a name that `..` leads out of the project folder
 * and for a viewed file outside it.
 */
export function relatedPath(root: string, path: string, reference: string): string | undefined {
  const slashed = path.replaceAll('\\', '/')
  let inside = slashed
  if (isAbsolutePath(path)) {
    const folder = root.replaceAll('\\', '/').replace(/\/+$/u, '')
    // Windows compares paths without regard to case.
    const fold = (value: string): string => (/^[A-Za-z]:\//u.test(folder) ? value.toLowerCase() : value)
    if (!fold(slashed).startsWith(`${fold(folder)}/`)) return undefined
    inside = slashed.slice(folder.length + 1)
  }
  const segments = inside.split('/').filter(segment => segment !== '' && segment !== '.')
  segments.pop()
  const named = reference.replaceAll('\\', '/')
  const relative = isAbsolutePath(reference) ? named.slice(named.lastIndexOf('/') + 1) : named
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * The URL of a file a model or material names, served by the route from inside the project folder.
 * @param baseUri - the page's base URI, which carries the deployment prefix or the Desktop scheme.
 * @param root - absolute project folder.
 * @param path - the viewed file, relative to `root` or absolute inside it.
 * @param reference - the name as the loader requested it; `data:` and `blob:` URLs pass through.
 * @param maxBytes - the largest file the route serves for it.
 * @returns the URL to fetch, or undefined for a file that does not load: a web address or other URL, a name outside the
 * project, or a path the route does not serve, such as one with a control character or on a UNC share.
 */
export function relatedUrl(baseUri: string, root: string, path: string, reference: string, maxBytes: number): string | undefined {
  if (/^(?:data|blob):/iu.test(reference)) return reference
  let decoded = reference
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    // URIError: a reference with a stray `%` is a literal file name, so it resolves as written.
  }
  if (URL_SCHEME.test(reference) || URL_SCHEME.test(decoded)) return undefined
  const resolved = relatedPath(root, path, decoded)
  return resolved === undefined ? undefined : assetFileUrl(baseUri, root, resolved, { max: maxBytes })
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The file's real path lies outside the project folder, as through a link inside the project. */
    'game-assets/outside': { readonly path: string }
    /** The file could not be read: no project folder to read it from, a failed request, or a refusal of its own. */
    'game-assets/unreadable': { readonly path: string }
  }
}
