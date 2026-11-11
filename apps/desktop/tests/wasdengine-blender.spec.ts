/** The Desktop app ships its platform's Blender runtime in the Blender plugin package, checked against its manifest. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { applyWasdengineBlender, BLENDER_ASAR_UNPACK, GIMP_ASAR_UNPACK } from '../scripts/wasdengine-builder-config.mjs'
import { BLENDER_MANIFEST_URL, stageBlenderRuntime } from '../scripts/wasdengine-blender.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const TARGET = { platform: 'darwin', arch: 'arm64' }
const ARCHIVE = 'blender-9.9-test-darwin-arm64.tar.gz'
const EXECUTABLE = 'python/bin/python3.13'
/** A runtime in miniature; the program is archived without execute permission, which staging restores. */
const FILES: Readonly<Record<string, string>> = {
  [EXECUTABLE]: '#!/bin/sh\n',
  'python/lib/python3.13/site-packages/bpy/__init__.so': 'bpy bytes',
  'python/lib/python3.13/site-packages/bpy/5.2/scripts/presets/camera/Arri_Alexa_Mini_&_SXT.py': 'preset',
  'python/lib/python3.13/site-packages/numpy/.dylibs/libscipy_openblas64_.dylib': 'openblas',
  'COPYING': 'GPL',
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wasd-blender-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Write a release folder as `wasdengine/blender/build.sh --out` does, with one darwin-arm64 archive. */
async function release(change: {
  readonly record?: object
  readonly artifact?: object
  readonly files?: Readonly<Record<string, string>>
} = {}): Promise<string> {
  const out = join(root, 'out')
  const stage = join(root, 'stage')
  await mkdir(out, { recursive: true })
  const files = change.files ?? FILES
  for (const [name, data] of Object.entries(files)) {
    await mkdir(dirname(join(stage, name)), { recursive: true })
    await writeFile(join(stage, name), data)
    await chmod(join(stage, name), 0o644)
  }
  await writeFile(join(stage, 'runtime.json'), JSON.stringify({
    format: 1, version: '9.9-test', bpy: '5.2.3', python: '3.13.18', platform: 'darwin', arch: 'arm64', executable: EXECUTABLE,
    sha256: Object.fromEntries(Object.entries(FILES).map(([name, data]) => [name, sha256(data)])), ...change.record,
  }))
  execFileSync('tar', ['-czf', join(out, ARCHIVE), '-C', stage, ...Object.keys(files), 'runtime.json'])
  const archive = await readFile(join(out, ARCHIVE))
  await writeFile(join(out, 'manifest.json'), JSON.stringify({
    format: 1, version: '9.9-test', bpy: '5.2.3',
    artifacts: {
      'darwin-arm64': {
        url: `https://github.com/WASDEngine/WASD-Engine/releases/download/blender-9.9-test/${ARCHIVE}`,
        bytes: archive.length, sha256: sha256(archive), ...change.artifact,
      },
    },
  }))
  return out
}

/** Write a prepared dsh tree that holds the Blender plugin package. */
async function dshTree(): Promise<string> {
  const plugin = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-blender')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"@deepseek-ai/dsh-blender"}')
  return join(root, 'dsh')
}

function shipped(dsh: string): string {
  return join(dsh, 'node_modules', '@deepseek-ai', 'dsh-blender', 'runtime')
}

