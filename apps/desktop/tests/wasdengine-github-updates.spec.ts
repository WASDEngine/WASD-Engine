/**
 * WASDEngine fork guard for updates through GitHub releases: `DSH_DESKTOP_AUTO_UPDATE_ENV=github` embeds the feed
 * `https://github.com/WASDEngine/WASD-Engine/releases/latest/download/` with single-range requests and no
 * mandatory-update policy, unsigned Windows builds carry it while unsigned macOS builds do not, and
 * `wasdengine-github-release.ts` stages feed files whose URLs name their own release and publishes only a complete
 * release. `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { createClient } from 'electron-updater/out/providerFactory.js'
import { Provider } from 'electron-updater/out/providers/Provider.js'
import { newUrlFromBase } from 'electron-updater/out/util.js'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveMacOSAppUpdateFeed, verifyMacOSAppUpdateConfig, writeMacOSAppUpdateConfig } from '../scripts/macos-app-update-config.mjs'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact, type MacOSArtifactOperations } from '../scripts/package-macos.ts'
import { applyWasdengineBrand } from '../scripts/wasdengine-builder-config.mjs'
import {
  SHA256SUMS, mergeSha256Sums, parseFeed, publishGitHubRelease, stageGitHubRelease, uploadGitHubRelease, verifyReleaseFeeds,
  type GhRunner, type ReleaseAsset, type StagedRelease,
} from '../scripts/wasdengine-github-release.ts'
import {
  GITHUB_UPDATE_SERVICE, githubReleaseFileUrl, githubUpdateFeedUrl, resolveWasdengineUpdateConfig, unsignedBuildCarriesUpdateFeed,
} from '../scripts/wasdengine-update-service.mjs'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'

const FEED = 'https://github.com/WASDEngine/WASD-Engine/releases/latest/download/'
const VERSION = '0.1.0-rc.3'
const COMMIT = 'a'.repeat(40)

/** Signed release settings of a WASDEngine notarized macOS build of the GitHub feed. */
const SIGNED_MACOS = {
  DSH_DESKTOP_APP_ID: BRAND.appId,
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'wasdengine-test',
  DSH_DESKTOP_AUTO_UPDATE_ENV: GITHUB_UPDATE_SERVICE,
}

/** Settings of an unsigned Windows release build of the GitHub feed, as `wasdengine/env.windows.example` gives them. */
const UNSIGNED_WINDOWS = {
  DSH_DESKTOP_APP_ID: BRAND.appId,
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_AUTO_UPDATE_ENV: GITHUB_UPDATE_SERVICE,
}

