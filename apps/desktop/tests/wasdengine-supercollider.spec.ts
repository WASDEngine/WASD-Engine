/** The Desktop app ships its platform's SuperCollider runtime in the SuperCollider plugin package, checked against its manifest. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { applyWasdengineSuperCollider, LIBGODOT_ASAR_UNPACK, SUPERCOLLIDER_ASAR_UNPACK } from '../scripts/wasdengine-builder-config.mjs'
import { stageSuperColliderRuntime, SUPERCOLLIDER_MANIFEST_URL } from '../scripts/wasdengine-supercollider.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const TARGET = { platform: 'linux', arch: 'x64' }
const ARCHIVE = 'supercollider-9.9-test-linux-x64.tar.gz'
/** A runtime in miniature; the two programs are archived without execute permission, which staging restores. */
const FILES: Readonly<Record<string, string>> = {
  'sclang': '#!/bin/sh\n',
  'scsynth': '#!/bin/sh\n',
  'plugins/OscUGens.so': 'plugin bytes',
  'SCClassLibrary/Common/Core/Object.sc': 'Object {}',
  'HelpSource/Classes/SinOsc.schelp': 'class:: SinOsc',
  'COPYING': 'GPL',
}

let root: string
let server: Server | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wasd-supercollider-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (server !== undefined) await new Promise(resolve => server?.close(resolve))
  server = undefined
  await rm(root, { recursive: true, force: true })
})

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Write a release folder as `wasdengine/supercollider/build.sh --out` does, with one linux-x64 archive. */
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
    format: 1, version: '9.9-test', supercollider: '3.14.1', platform: 'linux', arch: 'x64', sclang: 'sclang', scsynth: 'scsynth',
    plugins: 'plugins', classLibrary: 'SCClassLibrary', helpSource: 'HelpSource',
    sha256: Object.fromEntries(Object.entries(FILES).map(([name, data]) => [name, sha256(data)])), ...change.record,
  }))
  execFileSync('tar', ['-czf', join(out, ARCHIVE), '-C', stage, ...Object.keys(files), 'runtime.json'])
  const archive = await readFile(join(out, ARCHIVE))
  await writeFile(join(out, 'manifest.json'), JSON.stringify({
    format: 1, version: '9.9-test', supercollider: '3.14.1',
    artifacts: {
      'linux-x64': {
        url: `https://github.com/WASDEngine/WASD-Engine/releases/download/supercollider-9.9-test/${ARCHIVE}`,
        bytes: archive.length, sha256: sha256(archive), ...change.artifact,
      },
    },
  }))
  return out
}

/** Write a prepared dsh tree that holds the SuperCollider plugin package. */
async function dshTree(): Promise<string> {
  const plugin = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-supercollider')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"@deepseek-ai/dsh-supercollider"}')
  return join(root, 'dsh')
}

function shipped(dsh: string): string {
  return join(dsh, 'node_modules', '@deepseek-ai', 'dsh-supercollider', 'runtime')
}

