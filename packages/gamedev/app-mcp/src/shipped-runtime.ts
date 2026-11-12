/**
 * Runtimes that the Desktop app ships inside an application plugin's package: one `<platform>-<arch>` folder per
 * runtime in the package's `runtime` folder, described by the `runtime.json` that the runtime's build writes, or, on a
 * platform whose path length limit the runtime's deepest files would pass below the app's install folder, holding the
 * runtime's archive, which a server unpacks under its data folder on first use. A server reads the record and unpacks
 * the archive through a {@link ShippedRuntimeHost} or {@link RuntimeUnpackHost}, so both are testable without a runtime.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { firstExecutable, nodeSetupHost, runCommand } from './setup-host.ts'
import type { CommandArgv, CommandOptions, CommandResult, SetupHost } from './setup-host.ts'

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
  const paths = pathsOf(host.platform)
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

/** File-system and process effects of unpacking a runtime that the Desktop app ships as its archive. */
export interface RuntimeUnpackHost extends ShippedRuntimeHost {
  /**
   * Rename a directory; rejects when the destination exists and is not empty.
   * @param from - existing path.
   * @param to - new path.
   */
  rename(from: string, to: string): Promise<void>
  /**
   * Remove a file or directory tree; succeeds when it is already absent.
   * @param target - absolute path.
   */
  remove(target: string): Promise<void>
  /**
   * Run a command to completion without a shell.
   * @param argv - absolute executable followed by its arguments.
   * @param options - working directory, environment, and cancellation.
   * @returns exit status and the bounded output tail.
   */
  run(argv: CommandArgv, options: CommandOptions): Promise<CommandResult>
}

/**
 * The real host: the shared `nodeShippedRuntimeHost`, plus `node:fs` renames and removals and `node:child_process`
 * commands on this machine.
 * @param outputLimit - bytes of command output kept for diagnostics.
 * @returns a host bound to the current process environment and architecture.
 */
export function nodeRuntimeUnpackHost(outputLimit: number): RuntimeUnpackHost {
  return {
    ...nodeShippedRuntimeHost(),
    async rename(from, to) { await rename(from, to) },
    async remove(target) { await rm(target, { recursive: true, force: true }) },
    run: async (argv, options) => await runCommand(argv, options, outputLimit),
  }
}

/**
 * The folder that a packed runtime unpacks into: `<dataRoot>/runtime/<version>`, where even a long user name leaves
 * the deepest files of a runtime well inside Windows' path length limit.
 * @param dataRoot - the plugin's data directory.
 * @param version - the runtime version, such as `5.2.3-wasd.1`.
 * @param platform - selects the path syntax.
 * @returns the folder.
 */
export function unpackedRuntimeDirectory(dataRoot: string, version: string, platform: NodeJS.Platform): string {
  return pathsOf(platform).join(dataRoot, 'runtime', version)
}

/**
 * Find a program on the absolute `PATH` entries (`name.exe` on Windows).
 * @param name - program name without extension.
 * @param host - environment and file checks.
 * @returns the first match, or undefined.
 */
