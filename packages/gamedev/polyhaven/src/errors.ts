/**
 * The expected failures of the Poly Haven tools. `PolyHavenError` is the plugin's class, so a tool result records it
 * with a code that names what comes next:
 * - `POLYHAVEN_ASSET_NOT_FOUND`: Poly Haven has no asset with the id, or lists it without files; find one with
 *   `polyhaven_search`.
 * - `POLYHAVEN_FILES_NOT_FOUND`: the asset has no files in the format or resolution, or no map, that the call names, or
 *   none that a download writes; choose from what `polyhaven_asset` lists.
 * - `POLYHAVEN_TOO_LARGE`: the files of the download are larger than `maxDownloadBytes`; choose a lower resolution,
 *   fewer maps, or another format.
 * - `POLYHAVEN_ALREADY_EXISTS`: a file in the folder has other contents, or something other than a file stands where
 *   one goes; pass `replace: true`, or download into another folder.
 * - `POLYHAVEN_DOWNLOAD_CORRUPT`: a file arrived damaged, shorter, or longer than Poly Haven's file list says, or the
 *   list names files that would leave the folder or be one file; nothing was saved.
 * - `POLYHAVEN_DISK_FAILED`: the download failed on the disk, as when permission is missing or the disk is full: a
 *   folder or a file could not be made, read, written, or moved. The message names the file and the error code, and
 *   `cause` holds the file system's error; check the folder, or download elsewhere.
 * - `POLYHAVEN_REQUEST_FAILED`: Poly Haven could not be reached, refused or limited a request, broke off, redirected
 *   elsewhere, or answered in a form the plugin cannot read; nothing was saved, so try again later. A failure of the
 *   kit's requests keeps the kit's `AssetLibraryRequestError`, with the HTTP status, as its `cause`.
 *
 * An argument that breaks a rule the parameter schema cannot state, such as a malformed id, throws `ToolArgsError`
 * (`INVALID_ARGS`) instead.
 * @module @deepseek-ai/dsh-polyhaven/src/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { AssetLibraryRequestError } from '@deepseek-ai/dsh-game-mcp/kit'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'

/** Every code of a Poly Haven failure; the module documentation gives each one's meaning. */
export const POLYHAVEN_ERROR_CODES = [
  'POLYHAVEN_ASSET_NOT_FOUND',
  'POLYHAVEN_FILES_NOT_FOUND',
  'POLYHAVEN_TOO_LARGE',
  'POLYHAVEN_ALREADY_EXISTS',
  'POLYHAVEN_DOWNLOAD_CORRUPT',
  'POLYHAVEN_DISK_FAILED',
  'POLYHAVEN_REQUEST_FAILED',
] as const

/** One code of {@link POLYHAVEN_ERROR_CODES}. */
export type PolyHavenErrorCode = typeof POLYHAVEN_ERROR_CODES[number]

/** A failure of a Poly Haven tool, with a message for the model. */
export class PolyHavenError extends HarnessError {
  override readonly code: PolyHavenErrorCode

  /**
   * @param message - what failed and what to do next.
   * @param code - the failure's code.
   * @param options - the failure's cause.
   */
  constructor(message: string, code: PolyHavenErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PolyHavenError'
    this.code = code
  }
}

/**
 * The HTTP status of a request to Poly Haven that failed.
 * @param error - the failure.
 * @returns the status, 0 when Poly Haven could not be reached, or undefined for a failure that is not a request's.
 */
export function requestStatus(error: unknown): number | undefined {
  return error instanceof PolyHavenError && error.cause instanceof AssetLibraryRequestError ? error.cause.status : undefined
}

/**
 * The plugin's errors for the failures of the game tools kit's shared code: its requests, the files it writes, and the
 * folders it resolves.
 */
export const POLYHAVEN_ERRORS = {
  /**
   * @param failure - a failed request, with its HTTP status.
   * @returns `POLYHAVEN_REQUEST_FAILED` with the request as its cause.
   */
  request: (failure: AssetLibraryRequestError): Error => new PolyHavenError(failure.message, 'POLYHAVEN_REQUEST_FAILED', { cause: failure }),
  /**
   * @param message - the conflicting files.
   * @returns `POLYHAVEN_ALREADY_EXISTS`.
   */
  exists: (message: string): Error => new PolyHavenError(message, 'POLYHAVEN_ALREADY_EXISTS'),
  /**
   * @param message - the files that would leave the folder or be one file.
   * @returns `POLYHAVEN_DOWNLOAD_CORRUPT`.
   */
  corrupt: (message: string): Error => new PolyHavenError(message, 'POLYHAVEN_DOWNLOAD_CORRUPT'),
  /**
   * @param message - the step, the file, and the error code.
   * @param cause - the file system's error.
   * @returns `POLYHAVEN_DISK_FAILED` with the file system's error as its cause.
   */
  disk: (message: string, cause: unknown): Error => new PolyHavenError(message, 'POLYHAVEN_DISK_FAILED', { cause }),
  /**
   * @param message - the refused argument.
   * @returns `ToolArgsError` (`INVALID_ARGS`).
   */
  argument: (message: string): Error => new ToolArgsError([message]),
} as const
