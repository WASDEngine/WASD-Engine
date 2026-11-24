/**
 * What the plugins that download assets from a free library share (Poly Haven, ambientCG): requests that reach only the
 * library's own hosts, responses read up to a limit, preview images for a Session's model or for a connected agent, the
 * tools as connected agents call them, the folder a download writes into, and files that a download writes whole or
 * not at all. Types stay structural, so a plugin passes its own context and attachment service, and its own errors: the
 * kit imports no error class, so each failure it raises is the error that the plugin's {@link AssetLibraryErrors}
 * makes, such as a `HarnessError` with the plugin's code.
 * @module @deepseek-ai/dsh-game-mcp/src/asset-library
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isNetworkPath, modelSeesImages } from './plugin-kit.ts'
import { declaredArguments } from './project-tools.ts'
import type { GameMcpContent, GameMcpTool, JsonObject } from './provider.ts'

/** Most bytes of one JSON response. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

/** Most bytes of one preview image. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Most redirects one request follows, each to a host the library serves from. */
const MAX_REDIRECTS = 5

/** Most conflicting files that an error lists by name. */
const LISTED_CONFLICTS = 5

/** Most times a download makes a folder and its marker again after another download removed a folder on its path. */
const FOLDER_ATTEMPTS = 5

/** What a failure on the disk asks the caller to do. */
const DISK_ADVICE = 'Check that the folder can be written and that the disk has room, or download into another directory.'

/** Media types a preview image may have. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** Media type of a preview image. */
export type PreviewMediaType = typeof IMAGE_TYPES[number]

/** The file extension of each media type a preview image may have, which ends the name of the stored image. */
const IMAGE_EXTENSIONS: Readonly<Record<PreviewMediaType, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
}

/** A preview image's bytes. */
export interface PreviewImage {
  /** Encoded image. */
  readonly data: Buffer
  /** Media type from the response. */
  readonly mediaType: PreviewMediaType
}

/**
 * A failed request to an asset library: the HTTP status, or 0 without a response, and the model-facing message. The
 * kit does not throw it: it hands it to the plugin's {@link AssetLibraryErrors.request}, whose error keeps it as its
 * cause, so the plugin can still tell statuses apart.
 */
export class AssetLibraryRequestError extends Error {
  /**
   * @param status - HTTP status of the response, or 0 without one.
   * @param message - model-facing explanation.
   * @param options - the underlying failure.
   */
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssetLibraryRequestError'
  }
}

/**
 * The errors of a plugin for the failures that the kit raises. Each method returns the error the kit throws, normally
 * a `HarnessError` of the plugin's own class with the plugin's code, so a tool result records which failure it was.
 */
export interface AssetLibraryErrors {
  /**
   * A request that failed: the library could not be reached, answered an error status, broke off while it sent a body,
   * redirected too often or to a malformed address, named an address that is not the library's, or sent a body that is
   * too large or of the wrong kind. Nothing of the response was saved.
   * @param failure - the HTTP status, or 0 without a response, the model-facing message, and the underlying failure.
   * @returns the error to throw.
   */
  request(failure: AssetLibraryRequestError): Error
  /**
   * Files of a download that exist with other contents, or a target where something other than a file stands.
   * @param message - model-facing explanation with what to do instead.
   * @returns the error to throw.
   */
  exists(message: string): Error
  /**
   * A download whose files the library named so that one would leave the download folder, or two would be one file.
   * @param message - model-facing explanation.
   * @returns the error to throw.
   */
  corrupt(message: string): Error
  /**
   * A download that failed on the disk: a folder, a marker, a temporary file, or a file in place could not be made,
   * read, written, or moved, as when permission is missing or the disk is full.
   * @param message - model-facing explanation that names the file, the error code, and what is in place.
   * @param cause - the file system's error.
   * @returns the error to throw.
   */
  disk(message: string, cause: unknown): Error
  /**
   * An argument of a call that the kit refuses: a folder on another computer, or one that is not absolute where no
   * Session gives a working directory.
   * @param message - model-facing explanation.
   * @returns the error to throw.
   */
  argument(message: string): Error
}