const roots: string[] = []

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wasdengine-github-updates-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sha512(content: string): string {
  return createHash('sha512').update(content).digest('base64')
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** An electron-builder feed file for some installers, with relative file names. */
function builderFeed(version: string, files: Readonly<Record<string, string>>): string {
  const entries = Object.entries(files).map(([url, content]) => ({ url, sha512: sha512(content), size: Buffer.byteLength(content) }))
  return dump({ version, files: entries, path: entries[0]?.url, sha512: entries[0]?.sha512, releaseDate: '2026-11-10T08:00:00.000Z' })
}

/** A packaged mac-arm64 build: the ZIP, its blockmap, the DMG, the feed file, and the release record. */
async function packagedMac(directory: string, record: Record<string, unknown> = {}) {
  const base = `${BRAND.artifactBase}-${VERSION}-mac-arm64`
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${base}.zip`), 'zip bytes')
  await writeFile(join(directory, `${base}.zip.blockmap`), 'zip blockmap')
  await writeFile(join(directory, `${base}.dmg`), 'dmg bytes')
  await writeFile(join(directory, 'stable-mac.yml'), builderFeed(VERSION, { [`${base}.zip`]: 'zip bytes' }))
  await writeFile(join(directory, 'mac-arm64-release.json'), JSON.stringify({
    schemaVersion: 1, target: 'mac-arm64', version: VERSION, environment: 'github', channel: 'stable', publicUrl: FEED,
    commit: COMMIT, dirty: false, ...record,
  }))
  return base
}

/** A packaged unsigned win-x64 build: the installer, its blockmap, the feed file, and the release record. */
async function packagedWindows(directory: string) {
  const installer = `${BRAND.artifactBase}-${VERSION}-win-x64-unsigned.exe`
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, installer), 'exe bytes')
  await writeFile(join(directory, `${installer}.blockmap`), 'exe blockmap')
  await writeFile(join(directory, 'stable.yml'), builderFeed(VERSION, { [installer]: 'exe bytes' }))
  await writeFile(join(directory, 'win-x64-release.json'), JSON.stringify({
    schemaVersion: 1, target: 'win-x64', version: VERSION, environment: 'github', channel: 'stable', publicUrl: FEED, commit: COMMIT, dirty: false,
  }))
  return installer
}

/** A fake `gh` that keeps one release in memory and records each command. */
function fakeGh(initial?: { isDraft: boolean; assets: Record<string, string> }) {
  let release = initial === undefined ? undefined : { isDraft: initial.isDraft, assets: new Map(Object.entries(initial.assets)) }
  const calls: string[][] = []
  const runner: GhRunner = async (args) => {
    calls.push([...args])
    const [group, action] = args
    if (group !== 'release') throw new Error(`unexpected gh ${args.join(' ')}`)
    if (action === 'view') {
      if (release === undefined) throw new Error('github release: gh release view failed: release not found')
      return JSON.stringify({ isDraft: release.isDraft, url: `https://github.com/${BRAND.releaseRepository}/releases/tag/v${VERSION}`,
        assets: [...release.assets].map(([name, content]) => ({ name, size: Buffer.byteLength(content) })) })
    }
    if (action === 'create') {
      release = { isDraft: true, assets: new Map() }
      return ''
    }
    if (release === undefined) throw new Error('release not found')
    if (action === 'upload') {
      for (const path of args.slice(3).filter(argument => isAbsolute(argument))) {
        release.assets.set(path.split(/[\\/]/u).at(-1) ?? path, await readFile(path, 'utf8'))
      }
      return ''
    }
    if (action === 'download') {
      const name = args[args.indexOf('--pattern') + 1] ?? ''
      await writeFile(join(args[args.indexOf('--dir') + 1] ?? '', name), release.assets.get(name) ?? '')
      return ''
    }
    if (action === 'edit') {
      release.isDraft = false
      return ''
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  return { runner, calls, release: () => release }
}

