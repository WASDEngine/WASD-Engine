/**
 * WASDEngine fork guard for the Desktop product identity: the ordinary release configuration,
 * the unsigned local defaults, the shell copy, the command launchers, and the brand assets must
 * name WASDEngine and never DeepSeek Harness's bundle identity, scheme, or update feed.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppInfo, Packager } from 'app-builder-lib'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { unpackIco, TRAY_ICON_SIZES } from '../scripts/render-tray-icon.ts'
import { readInstallerLocales } from '../scripts/installer-locales.mjs'
import { applyWasdengineBrand, brandInstallerLocales, wasdengineBrandFile } from '../scripts/wasdengine-builder-config.mjs'
import {
  WASDENGINE_EXPORT_SPLASH, WASDENGINE_EXPORT_SPLASH_DIRECTORY, WASDENGINE_EXPORT_SPLASH_LAYOUT, WASDENGINE_HOME_ATLAS,
  WASDENGINE_HOME_ATLAS_FILE, WASDENGINE_ICON_EDGE, WASDENGINE_INSTALLER_ART, WASDENGINE_INSTALLER_ART_DIRECTORY,
  WASDENGINE_INSTALLER_LAYOUT, WASDENGINE_LOGO_FILE, renderWasdengineExportSplash, renderWasdengineHomeAtlas,
  renderWasdengineInstallerArt, type WasdengineExportSplashFile, type WasdengineInstallerArtFile,
} from '../scripts/wasdengine-render-icons.ts'
import { de, en, es, fr, ja, pt, resolveDesktopLocale, ru, zh } from '../src/locale.ts'
import { WASDENGINE_DESKTOP_BRAND as BRAND, WASDENGINE_DESKTOP_COPY, brandDesktopDictionaries } from '../src/wasdengine-brand.ts'

const UNSIGNED_MACOS: NodeJS.ProcessEnv = {
  ...localMacOSPackageEnvironment({}),
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
}

const SIGNED_MACOS = {
  DSH_DESKTOP_APP_ID: BRAND.appId,
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'wasdengine-test',
}

/** Mandatory-update policy of the test deployment. */
const TEST_POLICY = {
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
}

/** Signed release settings of each update deployment. */
const DEPLOYMENTS = {
  production: {
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
  },
  test: {
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
    ...TEST_POLICY,
    DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  },
} as const

