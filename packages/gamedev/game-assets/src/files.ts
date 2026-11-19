/**
 * `GET /api/game-assets.file`: the bytes of one file inside a game project, as the Assets tab and the pictures it draws
 * for agents read them: the viewed asset, the first bytes that size an image, the Godot files and sprite sheets that
 * define its animations, and the textures, buffers, and material libraries a model names. The request names the
 * project folder (`root`) and the file (`path`, relative to the folder or absolute); the route resolves both to their
 * real paths, following every link, and refuses a file whose real path lies outside the folder's, so that a link inside
 * the project cannot lead a read out of it. A file larger than the request's `max`, at most the plugin's
 * `maxPreviewBytes`, is refused before it is read; `length` reads only the file's first bytes. The bytes stream in
 * windows, and a file that changes while it streams ends its response with an error. The connection service
 * authenticates every request, and the route is the owner's alone: a Live Share viewer reaches no fetch route.
 * @module @deepseek-ai/dsh-game-assets/src/files
 */
import { isAbsolute } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** Path of the route on the connection's fetch registry. */
export const ASSET_FILE_ROUTE = '/api/game-assets.file'

/** Header naming the file's version, which the Assets tab compares with the `file` resource's. */
export const VERSION_HEADER = 'X-Asset-Version'

/** Header naming the file's size, also for a read of its first bytes. */
export const SIZE_HEADER = 'X-Asset-Size'

/** Bytes of each window the response streams. */
const WINDOW_BYTES = 4 * 1024 * 1024

/** Codes of the route's refusals, in the JSON body of each. */
export type AssetFileRefusal = 'bad-request' | 'outside-project' | 'not-found' | 'not-a-file' | 'too-large' | 'unreadable'

/** What the route reads with. */
export interface AssetFileRouteHost {
  /** The composed filesystem of the Host, whose access policy and versions every read follows. */
  readonly fs: FileSystem
  /** The largest file the route serves, in bytes. */
  readonly maxBytes: number
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cache-Control': 'private, no-store',
}

function refuse(status: number, code: AssetFileRefusal, message: string, limit?: number): Response {
  return new Response(JSON.stringify({ code, message, ...limit === undefined ? {} : { limit } }), {
    status,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
  })
}

/**
 * The code of a filesystem refusal, recognized by its code alone: the error class belongs to whichever `dsh-fs`
 * instance the provider loaded, so no class identity is shared across the package boundary.
 */
function fsErrorCode(error: unknown): string | undefined {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' && code.startsWith('FS_') ? code : undefined
}

/** A whole number from a query parameter, or undefined when it is absent; NaN when it is not a whole number from 0. */
function wholeNumber(value: string | null): number | undefined {
  if (value === null) return undefined
  return /^\d{1,15}$/u.test(value) ? Number(value) : Number.NaN
}

/**
 * Stream a file in windows, failing the stream when its version changes before the last window.
 * @returns the stream.
 */
function streamFile(fs: FileSystem, target: FsTarget, size: number, version: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) {
        const now = await fs.stat(target, signal)
        if (now?.version !== version) controller.error(new Error('the file changed while it was read'))
        else controller.close()
        return
      }
      const window = await fs.readByteRange(target, { offset, length: Math.min(WINDOW_BYTES, size - offset) }, signal)
      if (window.byteLength === 0) {
        controller.error(new Error('the file ended early'))
        return
      }
      offset += window.byteLength
      controller.enqueue(window)
    },
  })
}

/**
 * Answer one request of the route.
 * @param request - `GET` or `HEAD` with `root`, `path`, and the optional `max` and `length`.
 * @param host - the filesystem and the size cap.
 * @returns the file's bytes with its version and size, or a refusal: 400 for a bad request, 403 for a file outside the
 * project or that is no regular file, 404 for no file, 413 for a file over the cap, with its JSON code and message.
 */
export async function serveAssetFile(request: Request, host: AssetFileRouteHost): Promise<Response> {
  const params = new URL(request.url).searchParams
  const root = params.get('root')
  const path = params.get('path')
  const max = wholeNumber(params.get('max'))
  const length = wholeNumber(params.get('length'))
  if (root === null || !isAbsolute(root) || path === null || path === '' || root.includes('\0') || path.includes('\0')) {
    return refuse(400, 'bad-request', 'root must be an absolute folder and path a file in it.')
  }
  if (Number.isNaN(max) || Number.isNaN(length)) return refuse(400, 'bad-request', 'max and length must be whole numbers.')
  const limit = Math.min(host.maxBytes, max ?? host.maxBytes)
  const { fs } = host
  try {
    const folder = await fs.resolve(root, { signal: request.signal })
    const target = await fs.resolve(path, { cwd: root, signal: request.signal })
    if (!fs.contains(folder, target)) return refuse(403, 'outside-project', `${path} leads outside the project folder ${root}.`)
    const info = await fs.stat(target, request.signal)
    if (info === undefined) return refuse(404, 'not-found', `No file at ${path}.`)
    if (info.type !== 'file') return refuse(403, 'not-a-file', `${path} is not a file.`)
    const size = info.size ?? 0
    const sent = length === undefined ? size : Math.min(size, length)
    // A head the request asks for is read whole, so it keeps within the cap as a whole file does.
    if (sent > limit) {
      const refused = length === undefined
        ? `${path} is larger than ${String(limit)} bytes.`
        : `The first ${String(sent)} bytes of ${path} are more than the ${String(limit)} bytes this route reads.`
      return refuse(413, 'too-large', refused, limit)
    }
    const headers = {
      ...HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(sent), [VERSION_HEADER]: String(info.version), [SIZE_HEADER]: String(size),
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    if (length !== undefined) {
      const head = await fs.readByteRange(target, { offset: 0, length: sent }, request.signal)
      return new Response(head.slice(), { headers })
    }
    return new Response(streamFile(fs, target, size, info.version, request.signal), { headers })
  } catch (error) {
    const code = fsErrorCode(error)
    if (code === undefined) throw error
    if (code === 'FS_NOT_FOUND') return refuse(404, 'not-found', `No file at ${path}.`)
    if (code === 'FS_NOT_REGULAR_FILE') return refuse(403, 'not-a-file', `${path} is not a file.`)
    if (code === 'FS_TOO_LARGE') return refuse(413, 'too-large', `${path} is larger than ${String(limit)} bytes.`, limit)
    return refuse(403, 'unreadable', `${path} could not be read (${code}).`)
  }
}
