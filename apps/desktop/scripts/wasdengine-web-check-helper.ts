/**
 * Create the Web check bundle that `src/wasdengine-web-check-helper.ts` describes in a macOS application bundle, before
 * the application is signed: packaging adds it once electron-builder packed the application, and the development
 * launcher adds it to the bundle it stages.
 * @module
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_CHECK_HELPER_SUFFIX, webCheckHelperBundle, webCheckHelperExecutable } from '../src/wasdengine-web-check-helper.ts'

/** Where the application's main executable finds Electron's framework. */
const APPLICATION_RPATH = '@executable_path/../Frameworks'

/** Where an executable in a bundle inside `Contents/Frameworks` finds Electron's framework, as Electron's helpers do. */
const HELPER_RPATH = '@executable_path/../../..'

/** What the Web check bundle is made from. */
export interface WebCheckHelperOptions {
  /** Product name that names the application bundle and its helpers. */
  readonly productName: string
  /** File name, in `Contents/MacOS`, of the executable that runs the application's main process. */
  readonly executable: string
  /** Bundle identifier of the Web check bundle. */
  readonly bundleId: string
}

/**
 * The Info.plist of the application's helper bundle: the product's own helper, as packaging names it, else Electron's,
 * as the development bundle keeps it.
 * @param appBundle - the application's `.app` folder.
 * @param productName - the product name that names the application's helpers.
 * @returns the Info.plist path.
 * @throws when the application has neither helper.
 */
function helperInfoPlist(appBundle: string, productName: string): string {
  for (const name of [productName, 'Electron']) {
    const plist = join(appBundle, 'Contents', 'Frameworks', `${name} Helper.app`, 'Contents', 'Info.plist')
    if (existsSync(plist)) return plist
  }
  throw new Error(`Web check helper: ${appBundle} has no "${productName} Helper.app" or "Electron Helper.app" whose Info.plist the bundle can take`)
}

/**
 * Create, or replace, the Web check bundle in an application bundle that is not signed yet: a copy of the executable
 * that runs the main process, which finds Electron's framework from the bundle's place, and the Info.plist of the
 * application's helper, naming the copy, with `LSUIElement` set and without `ElectronMainProcess`, so that macOS never
 * shows the bundle in the Dock and Electron reads the copy as part of the application around it. Signing the
 * application signs the bundle with its other helpers. The copy needs no fuses of its own: on macOS Electron keeps its
 * fuse wire in the `Electron Framework` binary, which `@electron/fuses` flips after this hook and which the copy loads
 * through its run path, so a check runs with the application's fuses.
 * @param appBundle - the application's `.app` folder.
 * @param options - the product name, the main executable's file name, and the bundle identifier.
 * @returns the Web check bundle's executable.
 * @throws when the main executable does not find Electron's framework at `@executable_path/../Frameworks`, or when the
 * application has no helper bundle to take an Info.plist from.
 */
export function createWebCheckHelper(appBundle: string, options: WebCheckHelperOptions): string {
  const { productName, executable, bundleId } = options
  const template = helperInfoPlist(appBundle, productName)
  const source = join(appBundle, 'Contents', 'MacOS', executable)
  if (!execFileSync('/usr/bin/otool', ['-l', source], { encoding: 'utf8' }).includes(`path ${APPLICATION_RPATH} `)) {
    throw new Error(`Web check helper: ${source} does not find Electron's framework at ${APPLICATION_RPATH}`)
  }
  const bundle = webCheckHelperBundle(appBundle, productName)
  const target = webCheckHelperExecutable(appBundle, productName)
  rmSync(bundle, { recursive: true, force: true })
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  execFileSync('/usr/bin/install_name_tool', ['-rpath', APPLICATION_RPATH, HELPER_RPATH, target], { stdio: 'pipe' })
  const plist = join(bundle, 'Contents', 'Info.plist')
  copyFileSync(template, plist)
  const name = `${productName} ${WEB_CHECK_HELPER_SUFFIX}`
  const values: readonly (readonly [string, string, string])[] = [
    ['CFBundleExecutable', '-string', name],
    ['CFBundleIdentifier', '-string', bundleId],
    ['CFBundleName', '-string', name],
    ['CFBundleDisplayName', '-string', name],
    ['LSUIElement', '-bool', 'true'],
  ]
  for (const [key, type, value] of values) execFileSync('/usr/bin/plutil', ['-replace', key, type, value, plist])
  const info: unknown = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }))
  if (typeof info === 'object' && info !== null && Object.hasOwn(info, 'ElectronMainProcess')) {
    execFileSync('/usr/bin/plutil', ['-remove', 'ElectronMainProcess', plist])
  }
  return target
}
