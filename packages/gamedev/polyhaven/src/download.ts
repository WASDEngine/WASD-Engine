/**
 * Write the files of one download plan into a folder. Each file streams into a temporary file beside its target while
 * its size and MD5 digest are checked, and only after every file arrived intact do the temporary files take their
 * targets' places, so a failed or cancelled download writes none of its files. A file already in place with the same
 * digest is not downloaded again; a file with other contents stops the download unless the call allows replacing it.
 * @module @deepseek-ai/dsh-polyhaven/src/download
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { PolyHavenDownloadPlan, PolyHavenFile, PolyHavenFileStatus, PolyHavenWrittenFile } from './types.ts'

/** Most conflicting files that an error lists by name. */
const LISTED_CONFLICTS = 5

/** How one download reaches its files. */
export interface WriteOptions {
  /** Whether files whose contents differ are replaced; otherwise they stop the download before anything is written. */
  readonly replace: boolean
  /**
   * Start downloading one file.
   * @param url - file URL.
   * @param signal - cancellation of the request and its body.
   * @returns the successful response.
   */
  readonly open: (url: string, signal: AbortSignal) => Promise<Response>
  /** Cancellation of the whole download. */
  readonly signal: AbortSignal
}

/** One file of the plan with its target and what the download does with it. */
interface Target {
  readonly path: string
  readonly file: PolyHavenFile
  readonly target: string
  readonly status: PolyHavenFileStatus
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function md5Of(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Find what the download does with one file.
 * @throws Error when the target exists and is not a regular file.
 */
async function targetOf(directory: string, path: string, file: PolyHavenFile, signal: AbortSignal): Promise<Target> {
  const target = join(directory, ...path.split('/'))
  const inside = relative(directory, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`The file ${path} would leave the download folder; the download stopped.`)
  let status: PolyHavenFileStatus
  try {
    const stats = await lstat(target)
    if (!stats.isFile()) throw new Error(`${target} exists and is not a file; move it or download into another directory.`)
    status = stats.size === file.size && await md5Of(target, signal) === file.md5 ? 'unchanged' : 'replaced'
  } catch (error) {
    if (!isMissing(error)) throw error
    status = 'downloaded'
  }
  return { path, file, target, status }
}

/**
 * Stream one file into a temporary path beside its target and check it.
 * @throws Error when the request fails, or the size or digest differs from the file tree's.
 */
async function fetchInto(temporary: string, entry: Target, options: WriteOptions, signal: AbortSignal): Promise<void> {
  const response = await options.open(entry.file.url, signal)
  const hash = createHash('md5')
  let bytes = 0
  async function* checked(): AsyncGenerator<Uint8Array> {
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength
      if (bytes > entry.file.size) throw new Error(`Poly Haven sent more than the ${entry.file.size} bytes of ${entry.path}; the download stopped.`)
      hash.update(chunk)
      yield chunk
    }
  }
  await pipeline(checked(), createWriteStream(temporary, { flags: 'wx' }), { signal })
  if (bytes !== entry.file.size) throw new Error(`Poly Haven sent ${bytes} of the ${entry.file.size} bytes of ${entry.path}; the download stopped.`)
  if (hash.digest('hex') !== entry.file.md5) throw new Error(`${entry.path} arrived damaged: its MD5 digest differs from Poly Haven's; the download stopped.`)
}

/**
 * Write a plan's files into a folder, creating the folder and its subfolders.
 * @param plan - the files.
 * @param directory - absolute download folder.
 * @param options - whether to replace changed files, how to fetch a file, and cancellation.
 * @returns what happened to each file, in plan order.
 * @throws Error when a file conflicts, a request fails, a file arrives damaged, or writing fails; no file of the plan
 * is written then, except when moving the checked files into place fails partway.
 */
export async function writeDownload(
  plan: PolyHavenDownloadPlan,
  directory: string,
  options: WriteOptions,
): Promise<PolyHavenWrittenFile[]> {
  const { signal } = options
  const targets: Target[] = []
  for (const { path, file } of plan.files) targets.push(await targetOf(directory, path, file, signal))
  const conflicts = targets.filter(target => target.status === 'replaced')
  if (conflicts.length > 0 && !options.replace) {
    const names = conflicts.slice(0, LISTED_CONFLICTS).map(conflict => conflict.path).join(', ')
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
        await fetchInto(temporary, entry, options, linked)
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
  return targets.map(target => ({ path: target.path, bytes: target.file.size, status: target.status }))
}
