/**
 * Runtimes that the Desktop app ships inside an application plugin's package: one `<platform>-<arch>` folder per
 * runtime in the package's `runtime` folder, described by the `runtime.json` that the runtime's build writes. A server
 * reads the record through a {@link ShippedRuntimeHost}, so the lookup is testable without a runtime.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { nodeSetupHost } from './setup-host.ts'
import type { SetupHost } from './setup-host.ts'

/** The setup host plus the processor architecture and the text file that a shipped runtime lookup reads. */
export interface ShippedRuntimeHost extends SetupHost {
  /** Processor architecture in Node's names, such as `arm64`; selects the shipped runtime. */
  readonly arch: string
  /**
   * Read a UTF-8 text file.
   * @param file - absolute path.
   * @returns the text, or undefined when the file does not exist.
   */
  readTextFile(file: string): Promise<string | undefined>
}

/**
 * The real host: the shared `nodeSetupHost`, this process's architecture, and `node:fs` reads.
 * @returns a host bound to this process.
 */
export function nodeShippedRuntimeHost(): ShippedRuntimeHost {
  return {
    ...nodeSetupHost(),
    arch: process.arch,
    async readTextFile(file) {
      try {
        return await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}

/**
 * Locate the runtimes a packaged application ships inside a plugin package. A package inside an Electron `app.asar`
 * archive reads them from the sibling `app.asar.unpacked`, where the application keeps native files on disk.
 * @param packageRoot - folder holding the package manifest.
 * @returns the package's `runtime` folder, which holds one `<platform>-<arch>` folder per shipped runtime.
 */
export function shippedRuntimeRoot(packageRoot: string): string {
  return path.join(packageRoot.replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked'), 'runtime')
}

/** A path inside a runtime folder: relative, with `/` separators, and without `.` or `..` parts. */
export const ShippedRuntimePath = z.string().min(1).refine(
  value => !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\\')),
  'must be a relative path inside the runtime folder',
)

/** The `runtime.json` fields of every shipped runtime, which a runtime's record schema spreads beside its own. */
export const ShippedRuntimeFields = {
  format: z.literal(1),
  version: z.string().min(1),
  platform: z.string(),
  arch: z.string(),
}

/** A shipped runtime: its folder and its validated `runtime.json`. */
export interface ShippedRuntime<R> {
  /** The runtime's `<platform>-<arch>` folder. */
  readonly directory: string
  /** The validated record. */
  readonly record: R
  /**
   * Resolve a path of the record against the folder.
   * @param relative - `/`-separated path inside the folder, such as a {@link ShippedRuntimePath} field.
   * @returns the absolute path.
   */
  resolve(relative: string): string
}

/** A runtime that the Desktop app ships as its archive, for a server to unpack on first use. */
export interface PackedRuntime<R> {
  /** The runtime's `<platform>-<arch>` folder, which holds the archive and its `archive.json`. */
  readonly directory: string
  /** The gzip-compressed tar archive, whose files unpack into the runtime layout with its `runtime.json`. */
  readonly archive: string
  /** The archive's size in bytes. */
  readonly bytes: number
  /** The archive's SHA-256 digest. */
  readonly sha256: string
  /** The validated fields of the archive's `runtime.json`, without its file digests. */
  readonly record: R
}

/** A file name inside a runtime folder: no `/` or `\` separators, no `.` or `..`, and no leading dot. */
const ArchiveName = z.string().regex(/^[^/\\.][^/\\]*$/u, 'must be a file name inside the runtime folder')

/**
 * Read the runtime that the Desktop app ships as its archive for this Host's platform and architecture:
 * `<root>/<platform>-<arch>/archive.json`, which names the archive beside it, its size and SHA-256, and the fields of
 * its `runtime.json`. Desktop packaging ships the archive on a platform whose path length limit the runtime's deepest
 * files would pass below the app's install folder.
 * @param root - the package's `runtime` folder, from {@link shippedRuntimeRoot}.
 * @param host - platform, architecture, and file reads.
 * @param schema - the runtime's record schema, which spreads {@link ShippedRuntimeFields}.
 * @param invalid - builds the error for a runtime that cannot run, from its folder and the reason.
 * @returns the runtime, or undefined when no archive is shipped for this platform.
 * @throws the error that `invalid` builds when `archive.json` is not JSON, does not match the schema, or describes
 *   another platform or architecture.
 */
export async function readPackedRuntime<R extends { readonly platform: string; readonly arch: string }>(
  root: string, host: ShippedRuntimeHost, schema: z.ZodType<R>, invalid: (directory: string, reason: string) => Error,
): Promise<PackedRuntime<R> | undefined> {
  const archiveRecord = z.object({
    format: z.literal(1),
    archive: ArchiveName,
    bytes: z.int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    runtime: schema,
  })
  const shipped = await readRecord(root, host, 'archive.json', archiveRecord, record => record.runtime, invalid)
  if (shipped === undefined) return undefined
  const { record, directory } = shipped
  return { directory, archive: shipped.resolve(record.archive), bytes: record.bytes, sha256: record.sha256, record: record.runtime }
}

/**
 * Read the runtime that the Desktop app ships for this Host's platform and architecture:
 * `<root>/<platform>-<arch>/runtime.json`.
 * @param root - the package's `runtime` folder, from {@link shippedRuntimeRoot}.
 * @param host - platform, architecture, and file reads.
 * @param schema - the runtime's record schema, which spreads {@link ShippedRuntimeFields}.
 * @param invalid - builds the error for a runtime that cannot run, from its folder and the reason.
 * @returns the runtime, or undefined when no runtime is shipped for this platform.
 * @throws the error that `invalid` builds when `runtime.json` is not JSON, does not match the schema, or describes
 *   another platform or architecture.
 */
export async function readShippedRuntime<R extends { readonly platform: string; readonly arch: string }>(
  root: string, host: ShippedRuntimeHost, schema: z.ZodType<R>, invalid: (directory: string, reason: string) => Error,
): Promise<ShippedRuntime<R> | undefined> {
  return await readRecord(root, host, 'runtime.json', schema, record => record, invalid)
}

/** Read and validate one record file of this Host's `<platform>-<arch>` folder; undefined when the file is missing. */
async function readRecord<T>(
  root: string, host: ShippedRuntimeHost, file: string, schema: z.ZodType<T>,
  place: (record: T) => { readonly platform: string; readonly arch: string }, invalid: (directory: string, reason: string) => Error,
): Promise<ShippedRuntime<T> | undefined> {
  const paths = host.platform === 'win32' ? path.win32 : path.posix
  const directory = paths.join(root, `${host.platform}-${host.arch}`)
  const recordFile = paths.join(directory, file)
  const text = await host.readTextFile(recordFile)
  if (text === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // SyntaxError: the file is not JSON, which the runtime record must be.
    throw invalid(directory, `${recordFile} is not JSON`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw invalid(directory, `${recordFile} is not a format 1 runtime record: ${z.prettifyError(parsed.error)}`)
  const record = parsed.data
  const { platform, arch } = place(record)
  if (platform !== host.platform || arch !== host.arch) throw invalid(directory, `its ${file} describes ${platform}-${arch}`)
  return { directory, record, resolve: relative => paths.join(directory, ...relative.split('/')) }
}
