/** WASDEngine's update deployments: the GitHub releases feed, or no update service at all. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'
import { resolveDesktopAutoUpdateConfig, resolveDesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'

/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a signed build without an update feed or the mandatory-update
 * policy. Upstream accepts only `test` and `production` there, so every packaging step checks for the fork's values
 * before it resolves either.
 */
export const NO_UPDATE_SERVICE = 'none'

/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a build whose updater reads the newest GitHub release of
 * `WASDENGINE_DESKTOP_BRAND.releaseRepository`, without the mandatory-update policy, which needs a policy service.
 */
export const GITHUB_UPDATE_SERVICE = 'github'

/** Update channel of every GitHub feed build: GitHub serves one newest release, which the stable feed files name. */
const GITHUB_CHANNEL = 'stable'

/**
 * Whether a packaging environment packages without an update feed and the mandatory-update policy.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none`.
 */
export function desktopUpdatesDisabled(env) {
  return env.DSH_DESKTOP_AUTO_UPDATE_ENV?.trim() === NO_UPDATE_SERVICE
}

/**
 * Whether a packaging environment embeds the GitHub releases feed.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `github`.
 */
export function desktopGitHubUpdates(env) {
  return env.DSH_DESKTOP_AUTO_UPDATE_ENV?.trim() === GITHUB_UPDATE_SERVICE
}

/**
 * Whether a packaging environment packages without the mandatory-update policy, which only upstream's `test` and
 * `production` deployments serve.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none` or `github`.
 */
export function desktopUpdatePolicyDisabled(env) {
  return desktopUpdatesDisabled(env) || desktopGitHubUpdates(env)
}

/**
 * Whether an unsigned build of a platform embeds its update feed. macOS installs an update only when the new App's
 * signature satisfies the running App's designated requirement, which an ad hoc signature never does, so unsigned
 * macOS builds carry none. electron-updater checks a Windows update's SHA-512 against the feed and checks its
 * publisher only when `app-update.yml` names one, which an unsigned build omits, so unsigned Windows builds of the
 * GitHub feed carry it.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {boolean} True for a Windows build with `DSH_DESKTOP_AUTO_UPDATE_ENV=github`.
 */
export function unsignedBuildCarriesUpdateFeed(env, platform) {
  return platform === 'win32' && desktopGitHubUpdates(env)
}

/**
 * URL of the GitHub releases feed, which redirects every file name to that file of the newest release that is
 * neither a draft nor a pre-release.
 * @param {string} repository - `owner/name` of the GitHub repository.
 * @returns {string} Feed URL with a trailing slash.
 */
export function githubUpdateFeedUrl(repository = BRAND.releaseRepository) {
  return `https://github.com/${repository}/releases/latest/download/`
}

/**
 * URL of one file of the GitHub release `v<version>`.
 * @param {string} version - Desktop version; the release tag is `v<version>`.
 * @param {string} filename - Release file name.
 * @param {string} repository - `owner/name` of the GitHub repository.
 * @returns {string} Download URL.
 */
export function githubReleaseFileUrl(version, filename, repository = BRAND.releaseRepository) {
  return `https://github.com/${repository}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(filename)}`
}

/**
 * Resolve the update feed one packaging environment embeds: none for `none`, the GitHub releases feed for `github`,
 * and upstream's deployment otherwise. GitHub's asset storage answers a request for several byte ranges with HTTP
 * 501, so the GitHub feed sets `useMultipleRangeRequest: false` and differential downloads ask for one range at a time.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {string} arch - Target architecture.
 * @returns {import('./wasdengine-update-service.d.mts').WasdengineUpdateConfig | undefined} Feed, or undefined for `none`.
 * @throws {Error} When the GitHub feed is asked for a channel other than stable, or upstream's deployment is incomplete.
 */
export function resolveWasdengineUpdateConfig(env, platform, arch) {
  if (desktopUpdatesDisabled(env)) return undefined
  if (!desktopGitHubUpdates(env)) return resolveDesktopAutoUpdateConfig(env, platform, arch)
  const channel = env.DSH_DESKTOP_UPDATE_CHANNEL?.trim() || GITHUB_CHANNEL
  if (channel !== GITHUB_CHANNEL) {
    throw new Error(`desktop auto-update: the GitHub feed packages the ${GITHUB_CHANNEL} channel only; unset DSH_DESKTOP_UPDATE_CHANNEL`)
  }
  return {
    environment: GITHUB_UPDATE_SERVICE,
    channel: GITHUB_CHANNEL,
    target: resolveDesktopAutoUpdateTarget(platform, arch),
    publicUrl: githubUpdateFeedUrl(),
    useMultipleRangeRequest: false,
  }
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