export async function findOnPath(name: string, host: SetupHost): Promise<string | undefined> {
  const paths = pathsOf(host.platform)
  const file = host.platform === 'win32' ? `${name}.exe` : name
  for (const directory of (host.env.PATH ?? host.env.Path ?? '').split(paths.delimiter)) {
    if (!paths.isAbsolute(directory)) continue
    const candidate = paths.join(directory, file)
    if (await host.isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * The `tar` that unpacks a packed runtime: on Windows the bsdtar of `%SystemRoot%\System32`, because the GNU tar that
 * Git for Windows puts on `PATH` reads `C:\...` as a remote host; elsewhere `/usr/bin/tar`, then `tar` on `PATH`.
 * @param host - environment and file checks.
 * @returns the tar program, or undefined when there is none.
 */
export async function findTar(host: SetupHost): Promise<string | undefined> {
  if (host.platform !== 'win32') return await firstExecutable(['/usr/bin/tar'], host) ?? await findOnPath('tar', host)
  const root = host.env.SystemRoot ?? host.env.windir ?? 'C:\\Windows'
  return await firstExecutable([path.win32.join(root, 'System32', 'tar.exe')], host)
}

/**
 * Move a built or unpacked folder to its final path. A folder already there whose program is not executable, such as
 * one whose files were partly deleted, is moved aside and deleted; a working one that a concurrent server moved there
 * first is accepted.
 * @param host - renames, removals, and file checks.
 * @param built - the folder to move.
 * @param target - the final folder and the program inside it that a working folder holds.
 * @param failure - builds the error for a folder that cannot be moved into place, from the rename's error.
 * @throws the error that `failure` builds.
 */
export async function moveIntoPlace(
  host: RuntimeUnpackHost, built: string, target: { readonly directory: string; readonly program: string },
  failure: (cause: unknown) => Error,
): Promise<void> {
  try {
    await host.rename(built, target.directory)
    return
  } catch (error) {
    if (await host.isExecutable(target.program)) return
    const stale = `${target.directory}.stale-${randomUUID()}`
    try {
      await host.rename(target.directory, stale)
    } catch {
      // Nothing could be moved aside, so the failure of the first rename is the cause.
      throw failure(error)
    }
    try {
      await host.rename(built, target.directory)
    } catch (retryError) {
      if (!await host.isExecutable(target.program)) throw failure(retryError)
    } finally {
      await host.remove(stale)
    }
  }
}

/** Whether a folder holds an unpacked runtime whose `runtime.json` has every field of the given record. */
async function holdsRuntime(directory: string, expected: Readonly<Record<string, unknown>>, host: ShippedRuntimeHost): Promise<boolean> {
  const text = await host.readTextFile(pathsOf(host.platform).join(directory, 'runtime.json'))
  if (text === undefined) return false
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // SyntaxError: a runtime.json that is not JSON describes no runtime, so the archive unpacks again.
    return false
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false
  const record = json as Record<string, unknown>
  return Object.entries(expected).every(([field, value]) => record[field] === value)
}

/** How {@link unpackPackedRuntime} reports a runtime that it cannot unpack or move into place. */
export interface RuntimeUnpackFailures {
  /**
   * Build the error for an archive that cannot run: missing, no tar, a failing tar, or another runtime inside.
   * @param directory - the package's `<platform>-<arch>` folder that holds the archive.
   * @param reason - what is wrong.
   * @returns the error to throw.
   */
  invalid(directory: string, reason: string): Error
  /**
   * Build the error for an unpacked runtime that cannot be moved to its final folder.
   * @param directory - the final folder.
   * @param cause - the rename's error.
   * @returns the error to throw.
   */
  moveFailed(directory: string, cause: unknown): Error
}

/** A runtime that {@link unpackPackedRuntime} unpacked, or found unpacked. */
export interface UnpackedRuntime {
  /** The folder under the data root that holds the runtime and its `runtime.json`. */
  readonly directory: string
  /**
   * Resolve a path of the record against the folder.
   * @param relative - `/`-separated path inside the folder, such as a {@link ShippedRuntimePath} field.
   * @returns the absolute path.
   */
  resolve(relative: string): string
  /** Whether this call unpacked the archive; false when the folder already held the runtime. */
  readonly unpacked: boolean
}

/**
 * Unpack a runtime that the Desktop app ships as its archive into {@link unpackedRuntimeDirectory}, unless that folder
 * already holds it: a `runtime.json` with every field of the archive's record and an executable `program`. The archive
 * unpacks into a uniquely named sibling folder that is renamed into place, so an interrupted unpack never leaves a
 * half-unpacked runtime at the final path; a folder there whose program is not executable is replaced, and a runtime
 * that a concurrent server unpacked first is accepted.
 * @param packed - the archive and its runtime fields, from {@link readPackedRuntime}.
 * @param program - the record's `/`-separated path of the program that a working runtime holds.
 * @param dataRoot - the plugin's data directory.
 * @param host - file-system and process effects.
 * @param signal - cancels the running tar.
 * @param failures - builds the plugin's errors.
 * @returns the unpacked runtime and whether this call unpacked it.
 * @throws the errors that `failures` builds when the archive or tar is missing, tar fails, the unpacked `runtime.json`
 *   does not describe the archive's runtime, or the runtime cannot be moved into place.
 */
export async function unpackPackedRuntime<R extends { readonly version: string }>(
  packed: PackedRuntime<R>, program: string, dataRoot: string, host: RuntimeUnpackHost, signal: AbortSignal,
  failures: RuntimeUnpackFailures,
): Promise<UnpackedRuntime> {
  const paths = pathsOf(host.platform)
  const directory = unpackedRuntimeDirectory(dataRoot, packed.record.version, host.platform)
  const resolve = (relative: string): string => paths.join(directory, ...relative.split('/'))
  const target = { directory, program: resolve(program) }
  if (await holdsRuntime(directory, packed.record, host) && await host.isExecutable(target.program)) {
    return { directory, resolve, unpacked: false }
  }
  if (!(await host.listDirectory(packed.directory)).includes(paths.basename(packed.archive))) {
    throw failures.invalid(packed.directory, `its archive.json names ${packed.archive}, which is missing`)
  }
  const tar = await findTar(host)
  if (tar === undefined) {
    throw failures.invalid(packed.directory, `no tar program was found to unpack ${packed.archive}; Windows 10 and later have one in System32`)
  }
  await host.makeDirectory(paths.dirname(directory))
  // A short suffix keeps the folder's deepest paths inside Windows' path length limit while the archive unpacks.
  const partial = `${directory}.partial-${randomUUID().slice(0, 8)}`
  await host.makeDirectory(partial)
  try {
    // Windows' tar reads its arguments in the ANSI code page, which cannot hold every character of a profile folder, so
    // tar gets no path: it unpacks the archive from its standard input into its working folder.
    const result = await host.run([tar, '-xzf', '-'], { cwd: partial, env: host.env, signal, stdinFile: packed.archive })
    if (result.exitCode !== 0) {
      const ended = result.exitCode === null ? `signal ${String(result.signal)}` : `exit code ${String(result.exitCode)}`
      throw failures.invalid(packed.directory, `tar could not unpack ${packed.archive} (${ended}): ${result.output.trim()}`)
    }
    if (!await holdsRuntime(partial, packed.record, host)) {
      throw failures.invalid(packed.directory, `the runtime.json in ${packed.archive} does not describe the runtime ${packed.record.version} that its archive.json names`)
    }
    await moveIntoPlace(host, partial, target, cause => failures.moveFailed(directory, cause))
  } finally {
    await host.remove(partial)
  }
  return { directory, resolve, unpacked: true }
}

function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}