posix('SuperCollider staging', () => {
  it('ships a local build in the plugin package, with executable programs and nothing else left behind', async () => {
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'linux-x64')
    expect(await stageSuperColliderRuntime(dsh, TARGET, { WASD_SUPERCOLLIDER_DIR: await release() })).toEqual({ version: '9.9-test', directory })
    expect(await readdir(shipped(dsh))).toEqual(['linux-x64'])
    expect((await readdir(directory)).sort()).toEqual(['COPYING', 'HelpSource', 'SCClassLibrary', 'plugins', 'runtime.json', 'sclang', 'scsynth'])
    expect(await readFile(join(directory, 'SCClassLibrary', 'Common', 'Core', 'Object.sc'), 'utf8')).toBe('Object {}')
    for (const program of ['sclang', 'scsynth']) expect((await stat(join(directory, program))).mode & 0o111).not.toBe(0)
    expect((await stat(join(directory, 'plugins', 'OscUGens.so'))).mode & 0o111).toBe(0)
  })

  it('downloads the archive the manifest names, relative to the manifest URL', async () => {
    const out = await release({ artifact: { url: ARCHIVE } })
    server = createServer((request, response) => {
      const name = request.url === '/manifest.json' ? 'manifest.json' : request.url === `/${ARCHIVE}` ? ARCHIVE : undefined
      if (name === undefined) {
        response.writeHead(404).end()
        return
      }
      void readFile(join(out, name)).then(body => response.end(body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${String(address.port)}`
    const dsh = await dshTree()
    expect(await stageSuperColliderRuntime(dsh, TARGET, { WASD_SUPERCOLLIDER_MANIFEST_URL: `${base}/manifest.json` }))
      .toEqual({ version: '9.9-test', directory: join(shipped(dsh), 'linux-x64') })
    await expect(stageSuperColliderRuntime(dsh, TARGET, { WASD_SUPERCOLLIDER_MANIFEST_URL: `${base}/missing.json` }))
      .rejects.toThrow(/answered HTTP 404\. .*WASD_SUPERCOLLIDER_DIR.*WASD_SUPERCOLLIDER_BUNDLE=0/u)
  })

  it('ships nothing for a platform the manifest has no build for, or with WASD_SUPERCOLLIDER_BUNDLE=0', async () => {
    const dsh = await dshTree()
    const out = await release()
    expect(await stageSuperColliderRuntime(dsh, { platform: 'win32', arch: 'x64' }, { WASD_SUPERCOLLIDER_DIR: out })).toBeUndefined()
    expect(await stageSuperColliderRuntime(dsh, TARGET, { WASD_SUPERCOLLIDER_DIR: out, WASD_SUPERCOLLIDER_BUNDLE: '0' })).toBeUndefined()
    await expect(stat(shipped(dsh))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an archive or runtime that does not match its manifest or its runtime.json, and leaves no runtime behind', async () => {
    const cases: readonly (readonly [Parameters<typeof release>[0], RegExp])[] = [
      [{ artifact: { sha256: '0'.repeat(64) } }, /does not match the SHA-256 its manifest lists/u],
      [{ artifact: { bytes: 1 } }, /larger than the 1 bytes its manifest lists/u],
      [{ record: { version: '9.8-test' } }, /does not describe 9\.9-test for linux-x64/u],
      [{ record: { supercollider: '3.14.0' } }, /does not describe 9\.9-test for linux-x64/u],
      [{ record: { arch: 'arm64' } }, /does not describe 9\.9-test for linux-x64/u],
      [{ files: { ...FILES, 'plugins/Extra.so': 'extra' } }, /does not hold exactly the files its runtime\.json lists \(unlisted: plugins\/Extra\.so; missing: none\)/u],
      [{ files: { ...FILES, 'COPYING': 'changed' } }, /SuperCollider COPYING does not match the SHA-256 its runtime\.json lists/u],
      [{ record: { scsynth: 'missing-scsynth' } }, /names missing-scsynth, which it does not hold/u],
    ]
    for (const [change, message] of cases) {
      const dsh = await dshTree()
      await expect(stageSuperColliderRuntime(dsh, TARGET, { WASD_SUPERCOLLIDER_DIR: await release(change) })).rejects.toThrow(message)
      expect(await readdir(shipped(dsh))).toEqual([])
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
    }
  })

  it('rejects an unreadable or invalid manifest and a tree without the SuperCollider plugin', async () => {
    const out = await release()
    await expect(stageSuperColliderRuntime(join(root, 'empty'), TARGET, { WASD_SUPERCOLLIDER_DIR: out }))
      .rejects.toThrow('has no @deepseek-ai/dsh-supercollider package')
    await expect(stageSuperColliderRuntime(await dshTree(), TARGET, { WASD_SUPERCOLLIDER_DIR: join(root, 'none') }))
      .rejects.toThrow('cannot read the SuperCollider manifest')
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ format: 1, version: '9.9-test', godot: '4.7.2-stable', artifacts: {} }))
    await expect(stageSuperColliderRuntime(await dshTree(), TARGET, { WASD_SUPERCOLLIDER_DIR: out })).rejects.toThrow('is not a format 1 runtime manifest')
  })
})

describe('SuperCollider packaging hooks', () => {
  it('keeps the shipped runtime outside app.asar in the ordinary release entry', async () => {
    expect(applyWasdengineSuperCollider({ asarUnpack: ['first'] })).toEqual({ asarUnpack: ['first', SUPERCOLLIDER_ASAR_UNPACK] })
    expect(SUPERCOLLIDER_ASAR_UNPACK).toBe('**/node_modules/@deepseek-ai/dsh-supercollider/runtime/**/*')
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      expect(createReleaseConfig().asarUnpack).toEqual(expect.arrayContaining([LIBGODOT_ASAR_UNPACK, SUPERCOLLIDER_ASAR_UNPACK]))
    } finally { vi.unstubAllEnvs() }
  })

  it('ships the runtime before prepare-dsh signs the dsh tree and writes its runtime descriptor', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    const staging = prepare.indexOf("'runtime:supercollider', () => stageSuperColliderRuntime(DSH_OUTPUT_ROOT, target)")
    expect(staging).toBeGreaterThan(prepare.indexOf("'runtime:materialize-modules'"))
    expect(staging).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
    expect(staging).toBeLessThan(prepare.indexOf("'runtime:write-descriptor'"))
  })

  it('stages into the folder the SuperCollider plugin reads, from the release that build.sh builds by default', async () => {
    const environment = await readFile(new URL('../../../packages/gamedev/supercollider/src/environment.ts', import.meta.url), 'utf8')
    expect(/export function bundledRuntimeRoot\([^)]*\): string \{\n\s*return path\.join\([^\n]*'runtime'\)/u.test(environment)).toBe(true)
    const build = await readFile(new URL('../../../wasdengine/supercollider/build.sh', import.meta.url), 'utf8')
    const version = /^version=(\S+)$/mu.exec(build)?.[1]
    expect(SUPERCOLLIDER_MANIFEST_URL).toBe(`https://github.com/WASDEngine/WASD-Engine/releases/download/supercollider-${String(version)}/manifest.json`)
  })
})