/** How a plugin reaches its library. */
export interface AssetLibraryHttpOptions {
  /** The library's name as messages write it, such as `Poly Haven`. */
  readonly library: string
  /** The configured API's URL; its host is fetched over its own protocol. */
  readonly api: URL
  /** The domains whose hosts serve the library's files over HTTPS, besides the configured API's host. */
  readonly domains: readonly string[]
  /** Value of the `User-Agent` header of every request. */
  readonly userAgent: string
  /** The fetch implementation. */
  readonly fetch: typeof fetch
  /** The plugin's error for a failed request. */
  readonly errors: Pick<AssetLibraryErrors, 'request'>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Requests to one asset library. A library's answers name the URLs of its files, and a redirect names another, so
 * every request, and every redirect it follows, goes only to the configured API's host or to a host of the library's
 * domains over HTTPS. Every failure but cancellation, including a connection that breaks off while the library sends a
 * response's body, is the plugin's request error.
 */
export class AssetLibraryHttp {
  /**
   * @param options - the library's name and hosts, the user agent, the fetch implementation, and the plugin's error.
   */
  constructor(private readonly options: AssetLibraryHttpOptions) {}

  /**
   * Whether a URL is one the client fetches.
   * @param url - the URL.
   * @returns true for the configured API's host over its protocol, and for an HTTPS host of the library's domains.
   */
  serves(url: URL): boolean {
    const { api, domains } = this.options
    if (url.host === api.host && url.protocol === api.protocol) return true
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && domains.some(domain => host === domain || host.endsWith(`.${domain}`))
  }

  /** The plugin's error for a failed request. */
  private failure(status: number, text: string, cause?: unknown): Error {
    return this.options.errors.request(new AssetLibraryRequestError(status, text, cause === undefined ? undefined : { cause }))
  }

  /**
   * Send one GET request and follow its redirects.
   * @param url - the URL.
   * @param accept - value of the `Accept` header.
   * @param what - what the response is, for errors.
   * @param signal - cancellation of the request and of reading its body.
   * @returns the successful response, whose body the caller reads; a connection that breaks off while it is read ends
   * the reading with the plugin's request error, and a cancelled read fails as the fetch implementation fails it.
   * @throws the plugin's request error for a URL or redirect elsewhere, a malformed redirect, an unreachable host, and
   * every status but 2xx.
   */
  async request(url: URL, accept: string, what: string, signal: AbortSignal): Promise<Response> {
    const { library } = this.options
    let response: Response
    for (let target = url, redirects = 0; ; redirects += 1) {
      if (!this.serves(target)) {
        const article = /^[aeiou]/iu.test(library) ? 'an' : 'a'
        throw this.failure(0, `${library} named ${what} at ${target.href}, which is not ${article} ${library} address, so nothing was downloaded from it.`)
      }
      try {
        response = await this.options.fetch(target, { headers: { 'user-agent': this.options.userAgent, accept }, signal, redirect: 'manual' })
      } catch (error) {
        signal.throwIfAborted()
        throw this.failure(0, `Could not reach ${library} at ${target.host} for ${what}: ${message(error)}`, error)
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (location === null) break
      await response.body?.cancel()
      if (redirects >= MAX_REDIRECTS) throw this.failure(response.status, `${library} redirected ${what} more than ${String(MAX_REDIRECTS)} times.`)
      if (!URL.canParse(location, target)) {
        throw this.failure(response.status, `${library} redirected ${what} to ${JSON.stringify(location)}, which is not a valid URL; nothing was saved.`)
      }
      target = new URL(location, target)
    }
    if (response.ok) return this.guarded(response, what, signal)
    await response.body?.cancel()
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? Number.NaN)
      const after = Number.isFinite(wait) && wait > 0 ? `in ${Math.ceil(wait)} seconds` : 'later'
      throw this.failure(429, `${library} is limiting requests from this computer; try again ${after}.`)
    }
    throw this.failure(response.status, `${library} answered HTTP ${response.status} for ${what}.`)
  }