describe('WASDEngine updates through GitHub releases', () => {
  it('resolves the GitHub feed for every target, on the stable channel with single-range requests', () => {
    expect(resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'github' }, 'darwin', 'arm64')).toEqual({
      environment: 'github', channel: 'stable', target: 'mac-arm64', publicUrl: FEED, useMultipleRangeRequest: false,
    })
    expect(resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: ' github ' }, 'win32', 'x64')?.target).toBe('win-x64')
    expect(resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'github', DSH_DESKTOP_UPDATE_CHANNEL: 'stable' }, 'win32', 'x64')?.channel).toBe('stable')
    expect(() => resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'github', DSH_DESKTOP_UPDATE_CHANNEL: 'nightly' }, 'darwin', 'arm64'))
      .toThrow('packages the stable channel only')
    expect(resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'none' }, 'darwin', 'arm64')).toBeUndefined()
    expect(() => resolveWasdengineUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }, 'darwin', 'arm64')).toThrow('DOWNLOAD_TEST_ORIGIN')
    expect(githubUpdateFeedUrl()).toBe(FEED)
    expect(githubReleaseFileUrl(VERSION, 'stable.yml')).toBe(`https://github.com/WASDEngine/WASD-Engine/releases/download/v${VERSION}/stable.yml`)
  })

  it('lets only unsigned Windows builds of the GitHub feed carry it', () => {
    expect(unsignedBuildCarriesUpdateFeed({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'github' }, 'win32')).toBe(true)
    expect(unsignedBuildCarriesUpdateFeed({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'github' }, 'darwin')).toBe(false)
    expect(unsignedBuildCarriesUpdateFeed({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }, 'win32')).toBe(false)
  })

  it('configures a notarized macOS build with the GitHub feed and no mandatory-update policy', () => {
    const config = applyWasdengineBrand(createElectronBuilderConfig(SIGNED_MACOS, 'darwin', 'arm64'))
    expect(config.publish).toEqual([{ provider: 'generic', url: FEED, channel: 'stable', useMultipleRangeRequest: false }])
    expect(config.extraMetadata).toMatchObject({ dshDesktopUpdateChannel: 'stable' })
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  })

  it('gives unsigned macOS builds no feed, since macOS installs only updates the running signature accepts', () => {
    const config = applyWasdengineBrand(createElectronBuilderConfig({ ...SIGNED_MACOS, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64'))
    expect(config.publish).toBeNull()
  })

  it('configures an unsigned Windows build with the GitHub feed and no publisher check', () => {
    const config = applyWasdengineBrand(createElectronBuilderConfig(UNSIGNED_WINDOWS, 'win32', 'x64'))
    expect(config.publish).toEqual([{ provider: 'generic', url: FEED, channel: 'stable', useMultipleRangeRequest: false }])
    expect(config.win.forceCodeSigning).toBe(false)
    expect(config.win.verifyUpdateCodeSignature).toBe(false)
    expect(config.win.signtoolOptions.publisherName).toBeUndefined()
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.artifactName).toBe(`${BRAND.artifactBase}-\${version}-\${os}-\${arch}-unsigned.\${ext}`)
  })

  it('makes electron-updater ask GitHub for one byte range at a time', () => {
    // GitHub's asset storage answers a multi-range request with HTTP 501, which would end every differential download.
    const runtime = { isUseMultipleRangeRequest: true, platform: 'win32' as const, executor: {} as ElectronHttpExecutor }
    const [publish] = createElectronBuilderConfig(UNSIGNED_WINDOWS, 'win32', 'x64').publish ?? []
    expect(publish).toBeDefined()
    expect(createClient({ ...publish, provider: 'generic' }, {} as AppUpdater, runtime).isUseMultipleRangeRequest).toBe(false)
  })

  it('validates release settings that name no mandatory-update origin', async () => {
    expect(() => { validateDesktopPackageEnvironment(UNSIGNED_WINDOWS, { platform: 'win32', arch: 'x64' }, { unsigned: true }) }).not.toThrow()
    expect(() => { validateDesktopPackageEnvironment({ ...UNSIGNED_WINDOWS, DSH_DESKTOP_UPDATE_CHANNEL: 'nightly' }, { platform: 'win32', arch: 'x64' }, { unsigned: true }) })
      .toThrow('stable channel only')
    const root = await temporary()
    const p12 = join(root, 'developer-id.p12')
    const key = join(root, 'AuthKey_TEST.p8')
    await writeFile(p12, 'p12')
    await writeFile(key, 'key')
    const signed: NodeJS.ProcessEnv = {
      ...SIGNED_MACOS, APPLE_KEYCHAIN_PROFILE: undefined, CSC_LINK: p12, CSC_KEY_PASSWORD: '',
      APPLE_API_KEY: key, APPLE_API_KEY_ID: 'ABCDE12345', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    }
    expect(() => { validateDesktopPackageEnvironment(signed, { platform: 'darwin', arch: 'arm64' }) }).not.toThrow()
  })

  it('writes and checks the macOS app-update.yml with single-range requests', async () => {
    const root = await temporary()
    const appPath = join(root, `${BRAND.productName}.app`)
    const resources = join(appPath, 'Contents', 'Resources')
    await mkdir(resources, { recursive: true })
    const config = createElectronBuilderConfig(SIGNED_MACOS, 'darwin', 'arm64')
    await writeMacOSAppUpdateConfig(resources, resolveMacOSAppUpdateFeed(config.publish), 'wasdengine-desktop-updater')
    expect(load(await readFile(join(resources, 'app-update.yml'), 'utf8'))).toEqual({
      provider: 'generic', url: FEED, channel: 'stable', updaterCacheDirName: 'wasdengine-desktop-updater', useMultipleRangeRequest: false,
    })
    const update = resolveWasdengineUpdateConfig(SIGNED_MACOS, 'darwin', 'arm64')
    if (update === undefined) throw new Error('the GitHub feed resolves to a feed')
    await expect(verifyMacOSAppUpdateConfig(appPath, update)).resolves.toBeUndefined()
    await writeMacOSAppUpdateConfig(resources, { publicUrl: FEED, channel: 'stable' }, 'wasdengine-desktop-updater')
    await expect(verifyMacOSAppUpdateConfig(appPath, update)).rejects.toThrow('does not match')
  })

  it('promotes the DMG, the ZIP, its blockmap, and the stable feed file of a notarized build', async () => {
    const root = await temporary()
    const artifactsRoot = join(root, 'artifacts')
    const appPath = join(artifactsRoot, 'mac-arm64', `${BRAND.productName}.app`)
    await mkdir(join(appPath, 'Contents', 'Resources'), { recursive: true })
    const update = resolveWasdengineUpdateConfig(SIGNED_MACOS, 'darwin', 'arm64')
    if (update === undefined) throw new Error('the GitHub feed resolves to a feed')
    await writeMacOSAppUpdateConfig(join(appPath, 'Contents', 'Resources'), update, 'wasdengine-desktop-updater')
    const base = `${BRAND.artifactBase}-${VERSION}-mac-arm64`
    const apple: MacOSArtifactOperations = {
      copyApp: async (source, destination) => { await cp(source, destination, { recursive: true }) },
      notarize: async ({ appPath: path }) => { await writeFile(join(path, 'ticket'), 'accepted') },
      verifySignature: vi.fn(),
      verifyNotarization: vi.fn(),
    }
    const build = async (artifact: DesktopPrepackagedArtifact): Promise<void> => {
      await mkdir(artifact.output, { recursive: true })
      await writeFile(join(artifact.output, `${base}.${artifact.format}`), artifact.format)
      if (artifact.format === 'zip') {
        await writeFile(join(artifact.output, `${base}.zip.blockmap`), 'blockmap')
        await writeFile(join(artifact.output, 'stable-mac.yml'), builderFeed(VERSION, { [`${base}.zip`]: 'zip' }))
      }
    }
    await packageMacOSArtifacts({ arch: 'arm64', version: VERSION, artifactsRoot, environment: SIGNED_MACOS }, build, apple)
    expect((await readdir(artifactsRoot)).sort()).toEqual([`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, 'mac-arm64', 'stable-mac.yml'])
  })

  it('stages feed files whose URLs name their own release, with a nightly copy', async () => {
    const root = await temporary()
    const base = await packagedMac(join(root, 'artifacts'))
    const staged = await stageGitHubRelease({
      target: 'mac-arm64', unsigned: false, version: VERSION, artifactsDirectory: join(root, 'artifacts'), outputDirectory: join(root, 'staged'),
    })
    expect(staged).toMatchObject({ files: [`${base}.zip`, `${base}.zip.blockmap`, `${base}.dmg`], feeds: ['stable-mac.yml', 'nightly-mac.yml'], commit: COMMIT, dirty: false })
    const stable = await readFile(join(root, 'staged', 'stable-mac.yml'), 'utf8')
    expect(await readFile(join(root, 'staged', 'nightly-mac.yml'), 'utf8')).toBe(stable)
    const feed = parseFeed(stable, 'stable-mac.yml')
    const zipUrl = `https://github.com/WASDEngine/WASD-Engine/releases/download/v${VERSION}/${base}.zip`
    expect(feed.files.map(file => file.url)).toEqual([zipUrl])
    expect(feed).toMatchObject({ version: VERSION, path: zipUrl, sha512: sha512('zip bytes'), releaseDate: '2026-11-10T08:00:00.000Z' })
    // electron-updater loads feed files with its default schema, which would read an unquoted date as a Date.
    expect(load(stable)).toMatchObject({ releaseDate: '2026-11-10T08:00:00.000Z' })
    for (const name of staged.files) expect(await readFile(join(root, 'staged', name), 'utf8')).toBe(await readFile(join(root, 'artifacts', name), 'utf8'))
  })

  it('keeps the absolute URLs through electron-updater and finds the previous blockmap in the previous release', async () => {
    const installer = (version: string) => `${BRAND.artifactBase}-${version}-win-x64-unsigned.exe`
    const root = await temporary()
    await packagedWindows(join(root, 'artifacts'))
    await stageGitHubRelease({
      target: 'win-x64', unsigned: true, version: VERSION, artifactsDirectory: join(root, 'artifacts'), outputDirectory: join(root, 'staged'),
    })
    const feed = parseFeed(await readFile(join(root, 'staged', 'stable.yml'), 'utf8'), 'stable.yml')
    const [entry] = feed.files
    if (entry === undefined) throw new Error('the feed lists the installer')
    // resolveFiles resolves each file URL against the feed URL this way, which leaves an absolute URL as it is.
    const url = newUrlFromBase(entry.url, new URL(FEED))
    expect(url.href).toBe(githubReleaseFileUrl(VERSION, installer(VERSION)))
    const [previous, current] = await Provider.prototype.getBlockMapFiles(url, '0.1.0-rc.2', VERSION)
    expect(previous?.href).toBe(`${githubReleaseFileUrl('0.1.0-rc.2', installer('0.1.0-rc.2'))}.blockmap`)
    expect(current?.href).toBe(`${githubReleaseFileUrl(VERSION, installer(VERSION))}.blockmap`)
  })

  it('refuses to stage a build that does not match its feed file or its release record', async () => {
    const root = await temporary()
    const artifacts = join(root, 'artifacts')
    const stage = () => stageGitHubRelease({ target: 'mac-arm64', unsigned: false, version: VERSION, artifactsDirectory: artifacts, outputDirectory: join(root, 'staged') })
    const base = await packagedMac(artifacts)
    await writeFile(join(artifacts, `${base}.zip`), 'zip bytez')
    await expect(stage()).rejects.toThrow('does not match the SHA-512')
    await writeFile(join(artifacts, `${base}.zip`), 'zip bytes!')
    await expect(stage()).rejects.toThrow('has 10 bytes, but stable-mac.yml lists 9')
    await packagedMac(artifacts)
    await rm(join(artifacts, `${base}.zip.blockmap`))
    await expect(stage()).rejects.toThrow('.zip.blockmap is missing or empty')
    await packagedMac(artifacts, { version: '0.1.0-rc.2' })
    await expect(stage()).rejects.toThrow('does not record a mac-arm64 build of 0.1.0-rc.3')
    await packagedMac(artifacts, { environment: 'none' })
    await expect(stage()).rejects.toThrow('for the GitHub feed')
    await expect(stageGitHubRelease({ target: 'mac-arm64', unsigned: false, version: '0.1.0-rc.4', artifactsDirectory: artifacts, outputDirectory: join(root, 'staged') }))
      .rejects.toThrow('describes 0.1.0-rc.3, not 0.1.0-rc.4')
    await expect(stageGitHubRelease({ target: 'mac-arm64', unsigned: true, version: VERSION, artifactsDirectory: artifacts }))
      .rejects.toThrow('unsigned macOS builds carry no update feed')
  })

  it('merges SHA256SUMS lines by file name', () => {
    const merged = mergeSha256Sums(`${'1'.repeat(64)}  b.exe\n${'2'.repeat(64)} *a.zip\n`, new Map([['b.exe', '3'.repeat(64)], ['c.yml', '4'.repeat(64)]]))
    expect(merged).toBe(`${'2'.repeat(64)}  a.zip\n${'3'.repeat(64)}  b.exe\n${'4'.repeat(64)}  c.yml\n`)
    expect(() => mergeSha256Sums('not a checksum line\n', new Map())).toThrow('invalid line')
  })

  it('uploads a target to a new draft on the build commit, installers first and SHA256SUMS last', async () => {
    const root = await temporary()
    const installer = await packagedWindows(join(root, 'artifacts'))
    const staged = await stageGitHubRelease({ target: 'win-x64', unsigned: true, version: VERSION, artifactsDirectory: join(root, 'artifacts'), outputDirectory: join(root, 'staged') })
    const gh = fakeGh()
    await uploadGitHubRelease(staged, { published: false, allowDirty: false, runner: gh.runner, tagCommit: async () => undefined })
    const create = gh.calls.find(call => call[1] === 'create')
    expect(create).toEqual(['release', 'create', `v${VERSION}`, '--repo', BRAND.releaseRepository, '--draft', '--title', `WASD Engine ${VERSION}`, '--notes', '', '--target', COMMIT])
    const uploads = gh.calls.filter(call => call[1] === 'upload').map(call => call.slice(3).filter(argument => argument.startsWith(root)).map(path => path.slice(join(root, 'staged').length + 1)))
    expect(uploads).toEqual([[installer, `${installer}.blockmap`], ['stable.yml', 'nightly.yml'], [SHA256SUMS]])
    expect(gh.release()?.assets.get(SHA256SUMS)).toBe(mergeSha256Sums('', new Map([
      [installer, sha256('exe bytes')], [`${installer}.blockmap`, sha256('exe blockmap')],
      ['stable.yml', sha256(await readFile(join(root, 'staged', 'stable.yml'), 'utf8'))],
      ['nightly.yml', sha256(await readFile(join(root, 'staged', 'nightly.yml'), 'utf8'))],
    ])))
  })

  it('refuses a dirty build, a tag on another commit, and a published release without --published', async () => {
    const root = await temporary()
    await packagedWindows(join(root, 'artifacts'))
    const staged = await stageGitHubRelease({ target: 'win-x64', unsigned: true, version: VERSION, artifactsDirectory: join(root, 'artifacts'), outputDirectory: join(root, 'staged') })
    const dirty: StagedRelease = { ...staged, dirty: true }
    const offline = { published: false, allowDirty: false, tagCommit: async () => undefined }
    await expect(uploadGitHubRelease(dirty, { ...offline, runner: fakeGh().runner })).rejects.toThrow('uncommitted changes')
    await expect(uploadGitHubRelease(staged, { published: false, allowDirty: false, runner: fakeGh().runner, tagCommit: async () => 'b'.repeat(40) }))
      .rejects.toThrow(`names commit ${'b'.repeat(40)}`)
    const live = fakeGh({ isDraft: false, assets: {} })
    await expect(uploadGitHubRelease(staged, { published: false, allowDirty: false, runner: live.runner, tagCommit: async () => COMMIT }))
      .rejects.toThrow('already published')
    await expect(uploadGitHubRelease(staged, { published: true, allowDirty: false, runner: live.runner, tagCommit: async () => COMMIT })).resolves.toContain(`v${VERSION}`)
  })

  it('publishes a release only once it serves every target', async () => {
    const root = await temporary()
    const gh = fakeGh()
    const publish = () => publishGitHubRelease({ version: VERSION, targets: ['mac-arm64', 'win-x64'], runner: gh.runner })
    await expect(publish()).rejects.toThrow(`has no release v${VERSION}`)
    for (const [target, unsigned, packaged] of [['mac-arm64', false, packagedMac], ['win-x64', true, packagedWindows]] as const) {
      const artifacts = join(root, target)
      await packaged(artifacts)
      const staged = await stageGitHubRelease({ target, unsigned, version: VERSION, artifactsDirectory: artifacts, outputDirectory: join(root, `${target}-staged`) })
      await uploadGitHubRelease(staged, { published: false, allowDirty: false, runner: gh.runner, tagCommit: async () => undefined })
      if (target === 'mac-arm64') await expect(publish()).rejects.toThrow('win-x64: the release lacks stable.yml')
    }
    await publishGitHubRelease({ version: VERSION, targets: ['mac-arm64', 'win-x64'], runner: gh.runner })
    expect(gh.calls.at(-1)).toEqual(['release', 'edit', `v${VERSION}`, '--repo', BRAND.releaseRepository, '--draft=false', '--prerelease=false', '--latest'])
    expect(gh.release()?.isDraft).toBe(false)
  })

  it('reports what keeps a release from serving an update', async () => {
    const root = await temporary()
    const installer = await packagedWindows(join(root, 'artifacts'))
    await stageGitHubRelease({ target: 'win-x64', unsigned: true, version: VERSION, artifactsDirectory: join(root, 'artifacts'), outputDirectory: join(root, 'staged') })
    const stable = await readFile(join(root, 'staged', 'stable.yml'), 'utf8')
    const assets: ReleaseAsset[] = [
      { name: installer, size: Buffer.byteLength('exe bytes') }, { name: `${installer}.blockmap`, size: 12 },
      { name: 'stable.yml', size: stable.length }, { name: 'nightly.yml', size: stable.length }, { name: SHA256SUMS, size: 1 },
    ]
    const sums = mergeSha256Sums('', new Map(assets.filter(asset => asset.name !== SHA256SUMS).map(asset => [asset.name, '0'.repeat(64)])))
    const texts = new Map([['stable.yml', stable], ['nightly.yml', stable], [SHA256SUMS, sums]])
    const check = { version: VERSION, targets: ['win-x64'] as const, assets, texts }
    expect(verifyReleaseFeeds(check)).toEqual([])
    expect(verifyReleaseFeeds({ ...check, texts: new Map([...texts, ['nightly.yml', 'version: other']]) })).toEqual(['win-x64: nightly.yml differs from stable.yml'])
    expect(verifyReleaseFeeds({ ...check, assets: assets.map(asset => asset.name === installer ? { ...asset, size: 1 } : asset) }))
      .toEqual([`win-x64: ${installer} has 1 bytes, but stable.yml lists 9`])
    expect(verifyReleaseFeeds({ ...check, assets: assets.filter(asset => asset.name !== `${installer}.blockmap`) })).toEqual([`win-x64: the release lacks ${installer}.blockmap`])
    expect(verifyReleaseFeeds({ ...check, texts: new Map([...texts, [SHA256SUMS, mergeSha256Sums('', new Map())]]) }))
      .toEqual([installer, `${installer}.blockmap`, 'stable.yml', 'nightly.yml'].map(name => `${SHA256SUMS} has no line for ${name}`))
    expect(verifyReleaseFeeds({ ...check, targets: ['mac-arm64', 'win-x64'] })).toEqual(['mac-arm64: the release lacks stable-mac.yml'])
    expect(existsSync(join(root, 'staged', SHA256SUMS))).toBe(false)
  })
})
