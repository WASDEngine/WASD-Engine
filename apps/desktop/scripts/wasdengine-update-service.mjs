/** WASDEngine's packaging switch for signed builds without an update service. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a signed build without an update feed or the mandatory-update
 * policy, as WASDEngine's notarized macOS releases do while it has no update service. Upstream accepts only `test` and
 * `production` there, so every packaging step checks for this value before it resolves either.
 */
export const NO_UPDATE_SERVICE = 'none'

/**
 * Whether a packaging environment packages without an update feed and the mandatory-update policy.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none`.
 */
export function desktopUpdatesDisabled(env) {
  return env.DSH_DESKTOP_AUTO_UPDATE_ENV?.trim() === NO_UPDATE_SERVICE
}

/**
 * Require that an assembled macOS App carries no updater configuration.
 * @param {string} appPath - Application bundle path.
 * @returns {void}
 * @throws {Error} When the App holds `Contents/Resources/app-update.yml`.
 */
export function verifyNoMacOSAppUpdateConfig(appPath) {
  if (existsSync(join(appPath, 'Contents', 'Resources', 'app-update.yml'))) {
    throw new Error(`desktop macOS packaging: ${appPath} carries an update feed, but DSH_DESKTOP_AUTO_UPDATE_ENV is ${NO_UPDATE_SERVICE}`)
  }
}