  /**
   * The response with a body whose reading fails with the plugin's request error when the connection breaks off, and
   * with the original failure once the request was cancelled.
   */
  private guarded(response: Response, what: string, signal: AbortSignal): Response {
    const body = response.body
    if (body === null) return response
    const reader = body.getReader()
    const broken = (cause: unknown): Error => this.failure(
      response.status, `The connection to ${this.options.library} broke off while it sent ${what}; nothing was saved. Try again.`, cause,
    )
    const guarded = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        let next
        try {
          next = await reader.read()
        } catch (error) {
          if (signal.aborted) throw error
          throw broken(error)
        }
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
      cancel: reason => reader.cancel(reason),
    })
    return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  /**
   * Read a response body, at most `limit` bytes.
   * @param response - the response.
   * @param limit - most bytes.
   * @param what - what the body is, for the error.
   * @returns the bytes.
   * @throws the plugin's request error when the body is longer than the limit or its connection breaks off.
   */
  async bytes(response: Response, limit: number, what: string): Promise<Buffer> {
    const tooLarge = (): Error => this.failure(response.status, `${this.options.library} sent ${what} larger than ${limit} bytes.`)
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel()
      throw tooLarge()
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength
      // Leaving the loop cancels the body.
      if (total > limit) throw tooLarge()
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /**
   * Read a JSON response.
   * @param url - the URL.
   * @param what - what the response is, for errors.
   * @param signal - cancellation.
   * @returns the parsed value, which the caller validates.
   * @throws the plugin's request error when the request fails or the body is not JSON.
   */
  async json(url: URL, what: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(url, 'application/json', what, signal)
    const text = (await this.bytes(response, MAX_JSON_BYTES, what)).toString('utf8')
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      throw this.failure(response.status, `${this.options.library} sent ${what} that is not JSON.`, error)
    }
  }

  /**
   * Download a preview image.
   * @param url - image URL.
   * @param signal - cancellation.
   * @returns the image.
   * @throws the plugin's request error when the request fails or the response is not an image of a supported type.
   */
  async image(url: string, signal: AbortSignal): Promise<PreviewImage> {
    const response = await this.request(new URL(url), 'image/*', 'the preview image', signal)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const mediaType = IMAGE_TYPES.find(candidate => candidate === type)
    if (mediaType === undefined) {
      await response.body?.cancel()
      throw this.failure(response.status, `${this.options.library} sent the preview image as ${type === '' ? 'an unknown type' : type}.`)
    }
    return { data: await this.bytes(response, MAX_IMAGE_BYTES, 'a preview image'), mediaType }
  }
}

/** How a library's client is set up. */
export interface AssetLibraryClientOptions {
  /** The library's name as messages write it, such as `Poly Haven`. */
  readonly library: string
  /** Base URL of the library's API. */
  readonly apiUrl: string
  /** The domains whose hosts serve the library's files over HTTPS, besides the API's host. */
  readonly domains: readonly string[]
  /** Value of the `User-Agent` header of every request. */
  readonly userAgent: string
  /** The fetch implementation. */
  readonly fetch: typeof fetch
  /** What one download fetches, as errors name it, such as `the file`. */
  readonly downloads: string
  /** The plugin's error for a failed request. */
  readonly errors: Pick<AssetLibraryErrors, 'request'>
}

/**
 * The part of a library's client that every library has: the API's base URL, requests that stay on the library's
 * hosts, preview images, and downloads. A library's own client extends it with its catalog.
 */
export class AssetLibraryClient {
  /** The API's URL with a trailing slash, under which the API's paths resolve. */
  protected readonly base: URL
  /** Requests to the library. */
  protected readonly http: AssetLibraryHttp

  /**
   * @param client - the library's name, API URL, and hosts, the user agent, the fetch implementation, and the plugin's
   * error for a failed request.
   */
  constructor(private readonly client: AssetLibraryClientOptions) {
    const { library, domains, userAgent, errors } = client
    this.base = new URL(client.apiUrl.endsWith('/') ? client.apiUrl : `${client.apiUrl}/`)
    // A library's answers name its files' URLs, and a redirect names another, so neither may send a request elsewhere.
    this.http = new AssetLibraryHttp({ library, api: this.base, domains, userAgent, fetch: client.fetch, errors })
  }

  /**
   * Download a preview image.
   * @param url - image URL.
   * @param signal - cancellation.
   * @returns the image.
   * @throws the plugin's request error when the request fails or the response is not an image of a supported type.
   */
  async image(url: string, signal: AbortSignal): Promise<PreviewImage> {
    return await this.http.image(url, signal)
  }

  /**
   * Start downloading one of an asset's files.
   * @param url - the file's URL, as the library named it.
   * @param signal - cancellation of the request and of reading its body.
   * @returns the successful response, whose body the caller reads; a connection that breaks off ends the reading with
   * the plugin's request error.
   * @throws the plugin's request error when the request fails.
   */
  async download(url: string, signal: AbortSignal): Promise<Response> {
    return await this.http.request(new URL(url), '*/*', `${this.client.downloads} ${url}`, signal)
  }
}

