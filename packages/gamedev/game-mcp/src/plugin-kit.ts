/**
 * What the plugins that offer game tools here share (ElevenLabs, image generation, and the like): their gateway origin,
 * the signed-in account's token for it, the files a call names, and the files a call writes. Types stay structural, so a
 * plugin passes its own context and tool calls.
 * @module @deepseek-ai/dsh-game-mcp/src/plugin-kit
 */
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** The token a gateway call carries, and how a call that the gateway refused hands it back. */
export interface GatewayAccess {
  /** The signed-in account's token. */
  readonly token: string
  /** Report that the gateway refused the token, which signs the account out when it is still the stored one. */
  reject(): Promise<void>
}

/**
 * A plugin's `apiOrigin` setting as an origin.
 * @param value - the setting.
 * @param plugin - the plugin's name, for the error.
 * @returns the origin, without a trailing slash.
 * @throws {Error} when the setting is not an HTTP or HTTPS origin without a path.
 */
export function gatewayOrigin(value: string, plugin: string): string {
  const origin = URL.canParse(value) ? new URL(value) : undefined
  if (origin === undefined || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.replace(/\/$/u, '')) {
    throw new Error(`${plugin} plugin: apiOrigin must be an HTTP or HTTPS origin without a path, got ${JSON.stringify(value)}.`)
  }
  return origin.origin
}

/**
 * The signed-in account's access to a gateway URL, through the account plugin when it runs.
 * @param ctx - the plugin's context.
 * @returns the lookup: the token and its refusal, or undefined while no account is signed in.
 */
export function accountAccess(ctx: Context): (url: string) => Promise<GatewayAccess | undefined> {
  return async (url) => {
    const account = ctx.get('deepseekAccount')
    const token = await account?.resolveToken(url)
    if (account === undefined || token === undefined || token === '') return undefined
    return { token, reject: () => account.rejectToken(token) }
  }
}

/**
 * Whether a path names a file on another computer: a Windows network path such as `\\host\share` or `//host/share`,
 * or a device path such as `\\?\UNC\host\share`, with either slash. Opening one on Windows connects to that computer
 * with the user's credentials, so tools refuse them on every platform.
 * @param path - the path as a call names it.
 * @returns true for such a path.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/u.test(path)
}

/**
 * The resolver of the files that a plugin's tool calls name: an absolute path as it is, and a relative one inside the
 * calling Session's working directory.
 * @param ctx - the plugin's context, with the working directory service.
 * @returns the resolver.
 */
export function sessionFiles<A>(ctx: {
  readonly workingDirectory: { ensure(agent: A, signal: AbortSignal): Promise<string> }
}): (requested: string, exec: { readonly agent?: A; readonly signal: AbortSignal }) => Promise<string> {
  return async (requested, exec) => {
    if (isNetworkPath(requested)) throw new Error(`${requested} is a network path; pass a path on this computer.`)
    if (isAbsolute(requested)) return requested
    if (exec.agent === undefined) throw new Error('Pass path as an absolute path.')
    return resolve(await ctx.workingDirectory.ensure(exec.agent, exec.signal), requested)
  }
}

/**
 * A tool result of one text block.
 * @param text - the text.
 * @returns the content blocks.
 */
export function textBlocks(text: string): Array<{ readonly type: 'text'; readonly text: string }> {
  return [{ type: 'text', text }]
}

/**
 * A file's size as results say it: kilobytes, at least 1, or megabytes to a tenth.
 * @param bytes - the size.
 * @returns the text.
 */
export function kilobytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Write a file in place of any earlier one, through a temporary file beside it, so a reader never meets part of it.
 * @param path - the file.
 * @param data - its bytes.
 */
export async function writeWhole(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.part`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Whether a call that writes a file finds one at its path, refusing a path the call may not write.
 * @param path - absolute path of the file.
 * @param file - the path as the call names it, for errors.
 * @param replace - whether the call may replace a file.
 * @param maker - the tool whose call holds a path with an empty file while it makes the file, named in the refusal of
 * an empty file; without it an empty file is refused as any other.
 * @returns whether a file is there, which the call replaces.
 * @throws {Error} when the path is a folder, or a file and `replace` is false.
 */
export async function replaceableFile(path: string, file: string, replace: boolean, maker?: string): Promise<boolean> {
  let found
  try {
    found = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!found.isFile()) throw new Error(`${file} is a folder; pass the path of a file.`)
  if (replace) return true
  const what = maker !== undefined && found.size === 0 ? `as an empty file, which another ${maker} call may still be making` : ''
  throw new Error(`${file} already exists${what === '' ? '' : ` ${what}`}. Pass replace: true to overwrite it, or choose another path.`)
}

/**
 * The size of a file a call names.
 * @param path - the file.
 * @param file - the file as the call names it, for errors.
 * @returns its size in bytes.
 * @throws {Error} when it does not exist or is not a file.
 */
export async function namedFileSize(path: string, file: string): Promise<number> {
  try {
    const found = await stat(path)
    if (!found.isFile()) throw new Error(`${file} is not a file.`)
    return found.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} does not exist.`, { cause: error })
    throw error
  }
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const

