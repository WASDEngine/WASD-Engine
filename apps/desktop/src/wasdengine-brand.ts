/**
 * WASDEngine product identity for the Desktop shell and its packaging.
 *
 * WASDEngine is built on DeepSeek Harness and must not present itself as a DeepSeek Harness
 * installation or share operating-system state with one: the bundle identifier, deep-link
 * scheme, Electron data directory, and executable all differ. Packaging applies these values
 * through `scripts/wasdengine-builder-config.mjs`; the shell reads them for the macOS About
 * panel, the deep-link scheme, and the product name in its locale dictionaries. This module
 * has no imports, so the sandboxed preloads that read the dictionaries can bundle it.
 * `wasdengine/FORK.md` in the repository root lists every upstream file that reads it.
 */

/** The WASDEngine Desktop identity; icon paths are relative to `apps/desktop`. */
export const WASDENGINE_DESKTOP_BRAND = {
  /** Application, bundle, and executable name; Electron derives its data and log directories from it. */
  productName: 'WASDEngine',
  /** Bundle identifier of unsigned local builds; release builds name theirs in `DSH_DESKTOP_APP_ID`. */
  appId: 'com.wasdengine.desktop',
  /** Deep-link scheme; `wasdengine://open` brings the application to the foreground. */
  urlScheme: 'wasdengine',
  /** Packaged manifest author, which Windows reports as the publisher. */
  publisher: 'WASDEngine',
  /** Title of the macOS About panel. */
  aboutName: 'WASDEngine (built on DeepSeek Harness)',
  /** Text of the macOS microphone permission prompt. */
  microphoneUsage: 'WASDEngine uses your microphone to transcribe speech into message drafts.',
  /**
   * HTTPS origin of the WASDEngine update feed. Unset, a build may not carry an update feed:
   * unsigned builds have none, and packaging refuses a signed build because the release
   * pipeline always embeds one.
   */
  updateOrigin: undefined as string | undefined,
  /** Icon files rendered by `scripts/wasdengine-render-icons.ts`. */
  icons: {
    macOS: 'wasdengine/icon-macos.png',
    windows: 'wasdengine/icon-windows.png',
    tray: 'wasdengine/tray-windows.ico',
  },
} as const

/** The upstream product name in shell copy: "DeepSeek Harness", or "Harness" on its own. */
const UPSTREAM_PRODUCT_NAME = /(?:DeepSeek )?\bHarness\b/gu

/**
 * Replace the upstream product name with WASDEngine in every message, in place. The
 * dictionaries are the objects `locale.ts` exports, so a direct import and a resolved locale
 * read the same copy. "DSH" and references to DeepSeek models stay unchanged.
 * @param dictionaries - Every shipped Desktop dictionary, keyed by language.
 * @returns The same dictionaries.
 */
export function brandDesktopDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  for (const messages of Object.values<Record<string, string>>(dictionaries)) {
    for (const [key, message] of Object.entries(messages)) {
      messages[key] = message.replaceAll(UPSTREAM_PRODUCT_NAME, WASDENGINE_DESKTOP_BRAND.productName)
    }
  }
  return dictionaries
}