/**
 * Stream a response's body into a new file while hashing it.
 * @param response - the response; one from {@link AssetLibraryClient.download} fails with the plugin's request error
 * when its connection breaks off.
 * @param path - absolute path of the file to create.
 * @param algorithm - the digest's algorithm, such as `md5` or `sha1`.
 * @param limit - the size in bytes the body may have; past it, reading stops with the error of `tooLong`.
 * @param tooLong - makes the error of a body longer than `limit`.
 * @param signal - cancellation.
 * @returns the body's size in bytes and its lowercase hexadecimal digest.
 */
export async function saveBody(
  response: Response, path: string, algorithm: string, limit: number, tooLong: () => Error, signal: AbortSignal,
): Promise<{ readonly bytes: number; readonly digest: string }> {
  const hash = createHash(algorithm)
  let bytes = 0
  async function* checked(): AsyncGenerator<Uint8Array> {
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength
      if (bytes > limit) throw tooLong()
      hash.update(chunk)
      yield chunk
    }
  }
  await pipeline(checked(), createWriteStream(path, { flags: 'wx' }), { signal })
  return { bytes, digest: hash.digest('hex') }
}

/** How one set of tool definitions shows preview images to its callers. */
export interface PreviewSurface<Stored> {
  /**
   * Show one asset's preview image to the caller of a call.
   * @param exec - the call's execution.
   * @param load - downloads the image; called only when the caller can see images.
   * @param name - display name of the image without an extension; a stored image's name ends in the extension of its
   * media type, such as `.jpg` or `.png`.
   * @returns the stored image that the result carries, or undefined when the caller cannot see images or the image
   * reaches the caller another way.
   */
  preview(exec: ToolRunContext, load: (signal: AbortSignal) => Promise<PreviewImage>, name: string): Promise<Stored | undefined>
}

/** The part of the attachment service that keeps preview images. */
export interface PreviewStore<Stored> {
  /**
   * Store images for the Session's model.
   * @param images - each image's bytes, media type, and display name.
   * @returns one reference per image, in order.
   */
  saveImages(
    images: ReadonlyArray<{ readonly data: Buffer; readonly mediaType: PreviewMediaType; readonly name: string }>,
  ): Promise<readonly Stored[]>
}

/**
 * The previews of a Session's own tools: each image becomes an attachment that the Session's model receives, named
 * with the extension of the media type the library sent, and a model that does not accept images gets none.
 * @param ctx - plugin context with the optional model service.
 * @param store - the attachment service, or undefined while the Host keeps no attachments.
 * @returns the preview surface.
 */
export function sessionPreviews<Stored>(ctx: Context, store: () => PreviewStore<Stored> | undefined): PreviewSurface<Stored> {
  return {
    async preview(exec, load, name) {
      const attachments = store()
      if (attachments === undefined || !await modelSeesImages(ctx, exec)) return undefined
      const image = await load(exec.signal)
      const named = `${name}.${IMAGE_EXTENSIONS[image.mediaType]}`
      const [stored] = await attachments.saveImages([{ data: image.data, mediaType: image.mediaType, name: named }])
      return stored
    },
  }
}

/** The preview a tool result carries, or why the image could not be shown. */
export interface ShownPreview<Stored> {
  /** The stored image, when the surface keeps one for the result. */
  readonly preview?: Stored
  /** Why the image could not be loaded or stored. */
  readonly previewError?: string
}

/**
 * Show an asset's preview image. A failure becomes part of the result instead of failing the call, whose text still
 * tells the caller about the asset.
 * @param surface - how the tool shows preview images.
 * @param exec - the call's execution.
 * @param load - downloads the image.
 * @param name - display name of the image without an extension.
 * @returns the stored image when the surface returns one, or the failure's message.
 * @throws the call's abort reason when the call was cancelled meanwhile.
 */
export async function shownPreview<Stored>(
  surface: PreviewSurface<Stored>, exec: ToolRunContext, load: (signal: AbortSignal) => Promise<PreviewImage>, name: string,
): Promise<ShownPreview<Stored>> {
  try {
    const preview = await surface.preview(exec, load, name)
    return preview === undefined ? {} : { preview }
  } catch (error) {
    exec.signal.throwIfAborted()
    return { previewError: message(error) }
  }
}

/** The download tool of a library, as connected agents call it. */
export interface ConnectedDownload {
  /** Name of the tool that writes files. */
  readonly tool: string
  /** Schema of its `directory` argument, which connected agents must pass as an absolute path. */
  readonly directory: JsonObject
  /** The plugin's error for a `directory` that is not absolute. */
  readonly errors: Pick<AssetLibraryErrors, 'argument'>
}

