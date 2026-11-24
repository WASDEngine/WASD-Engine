/**
 * The expected failures of the game add-ons. `GameAddonError` is the domain's class, and the catalog, archive, path,
 * and record failures are its subclasses, so a tool result records each one's class and code. Each code names what
 * comes next:
 * - `GAME_ADDON_NOT_FOUND`: no catalog add-on has the id; search the catalog for it.
 * - `GAME_ADDON_PERMISSION_DENIED`: the user turned the add-on off in the Add-ons dialog; do the work without it, or
 *   ask the user to turn it on.
 * - `GAME_ADDON_CONFLICT`: an add-on that does the same job, or a script under the autoload name the add-on needs, is
 *   in the project; keep it, or remove or rename it first.
 * - `GAME_ADDON_ALREADY_EXISTS`: a copy of the add-on is in `addons/` without a WASD Engine record; install with
 *   `replace`, or keep the copy.
 * - `GAME_ADDON_NOT_INSTALLED`: the project does not have the add-on that a removal names.
 * - `GAME_ADDON_PROJECT_NOT_FOUND`: the folder holds no `project.godot`.
 * - `GAME_ADDON_OUTSIDE_PROJECT`: a folder of the project leads outside it, so nothing changes there.
 * - `GAME_ADDON_NOT_REGULAR_FILE`: a file that the manager edits, such as `project.godot`, is a symbolic link or not a
 *   regular file; replace it with a regular file.
 * - `GAME_ADDON_RECORD_CORRUPT`: the project's add-on record or settings file is not valid, or lists a path outside the
 *   add-on's folder; fix or delete it.
 * - `GAME_ADDON_RECORD_UNREADABLE`: that file exists but cannot be read.
 * - `GAME_ADDON_DOWNLOAD_FAILED`: an archive's request failed or answered an error status; try again later.
 * - `GAME_ADDON_ARCHIVE_CORRUPT`: an archive does not match its pin, cannot be read as a zip, or holds an entry that
 *   would leave its folder; nothing of it was installed.
 * - `GAME_ADDON_CATALOG_INVALID`: the catalog, a guide, or an entry that no longer fits its archive cannot be used.
 * - `GAME_ADDON_UNDO_INCOMPLETE`: a change failed and could not be undone completely; the message names what stays in
 *   the project, and `cause` holds the failure.
 * @module @deepseek-ai/dsh-game-addons/src/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Every code of a game add-on failure; the module documentation gives each one's meaning. */
export const GAME_ADDON_ERROR_CODES = [
  'GAME_ADDON_NOT_FOUND',
  'GAME_ADDON_PERMISSION_DENIED',
  'GAME_ADDON_CONFLICT',
  'GAME_ADDON_ALREADY_EXISTS',
  'GAME_ADDON_NOT_INSTALLED',
  'GAME_ADDON_PROJECT_NOT_FOUND',
  'GAME_ADDON_OUTSIDE_PROJECT',
  'GAME_ADDON_NOT_REGULAR_FILE',
  'GAME_ADDON_RECORD_CORRUPT',
  'GAME_ADDON_RECORD_UNREADABLE',
  'GAME_ADDON_DOWNLOAD_FAILED',
  'GAME_ADDON_ARCHIVE_CORRUPT',
  'GAME_ADDON_CATALOG_INVALID',
  'GAME_ADDON_UNDO_INCOMPLETE',
] as const

/** One code of {@link GAME_ADDON_ERROR_CODES}. */
export type GameAddonErrorCode = typeof GAME_ADDON_ERROR_CODES[number]

/** A request that the add-on manager refuses or a step of it that failed, with a message for the model or the user. */
export class GameAddonError extends HarnessError {
  override readonly code: GameAddonErrorCode

  /**
   * @param message - what failed and what to do next.
   * @param code - the failure's code.
   * @param options - the failure's cause.
   */
  constructor(message: string, code: GameAddonErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'GameAddonError'
    this.code = code
  }
}
