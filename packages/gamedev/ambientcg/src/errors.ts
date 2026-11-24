/**
 * The expected failures of the ambientCG tools. `AmbientCgError` is the plugin's class, so a tool result records it
 * with a code that names what comes next:
 * - `AMBIENTCG_ASSET_NOT_FOUND`: ambientCG has no material, decal, atlas, or HDRI with the id; find one with
 *   `ambientcg_search`.
 * - `AMBIENTCG_FILES_NOT_FOUND`: the asset or its archive has no files in the picture format or resolution, or no map,
 *   that the call names, or none that a download writes; choose from what `ambientcg_asset` lists.
 * - `AMBIENTCG_TOO_LARGE`: the archive, or the pictures that a download unpacks, are larger than `maxDownloadBytes`;
 *   choose a lower resolution, jpg, or fewer maps.
 * - `AMBIENTCG_ALREADY_EXISTS`: a picture in the folder has other contents, or something other than a file stands where
 *   one goes; pass `replace: true`, or download into another folder.
 * - `AMBIENTCG_DOWNLOAD_CORRUPT`: the archive or a picture arrived damaged, the archive cannot be read, or it names
 *   files that would leave the folder or be one file; nothing was saved.
 * - `AMBIENTCG_STALE_LISTING`: the archive differs from the asset's listing, as after an update of the asset; call
 *   again, which reads the new listing.
 * - `AMBIENTCG_DISK_FAILED`: the download failed on the disk, as when permission is missing or the disk is full: a
 *   folder, the archive's temporary copy, or a picture could not be made, read, written, or moved. The message names
 *   the file and the error code, and `cause` holds the file system's error; check the folder, or download elsewhere.
 * - `AMBIENTCG_REQUEST_FAILED`: ambientCG could not be reached, refused or limited a request, broke off, redirected
 *   elsewhere, or answered in a form the plugin cannot read; nothing was saved, so try again later. A failure of the
 *   kit's requests keeps the kit's `AssetLibraryRequestError`, with the HTTP status, as its `cause`.
 *
 * An argument that breaks a rule the parameter schema cannot state, such as a malformed id, throws `ToolArgsError`
 * (`INVALID_ARGS`) instead.
 * @module @deepseek-ai/dsh-ambientcg/src/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { AssetLibraryRequestError } from '@deepseek-ai/dsh-game-mcp/kit'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'

/** Every code of an ambientCG failure; the module documentation gives each one's meaning. */
export const AMBIENTCG_ERROR_CODES = [
  'AMBIENTCG_ASSET_NOT_FOUND',
  'AMBIENTCG_FILES_NOT_FOUND',
  'AMBIENTCG_TOO_LARGE',
  'AMBIENTCG_ALREADY_EXISTS',
  'AMBIENTCG_DOWNLOAD_CORRUPT',
  'AMBIENTCG_STALE_LISTING',
  'AMBIENTCG_DISK_FAILED',
  'AMBIENTCG_REQUEST_FAILED',
] as const

/** One code of {@link AMBIENTCG_ERROR_CODES}. */
export type AmbientCgErrorCode = typeof AMBIENTCG_ERROR_CODES[number]

/** A failure of an ambientCG tool, with a message for the model. */
export class AmbientCgError extends HarnessError {
  override readonly code: AmbientCgErrorCode

  /**
   * @param message - what failed and what to do next.
   * @param code - the failure's code.
   * @param options - the failure's cause.
   */
  constructor(message: string, code: AmbientCgErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AmbientCgError'
    this.code = code
  }
}

/**
 * Whether a failure is an archive that differs from the asset's listing.
 * @param error - the failure.
 * @returns true for `AMBIENTCG_STALE_LISTING`.
 */
export function isStaleListing(error: unknown): boolean {
  return error instanceof AmbientCgError && error.code === 'AMBIENTCG_STALE_LISTING'
}

/**
 * The plugin's errors for the failures of the game tools kit's shared code: its requests, the files it writes, and the
 * folders it resolves.
 */
export const AMBIENTCG_ERRORS = {
  /**
   * @param failure - a failed request, with its HTTP status.
   * @returns `AMBIENTCG_REQUEST_FAILED` with the request as its cause.
   */
  request: (failure: AssetLibraryRequestError): Error => new AmbientCgError(failure.message, 'AMBIENTCG_REQUEST_FAILED', { cause: failure }),
  /**
   * @param message - the conflicting files.
   * @returns `AMBIENTCG_ALREADY_EXISTS`.
   */
  exists: (message: string): Error => new AmbientCgError(message, 'AMBIENTCG_ALREADY_EXISTS'),
  /**
   * @param message - the files that would leave the folder or be one file.
   * @returns `AMBIENTCG_DOWNLOAD_CORRUPT`.
   */
  corrupt: (message: string): Error => new AmbientCgError(message, 'AMBIENTCG_DOWNLOAD_CORRUPT'),
  /**
   * @param message - the step, the file, and the error code.
   * @param cause - the file system's error.
   * @returns `AMBIENTCG_DISK_FAILED` with the file system's error as its cause.
   */
  disk: (message: string, cause: unknown): Error => new AmbientCgError(message, 'AMBIENTCG_DISK_FAILED', { cause }),
  /**
   * @param message - the refused argument.
   * @returns `ToolArgsError` (`INVALID_ARGS`).
   */
  argument: (message: string): Error => new ToolArgsError([message]),
} as const