/** The schema of an image that a tool's result attaches for the agent's model. */
export const ATTACHED_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: STRING,
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: INTEGER,
    width: INTEGER,
    height: INTEGER,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: INTEGER, height: INTEGER } },
  },
} as const

/**
 * Whether the calling agent's model takes images, so a tool attaches the images it shows.
 * @param ctx - the plugin's context, with the optional attachment and model services.
 * @param exec - the tool call.
 * @returns false also when the Host keeps no attachments or the call has no agent.
 */
export async function modelSeesImages(
  ctx: Context,
  exec: {
    readonly agent?: { readonly model: { current(): { provider: string; model: string } | undefined } }
    readonly signal: AbortSignal
  },
): Promise<boolean> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const route = exec.agent?.model.current()
  if (attachments === undefined || llm === undefined || route === undefined) return false
  const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
  return info.inputModalities?.includes('image') === true
}

/**
 * An integer argument, or its default, within bounds.
 * @param value - the argument.
 * @param fallback - its default.
 * @param name - its name, for the error.
 * @param min - the least it may be.
 * @param max - the most it may be.
 * @param fail - the tool's failure, given the message.
 * @returns the integer.
 */
export function checkedInteger(
  value: number | undefined, fallback: number, name: string, min: number, max: number, fail: (message: string) => never,
): number {
  const chosen = value ?? fallback
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) fail(`${name} must be an integer from ${String(min)} to ${String(max)}.`)
  return chosen
}

/**
 * The path a window reads a file at. The window resolves a Session's relative paths against the folder in the
 * Session's header, which stays the project folder when an agent's working directory moves below it, as for a teammate
 * started in a subfolder.
 * @param root - the folder in the Session's header, or undefined when the header has none.
 * @param absolute - absolute path of the file.
 * @returns the `/`-separated path relative to `root` for a file inside it, and the absolute path otherwise.
 */
export function windowPath(root: string | undefined, absolute: string): string {
  const inside = root === undefined ? undefined : pathWithin(root, absolute)
  return inside === undefined || inside === '' ? absolute : inside
}

/**
 * Where a path lies in a folder.
 * @param folder - absolute folder.
 * @param path - absolute path.
 * @returns the `/`-separated path relative to `folder`, empty for the folder itself; undefined for a path outside it,
 * such as one on another drive.
 */
export function pathWithin(folder: string, path: string): string | undefined {
  const steps = relative(folder, path)
  if (steps === '..' || steps.startsWith(`..${sep}`) || isAbsolute(steps)) return undefined
  return steps.split(sep).join('/')
}

/**
 * Read a path's file information.
 * @param path - absolute path.
 * @returns the information, or undefined when nothing readable is there.
 */
export async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    // ENOENT, ENOTDIR, or EACCES: nothing readable at the path.
    return undefined
  }
}

/**
 * The folder part of a `/`-separated path.
 * @param path - the path.
 * @returns everything before its last `/`, or empty.
 */
export function pathFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * The name part of a `/`-separated path.
 * @param path - the path.
 * @returns everything after its last `/`.
 */
export function pathName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Rows of a listing's folders with their counts, in name order, at most `limit`.
 * @param counts - each folder's counts.
 * @param order - how folder names sort.
 * @param limit - the most rows.
 * @returns the rows.
 */
export function folderRows<C extends object>(
  counts: ReadonlyMap<string, C>, order: { compare(left: string, right: string): number }, limit: number,
): Array<{ readonly path: string } & C> {
  return [...counts.entries()]
    .sort(([left], [right]) => order.compare(left, right))
    .slice(0, limit)
    .map(([path, entry]) => ({ path, ...entry }))
}

/**
 * Wake a stream each time its state changes: it goes on at once, then after each change that its notifier reports,
 * changes that come while the stream is busy counting as one, until `ended` aborts. The notifier is in `watchers`
 * while the stream runs.
 * @param watchers - the notifiers of the state's streams, which the state calls on each change.
 * @param ended - ends the stream.
 * @yields once at the start and once for each change.
 * @returns the stream, which ends once `ended` aborts.
 */
export async function* stateChanges(watchers: Set<() => void>, ended: AbortSignal): AsyncGenerator<void, void, undefined> {
  let changed = true
  let wake: (() => void) | undefined
  const notify = (): void => {
    changed = true
    wake?.()
  }
  const onEnd = (): void => { wake?.() }
  watchers.add(notify)
  ended.addEventListener('abort', onEnd, { once: true })
  try {
    while (!ended.aborted) {
      if (changed) {
        changed = false
        yield
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
      wake = undefined
    }
  } finally {
    watchers.delete(notify)
    ended.removeEventListener('abort', onEnd)
  }
}