/**
 * A library's tools for agents connected through the MCP server. They need no Session: each preview image's bytes wait
 * for the call's result, which sends them after its text, every tool but the download is read-only, and the download
 * takes its folder as an absolute path.
 * @param build - builds the tool definitions for a preview surface.
 * @param download - the tool that writes files.
 * @returns the server tools, in the definitions' order.
 */
export function connectedLibraryTools<Stored>(
  build: (surface: PreviewSurface<Stored>) => readonly ToolDefinition[], download: ConnectedDownload,
): GameMcpTool[] {
  const images = new WeakMap<ToolRunContext, PreviewImage[]>()
  const surface: PreviewSurface<Stored> = {
    async preview(exec, load) {
      const image = await load(exec.signal)
      images.set(exec, [...images.get(exec) ?? [], image])
      return undefined
    },
  }
  return build(surface).map((definition): GameMcpTool => {
    const content = (value: JsonValue, args: JsonObject, exec: ToolRunContext): GameMcpContent[] => [
      ...definition.output.render(args, value).flatMap((block): GameMcpContent[] => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
      ...(images.get(exec) ?? []).map((image): GameMcpContent => ({ type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType })),
    ]
    if (definition.name !== download.tool) return { name: definition.name, definition, readOnly: true, content }
    const { properties, required } = declaredArguments(definition)
    return {
      name: definition.name,
      definition,
      inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, directory: download.directory }, required: [...required, 'directory'] },
      readOnly: false,
      prepare(args) {
        const directory = args.directory
        if (typeof directory !== 'string' || !isAbsolute(directory)) return Promise.reject(download.errors.argument('directory must be an absolute path.'))
        return Promise.resolve({ args })
      },
      content,
    }
  })
}

/**
 * The resolver of the folder a download writes into: an absolute folder as it is, and a relative one, or the call's
 * default, inside the calling Session's working directory.
 * @param ctx - the plugin's context, with the working directory service.
 * @param errors - the plugin's error for a folder on another computer, and for a relative one without a Session.
 * @returns the resolver, which takes the folder the call names, the default relative folder, and the call.
 */
export function downloadFolders<A>(
  ctx: { readonly workingDirectory: { ensure(agent: A, signal: AbortSignal): Promise<string> } },
  errors: Pick<AssetLibraryErrors, 'argument'>,
): (requested: string | undefined, fallback: string, exec: { readonly agent?: A; readonly signal: AbortSignal }) => Promise<string> {
  return async (requested, fallback, exec) => {
    if (requested !== undefined && isNetworkPath(requested)) throw errors.argument(`${requested} is a network path; pass a folder on this computer.`)
    if (requested !== undefined && isAbsolute(requested)) return requested
    if (exec.agent === undefined) throw errors.argument('Pass directory as an absolute path.')
    return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested ?? fallback)
  }
}

/** What a download did with one file. */
export type AssetFileStatus = 'downloaded' | 'replaced' | 'unchanged'

/** The schema of the files in a download tool's result: each {@link WrittenAssetFile}. */
export const WRITTEN_FILES_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', required: true },
      bytes: { type: 'integer', required: true },
      status: { type: 'string', enum: ['downloaded', 'replaced', 'unchanged'], required: true },
    },
  },
} as const

/**
 * Say what a download did with its files, by how many: `3 downloaded`, `1 replaced`, `2 already in place`.
 * @param files - what happened to each file.
 * @returns one phrase for each thing that happened to at least one file, in that order.
 */
