import type { DesktopAutoUpdateConfig, DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'

/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a signed build without an update feed or the mandatory-update
 * policy.
 */
export const NO_UPDATE_SERVICE: 'none'

/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a build whose updater reads the newest GitHub release of
 * `WASDENGINE_DESKTOP_BRAND.releaseRepository`, without the mandatory-update policy.
 */
export const GITHUB_UPDATE_SERVICE: 'github'

/** The GitHub releases feed one build embeds. */
export interface WasdengineGitHubUpdateConfig {
  readonly environment: 'github'
  readonly channel: 'stable'
  readonly target: DesktopAutoUpdateTarget
  readonly publicUrl: string
  /** GitHub's asset storage answers a request for several byte ranges with HTTP 501. */
  readonly useMultipleRangeRequest: false
}

/** The update feed one build embeds: the GitHub releases feed or one of upstream's deployments. */
export type WasdengineUpdateConfig = WasdengineGitHubUpdateConfig | DesktopAutoUpdateConfig

/**
 * Whether a packaging environment packages without an update feed and the mandatory-update policy.
 * @param env - Packaging environment.
 * @returns True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none`.
 */
export function desktopUpdatesDisabled(env: NodeJS.ProcessEnv): boolean

/**
 * Whether a packaging environment embeds the GitHub releases feed.
 * @param env - Packaging environment.
 * @returns True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `github`.
 */
export function desktopGitHubUpdates(env: NodeJS.ProcessEnv): boolean

/**
 * Whether a packaging environment packages without the mandatory-update policy.
 * @param env - Packaging environment.
 * @returns True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none` or `github`.
 */
export function desktopUpdatePolicyDisabled(env: NodeJS.ProcessEnv): boolean

/**
 * Whether an unsigned build of a platform embeds its update feed: only Windows builds of the GitHub feed do.
 * @param env - Packaging environment.
 * @param platform - Target platform.
 * @returns True for a Windows build with `DSH_DESKTOP_AUTO_UPDATE_ENV=github`.
 */
export function unsignedBuildCarriesUpdateFeed(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean

/**
 * URL of the GitHub releases feed, which serves the newest release that is neither a draft nor a pre-release.
 * @param repository - `owner/name` of the GitHub repository; defaults to the brand's.
 * @returns Feed URL with a trailing slash.
 */
export function githubUpdateFeedUrl(repository?: string): string

/**
 * URL of one file of the GitHub release `v<version>`.
 * @param version - Desktop version.
 * @param filename - Release file name.
 * @param repository - `owner/name` of the GitHub repository; defaults to the brand's.
 * @returns Download URL.
 */
export function githubReleaseFileUrl(version: string, filename: string, repository?: string): string

/**
 * Resolve the update feed one packaging environment embeds.
 * @param env - Packaging environment.
 * @param platform - Target platform.
 * @param arch - Target architecture.
 * @returns Feed, or undefined when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none`.
 * @throws When the GitHub feed is asked for a channel other than stable, or upstream's deployment is incomplete.
 */
export function resolveWasdengineUpdateConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string): WasdengineUpdateConfig | undefined

/**
 * Require that an assembled macOS App carries no updater configuration.
 * @param appPath - Application bundle path.
 * @throws When the App holds `Contents/Resources/app-update.yml`.
 */
export function verifyNoMacOSAppUpdateConfig(appPath: string): void
