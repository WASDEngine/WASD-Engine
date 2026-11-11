/** The Desktop app ships its platform's GIMP runtime in the GIMP plugin package, checked against its manifest. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { applyWasdengineGimp, GIMP_ASAR_UNPACK, SUPERCOLLIDER_ASAR_UNPACK } from '../scripts/wasdengine-builder-config.mjs'
import { GIMP_MANIFEST_URL, stageGimpRuntime } from '../scripts/wasdengine-gimp.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const TARGET = { platform: 'darwin', arch: 'arm64' }
const ARCHIVE = 'gimp-9.9-test-darwin-arm64.tar.gz'
const CONSOLE = 'Contents/MacOS/gimp-console-3.2'
/** A runtime in miniature; the console is archived without execute permission, which staging restores. */
const FILES: Readonly<Record<string, string>> = {
  [CONSOLE]: '#!/bin/sh\n',
  'Contents/lib/gimp/3.0/plug-ins/file-png/file-png': 'plug-in bytes',
  'Contents/share/gimp/3.0/brushes/arrow#1.myb': 'brush',
  'Contents/share/locale/wasd-engine-folder.txt': 'keep',
  'Contents/etc/gimp/3.0/gimprc': '# gimprc',
  'COPYING': 'GPL',
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wasd-gimp-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Write a release folder as `wasdengine/gimp/build.sh --out` does, with one darwin-arm64 archive. */
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
    format: 1, version: '9.9-test', gimp: '3.2.8', platform: 'darwin', arch: 'arm64', console: CONSOLE,
    dataDir: 'Contents/share/gimp/3.0', localeDir: 'Contents/share/locale', sysconfDir: 'Contents/etc/gimp/3.0',
    sha256: Object.fromEntries(Object.entries(FILES).map(([name, data]) => [name, sha256(data)])), ...change.record,
  }))
  execFileSync('tar', ['-czf', join(out, ARCHIVE), '-C', stage, ...Object.keys(files), 'runtime.json'])
  const archive = await readFile(join(out, ARCHIVE))
  await writeFile(join(out, 'manifest.json'), JSON.stringify({
    format: 1, version: '9.9-test', gimp: '3.2.8',
    artifacts: {
      'darwin-arm64': {
        url: `https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-9.9-test/${ARCHIVE}`,
        bytes: archive.length, sha256: sha256(archive), ...change.artifact,
      },
    },
  }))
  return out
}

/** Write a prepared dsh tree that holds the GIMP plugin package. */
async function dshTree(): Promise<string> {
  const plugin = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-gimp')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"@deepseek-ai/dsh-gimp"}')
  return join(root, 'dsh')
}

function shipped(dsh: string): string {
  return join(dsh, 'node_modules', '@deepseek-ai', 'dsh-gimp', 'runtime')
}

