import type { DesktopElectronBuilderConfig } from '../electron-builder.config.mjs'
import type { InstallerLocale } from './installer-locales.mjs'

/** An ordinary release configuration with the WASDEngine product identity applied. */
export type WasdengineElectronBuilderConfig = Omit<DesktopElectronBuilderConfig, 'protocols' | 'extraMetadata' | 'mac' | 'win'> & {
  readonly productName: string
  readonly protocols: readonly [{ readonly name: string; readonly schemes: readonly [string] }]
  readonly extraMetadata: DesktopElectronBuilderConfig['extraMetadata'] & {
    readonly name: string
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

/** `asarUnpack` pattern of the SuperCollider runtime that `wasdengine-supercollider.ts` ships in the SuperCollider plugin package. */
export const SUPERCOLLIDER_ASAR_UNPACK: string

/**
 * Keep the shipped SuperCollider runtime on disk, outside `app.asar`: sclang and scsynth start as processes and read
 * their class library, UGen plugins, and help files by path, which none of them can do inside the archive.
 * @param config - Configuration from `createElectronBuilderConfig` or another `applyWasdengine*` function.
 * @returns A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineSuperCollider<T extends { readonly asarUnpack: readonly string[] }>(config: T): T

/** `asarUnpack` pattern of the GIMP runtime that `wasdengine-gimp.ts` ships in the GIMP plugin package. */
export const GIMP_ASAR_UNPACK: string

/**
 * Keep the shipped GIMP runtime on disk, outside `app.asar`: gimp-console, its plug-ins, and its Python start as
 * processes and read GIMP's libraries, data, and configuration by path, which none of them can do inside the archive.
 * @param config - Configuration from `createElectronBuilderConfig` or another `applyWasdengine*` function.
 * @returns A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineGimp<T extends { readonly asarUnpack: readonly string[] }>(config: T): T

/** The game layer module that `wasdengine-game-layer.ts` builds beside the main bundle, as electron-builder names it. */
export const GAME_LAYER_FILE: string

/**
 * Ship the game layer module beside the main bundle, outside `app.asar`, where the main process loads it as a native
 * module. The packaged files list it before the dsh trees that end the list.
 * @param config - Configuration from `createElectronBuilderConfig` or another `applyWasdengine*` function.
 * @returns A new configuration whose `files` and `asarUnpack` also list the module.
 */
export function applyWasdengineGameLayer<T extends { readonly files: readonly (string | object)[]; readonly asarUnpack: readonly string[] }>(config: T): T

/**
 * Replace the product identity in one electron-builder configuration: the product and bundle
 * names, the packaged manifest `name`, `productName`, and `author`, the deep-link scheme, the icons,
 * the microphone prompt, and the start of the packaged file names.
 * @param config - Configuration from `createElectronBuilderConfig`.
 * @returns A new configuration that keeps every hook and packaging rule of `config`.
 * @throws When the application identifier is DeepSeek's, when the configuration embeds an update
 * feed other than the GitHub releases feed of `WASDENGINE_DESKTOP_BRAND.releaseRepository`, or when
 * upstream no longer ships the About panel icon or the file name start that this function replaces.
 */
export function applyWasdengineBrand(config: DesktopElectronBuilderConfig): WasdengineElectronBuilderConfig