/** Every string a configuration holds, functions excluded. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

/** Width and height from a PNG stream's IHDR chunk. */
function pngSize(png: Buffer): [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

describe('WASDEngine Desktop packaging identity', () => {
  it('builds unsigned local packages under the WASDEngine bundle identifier', () => {
    expect(UNSIGNED_MACOS.DSH_DESKTOP_APP_ID).toBe(BRAND.appId)
    expect(UNSIGNED_MACOS.DSH_DESKTOP_UNSIGNED).toBe('1')
  })

  it('names the application, scheme, publisher, and icons after WASDEngine', () => {
    const config = applyWasdengineBrand(createElectronBuilderConfig(UNSIGNED_MACOS, 'darwin', 'arm64'))
    expect(config.appId).toBe(BRAND.appId)
    expect(config.extraMetadata.dshDesktopAppId).toBe(BRAND.appId)
    expect(config.productName).toBe(BRAND.productName)
    expect(config.artifactName).toBe(`${BRAND.artifactBase}-\${version}-\${os}-\${arch}-unsigned.\${ext}`)
    expect(config.protocols).toEqual([{ name: BRAND.productName, schemes: [BRAND.urlScheme] }])
    // The packaged productName names Electron's data directory, so it never shares DeepSeek Harness's.
    expect(config.extraMetadata).toMatchObject({ productName: BRAND.productName, author: { name: BRAND.publisher } })
    // The packaged npm name names the updater cache and the second folder the Windows uninstaller deletes.
    expect(config.extraMetadata.name).toBe(BRAND.packageName)
    // Upstream's description, which describes the Electron shell for developers, would name the Windows installer in Task Manager.
    expect(config.extraMetadata.description).toBe(BRAND.productName)
    expect(config.mac.extendInfo.NSMicrophoneUsageDescription).toBe(BRAND.microphoneUsage)
    expect(config.mac.icon).toBe(wasdengineBrandFile(BRAND.icons.macOS))
    expect(config.win.icon).toBe(wasdengineBrandFile(BRAND.icons.windows))
    expect(config.extraResources.find(resource => resource.to === 'icon.png')?.from).toBe(wasdengineBrandFile(BRAND.icons.windows))
    expect(config.publish).toBeNull()
    for (const text of strings(config)) {
      expect(text).not.toContain('DeepSeek Harness')
      expect(text).not.toMatch(/com\.deepseek/iu)
    }
    const packager = new Packager({ projectDir: tmpdir() })
    const metadata = { ...JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as object, ...config.extraMetadata }
    Object.defineProperties(packager, { config: { value: config }, metadata: { value: metadata } })
    const appInfo = new AppInfo(packager, undefined)
    expect(appInfo.productFilename).toBe(BRAND.productName)
    expect(appInfo.companyName).toBe(BRAND.publisher)
    // electron-builder's NSIS target writes it as the installer's FileDescription and the shortcuts' description.
    expect(appInfo.description).toBe(BRAND.productName)
    expect(appInfo.copyright).toBe(`Copyright © ${new Date().getFullYear()} ${BRAND.productName}`)
    expect(appInfo.macBundleIdentifier).toBe(BRAND.appId)
    // Upstream's name would make both folders a stock DeepSeek Harness install's.
    expect(appInfo.name).toBe('wasdengine-desktop')
    expect(appInfo.updaterCacheDirName).toBe('wasdengine-desktop-updater')
    const upstream = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
    expect(appInfo.name).not.toBe(upstream.name)
  })

  it('replaces the Windows tray icon', () => {
    // Unlike unsigned macOS packages, unsigned Windows packages carry the mandatory-update policy.
    const config = applyWasdengineBrand(createElectronBuilderConfig({ ...UNSIGNED_MACOS, ...TEST_POLICY,
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' }, 'win32', 'x64'))
    expect(config.extraResources.find(resource => resource.to === 'tray.ico')?.from).toBe(wasdengineBrandFile(BRAND.icons.tray))
  })

  it('refuses an upstream file name that no longer starts with deepseek-harness-', () => {
    const config = createElectronBuilderConfig(UNSIGNED_MACOS, 'darwin', 'arm64')
    expect(() => applyWasdengineBrand({ ...config, artifactName: 'harness.dmg' })).toThrow('update applyWasdengineBrand')
  })

  it('refuses a DeepSeek application identifier', () => {
    expect(() => applyWasdengineBrand(createElectronBuilderConfig({ ...UNSIGNED_MACOS, DSH_DESKTOP_APP_ID: 'com.deepseek.dsh' }, 'darwin', 'arm64')))
      .toThrow('belongs to DeepSeek')
  })

  it.each(['production', 'test'] as const)('refuses the %s update feed, which is not the GitHub releases feed', (deployment) => {
    const config = createElectronBuilderConfig({ ...SIGNED_MACOS, ...DEPLOYMENTS[deployment] }, 'darwin', 'arm64')
    expect(config.publish).not.toBeNull()
    expect(() => applyWasdengineBrand(config)).toThrow('WASDEngine publishes updates only through https://github.com/WASDEngine/WASD-Engine/releases/latest/download/')
  })

  it('applies the brand in the ordinary release entry', async () => {
    for (const [name, value] of Object.entries(UNSIGNED_MACOS)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      const config = createReleaseConfig()
      expect(config.productName).toBe(BRAND.productName)
      expect(config.protocols).toEqual([{ name: BRAND.productName, schemes: [BRAND.urlScheme] }])
    } finally { vi.unstubAllEnvs() }
  })

  it('runs the WASDEngine executable from the installed command launchers', () => {
    expect(readFileSync(new URL('../cli/dsh', import.meta.url), 'utf8')).toContain(`exec "$resources/../MacOS/${BRAND.productName}" `)
    expect(readFileSync(new URL('../cli/dsh.cmd', import.meta.url), 'utf8')).toContain(`"%~dp0..\\..\\..\\..\\${BRAND.productName}.exe" `)
  })

  it('ships rendered icons and a WASDEngine welcome wordmark', () => {
    for (const icon of [BRAND.icons.macOS, BRAND.icons.windows]) {
      expect(existsSync(wasdengineBrandFile(icon.replace(/\.png$/u, '.svg')))).toBe(true)
      expect(pngSize(readFileSync(wasdengineBrandFile(icon)))).toEqual([WASDENGINE_ICON_EDGE, WASDENGINE_ICON_EDGE])
    }
    expect(unpackIco(readFileSync(wasdengineBrandFile(BRAND.icons.tray))).map(entry => entry.size)).toEqual([...TRAY_ICON_SIZES])
    // The welcome page reserves 472 x 40 for the WASD Engine logo; its wordmark follows the color scheme.
    const wordmark = readFileSync(new URL('../renderer/assets/welcome-brand.svg', import.meta.url), 'utf8')
    expect(wordmark).toContain(`<title>${BRAND.productName}</title>`)
    expect(wordmark).toContain('viewBox="0 0 472 40"')
    expect(wordmark).toContain('fill="var(--wasdengine-wordmark)"')
    expect(wordmark).toMatch(/@media \(prefers-color-scheme: dark\)/u)
  })

  it('renders the home atlas at the frame geometry of the ui-brand-official renderer', async () => {
    const renderer = readFileSync(new URL('../../../packages/client/ui-brand-official/src/client/home-whale/renderer.ts', import.meta.url), 'utf8')
    const { width, height, columns, frames } = WASDENGINE_HOME_ATLAS
    expect(/const ATLAS = \{ width: (\d+), height: (\d+), columns: (\d+), frames: (\d+) \} as const/u.exec(renderer)?.slice(1).map(Number))
      .toEqual([width, height, columns, frames])
    const atlas = await sharp(WASDENGINE_HOME_ATLAS_FILE).metadata()
    expect([atlas.format, atlas.width, atlas.height]).toEqual(['webp', width * columns, height * Math.ceil(frames / columns)])
  })

  it('ships a current home atlas of the Windows icon keycaps', async () => {
    const source = readFileSync(wasdengineBrandFile(BRAND.icons.windows.replace(/\.png$/u, '.svg')))
    const fresh = await sharp(await renderWasdengineHomeAtlas(source)).raw().toBuffer()
    const committed = await sharp(WASDENGINE_HOME_ATLAS_FILE).raw().toBuffer()
    let drift = 0
    for (let index = 0; index < fresh.length; index += 1) drift += Math.abs(fresh[index]! - committed[index]!)
    // One level of mean drift allows rasterizer differences between platforms.
    expect(drift / fresh.length).toBeLessThan(1)
  })

  it('names WASD Engine in the Windows installer text of every language', () => {
    const locales = brandInstallerLocales(readInstallerLocales())
    for (const locale of locales) expect(JSON.stringify(locale)).not.toContain('DeepSeek Harness')
    expect(locales.find(locale => locale.id === 'en_US')?.strings.INSTALLER_RUNNING).toBe(`${BRAND.productName} is running. Quit it from the system tray and try again.`)
    const builder = readFileSync(new URL('../scripts/electron-builder-config.mjs', import.meta.url), 'utf8')
    expect(builder).toContain('renderInstallerStrings(brandInstallerLocales(readInstallerLocales()))')
  })

  it('ships current Windows installer art of the WASD Engine icon and wordmark', async () => {
    // prepare-windows-installer.ps1 converts exactly these files; the installer pages and the uninstaller embed the bitmaps.
    const prepare = readFileSync(new URL('../scripts/prepare-windows-installer.ps1', import.meta.url), 'utf8')
    expect(prepare).toContain("foreach ($asset in @('brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar'))")
    expect(Object.keys(WASDENGINE_INSTALLER_ART)).toEqual(['brand.png', 'brand-2x.png', 'brand-dark.png', 'brand-dark-2x.png', 'uninstaller-sidebar.png'])
    const theme = readFileSync(new URL('../installer/theme.nsh', import.meta.url), 'utf8')
    expect(theme).toContain(`!define INSTALLER_WINDOW_SIZE ${String(WASDENGINE_INSTALLER_LAYOUT.banner.width)}\n`)
    expect(theme).toContain(`!define INSTALLER_BRAND_HEIGHT ${String(WASDENGINE_INSTALLER_LAYOUT.banner.height)}\n`)
    const icon = readFileSync(wasdengineBrandFile(BRAND.icons.windows.replace(/\.png$/u, '.svg')))
    const logo = readFileSync(WASDENGINE_LOGO_FILE)
    for (const [file, { kind, scale }] of Object.entries(WASDENGINE_INSTALLER_ART)) {
      const committed = join(WASDENGINE_INSTALLER_ART_DIRECTORY, file)
      const { width, height } = WASDENGINE_INSTALLER_LAYOUT[kind]
      const { channels } = await sharp(committed).metadata()
      expect([...pngSize(readFileSync(committed)), channels], file).toEqual([width * scale, height * scale, kind === 'banner' ? 4 : 3])
      const fresh = await sharp(await renderWasdengineInstallerArt(file as WasdengineInstallerArtFile, icon, logo)).raw().toBuffer()
      const shipped = await sharp(committed).raw().toBuffer()
      let drift = 0
      for (let index = 0; index < fresh.length; index += 1) drift += Math.abs(fresh[index]! - shipped[index]!)
      // One level of mean drift allows rasterizer differences between platforms.
      expect(drift / fresh.length, file).toBeLessThan(1)
    }
  })

  it('ships current export splash images of the WASD Engine logo for dark and light splash colors', async () => {
    const logo = readFileSync(WASDENGINE_LOGO_FILE)
    const { width, height } = WASDENGINE_EXPORT_SPLASH_LAYOUT
    const brightness: Record<string, number> = {}
    for (const file of Object.keys(WASDENGINE_EXPORT_SPLASH) as WasdengineExportSplashFile[]) {
      const committed = join(WASDENGINE_EXPORT_SPLASH_DIRECTORY, file)
      const { channels } = await sharp(committed).metadata()
      expect([...pngSize(readFileSync(committed)), channels], file).toEqual([width, height, 4])
      const fresh = await sharp(await renderWasdengineExportSplash(file, logo)).raw().toBuffer()
      const shipped = await sharp(committed).raw().toBuffer()
      let drift = 0
      let lit = 0
      for (let index = 0; index < fresh.length; index += 1) drift += Math.abs(fresh[index]! - shipped[index]!)
      for (let index = 0; index < shipped.length; index += 4) {
        lit += (shipped[index]! + shipped[index + 1]! + shipped[index + 2]!) * shipped[index + 3]!
      }
      // One level of mean drift allows rasterizer differences between platforms.
      expect(drift / fresh.length, file).toBeLessThan(1)
      brightness[WASDENGINE_EXPORT_SPLASH[file]] = lit
    }
    // The splash for a dark color draws the light wordmark of the dark theme.
    expect(brightness.dark).toBeGreaterThan(brightness.light! * 2)
  })

  it('refuses a logo whose wordmark the installer art cannot read', async () => {
    const icon = readFileSync(wasdengineBrandFile(BRAND.icons.windows.replace(/\.png$/u, '.svg')))
    const logo = readFileSync(WASDENGINE_LOGO_FILE, 'utf8')
    await expect(renderWasdengineInstallerArt('brand.png', icon, Buffer.from(logo.replaceAll('var(--wasdengine-wordmark)', '#17181D'))))
      .rejects.toThrow('the logo needs one path filled with --wasdengine-wordmark')
    const relative = logo.replace(/<path d="M([^"]+)" fill="var\(--wasdengine-wordmark\)"/u, '<path d="m$1" fill="var(--wasdengine-wordmark)"')
    expect(relative).not.toBe(logo)
    await expect(renderWasdengineInstallerArt('brand.png', icon, Buffer.from(relative))).rejects.toThrow('the wordmark path uses m;')
  })

  it('names WASD Engine in the installer update windows and extraction failure report', () => {
    const source = (file: string): string => readFileSync(new URL(`../installer/${file}`, import.meta.url), 'utf8')
    expect(source('restart-banner.h')).toContain(`    SetWindowTextW(title, L"${BRAND.productName}");\n`)
    expect(source('restart-status.h')).toContain(`    SetWindowTextW(window, L"${BRAND.productName}");\n`)
    expect(source('extract-report.h')).toContain(`    std::wstring report = L"${BRAND.productName} installer: extraction failed\\r\\n";\n`)
    // brandInstallerLocales names WASD Engine in the locale files while packaging; no other installer source names DeepSeek Harness.
    const native = readdirSync(new URL('../installer/', import.meta.url)).filter(file => /\.(?:cpp|h|nsh)$/u.test(file))
    expect(native.length).toBeGreaterThan(10)
    for (const file of native) expect(source(file), file).not.toContain('DeepSeek Harness')
    for (const file of readdirSync(new URL('../scripts/', import.meta.url)).filter(file => file.endsWith('.nsh'))) {
      expect(readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8'), file).not.toContain('DeepSeek Harness')
    }
  })

  it('publishes updates from a WASDEngine repository on GitHub', () => {
    expect(BRAND.releaseRepository).toMatch(/^WASDEngine\/[\w.-]+$/u)
  })
})

describe('WASDEngine Desktop shell copy', () => {
  const dictionaries = { en, zh, ja, es, fr, de, ru, pt }

  it.each(Object.keys(dictionaries))('names WASDEngine instead of DeepSeek Harness in %s', (id) => {
    const messages = dictionaries[id as keyof typeof dictionaries]
    for (const [key, message] of Object.entries(messages)) {
      expect(message, key).not.toMatch(/\bHarness\b/u)
    }
    expect(messages.aboutProduct).toBe(BRAND.productName)
    expect(messages.welcomeBrand).toBe(BRAND.productName)
    expect(messages.startupAddressInUse).toContain('DSH')
    expect(resolveDesktopLocale(id).messages).toBe(messages)
  })

  it('keeps sentence structure around the substituted name', () => {
    expect(en.aboutMenu).toBe('About WASD Engine')
    expect(en.quitTitle).toBe('Quit WASD Engine?')
    expect(zh.aboutMenu).toBe('关于 WASD Engine')
    expect(de.updateTitle).toBe('WASD Engine-Update')
    expect(ja.hideApplication).toBe('WASD Engine を隠す')
  })

  it.each(Object.keys(dictionaries))('applies the WASD Engine welcome and update copy in %s', (id) => {
    const messages = dictionaries[id as keyof typeof dictionaries]
    const copy = WASDENGINE_DESKTOP_COPY[id]
    expect(copy, id).toBeDefined()
    expect(Object.keys(copy!).sort()).toEqual(['updateDetail', 'updateDownloadDetail', 'welcomeDescription', 'welcomeKeyDescription'])
    for (const [key, message] of Object.entries(copy!)) expect(messages[key as keyof typeof messages], key).toBe(message)
    expect(messages.welcomeKeyDescription).toContain(BRAND.productName)
    expect(messages.welcomeKeyDescription).not.toContain('DeepSeek')
  })

  it('refuses copy for a message the dictionaries do not have', () => {
    expect(() => brandDesktopDictionaries({ en: { welcomeTitle: 'DeepSeek Harness' } }))
      .toThrow('WASD Engine desktop copy: en has no message welcomeDescription')
  })

  it('titles the macOS About panel with the upstream attribution', () => {
    expect(BRAND.aboutName).toBe(`${BRAND.productName} (built on DeepSeek Harness)`)
  })

  it('opens the main window instead of the welcome window, whose Get started dialog asks for credentials', () => {
    expect(BRAND.welcomeWindow).toBe(false)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('  WASDENGINE_DESKTOP_BRAND.welcomeWindow && needsWelcomeWindow(authentication)\n')
    expect(main).toContain('    if (!WASDENGINE_DESKTOP_BRAND.welcomeWindow) return enterWorkspace()\n')
    const overlay = readFileSync(new URL('../../../packages/bundle/web-app/wasdengine/first-run.cordis.patch.yml', import.meta.url), 'utf8')
    expect(overlay).toContain('    nativeCredentialOnboarding: false\n')
  })
})
