/**
 * WASDEngine fork guard for notarized macOS releases without an update service: `DSH_DESKTOP_AUTO_UPDATE_ENV=none`
 * packages a signed build with no update feed or mandatory-update policy, the macOS lanes name their files after the
 * brand, a signed build carries every bundled runtime in its pinned version, the bundled runtimes get the signing steps
 * that upstream's per-file pass leaves, and official client builds carry the WASD Engine title. `wasdengine/FORK.md`
 * (repository root) runs this spec after every upstream merge.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { writeMacOSAppUpdateConfig } from '../scripts/macos-app-update-config.mjs'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact, type MacOSArtifactOperations } from '../scripts/package-macos.ts'
import { applyWasdengineBrand } from '../scripts/wasdengine-builder-config.mjs'
import { BLENDER_MANIFEST_URL, BLENDER_RUNTIME } from '../scripts/wasdengine-blender.ts'
import { GIMP_MANIFEST_URL, GIMP_RUNTIME } from '../scripts/wasdengine-gimp.ts'
import { LIBGODOT_MANIFEST_URL, LIBGODOT_RUNTIME } from '../scripts/wasdengine-libgodot.ts'
import type { PinnedRuntime } from '../scripts/wasdengine-runtime-archive.ts'
import {
  GODOT_RUNNER_ENTITLEMENTS, WASDENGINE_PINNED_RUNTIMES, checkWasdengineRuntimes, wasdengineRuntimeMismatches, wasdengineRuntimeSigningPlan,
} from '../scripts/wasdengine-runtime-signing.ts'
import { SUPERCOLLIDER_MANIFEST_URL, SUPERCOLLIDER_RUNTIME } from '../scripts/wasdengine-supercollider.ts'
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

describe('the runtimes of a signed build', () => {
  const MAC = { platform: 'darwin', arch: 'arm64' }
  const WINDOWS = { platform: 'win32', arch: 'x64' }
  const roots: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  /** Write a prepared dsh tree holding each runtime in the version given, as its runtime.json or, if asked, its archive.json. */
  async function tree(target: typeof MAC, versions: ReadonlyMap<PinnedRuntime, string>, archived: ReadonlySet<PinnedRuntime> = new Set()) {
    const root = await mkdtemp(join(tmpdir(), 'wasdengine-runtime-pins-'))
    roots.push(root)
    for (const [runtime, version] of versions) {
      const folder = join(root, 'node_modules', ...runtime.packageName.split('/'), runtime.folder, `${target.platform}-${target.arch}`)
      await mkdir(folder, { recursive: true })
      if (archived.has(runtime)) await writeFile(join(folder, 'archive.json'), JSON.stringify({ format: 1, archive: 'runtime.tar.gz', runtime: { format: 1, version } }))
      else await writeFile(join(folder, 'runtime.json'), JSON.stringify({ format: 1, version, platform: target.platform, arch: target.arch }))
    }
    return root
  }

  const pinned = () => new Map(WASDENGINE_PINNED_RUNTIMES.map(runtime => [runtime, runtime.version]))

  it('pins LibGodot, SuperCollider, GIMP, and Blender at the versions of the releases their manifest URLs name', () => {
    expect(WASDENGINE_PINNED_RUNTIMES).toEqual([LIBGODOT_RUNTIME, SUPERCOLLIDER_RUNTIME, GIMP_RUNTIME, BLENDER_RUNTIME])
    for (const [runtime, url, tag] of [
      [LIBGODOT_RUNTIME, LIBGODOT_MANIFEST_URL, 'libgodot'], [SUPERCOLLIDER_RUNTIME, SUPERCOLLIDER_MANIFEST_URL, 'supercollider'],
      [GIMP_RUNTIME, GIMP_MANIFEST_URL, 'gimp'], [BLENDER_RUNTIME, BLENDER_MANIFEST_URL, 'blender'],
    ] as const) {
      expect(url).toBe(`https://github.com/WASDEngine/WASD-Engine/releases/download/${tag}-${runtime.version}/manifest.json`)
    }
  })

  it('accepts a tree that holds every pinned runtime, unpacked or as its archive', async () => {
    await expect(checkWasdengineRuntimes(await tree(MAC, pinned()), MAC, {})).resolves.toBeUndefined()
    const windows = await tree(WINDOWS, pinned(), new Set([GIMP_RUNTIME, BLENDER_RUNTIME]))
    expect(await wasdengineRuntimeMismatches(windows, WINDOWS)).toEqual([])
  })

  it.each([{}, { DSH_DESKTOP_UNSIGNED: '0' }])('stops a signed build that lacks a pinned runtime or holds another version (%j)', async (env) => {
    const versions = pinned()
    versions.set(GIMP_RUNTIME, '3.2.8-wasd.1')
    versions.delete(BLENDER_RUNTIME)
    const root = await tree(MAC, versions)
    expect(await wasdengineRuntimeMismatches(root, MAC)).toEqual([
      { runtime: GIMP_RUNTIME, shipped: '3.2.8-wasd.1' }, { runtime: BLENDER_RUNTIME, shipped: undefined },
    ])
    await expect(checkWasdengineRuntimes(root, MAC, env)).rejects.toThrow(
      `desktop runtime: a signed build ships every runtime in its pinned version, but it ships GIMP 3.2.8-wasd.1, not the pinned ${GIMP_RUNTIME.version}; `
      + `it ships no Blender runtime, whose pinned version is ${BLENDER_RUNTIME.version}. Unset WASD_GIMP_DIR, WASD_GIMP_MANIFEST_URL, `
      + 'WASD_GIMP_BUNDLE, WASD_BLENDER_DIR, WASD_BLENDER_MANIFEST_URL, WASD_BLENDER_BUNDLE to package the pinned releases.')
  })

  it('lets an unsigned build continue with a warning for each runtime that differs from its pin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const versions = pinned()
    versions.delete(LIBGODOT_RUNTIME)
    await expect(checkWasdengineRuntimes(await tree(MAC, versions), MAC, { DSH_DESKTOP_UNSIGNED: '1' })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledExactlyOnceWith('desktop runtime: this unsigned build continues, but it ships no LibGodot runtime, '
      + `whose pinned version is ${LIBGODOT_RUNTIME.version}; a signed build stops here`)
  })

  it('rejects a runtime record that names no version', async () => {
    const root = await tree(MAC, pinned())
    const folder = join(root, 'node_modules', '@deepseek-ai', 'dsh-supercollider', 'runtime', 'darwin-arm64')
    await writeFile(join(folder, 'runtime.json'), JSON.stringify({ format: 1 }))
    await expect(checkWasdengineRuntimes(root, MAC, { DSH_DESKTOP_UNSIGNED: '1' })).rejects.toThrow(
      `desktop runtime: the SuperCollider runtime in ${folder} names no version`)
  })

  it('checks the pins after the runtime staging steps and before signing', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    const check = prepare.indexOf("'runtime:wasdengine-pins', () => checkWasdengineRuntimes(DSH_OUTPUT_ROOT, target, process.env)")
    for (const step of ['runtime:libgodot', 'runtime:supercollider', 'runtime:gimp', 'runtime:blender']) {
      expect(prepare.indexOf(`'${step}'`)).toBeGreaterThan(0)
      expect(check).toBeGreaterThan(prepare.indexOf(`'${step}'`))
    }
    expect(check).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
  })
})
