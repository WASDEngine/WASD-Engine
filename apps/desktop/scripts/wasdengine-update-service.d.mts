/**
 * `DSH_DESKTOP_AUTO_UPDATE_ENV` value that packages a signed build without an update feed or the mandatory-update
 * policy, as WASDEngine's notarized macOS releases do while it has no update service.
 */
export const NO_UPDATE_SERVICE: 'none'

/**
 * Whether a packaging environment packages without an update feed and the mandatory-update policy.
 * @param env - Packaging environment.
 * @returns True when `DSH_DESKTOP_AUTO_UPDATE_ENV` is `none`.
 */
export function desktopUpdatesDisabled(env: NodeJS.ProcessEnv): boolean

/**
 * Require that an assembled macOS App carries no updater configuration.
 * @param appPath - Application bundle path.
 * @throws When the App holds `Contents/Resources/app-update.yml`.
 */
export function verifyNoMacOSAppUpdateConfig(appPath: string): void
