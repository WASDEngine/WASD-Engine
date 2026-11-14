import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyWasdengineWebCheckHelper } from '../scripts/wasdengine-builder-config.mjs'
import { createWebCheckHelper } from '../scripts/wasdengine-web-check-helper.ts'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'
import { webCheckHelperBundle, webCheckHelperExecutable } from '../src/wasdengine-web-check-helper.ts'

const PRODUCT = WASDENGINE_DESKTOP_BRAND.productName
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The keys of a property list. */
function readPlist(path: string): Record<string, unknown> {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' })) as Record<string, unknown>
}

/** The run paths a Mach-O executable searches. */
function rpaths(path: string): string[] {
  return [...execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8' }).matchAll(/^\s*path (\S+) \(offset/gmu)].map(match => match[1] as string)
}

/**
 * An unsigned application bundle like the ones packaging and the development launcher sign: a main executable that
 * searches `rpath` and a helper bundle named after `helper`, whose Info.plist names a main process.
 */
function fakeApplication(helper: string, rpath = '@executable_path/../Frameworks'): string {
  const root = mkdtempSync(join(tmpdir(), 'wasd-web-check-helper-'))
  roots.push(root)
  const bundle = join(root, `${PRODUCT}.app`)
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  const source = join(root, 'main.c')
  writeFileSync(source, 'int main(void) { return 0; }\n')
  execFileSync('/usr/bin/cc', [source, '-o', join(bundle, 'Contents', 'MacOS', PRODUCT), `-Wl,-rpath,${rpath}`])
  const contents = join(bundle, 'Contents', 'Frameworks', `${helper} Helper.app`, 'Contents')
  mkdirSync(contents, { recursive: true })
  writeFileSync(join(contents, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>CFBundleExecutable</key><string>${helper} Helper</string>`,
    '<key>CFBundleIdentifier</key><string>com.example.helper</string>',
    `<key>CFBundleName</key><string>${helper} Helper</string>`,
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>ElectronMainProcess</key><true/>',
    '<key>LSMinimumSystemVersion</key><string>12.0</string>',
    '</dict></plist>',
    '',
  ].join('\n'))
  return bundle
}

describe.skipIf(process.platform !== 'darwin')('createWebCheckHelper', () => {
  it('copies the main executable into a bundle that macOS keeps out of the Dock and Electron reads as part of the application', () => {
    const bundle = fakeApplication(PRODUCT)
    const executable = createWebCheckHelper(bundle, { productName: PRODUCT, executable: PRODUCT, bundleId: 'com.example.app.helper.WebCheck' })
    expect(executable).toBe(webCheckHelperExecutable(bundle, PRODUCT))
    expect(statSync(executable).mode & 0o111).toBe(0o111)
    expect(rpaths(executable)).toEqual(['@executable_path/../../..'])
    expect(rpaths(join(bundle, 'Contents', 'MacOS', PRODUCT))).toEqual(['@executable_path/../Frameworks'])
    const info = readPlist(join(webCheckHelperBundle(bundle, PRODUCT), 'Contents', 'Info.plist'))
    expect(info).toMatchObject({
      CFBundleExecutable: `${PRODUCT} Web Check Helper`,
      CFBundleIdentifier: 'com.example.app.helper.WebCheck',
      CFBundleName: `${PRODUCT} Web Check Helper`,
      CFBundleDisplayName: `${PRODUCT} Web Check Helper`,
      LSUIElement: true,
      LSMinimumSystemVersion: '12.0',
    })
    expect(info).not.toHaveProperty('ElectronMainProcess')
    expect(executable.endsWith(' Helper')).toBe(true)
  })

  it('takes Electron\'s helper when the product has none, as the development bundle has, and replaces an earlier bundle', () => {
    const bundle = fakeApplication('Electron')
    const options = { productName: PRODUCT, executable: PRODUCT, bundleId: 'com.example.dev.helper.WebCheck' }
    createWebCheckHelper(bundle, options)
    const stale = join(webCheckHelperBundle(bundle, PRODUCT), 'Contents', 'stale.txt')
    writeFileSync(stale, 'left by an earlier build')
    createWebCheckHelper(bundle, options)
    expect(existsSync(stale)).toBe(false)
    expect(readPlist(join(webCheckHelperBundle(bundle, PRODUCT), 'Contents', 'Info.plist'))).toMatchObject({ LSUIElement: true })
  })

  it('refuses an executable that finds the framework elsewhere, and an application without a helper', () => {
    const elsewhere = fakeApplication(PRODUCT, '@executable_path/../Libraries')
    expect(() => createWebCheckHelper(elsewhere, { productName: PRODUCT, executable: PRODUCT, bundleId: 'com.example.helper.WebCheck' }))
      .toThrow(/does not find Electron's framework at @executable_path\/\.\.\/Frameworks/u)
    expect(existsSync(webCheckHelperBundle(elsewhere, PRODUCT))).toBe(false)
    const bare = fakeApplication(PRODUCT)
    rmSync(join(bare, 'Contents', 'Frameworks'), { recursive: true })
    expect(() => createWebCheckHelper(bare, { productName: PRODUCT, executable: PRODUCT, bundleId: 'com.example.helper.WebCheck' }))
      .toThrow(/has no "WASD Engine Helper\.app" or "Electron Helper\.app"/u)
  })
})

describe('applyWasdengineWebCheckHelper', () => {
  /** What electron-builder's `afterPack` context gives the hook. */
  interface PackContext {
    readonly electronPlatformName: string
    readonly appOutDir: string
    readonly packager: { readonly appInfo: { readonly productFilename: string; readonly macBundleIdentifier: string } }
  }

  it.skipIf(process.platform !== 'darwin')('adds the bundle to a macOS package after the configuration\'s own hook', async () => {
    const calls: string[] = []
    const record = async (context: PackContext): Promise<void> => { calls.push(context.electronPlatformName) }
    const config = applyWasdengineWebCheckHelper({ afterPack: record })
    const bundle = fakeApplication(PRODUCT)
    await config.afterPack({
      electronPlatformName: 'darwin', appOutDir: dirname(bundle),
      packager: { appInfo: { productFilename: PRODUCT, macBundleIdentifier: 'com.example.app' } },
    })
    expect(calls).toEqual(['darwin'])
    expect(readPlist(join(webCheckHelperBundle(bundle, PRODUCT), 'Contents', 'Info.plist')))
      .toMatchObject({ CFBundleIdentifier: 'com.example.app.helper.WebCheck', LSUIElement: true })
  })

  it('leaves other platforms\' packages to the configuration\'s own hook, and refuses a hook named by its module', async () => {
    const calls: string[] = []
    const record = async (context: PackContext): Promise<void> => { calls.push(context.electronPlatformName) }
    const config = applyWasdengineWebCheckHelper({ afterPack: record })
    await config.afterPack({
      electronPlatformName: 'win32', appOutDir: join(tmpdir(), 'wasd-web-check-helper-missing'),
      packager: { appInfo: { productFilename: PRODUCT, macBundleIdentifier: 'com.example.app' } },
    })
    expect(calls).toEqual(['win32'])
    expect(() => applyWasdengineWebCheckHelper({ afterPack: './hooks/after-pack.js' })).toThrow(/afterPack names a module/u)
  })
})
