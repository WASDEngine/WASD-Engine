/** Apply the WASDEngine product identity, and the unpacked LibGodot, SuperCollider, and GIMP runtimes, to the ordinary Desktop release configuration. */

import { fileURLToPath } from 'node:url'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'

/**
 * Resolve one brand file named relative to the Desktop application directory.
 * @param {string} path - Path relative to `apps/desktop`, as `WASDENGINE_DESKTOP_BRAND.icons` names it.
 * @returns {string} Absolute path.
 */
export function wasdengineBrandFile(path) {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}

/**
 * Name the brand product in the Windows installer text, where upstream names DeepSeek Harness.
 * @param {import('./installer-locales.mjs').InstallerLocale[]} locales - Resources from `readInstallerLocales`.
 * @returns {import('./installer-locales.mjs').InstallerLocale[]} Copies whose installer and uninstaller text name `WASDENGINE_DESKTOP_BRAND.productName`.
 */
export function brandInstallerLocales(locales) {
  const rename = (/** @type {Record<string, string>} */ messages) => Object.fromEntries(Object.entries(messages)
    .map(([key, text]) => [key, text.replaceAll('DeepSeek Harness', BRAND.productName)]))
  return locales.map(locale => ({ ...locale, strings: rename(locale.strings), uninstaller: rename(locale.uninstaller) }))
}

/** `asarUnpack` pattern of the LibGodot runtime that `wasdengine-libgodot.ts` ships in the Godot plugin package. */
export const LIBGODOT_ASAR_UNPACK = '**/node_modules/@deepseek-ai/dsh-godot/libgodot/**/*'

/**
 * Keep the shipped LibGodot runtime on disk, outside `app.asar`: its runner starts as a process and loads the
 * library by path, which neither can do inside the archive.
 * @template {{ readonly asarUnpack: readonly string[] }} T
 * @param {T} config - Configuration from `createElectronBuilderConfig` or `applyWasdengineBrand`.
 * @returns {T} A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineLibGodot(config) {
  return { ...config, asarUnpack: [...config.asarUnpack, LIBGODOT_ASAR_UNPACK] }
}

/** `asarUnpack` pattern of the SuperCollider runtime that `wasdengine-supercollider.ts` ships in the SuperCollider plugin package. */
export const SUPERCOLLIDER_ASAR_UNPACK = '**/node_modules/@deepseek-ai/dsh-supercollider/runtime/**/*'

/**
 * Keep the shipped SuperCollider runtime on disk, outside `app.asar`: sclang and scsynth start as processes and read
 * their class library, UGen plugins, and help files by path, which none of them can do inside the archive.
 * @template {{ readonly asarUnpack: readonly string[] }} T
 * @param {T} config - Configuration from `createElectronBuilderConfig` or another `applyWasdengine*` function.
 * @returns {T} A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineSuperCollider(config) {
  return { ...config, asarUnpack: [...config.asarUnpack, SUPERCOLLIDER_ASAR_UNPACK] }
}

/** `asarUnpack` pattern of the GIMP runtime that `wasdengine-gimp.ts` ships in the GIMP plugin package. */
export const GIMP_ASAR_UNPACK = '**/node_modules/@deepseek-ai/dsh-gimp/runtime/**/*'

/**
 * Keep the shipped GIMP runtime on disk, outside `app.asar`: gimp-console, its plug-ins, and its Python start as
 * processes and read GIMP's libraries, data, and configuration by path, which none of them can do inside the archive.
 * @template {{ readonly asarUnpack: readonly string[] }} T
 * @param {T} config - Configuration from `createElectronBuilderConfig` or another `applyWasdengine*` function.
 * @returns {T} A new configuration whose `asarUnpack` also lists the runtime folder.
 */
export function applyWasdengineGimp(config) {
  return { ...config, asarUnpack: [...config.asarUnpack, GIMP_ASAR_UNPACK] }
}

/**
 * Replace the product identity in one electron-builder configuration: the product and bundle
 * names, the packaged manifest `productName` and `author`, which move Electron's data directory
 * and set the Windows publisher, the deep-link scheme, the icons, and the microphone prompt. The
 * application identifier stays `DSH_DESKTOP_APP_ID`; unsigned local builds set the WASDEngine one.
 * @param {object} config - Configuration from `createElectronBuilderConfig`.
 * @returns {object} A new configuration that keeps every hook and packaging rule of `config`.
 * @throws {Error} When the application identifier is DeepSeek's, when the configuration embeds an
 * update feed outside `WASDENGINE_DESKTOP_BRAND.updateOrigin`, or when upstream no longer ships the
 * About panel icon this function replaces.
 */
export function applyWasdengineBrand(config) {
  if (/^com\.deepseek(?:\.|$)/iu.test(config.appId)) {
    throw new Error(`WASDEngine desktop: application identifier ${config.appId} belongs to DeepSeek; set DSH_DESKTOP_APP_ID to a WASDEngine identifier such as ${BRAND.appId}`)
  }
  for (const provider of config.publish ?? []) {
    const origin = new URL(provider.url).origin
    if (origin === BRAND.updateOrigin) continue
    throw new Error(BRAND.updateOrigin === undefined
      ? `WASDEngine desktop: this build would embed the update feed ${origin}; WASDEngine has no update service, so package with --unsigned or set updateOrigin in apps/desktop/src/wasdengine-brand.ts`
      : `WASDEngine desktop: this build would embed the update feed ${origin} instead of the WASDEngine update origin ${BRAND.updateOrigin}`)
  }
  if (!config.extraResources.some(resource => resource.to === 'icon.png')) {
    throw new Error('WASDEngine desktop: the upstream configuration no longer ships icon.png; update applyWasdengineBrand')
  }
  const resourceIcons = { 'icon.png': wasdengineBrandFile(BRAND.icons.windows), 'tray.ico': wasdengineBrandFile(BRAND.icons.tray) }
  return {
    ...config,
    productName: BRAND.productName,
    protocols: [{ name: BRAND.productName, schemes: [BRAND.urlScheme] }],
    extraMetadata: { ...config.extraMetadata, name: BRAND.packageName, productName: BRAND.productName, author: { name: BRAND.publisher } },
    extraResources: config.extraResources.map(resource => Object.hasOwn(resourceIcons, resource.to)
      ? { ...resource, from: resourceIcons[resource.to] }
      : resource),
    mac: {
      ...config.mac,
      icon: wasdengineBrandFile(BRAND.icons.macOS),
      extendInfo: { ...config.mac.extendInfo, NSMicrophoneUsageDescription: BRAND.microphoneUsage },
    },
    win: { ...config.win, icon: wasdengineBrandFile(BRAND.icons.windows) },
  }
}