posix('Blender staging', () => {
  it('ships a local build in the plugin package, with an executable Python and nothing else left behind', async () => {
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'darwin-arm64')
    expect(await stageBlenderRuntime(dsh, TARGET, { WASD_BLENDER_DIR: await release() })).toEqual({ version: '9.9-test', directory })
    expect(await readdir(shipped(dsh))).toEqual(['darwin-arm64'])
    expect((await readdir(directory)).sort()).toEqual(['COPYING', 'python', 'runtime.json'])
    expect(await readFile(join(directory, 'python', 'lib', 'python3.13', 'site-packages', 'numpy', '.dylibs', 'libscipy_openblas64_.dylib'), 'utf8')).toBe('openblas')
    expect((await stat(join(directory, ...EXECUTABLE.split('/')))).mode & 0o111).not.toBe(0)
  })

  it('ships the checked archive with its archive.json for Windows, whose plugin unpacks it on first use', async () => {
    const out = join(root, 'win-out')
    const stage = join(root, 'win-stage')
    const archiveName = 'blender-9.9-test-win32-x64.tar.gz'
    const files: Readonly<Record<string, string>> = { 'python/python.exe': 'MZ', 'python/Lib/site-packages/bpy/__init__.pyd': 'bpy', 'COPYING': 'GPL' }
    await mkdir(out, { recursive: true })
    for (const [name, data] of Object.entries(files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true })
      await writeFile(join(stage, name), data)
    }
    const runtime = { format: 1, version: '9.9-test', bpy: '5.2.3', python: '3.13.18', platform: 'win32', arch: 'x64', executable: 'python/python.exe' }
    await writeFile(join(stage, 'runtime.json'), JSON.stringify({ ...runtime, sha256: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])) }))
    execFileSync('tar', ['-czf', join(out, archiveName), '-C', stage, ...Object.keys(files), 'runtime.json'])
    const archive = await readFile(join(out, archiveName))
    await writeFile(join(out, 'manifest.json'), JSON.stringify({
      format: 1, version: '9.9-test', bpy: '5.2.3',
      artifacts: { 'win32-x64': { url: `https://github.com/WASDEngine/WASD-Engine/releases/download/blender-9.9-test/${archiveName}`, bytes: archive.length, sha256: sha256(archive) } },
    }))
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'win32-x64')
    expect(await stageBlenderRuntime(dsh, { platform: 'win32', arch: 'x64' }, { WASD_BLENDER_DIR: out })).toEqual({ version: '9.9-test', directory })
    expect((await readdir(directory)).sort()).toEqual(['archive.json', archiveName])
    expect(await readFile(join(directory, archiveName))).toEqual(archive)
    expect(JSON.parse(await readFile(join(directory, 'archive.json'), 'utf8'))).toEqual({
      format: 1, archive: archiveName, bytes: archive.length, sha256: sha256(archive), runtime,
    })
    expect(await readdir(shipped(dsh))).toEqual(['win32-x64'])
  })

  it('ships nothing for a platform the manifest has no build for, or with WASD_BLENDER_BUNDLE=0', async () => {
    const dsh = await dshTree()
    const out = await release()
    expect(await stageBlenderRuntime(dsh, { platform: 'win32', arch: 'x64' }, { WASD_BLENDER_DIR: out })).toBeUndefined()
    expect(await stageBlenderRuntime(dsh, TARGET, { WASD_BLENDER_DIR: out, WASD_BLENDER_BUNDLE: '0' })).toBeUndefined()
    await expect(stat(shipped(dsh))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an archive or runtime that does not match its manifest or its runtime.json, and leaves no runtime behind', async () => {
    const cases: readonly (readonly [Parameters<typeof release>[0], RegExp])[] = [
      [{ artifact: { sha256: '0'.repeat(64) } }, /does not match the SHA-256 its manifest lists/u],
      [{ record: { version: '9.8-test' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ record: { bpy: '5.2.2' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ record: { arch: 'x64' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ record: { python: 3.13 } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ files: { ...FILES, 'python/lib/extra.dylib': 'extra' } }, /does not hold exactly the files its runtime\.json lists \(unlisted: python\/lib\/extra\.dylib; missing: none\)/u],
      [{ files: { ...FILES, 'COPYING': 'changed' } }, /Blender COPYING does not match the SHA-256 its runtime\.json lists/u],
      [{ record: { executable: 'python/bin/python3.14' } }, /names python\/bin\/python3\.14, which it does not hold/u],
    ]
    for (const [change, message] of cases) {
      const dsh = await dshTree()
      await expect(stageBlenderRuntime(dsh, TARGET, { WASD_BLENDER_DIR: await release(change) })).rejects.toThrow(message)
      expect(await readdir(shipped(dsh))).toEqual([])
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
    }
  })

  it('rejects an unreadable or invalid manifest and a tree without the Blender plugin', async () => {
    const out = await release()
    await expect(stageBlenderRuntime(join(root, 'empty'), TARGET, { WASD_BLENDER_DIR: out })).rejects.toThrow('has no @deepseek-ai/dsh-blender package')
    await expect(stageBlenderRuntime(await dshTree(), TARGET, { WASD_BLENDER_DIR: join(root, 'none') })).rejects.toThrow('cannot read the Blender manifest')
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ format: 1, version: '9.9-test', gimp: '3.2.8', artifacts: {} }))
    await expect(stageBlenderRuntime(await dshTree(), TARGET, { WASD_BLENDER_DIR: out })).rejects.toThrow('is not a format 1 runtime manifest')
  })
})