posix('GIMP staging', () => {
  it('ships a local build in the plugin package, with an executable console and nothing else left behind', async () => {
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'darwin-arm64')
    expect(await stageGimpRuntime(dsh, TARGET, { WASD_GIMP_DIR: await release() })).toEqual({ version: '9.9-test', directory })
    expect(await readdir(shipped(dsh))).toEqual(['darwin-arm64'])
    expect((await readdir(directory)).sort()).toEqual(['COPYING', 'Contents', 'runtime.json'])
    expect(await readFile(join(directory, 'Contents', 'share', 'gimp', '3.0', 'brushes', 'arrow#1.myb'), 'utf8')).toBe('brush')
    expect((await stat(join(directory, ...CONSOLE.split('/')))).mode & 0o111).not.toBe(0)
  })

  it('ships the checked archive with its archive.json for Windows, whose plugin unpacks it on first use', async () => {
    const out = join(root, 'win-out')
    const stage = join(root, 'win-stage')
    const archiveName = 'gimp-9.9-test-win32-x64.tar.gz'
    const files: Readonly<Record<string, string>> = {
      'bin/gimp-console-3.2.exe': 'MZ', 'share/gimp/3.0/brushes/arrow#1.myb': 'brush', 'share/locale/wasd-engine-folder.txt': 'keep',
      'etc/gimp/3.0/gimprc': '# gimprc', 'COPYING': 'GPL',
    }
    await mkdir(out, { recursive: true })
    for (const [name, data] of Object.entries(files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true })
      await writeFile(join(stage, name), data)
    }
    const runtime = {
      format: 1, version: '9.9-test', gimp: '3.2.8', platform: 'win32', arch: 'x64', console: 'bin/gimp-console-3.2.exe',
      dataDir: 'share/gimp/3.0', localeDir: 'share/locale', sysconfDir: 'etc/gimp/3.0',
    }
    await writeFile(join(stage, 'runtime.json'), JSON.stringify({ ...runtime, sha256: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])) }))
    execFileSync('tar', ['-czf', join(out, archiveName), '-C', stage, ...Object.keys(files), 'runtime.json'])
    const archive = await readFile(join(out, archiveName))
    await writeFile(join(out, 'manifest.json'), JSON.stringify({
      format: 1, version: '9.9-test', gimp: '3.2.8',
      artifacts: { 'win32-x64': { url: `https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-9.9-test/${archiveName}`, bytes: archive.length, sha256: sha256(archive) } },
    }))
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'win32-x64')
    expect(await stageGimpRuntime(dsh, { platform: 'win32', arch: 'x64' }, { WASD_GIMP_DIR: out })).toEqual({ version: '9.9-test', directory })
    expect((await readdir(directory)).sort()).toEqual(['archive.json', archiveName])
    expect(await readFile(join(directory, archiveName))).toEqual(archive)
    expect(JSON.parse(await readFile(join(directory, 'archive.json'), 'utf8'))).toEqual({
      format: 1, archive: archiveName, bytes: archive.length, sha256: sha256(archive), runtime,
    })
    expect(await readdir(shipped(dsh))).toEqual(['win32-x64'])
  })

  it('ships nothing for a platform the manifest has no build for, or with WASD_GIMP_BUNDLE=0', async () => {
    const dsh = await dshTree()
    const out = await release()
    expect(await stageGimpRuntime(dsh, { platform: 'win32', arch: 'x64' }, { WASD_GIMP_DIR: out })).toBeUndefined()
    expect(await stageGimpRuntime(dsh, TARGET, { WASD_GIMP_DIR: out, WASD_GIMP_BUNDLE: '0' })).toBeUndefined()
    await expect(stat(shipped(dsh))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an archive or runtime that does not match its manifest or its runtime.json, and leaves no runtime behind', async () => {
    const cases: readonly (readonly [Parameters<typeof release>[0], RegExp])[] = [
      [{ artifact: { sha256: '0'.repeat(64) } }, /does not match the SHA-256 its manifest lists/u],
      [{ record: { version: '9.8-test' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ record: { gimp: '3.2.6' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ record: { arch: 'x64' } }, /does not describe 9\.9-test for darwin-arm64/u],
      [{ files: { ...FILES, 'Contents/lib/extra.dylib': 'extra' } }, /does not hold exactly the files its runtime\.json lists \(unlisted: Contents\/lib\/extra\.dylib; missing: none\)/u],
      [{ files: { ...FILES, 'COPYING': 'changed' } }, /GIMP COPYING does not match the SHA-256 its runtime\.json lists/u],
      [{ record: { console: 'Contents/MacOS/missing' } }, /names Contents\/MacOS\/missing, which it does not hold/u],
      [{ record: { sysconfDir: 'Contents/etc/fonts' } }, /names the folder Contents\/etc\/fonts, which holds no file/u],
    ]
    for (const [change, message] of cases) {
      const dsh = await dshTree()
      await expect(stageGimpRuntime(dsh, TARGET, { WASD_GIMP_DIR: await release(change) })).rejects.toThrow(message)
      expect(await readdir(shipped(dsh))).toEqual([])
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
    }
  })

  it('rejects an unreadable or invalid manifest and a tree without the GIMP plugin', async () => {
    const out = await release()
    await expect(stageGimpRuntime(join(root, 'empty'), TARGET, { WASD_GIMP_DIR: out })).rejects.toThrow('has no @deepseek-ai/dsh-gimp package')
    await expect(stageGimpRuntime(await dshTree(), TARGET, { WASD_GIMP_DIR: join(root, 'none') })).rejects.toThrow('cannot read the GIMP manifest')
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ format: 1, version: '9.9-test', supercollider: '3.14.1', artifacts: {} }))
    await expect(stageGimpRuntime(await dshTree(), TARGET, { WASD_GIMP_DIR: out })).rejects.toThrow('is not a format 1 runtime manifest')
  })
})

describe('GIMP packaging hooks', () => {
  it('keeps the shipped runtime outside app.asar in the ordinary release entry', async () => {
    expect(applyWasdengineGimp({ asarUnpack: ['first'] })).toEqual({ asarUnpack: ['first', GIMP_ASAR_UNPACK] })
    expect(GIMP_ASAR_UNPACK).toBe('**/node_modules/@deepseek-ai/dsh-gimp/runtime/**/*')
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      expect(createReleaseConfig().asarUnpack).toEqual(expect.arrayContaining([SUPERCOLLIDER_ASAR_UNPACK, GIMP_ASAR_UNPACK]))
    } finally { vi.unstubAllEnvs() }
  })

  it('ships the runtime before prepare-dsh signs the dsh tree and writes its runtime descriptor', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    const staging = prepare.indexOf("'runtime:gimp', () => stageGimpRuntime(DSH_OUTPUT_ROOT, target)")
    expect(staging).toBeGreaterThan(prepare.indexOf("'runtime:materialize-modules'"))
    expect(staging).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
    expect(staging).toBeLessThan(prepare.indexOf("'runtime:write-descriptor'"))
  })

  it('stages into the folder the GIMP plugin reads, from the release that build.sh builds by default', async () => {
    const worker = await readFile(new URL('../../../packages/gamedev/gimp/src/worker.ts', import.meta.url), 'utf8')
    expect(worker).toContain("bundledRoot: shippedRuntimeRoot(fileURLToPath(new URL('..', import.meta.url)))")
    const lookup = await readFile(new URL('../../../packages/gamedev/app-mcp/src/shipped-runtime.ts', import.meta.url), 'utf8')
    expect(/export function shippedRuntimeRoot\([^)]*\): string \{\n\s*return path\.join\([^\n]*'runtime'\)/u.test(lookup)).toBe(true)
    const build = await readFile(new URL('../../../wasdengine/gimp/build.sh', import.meta.url), 'utf8')
    const version = /^version=(\S+)$/mu.exec(build)?.[1]
    expect(GIMP_MANIFEST_URL).toBe(`https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-${String(version)}/manifest.json`)
  })
})
