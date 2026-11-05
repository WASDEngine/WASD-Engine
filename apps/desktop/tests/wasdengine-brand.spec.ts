/**
 * WASDEngine fork guard for the Desktop product identity: the ordinary release configuration,
 * the unsigned local defaults, the shell copy, the command launchers, and the brand assets must
 * name WASDEngine and never DeepSeek Harness's bundle identity, scheme, or update feed.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AppInfo, Packager } from 'app-builder-lib'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { unpackIco, TRAY_ICON_SIZES } from '../scripts/render-tray-icon.ts'
import { applyWasdengineBrand, wasdengineBrandFile } from '../scripts/wasdengine-builder-config.mjs'
import {
  WASDENGINE_HOME_ATLAS, WASDENGINE_HOME_ATLAS_FILE, WASDENGINE_ICON_EDGE, renderWasdengineHomeAtlas,
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
    expect(config.protocols).toEqual([{ name: BRAND.productName, schemes: [BRAND.urlScheme] }])
    // The packaged productName names Electron's data directory, so it never shares DeepSeek Harness's.
    expect(config.extraMetadata).toMatchObject({ productName: BRAND.productName, author: { name: BRAND.publisher } })
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
    expect(appInfo.copyright).toBe(`Copyright © ${new Date().getFullYear()} ${BRAND.productName}`)
    expect(appInfo.macBundleIdentifier).toBe(BRAND.appId)
  })

  it('replaces the Windows tray icon', () => {
    // Unlike unsigned macOS packages, unsigned Windows packages carry the mandatory-update policy.
    const config = applyWasdengineBrand(createElectronBuilderConfig({ ...UNSIGNED_MACOS, ...TEST_POLICY,
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' }, 'win32', 'x64'))
    expect(config.extraResources.find(resource => resource.to === 'tray.ico')?.from).toBe(wasdengineBrandFile(BRAND.icons.tray))
  })

  it('refuses a DeepSeek application identifier', () => {
    expect(() => applyWasdengineBrand(createElectronBuilderConfig({ ...UNSIGNED_MACOS, DSH_DESKTOP_APP_ID: 'com.deepseek.dsh' }, 'darwin', 'arm64')))
      .toThrow('belongs to DeepSeek')
  })

  it.each(['production', 'test'] as const)('refuses the %s update feed while WASDEngine has no update origin', (deployment) => {
    expect(BRAND.updateOrigin).toBeUndefined()
    const config = createElectronBuilderConfig({ ...SIGNED_MACOS, ...DEPLOYMENTS[deployment] }, 'darwin', 'arm64')
    expect(config.publish).not.toBeNull()
    expect(() => applyWasdengineBrand(config)).toThrow('WASDEngine has no update service')
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
    const wordmark = readFileSync(new URL('../renderer/assets/welcome-brand.svg', import.meta.url), 'utf8')
    expect(wordmark).toContain(`>${BRAND.productName}</text>`)
    expect(wordmark).toContain('viewBox="0 0 472 40"')
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

  it('accepts only an HTTPS update origin outside DeepSeek', () => {
    const origin = BRAND.updateOrigin
    if (origin === undefined) return
    const url = new URL(origin)
    expect(url.protocol).toBe('https:')
    expect(url.origin).toBe(origin)
    expect(url.hostname).not.toMatch(/(?:^|\.)deepseek(?:svc)?\.com$/u)
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

  it.each(Object.keys(dictionaries))('applies the WASD Engine welcome copy in %s', (id) => {
    const messages = dictionaries[id as keyof typeof dictionaries]
    const copy = WASDENGINE_DESKTOP_COPY[id]
    expect(copy, id).toBeDefined()
    expect(Object.keys(copy!).sort()).toEqual(['welcomeDescription', 'welcomeKeyDescription'])
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
})
