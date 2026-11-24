/**
 * Write the files of one download plan into a folder. Each file streams from Poly Haven into a temporary file beside
 * its target while its size and MD5 digest are checked, and the files are written whole or not at all: a failed or
 * cancelled download writes none of them, a file already in place with the same digest is not downloaded again, and a
 * file with other contents stops the download unless the call allows replacing it.
 * @module @deepseek-ai/dsh-polyhaven/src/download
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { saveBody, writeAssetFiles } from '@deepseek-ai/dsh-game-mcp/kit'
import type { PolyHavenDownloadPlan, PolyHavenFile, PolyHavenWrittenFile } from './types.ts'

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

async function md5Of(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Stream one file into a temporary path beside its target and check it.
 * @throws Error when the request fails, or the size or digest differs from the file tree's.
 */
async function fetchInto(temporary: string, path: string, file: PolyHavenFile, options: WriteOptions, signal: AbortSignal): Promise<void> {
  const response = await options.open(file.url, signal)
  const tooLong = (): Error => new Error(`Poly Haven sent more than the ${file.size} bytes of ${path}; the download stopped.`)
  const { bytes, digest } = await saveBody(response, temporary, 'md5', file.size, tooLong, signal)
  if (bytes !== file.size) throw new Error(`Poly Haven sent ${bytes} of the ${file.size} bytes of ${path}; the download stopped.`)
  if (digest !== file.md5) throw new Error(`${path} arrived damaged: its MD5 digest differs from Poly Haven's; the download stopped.`)
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
  return await writeAssetFiles(plan.files.map(({ path, file }) => ({
    path,
    bytes: file.size,
    same: async (target, signal) => await md5Of(target, signal) === file.md5,
    write: (temporary, signal) => fetchInto(temporary, path, file, options, signal),
  })), directory, options)
}