export function savedCounts(files: readonly { readonly status: AssetFileStatus }[]): string[] {
  return (['downloaded', 'replaced', 'unchanged'] as const)
    .map(status => [status, files.filter(file => file.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status === 'unchanged' ? 'already in place' : status}`)
}

/** One file that a download wrote or found in place. */
export interface WrittenAssetFile {
  /** Path relative to the download folder, with `/` separators. */
  readonly path: string
  /** Size in bytes. */
  readonly bytes: number
  /** `downloaded` for a new file, `replaced` for a file whose earlier contents differed, `unchanged` for a file already in place. */
  readonly status: AssetFileStatus
}

/** One file a download writes. */
export interface AssetFileWrite {
  /** Path relative to the download folder, with `/` separators. */
  readonly path: string
  /** Size in bytes of the file's contents. */
  readonly bytes: number
  /**
   * Whether a file of the same size already at the target holds the same contents.
   * @param target - absolute path of the existing file.
   * @param signal - cancellation.
   * @returns true when the file need not be written.
   */
  same(target: string, signal: AbortSignal): Promise<boolean>
  /**
   * Write the contents into a new file and check them.
   * @param temporary - absolute path of the file to create.
   * @param signal - cancellation.
   * @throws Error when the contents cannot be fetched or arrive damaged.
   */
  write(temporary: string, signal: AbortSignal): Promise<void>
}

/**
 * The folders that a plugin's running downloads made, each with how many of those downloads hold it: each that made it,
 * or found it missing and tried to make it at the same time, and each that found it held on the way to its own folder
 * or above a folder it holds. A plugin keeps one for all of its downloads and passes it to every
 * {@link writeAssetFiles} call; a folder leaves it when the last download that holds it ends.
 */
export type AssetFolderHolds = Map<string, number>

/** How {@link writeAssetFiles} writes the files of one download. */
export interface AssetFileOptions {
  /** Whether files whose contents differ are replaced; otherwise they stop the download before anything is written. */
  readonly replace: boolean
  /** The plugin's held folders, which every download of the plugin shares. */
  readonly folders: AssetFolderHolds
  /** The plugin's errors for conflicting files, unsafe or colliding paths, and failures on the disk. */
  readonly errors: Pick<AssetLibraryErrors, 'corrupt' | 'disk' | 'exists'>
  /** Cancellation of the whole download. */
  readonly signal: AbortSignal
}

/** One file with its absolute target. */
interface Placed {
  readonly file: AssetFileWrite
  readonly target: string
}

/** One file with its target and what the download does with it. */
interface Target extends Placed {
  readonly status: AssetFileStatus
}

/**
 * Whether a failure is the file system's, which names its error code and the call that failed.
 * @param error - the failure.
 * @returns true for an error of a file system call, such as `EACCES` from `open`.
 */
function isDiskFailure(error: unknown): error is NodeJS.ErrnoException {
  const { code, syscall } = error instanceof Error ? error as NodeJS.ErrnoException : {}
  return typeof code === 'string' && typeof syscall === 'string'
}

/**
 * Remove the temporary and marker files a download leaves, as far as the disk allows: a file that another program
 * still holds open is tried again a few times, and one that cannot be removed stays behind, hidden by its leading dot.
 * @param paths - absolute paths.
 */
async function removeLeftovers(paths: Iterable<string>): Promise<void> {
  await Promise.all([...paths].map(async (path) => {
    try {
      // `recursive` lets `rm` retry a file that another program holds open, as Windows reports with EBUSY or EPERM.
      await rm(path, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // A leftover that cannot be removed stays; the download's own outcome, a failure or its files in place, stands.
    }
  }))
}

/**
 * Find each file's target in the folder.
 * @throws the plugin's corrupt-download error when a path leaves the folder, or two paths name one file, as paths that
 * differ only in letter case do on the disks of macOS and Windows.
 */
function placeFiles(directory: string, files: readonly AssetFileWrite[], errors: AssetFileOptions['errors']): Placed[] {
  const seen = new Map<string, Placed>()
  return files.map((file) => {
    const target = join(directory, ...file.path.split('/'))
    const inside = relative(directory, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw errors.corrupt(`The file ${file.path} would leave the download folder; the download stopped.`)
    const earlier = seen.get(inside.toLowerCase())
    if (earlier !== undefined) {
      const why = earlier.target === target ? '' : ', since macOS and Windows ignore letter case in file names'
      throw errors.corrupt(`The files ${earlier.file.path} and ${file.path} would be one file in the download folder${why}; the download stopped.`)
    }
    const placed = { file, target }
    seen.set(inside.toLowerCase(), placed)
    return placed
  })
}

/**
 * Find what a download does with one file.
 * @throws the plugin's error for an existing file when the target exists and is not a regular file.
 */
async function targetOf({ file, target }: Placed, signal: AbortSignal, errors: AssetFileOptions['errors']): Promise<Target> {
  let status: AssetFileStatus
  try {
    const stats = await lstat(target)
    if (!stats.isFile()) throw errors.exists(`${target} exists and is not a file; move it or download into another directory.`)
    status = stats.size === file.bytes && await file.same(target, signal) ? 'unchanged' : 'replaced'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    status = 'downloaded'
  }
  return { file, target, status }
}

/**
 * Count this download in a folder from now on, and at the same moment in each folder above it that the plugin's
 * downloads hold, so that no download lets go of one of those last while this download holds a folder inside it.
 * @param folder - absolute folder that this download is about to make, or that the plugin's downloads hold.
 * @param holds - the plugin's held folders.
 * @param held - the folders this download holds; receives each one it holds now.
 */
function hold(folder: string, holds: AssetFolderHolds, held: Set<string>): void {
  for (let current = folder; ; current = dirname(current)) {
    if ((current === folder || holds.has(current)) && !held.has(current)) {
      held.add(current)
      holds.set(current, (holds.get(current) ?? 0) + 1)
    }
    if (dirname(current) === current) return
  }
}

/**
 * Hold the folders on the way to a folder: each one that the plugin's downloads hold, with every held folder above it,
 * and each missing one, which this call holds and then creates, up to the first folder that is there and that no
 * download holds.
 * @param folder - absolute folder.
 * @param holds - the plugin's held folders.
 * @param held - the folders this download holds; receives each one it holds now.
 * @throws Error when a folder cannot be created.
 */
async function holdFolders(folder: string, holds: AssetFolderHolds, held: Set<string>): Promise<void> {
  const missing: string[] = []
  for (let current = folder; ; current = dirname(current)) {
    // A path that cannot be looked up counts as missing; creating it then fails with the reason.
    const exists = await lstat(current).then(() => true, () => false)
    if (holds.has(current)) hold(current, holds, held)
    else if (exists) break
    if (!exists) missing.push(current)
    if (dirname(current) === current) break
  }
  // The highest first. Each is held before it is made, so that every download of the plugin that makes it at the same
  // time holds it, whichever of them made it.
  for (const current of missing.reverse()) {
    hold(current, holds, held)
    await mkdir(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  }
}

/**
 * Make a folder that a download writes into, with the missing folders above it, and a marker file in it, which keeps
 * the folder from being empty, so that a download that holds no count of it, such as one of another process, leaves it
 * while this download runs.
 * @param folder - absolute folder.
 * @param marker - absolute path of the marker file to create in it.
 * @param holds - the plugin's held folders.
 * @param held - the folders this download holds; receives each one it holds now.
 * @throws Error when the folder or the marker cannot be created.
 */
async function claimFolder(folder: string, marker: string, holds: AssetFolderHolds, held: Set<string>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await holdFolders(folder, holds, held)
      await writeFile(marker, '', { flag: 'wx' })
      return
    } catch (error) {
      // ENOENT: a download that ended meanwhile removed a folder on the path, which this download makes again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= FOLDER_ATTEMPTS) throw error
    }
  }
}

/**
 * Let go of the folders a download held, the deepest first. A folder that no other download holds then leaves the
 * plugin's held folders, and when the download failed, it is removed first while it is empty.
 * @param held - the folders the download held.
 * @param holds - the plugin's held folders.
 * @param remove - whether the download failed, so that the folders no other download holds are removed while empty.
 */
async function releaseFolders(held: ReadonlySet<string>, holds: AssetFolderHolds, remove: boolean): Promise<void> {
  // A folder's path is longer than the path of each folder above it.
  for (const folder of [...held].sort((left, right) => right.length - left.length)) {
    const count = (holds.get(folder) ?? 1) - 1
    holds.set(folder, count)
    if (count > 0) continue
    if (remove) {
      try {
        await rmdir(folder)
      } catch {
        // Any error keeps the folder: ENOTEMPTY or EEXIST when a file holds it, ENOENT when it is gone. The call
        // reports the download's own failure.
      }
    }
    // A download that came to hold the folder meanwhile holds it on, and makes it again if it was removed.
    if (holds.get(folder) === 0) holds.delete(folder)
  }
}

/**
 * Write a download's files into a folder, creating the folder and its subfolders. Each file is written into a temporary
 * file beside its target, and only after every file arrived intact do the temporary files take their targets' places,
 * so a failed or cancelled download writes none of its files. The folders a download creates are held in the plugin's
 * {@link AssetFolderHolds} with each download of the plugin that uses them, and when the last of those downloads ends
 * after a failure or cancellation, it removes each such folder that is empty; a hidden marker file in each folder that
 * a download's files go into also keeps a download that holds no count of the folder, such as one of another process,
 * from removing it while the download runs. A file already in place with the same contents is not written again; a
 * file with other contents stops the download unless the call allows replacing it. Two paths that differ only in letter
 * case stop the download before anything is written, since the disks of macOS and Windows hold one file for both. A
 * failure of the file system, in this function or in a file's `same` or `write`, becomes the plugin's disk error, which
 * names the file, the error code, and what is in place; a cancelled download fails with its cancellation as it is.
 * @param files - the files.
 * @param directory - absolute download folder.
 * @param options - whether to replace changed files, the plugin's held folders and errors, and cancellation of the
 * whole download.
 * @returns what happened to each file, in the given order.
 * @throws the plugin's corrupt-download error when a path leaves the folder or two paths name one file, its error for
 * an existing file when a file conflicts or a target is not a file, and its disk error when the file system fails; a
 * file's own error when it cannot be fetched or arrives damaged. No file is written then, except when moving the
 * checked files into place fails partway, which the disk error says.
 */
export async function writeAssetFiles(
  files: readonly AssetFileWrite[], directory: string, options: AssetFileOptions,
): Promise<WrittenAssetFile[]> {
  const { signal, errors } = options
  // A failure of the file system becomes the plugin's disk error; a cancellation and other failures stay as they are.
  const onDisk = (error: unknown, step: string, saved = 'nothing was saved'): unknown => signal.aborted || !isDiskFailure(error)
    ? error
    : errors.disk(`The download failed on the disk while it ${step}: ${error.message}; ${saved}. ${DISK_ADVICE}`, error)
  const targets: Target[] = []
  for (const placed of placeFiles(directory, files, errors)) {
    try {
      targets.push(await targetOf(placed, signal, errors))
    } catch (error) {
      throw onDisk(error, `looked at ${placed.file.path}`)
    }
  }
  const conflicts = targets.filter(target => target.status === 'replaced')
  if (conflicts.length > 0 && !options.replace) {
    const names = conflicts.slice(0, LISTED_CONFLICTS).map(conflict => conflict.file.path).join(', ')
    const more = conflicts.length > LISTED_CONFLICTS ? ` and ${conflicts.length - LISTED_CONFLICTS} more` : ''
    const [subject, pronoun] = conflicts.length === 1 ? ['A file in ', 'it'] : [`${conflicts.length} files in `, 'them']
    throw errors.exists(`${subject}${directory} already ${conflicts.length === 1 ? 'exists' : 'exist'} with other contents: ${names}${more}. Pass replace: true to overwrite ${pronoun}, or download into another directory.`)
  }
  const pending = targets.filter(target => target.status !== 'unchanged')
    .map(entry => ({ entry, temporary: join(dirname(entry.target), `.${basename(entry.target)}.${randomUUID()}.part`) }))
  const folders = [...new Set(pending.map(({ entry }) => dirname(entry.target)))]
  const markers = new Map(folders.map((folder): [string, string] => [folder, join(folder, `.${randomUUID()}.part`)]))
  const controller = new AbortController()
  const linked = AbortSignal.any([signal, controller.signal])
  // The markers go with the temporary files, whether the download succeeds or fails.
  const leftovers = new Set([...pending.map(({ temporary }) => temporary), ...markers.values()])
  const held = new Set<string>()
  let placed = false
  try {
    for (const [folder, marker] of markers) {
      try {
        await claimFolder(folder, marker, options.folders, held)
      } catch (error) {
        throw onDisk(error, `made the folder ${folder}`)
      }
    }
    // The first failure stops the other files; the cancellations it causes are not the reason the download failed.
    const failures: Array<{ readonly error: unknown; readonly path: string }> = []
    await Promise.all(pending.map(async ({ entry, temporary }) => {
      try {
        await entry.file.write(temporary, linked)
      } catch (error) {
        failures.push({ error, path: entry.file.path })
        controller.abort()
      }
    }))
    signal.throwIfAborted()
    const [first] = failures
    if (first !== undefined) throw onDisk(first.error, `wrote ${first.path}`)
    const moved: string[] = []
    for (const { entry, temporary } of pending) {
      try {
        await rename(temporary, entry.target)
      } catch (error) {
        const inPlace = moved.length === 0 ? 'none is' : `${moved.join(', ')} ${moved.length === 1 ? 'is' : 'are'}`
        throw onDisk(error, `moved ${entry.file.path} into place`, `of its files, ${inPlace} in place`)
      }
      moved.push(entry.file.path)
      leftovers.delete(temporary)
    }
    placed = true
  } finally {
    await removeLeftovers(leftovers)
    await releaseFolders(held, options.folders, !placed)
  }
  return targets.map(target => ({ path: target.file.path, bytes: target.file.bytes, status: target.status }))
}
