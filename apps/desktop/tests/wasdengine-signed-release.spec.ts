/**
 * WASDEngine fork guard for notarized macOS releases without an update service: `DSH_DESKTOP_AUTO_UPDATE_ENV=none`
 * packages a signed build with no update feed or mandatory-update policy, the macOS lanes name their files after the
 * brand, the bundled runtimes get the signing steps that upstream's per-file pass leaves, and official client builds
 * carry the WASD Engine title. `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { writeMacOSAppUpdateConfig } from '../scripts/macos-app-update-config.mjs'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact, type MacOSArtifactOperations } from '../scripts/package-macos.ts'
import { applyWasdengineBrand } from '../scripts/wasdengine-builder-config.mjs'
import { GODOT_RUNNER_ENTITLEMENTS, wasdengineRuntimeSigningPlan } from '../scripts/wasdengine-runtime-signing.ts'
import { NO_UPDATE_SERVICE, desktopUpdatesDisabled } from '../scripts/wasdengine-update-service.mjs'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'

/** Signed release settings of a WASDEngine notarized build, without the update and policy settings upstream needs. */
const SIGNED_MACOS = {
  DSH_DESKTOP_APP_ID: BRAND.appId,
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'wasdengine-test',
  DSH_DESKTOP_AUTO_UPDATE_ENV: NO_UPDATE_SERVICE,
}

/** A signed App in the artifacts folder and a builder that writes only the DMG and the ZIP. */
async function signedApp(root: string) {
  const artifactsRoot = join(root, 'artifacts')
  const appPath = join(artifactsRoot, 'mac-arm64', `${BRAND.productName}.app`)
  await mkdir(join(appPath, 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(appPath, 'payload'), 'signed content')
  const version = '0.1.0-rc'
  const base = `${BRAND.artifactBase}-${version}-mac-arm64`
  const apple: MacOSArtifactOperations = {
    copyApp: async (source, destination) => { await cp(source, destination, { recursive: true }) },
    notarize: async ({ appPath: path }) => { await writeFile(join(path, 'ticket'), 'accepted') },
    verifySignature: vi.fn(),
    verifyNotarization: vi.fn((path: string) => {
      if (!existsSync(join(path, 'ticket'))) throw new Error('missing App ticket')
    }),
  }
  const build = async (artifact: DesktopPrepackagedArtifact): Promise<void> => {
    await mkdir(artifact.output, { recursive: true })
    await writeFile(join(artifact.output, `${base}.${artifact.format}`), artifact.format)
  }
  return { request: { arch: 'arm64' as const, version, artifactsRoot, environment: SIGNED_MACOS }, appPath, apple, build, base }
}

describe('WASDEngine notarized macOS releases', () => {
  it('reads the switch from DSH_DESKTOP_AUTO_UPDATE_ENV', () => {
    expect(desktopUpdatesDisabled({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'none' })).toBe(true)
    expect(desktopUpdatesDisabled({ DSH_DESKTOP_AUTO_UPDATE_ENV: ' none ' })).toBe(true)
    expect(desktopUpdatesDisabled({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' })).toBe(false)
    expect(desktopUpdatesDisabled({})).toBe(false)
  })

  it('configures a signed, notarized build with no update feed or mandatory-update policy', () => {
    const config = applyWasdengineBrand(createElectronBuilderConfig(SIGNED_MACOS, 'darwin', 'arm64'))
    expect(config.publish).toBeNull()
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.mac.identity).toBe(SIGNED_MACOS.DSH_DESKTOP_MACOS_SIGNING_IDENTITY)
    expect(config.mac.notarize).toBe(true)
    expect(config.artifactName).toBe(`${BRAND.artifactBase}-\${version}-\${os}-\${arch}.\${ext}`)
  })

  it('validates a signed configuration that names no update or policy origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wasdengine-signed-release-'))
    try {
      const p12 = join(root, 'developer-id.p12')
      const key = join(root, 'AuthKey_TEST.p8')
      await writeFile(p12, 'p12')
      await writeFile(key, 'key')
      const environment: NodeJS.ProcessEnv = {
        ...SIGNED_MACOS, APPLE_KEYCHAIN_PROFILE: undefined, CSC_LINK: p12, CSC_KEY_PASSWORD: '',
        APPLE_API_KEY: key, APPLE_API_KEY_ID: 'ABCDE12345', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
      }
      const target = { platform: 'darwin', arch: 'arm64' } as const
      expect(() => { validateDesktopPackageEnvironment(environment, target) }).not.toThrow()
      // Upstream's deployments still require their update origins.
      expect(() => { validateDesktopPackageEnvironment({ ...environment, DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }, target) }).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('promotes only the brand-named DMG and ZIP of a build without an update service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wasdengine-signed-release-'))
    try {
      const f = await signedApp(root)
      await packageMacOSArtifacts(f.request, f.build, f.apple)
      expect((await readdir(f.request.artifactsRoot)).sort()).toEqual([`${f.base}.dmg`, `${f.base}.zip`, 'mac-arm64'])
      expect(existsSync(join(f.appPath, 'ticket'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an App that carries an update feed when the build has no update service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wasdengine-signed-release-'))
    try {
      const f = await signedApp(root)
      await writeMacOSAppUpdateConfig(join(f.appPath, 'Contents', 'Resources'), { publicUrl: 'https://updates.example.com/feeds/mac-arm64/' }, 'wasdengine-desktop-updater')
      await expect(packageMacOSArtifacts(f.request, f.build, f.apple)).rejects.toThrow('carries an update feed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('signs the LibGodot runner with its entitlements and seals GIMP\'s Python.app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wasdengine-runtime-signing-'))
    try {
      const runner = 'node_modules/@deepseek-ai/dsh-godot/libgodot/darwin-arm64/godot_runner'
      const framework = 'node_modules/@deepseek-ai/dsh-gimp/runtime/darwin-arm64/Contents/lib/Python.framework/Versions/3.14'
      await mkdir(join(root, dirname(runner)), { recursive: true })
      await writeFile(join(root, runner), '')
      await mkdir(join(root, framework, 'Resources', 'Python.app', 'Contents'), { recursive: true })
      expect(wasdengineRuntimeSigningPlan(root, 'arm64')).toEqual([
        { kind: 'file', path: runner, entitlements: GODOT_RUNNER_ENTITLEMENTS },
        { kind: 'bundle', path: `${framework}/Resources/Python.app` },
      ])
      expect(wasdengineRuntimeSigningPlan(root, 'x64')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const entitlements = readFileSync(GODOT_RUNNER_ENTITLEMENTS, 'utf8')
    expect(entitlements).toContain('<key>com.apple.security.cs.disable-library-validation</key><true/>')
    expect(entitlements.match(/<key>/gu)).toHaveLength(1)
  })

  it('titles official client builds WASD Engine', () => {
    const environment = resolveClientBuildEnvironment({ DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_VERSION: '0.1.0-rc' }, 'official')
    expect(environment.DSH_CLIENT_TITLE).toBe('WASD Engine')
  })
})
