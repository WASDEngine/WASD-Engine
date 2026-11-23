/**
 * What the plugins that download assets from a free library share (Poly Haven, ambientCG): requests that reach only the
 * library's own hosts, responses read up to a limit, preview images for a Session's model or for a connected agent, the
 * tools as connected agents call them, the folder a download writes into, and files that a download writes whole or
 * not at all. Types stay structural, so a plugin passes its own context and attachment service.
 * @module @deepseek-ai/dsh-game-mcp/src/asset-library
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
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

/** Media types a preview image may have. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** Media type of a preview image. */
export type PreviewMediaType = typeof IMAGE_TYPES[number]

/** A preview image's bytes. */
export interface PreviewImage {
  /** Encoded image. */
  readonly data: Buffer
  /** Media type from the response. */
  readonly mediaType: PreviewMediaType
}

/** A failed request to an asset library: the HTTP status, or 0 when the library could not be reached. */
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Requests to one asset library. A library's answers name the URLs of its files, and a redirect names another, so
 * every request, and every redirect it follows, goes only to the configured API's host or to a host of the library's
 * domains over HTTPS.
 */
export class AssetLibraryHttp {
  /**
   * @param options - the library's name and hosts, the user agent, and the fetch implementation.
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

  /**
   * Send one GET request and follow its redirects.
   * @param url - the URL.
   * @param accept - value of the `Accept` header.
   * @param what - what the response is, for errors.
   * @param signal - cancellation of the request and of reading its body.
   * @returns the successful response, whose body the caller reads.
   * @throws AssetLibraryRequestError for a URL or redirect elsewhere, an unreachable host, and every status but 2xx.
   */
  async request(url: URL, accept: string, what: string, signal: AbortSignal): Promise<Response> {
    const { library } = this.options
    let response: Response
    for (let target = url, redirects = 0; ; redirects += 1) {
      if (!this.serves(target)) {
        const article = /^[aeiou]/iu.test(library) ? 'an' : 'a'
        throw new AssetLibraryRequestError(0, `${library} named ${what} at ${target.href}, which is not ${article} ${library} address, so nothing was downloaded from it.`)
      }
      try {
        response = await this.options.fetch(target, { headers: { 'user-agent': this.options.userAgent, accept }, signal, redirect: 'manual' })
      } catch (error) {
        signal.throwIfAborted()
        throw new AssetLibraryRequestError(0, `Could not reach ${library} at ${target.host} for ${what}: ${message(error)}`, { cause: error })
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (location === null) break
      await response.body?.cancel()
      if (redirects >= MAX_REDIRECTS) throw new AssetLibraryRequestError(response.status, `${library} redirected ${what} more than ${String(MAX_REDIRECTS)} times.`)
      target = new URL(location, target)
    }
    if (response.ok) return response
    await response.body?.cancel()
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? Number.NaN)
      const after = Number.isFinite(wait) && wait > 0 ? `in ${Math.ceil(wait)} seconds` : 'later'
      throw new AssetLibraryRequestError(429, `${library} is limiting requests from this computer; try again ${after}.`)
    }
    throw new AssetLibraryRequestError(response.status, `${library} answered HTTP ${response.status} for ${what}.`)
  }

  /**
   * Read a response body, at most `limit` bytes.
   * @param response - the response.
   * @param limit - most bytes.
   * @param what - what the body is, for the error.
   * @returns the bytes.
   * @throws AssetLibraryRequestError when the body is longer than the limit.
   */
  async bytes(response: Response, limit: number, what: string): Promise<Buffer> {
    const tooLarge = (): AssetLibraryRequestError => new AssetLibraryRequestError(response.status, `${this.options.library} sent ${what} larger than ${limit} bytes.`)
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
   * @throws AssetLibraryRequestError when the request fails or the body is not JSON.
   */
  async json(url: URL, what: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(url, 'application/json', what, signal)
    const text = (await this.bytes(response, MAX_JSON_BYTES, what)).toString('utf8')
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      throw new AssetLibraryRequestError(response.status, `${this.options.library} sent ${what} that is not JSON.`, { cause: error })
    }
  }

  /**
   * Download a preview image.
   * @param url - image URL.
   * @param signal - cancellation.
   * @returns the image.
   * @throws AssetLibraryRequestError when the request fails or the response is not an image of a supported type.
   */
  async image(url: string, signal: AbortSignal): Promise<PreviewImage> {
    const response = await this.request(new URL(url), 'image/*', 'the preview image', signal)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const mediaType = IMAGE_TYPES.find(candidate => candidate === type)
    if (mediaType === undefined) {
      await response.body?.cancel()
      throw new AssetLibraryRequestError(response.status, `${this.options.library} sent the preview image as ${type === '' ? 'an unknown type' : type}.`)
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
   * @param client - the library's name, API URL, and hosts, the user agent, and the fetch implementation.
   */
  constructor(private readonly client: AssetLibraryClientOptions) {
    const { library, domains, userAgent } = client
    this.base = new URL(client.apiUrl.endsWith('/') ? client.apiUrl : `${client.apiUrl}/`)
    // A library's answers name its files' URLs, and a redirect names another, so neither may send a request elsewhere.
    this.http = new AssetLibraryHttp({ library, api: this.base, domains, userAgent, fetch: client.fetch })
  }

  /**
   * Download a preview image.
   * @param url - image URL.
   * @param signal - cancellation.
   * @returns the image.
   * @throws AssetLibraryRequestError when the request fails or the response is not an image of a supported type.
   */
  async image(url: string, signal: AbortSignal): Promise<PreviewImage> {
    return await this.http.image(url, signal)
  }

  /**
   * Start downloading one of an asset's files.
   * @param url - the file's URL, as the library named it.
   * @param signal - cancellation of the request and of reading its body.
   * @returns the successful response, whose body the caller reads.
   * @throws AssetLibraryRequestError when the request fails.
   */
  async download(url: string, signal: AbortSignal): Promise<Response> {
    return await this.http.request(new URL(url), '*/*', `${this.client.downloads} ${url}`, signal)
  }
}

/**
 * Stream a response's body into a new file while hashing it.
 * @param response - the response.
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
   * @param name - display name of the image.
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
 * The previews of a Session's own tools: each image becomes an attachment that the Session's model receives, and a
 * model that does not accept images gets none.
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
      const [stored] = await attachments.saveImages([{ data: image.data, mediaType: image.mediaType, name }])
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
 * @param name - display name of the image.
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
        if (typeof directory !== 'string' || !isAbsolute(directory)) return Promise.reject(new Error('directory must be an absolute path.'))
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
 * @returns the resolver, which takes the folder the call names, the default relative folder, and the call.
 */
export function downloadFolders<A>(ctx: {
  readonly workingDirectory: { ensure(agent: A, signal: AbortSignal): Promise<string> }
}): (requested: string | undefined, fallback: string, exec: { readonly agent?: A; readonly signal: AbortSignal }) => Promise<string> {
  return async (requested, fallback, exec) => {
    if (requested !== undefined && isNetworkPath(requested)) throw new Error(`${requested} is a network path; pass a folder on this computer.`)
    if (requested !== undefined && isAbsolute(requested)) return requested
    if (exec.agent === undefined) throw new Error('Pass directory as an absolute path.')
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

/** One file with its target and what the download does with it. */
interface Target {
  readonly file: AssetFileWrite
  readonly target: string
  readonly status: AssetFileStatus
}

/**
 * Find what a download does with one file.
 * @throws Error when the path leaves the folder, or the target exists and is not a regular file.
 */
async function targetOf(directory: string, file: AssetFileWrite, signal: AbortSignal): Promise<Target> {
  const target = join(directory, ...file.path.split('/'))
  const inside = relative(directory, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`The file ${file.path} would leave the download folder; the download stopped.`)
  let status: AssetFileStatus
  try {
    const stats = await lstat(target)
    if (!stats.isFile()) throw new Error(`${target} exists and is not a file; move it or download into another directory.`)
    status = stats.size === file.bytes && await file.same(target, signal) ? 'unchanged' : 'replaced'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    status = 'downloaded'
  }
  return { file, target, status }
}

/**
 * Write a download's files into a folder, creating the folder and its subfolders. Each file is written into a temporary
 * file beside its target, and only after every file arrived intact do the temporary files take their targets' places,
 * so a failed or cancelled download writes none of its files. A file already in place with the same contents is not
 * written again; a file with other contents stops the download unless the call allows replacing it.
 * @param files - the files.
 * @param directory - absolute download folder.
 * @param options - whether to replace changed files, and cancellation of the whole download.
 * @returns what happened to each file, in the given order.
 * @throws Error when a file conflicts, cannot be fetched, arrives damaged, or cannot be written; no file is written
 * then, except when moving the checked files into place fails partway.
 */
export async function writeAssetFiles(
  files: readonly AssetFileWrite[], directory: string, options: { readonly replace: boolean; readonly signal: AbortSignal },
): Promise<WrittenAssetFile[]> {
  const { signal } = options
  const targets: Target[] = []
  for (const file of files) targets.push(await targetOf(directory, file, signal))
  const conflicts = targets.filter(target => target.status === 'replaced')
  if (conflicts.length > 0 && !options.replace) {
    const names = conflicts.slice(0, LISTED_CONFLICTS).map(conflict => conflict.file.path).join(', ')
    const more = conflicts.length > LISTED_CONFLICTS ? ` and ${conflicts.length - LISTED_CONFLICTS} more` : ''
    const [subject, pronoun] = conflicts.length === 1 ? ['A file in ', 'it'] : [`${conflicts.length} files in `, 'them']
    throw new Error(`${subject}${directory} already ${conflicts.length === 1 ? 'exists' : 'exist'} with other contents: ${names}${more}. Pass replace: true to overwrite ${pronoun}, or download into another directory.`)
  }
  const pending = targets.filter(target => target.status !== 'unchanged')
    .map(entry => ({ entry, temporary: join(dirname(entry.target), `.${basename(entry.target)}.${randomUUID()}.part`) }))
  const controller = new AbortController()
  const linked = AbortSignal.any([signal, controller.signal])
  const leftovers = new Set(pending.map(({ temporary }) => temporary))
  try {
    for (const { entry } of pending) await mkdir(dirname(entry.target), { recursive: true })
    // The first failure stops the other files; the cancellations it causes are not the reason the download failed.
    const failures: unknown[] = []
    await Promise.all(pending.map(async ({ entry, temporary }) => {
      try {
        await entry.file.write(temporary, linked)
      } catch (error) {
        failures.push(error)
        controller.abort()
      }
    }))
    signal.throwIfAborted()
    if (failures.length > 0) throw failures[0]
    for (const { entry, temporary } of pending) {
      await rename(temporary, entry.target)
      leftovers.delete(temporary)
    }
  } finally {
    await Promise.all([...leftovers].map(path => rm(path, { force: true })))
  }
  return targets.map(target => ({ path: target.file.path, bytes: target.file.bytes, status: target.status }))
}