describe('Blender packaging hooks', () => {
  it('keeps the shipped runtime outside app.asar in the ordinary release entry', async () => {
    expect(applyWasdengineBlender({ asarUnpack: ['first'] })).toEqual({ asarUnpack: ['first', BLENDER_ASAR_UNPACK] })
    expect(BLENDER_ASAR_UNPACK).toBe('**/node_modules/@deepseek-ai/dsh-blender/runtime/**/*')
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      expect(createReleaseConfig().asarUnpack).toEqual(expect.arrayContaining([GIMP_ASAR_UNPACK, BLENDER_ASAR_UNPACK]))
    } finally { vi.unstubAllEnvs() }
  })

  it('ships the runtime before prepare-dsh signs the dsh tree and writes its runtime descriptor', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    const staging = prepare.indexOf("'runtime:blender', () => stageBlenderRuntime(DSH_OUTPUT_ROOT, target)")
    expect(staging).toBeGreaterThan(prepare.indexOf("'runtime:materialize-modules'"))
    expect(staging).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
    expect(staging).toBeLessThan(prepare.indexOf("'runtime:write-descriptor'"))
  })

  it('stages into the folder the Blender plugin reads, from the release that build.sh builds by default, with the bpy version the plugin runs', async () => {
    const worker = await readFile(new URL('../../../packages/gamedev/blender/src/worker.ts', import.meta.url), 'utf8')
    expect(worker).toContain("bundledRoot: shippedRuntimeRoot(fileURLToPath(new URL('..', import.meta.url)))")
    const lookup = await readFile(new URL('../../../packages/gamedev/app-mcp/src/shipped-runtime.ts', import.meta.url), 'utf8')
    expect(/export function shippedRuntimeRoot\([^)]*\): string \{\n\s*return path\.join\([^\n]*'runtime'\)/u.test(lookup)).toBe(true)
    const build = await readFile(new URL('../../../wasdengine/blender/build.sh', import.meta.url), 'utf8')
    const version = /^version=(\S+)$/mu.exec(build)?.[1]
    expect(BLENDER_MANIFEST_URL).toBe(`https://github.com/WASDEngine/WASD-Engine/releases/download/blender-${String(version)}/manifest.json`)
    // The plugin runs the shipped runtime only when its bpy version is the plugin's bpyVersion.
    const bpy = /^bpy_version=(\S+)$/mu.exec(build)?.[1]
    const plugin = await readFile(new URL('../../../packages/gamedev/blender/src/index.ts', import.meta.url), 'utf8')
    expect(plugin).toContain(`bpyVersion: z.string().pattern(BPY_VERSION_PATTERN).default('${String(bpy)}')`)
    expect(String(version).startsWith(`${String(bpy)}-`)).toBe(true)
  })
})
