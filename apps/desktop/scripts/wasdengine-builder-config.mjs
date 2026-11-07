/** Apply the WASDEngine product identity to the ordinary Desktop release configuration. */

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
    extraMetadata: { ...config.extraMetadata, productName: BRAND.productName, author: { name: BRAND.publisher } },
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
