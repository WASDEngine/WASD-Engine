import type { DesktopElectronBuilderConfig } from '../electron-builder.config.mjs'
import type { InstallerLocale } from './installer-locales.mjs'

/** An ordinary release configuration with the WASDEngine product identity applied. */
export type WasdengineElectronBuilderConfig = Omit<DesktopElectronBuilderConfig, 'protocols' | 'extraMetadata' | 'mac' | 'win'> & {
  readonly productName: string
  readonly protocols: readonly [{ readonly name: string; readonly schemes: readonly [string] }]
  readonly extraMetadata: DesktopElectronBuilderConfig['extraMetadata'] & {
    readonly productName: string
    readonly author: { readonly name: string }
  }
  readonly mac: DesktopElectronBuilderConfig['mac'] & { readonly icon: string }
  readonly win: DesktopElectronBuilderConfig['win'] & { readonly icon: string }
}

/**
 * Resolve one brand file named relative to the Desktop application directory.
 * @param path - Path relative to `apps/desktop`, as `WASDENGINE_DESKTOP_BRAND.icons` names it.
 * @returns Absolute path.
 */
export function wasdengineBrandFile(path: string): string

/**
 * Name the brand product in the Windows installer text, where upstream names DeepSeek Harness.
 * @param locales - Resources from `readInstallerLocales`.
 * @returns Copies whose installer and uninstaller text name `WASDENGINE_DESKTOP_BRAND.productName`.
 */
export function brandInstallerLocales(locales: InstallerLocale[]): InstallerLocale[]

/** `asarUnpack` pattern of the LibGodot runtime that `wasdengine-libgodot.ts` ships in the Godot plugin package. */
export const LIBGODOT_ASAR_UNPACK: string

/**
 * Keep the shipped LibGodot runtime on disk, outside `app.asar`: its runner starts as a process and loads the
 * library by path, which neither can do inside the archive.
 * @param config - Configuration from `createElectronBuilderConfig` or `applyWasdengineBrand`.
 * @returns A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineLibGodot<T extends { readonly asarUnpack: readonly string[] }>(config: T): T

/**
 * Replace the product identity in one electron-builder configuration: the product and bundle
 * names, the packaged manifest `productName` and `author`, the deep-link scheme, the icons, and
 * the microphone prompt.
 * @param config - Configuration from `createElectronBuilderConfig`.
 * @returns A new configuration that keeps every hook and packaging rule of `config`.
 * @throws When the application identifier is DeepSeek's, when the configuration embeds an update
 * feed outside `WASDENGINE_DESKTOP_BRAND.updateOrigin`, or when upstream no longer ships the About
 * panel icon this function replaces.
 */
export function applyWasdengineBrand(config: DesktopElectronBuilderConfig): WasdengineElectronBuilderConfig
