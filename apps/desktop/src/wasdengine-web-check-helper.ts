/**
 * The macOS bundle that the Desktop app's Web check mode starts from. macOS gives a process a Dock icon from its
 * bundle's `Info.plist` as the process starts, before any of the application's code runs, so a check started from the
 * application's own executable showed in the Dock until it switched itself to the accessory activation policy. The
 * check starts instead from a copy of that executable in `Contents/Frameworks/<product> Web Check Helper.app`, a bundle
 * marked `LSUIElement` like Electron's own helpers, which macOS never shows in the Dock. Electron reads an executable
 * whose name ends with ` Helper` as part of the application bundle around it, so the copy runs the application's main
 * process with its framework, helpers, and resources. Chromium's sandbox lets a child process read only the bundle its
 * browser process runs from, which for the copy holds neither the framework nor the helpers, so a check started from
 * this bundle runs with {@link WEB_CHECK_HELPER_SWITCHES}.
 * @module
 */
import { join } from 'node:path'

/** What the bundle's and its executable's names add to the product name. */
export const WEB_CHECK_HELPER_SUFFIX = 'Web Check Helper'

/** The Chromium switches of a check that starts from the bundle: without the sandbox, its child processes start. */
export const WEB_CHECK_HELPER_SWITCHES: readonly string[] = ['--no-sandbox']

/**
 * The Web check bundle inside an application bundle.
 * @param appBundle - the application's `.app` folder.
 * @param productName - the product name that names the application's bundle and helpers.
 * @returns the Web check bundle's `.app` folder.
 */
export function webCheckHelperBundle(appBundle: string, productName: string): string {
  return join(appBundle, 'Contents', 'Frameworks', `${productName} ${WEB_CHECK_HELPER_SUFFIX}.app`)
}

/**
 * The executable of the Web check bundle inside an application bundle.
 * @param appBundle - the application's `.app` folder.
 * @param productName - the product name that names the application's bundle and helpers.
 * @returns the executable's path.
 */
export function webCheckHelperExecutable(appBundle: string, productName: string): string {
  return join(webCheckHelperBundle(appBundle, productName), 'Contents', 'MacOS', `${productName} ${WEB_CHECK_HELPER_SUFFIX}`)
}
