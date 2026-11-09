/** The Desktop app ships its platform's LibGodot runtime in the Godot plugin package, checked against its manifest. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { applyWasdengineLibGodot, LIBGODOT_ASAR_UNPACK } from '../scripts/wasdengine-builder-config.mjs'
import { LIBGODOT_MANIFEST_URL, stageLibGodotRuntime } from '../scripts/wasdengine-libgodot.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const TARGET = { platform: 'linux', arch: 'x64' }
const ARCHIVE = 'libgodot-9.9-test-linux-x64.tar.gz'
const RUNNER = '#!/bin/sh\n'
const LIBRARY = 'library bytes'

let root: string
let server: Server | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wasd-libgodot-'))
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

/** Write a release folder as `wasdengine/libgodot/build.sh --out` does, with one linux-x64 archive. */
async function release(change: { readonly record?: object; readonly artifact?: object } = {}): Promise<string> {
  const out = join(root, 'out')
  const stage = join(root, 'stage')
  await mkdir(out, { recursive: true })
  await mkdir(stage, { recursive: true })
  await writeFile(join(stage, 'godot_runner'), RUNNER, { mode: 0o644 })
  await writeFile(join(stage, 'libgodot.so'), LIBRARY)
  await writeFile(join(stage, 'runtime.json'), JSON.stringify({
    format: 1, version: '9.9-test', godot: '4.7.2-stable', platform: 'linux', arch: 'x64', runner: 'godot_runner',
    library: 'libgodot.so', sha256: { godot_runner: sha256(RUNNER), 'libgodot.so': sha256(LIBRARY) }, ...change.record,
  }))
  execFileSync('tar', ['-czf', join(out, ARCHIVE), '-C', stage, 'godot_runner', 'libgodot.so', 'runtime.json'])
  const archive = await readFile(join(out, ARCHIVE))
  await writeFile(join(out, 'manifest.json'), JSON.stringify({
    format: 1, version: '9.9-test', godot: '4.7.2-stable',
    artifacts: {
      'linux-x64': {
        url: `https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-9.9-test/${ARCHIVE}`,
        bytes: archive.length, sha256: sha256(archive), runner: 'godot_runner', library: 'libgodot.so', ...change.artifact,
      },
    },
  }))
  return out
}

/** Write a prepared dsh tree that holds the Godot plugin package. */
async function dshTree(): Promise<string> {
  const plugin = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-godot')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"@deepseek-ai/dsh-godot"}')
  return join(root, 'dsh')
}

function shipped(dsh: string): string {
  return join(dsh, 'node_modules', '@deepseek-ai', 'dsh-godot', 'libgodot')
}

posix('LibGodot staging', () => {
  it('ships a local build in the Godot plugin package, with an executable runner and nothing else left behind', async () => {
    const dsh = await dshTree()
    const directory = join(shipped(dsh), 'linux-x64')
    expect(await stageLibGodotRuntime(dsh, TARGET, { WASD_LIBGODOT_DIR: await release() })).toEqual({ version: '9.9-test', directory })
    expect(await readdir(shipped(dsh))).toEqual(['linux-x64'])
    expect((await readdir(directory)).sort()).toEqual(['godot_runner', 'libgodot.so', 'runtime.json'])
    expect((await stat(join(directory, 'godot_runner'))).mode & 0o111).not.toBe(0)
    expect(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))).toMatchObject({
      format: 1, version: '9.9-test', platform: 'linux', arch: 'x64', runner: 'godot_runner', library: 'libgodot.so',
    })
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
    expect(await stageLibGodotRuntime(dsh, TARGET, { WASD_LIBGODOT_MANIFEST_URL: `${base}/manifest.json` }))
      .toEqual({ version: '9.9-test', directory: join(shipped(dsh), 'linux-x64') })
    await expect(stageLibGodotRuntime(dsh, TARGET, { WASD_LIBGODOT_MANIFEST_URL: `${base}/missing.json` }))
      .rejects.toThrow(/answered HTTP 404\. .*WASD_LIBGODOT_DIR.*WASD_LIBGODOT_BUNDLE=0/u)
  })

  it('ships nothing for a platform the manifest has no build for, or with WASD_LIBGODOT_BUNDLE=0', async () => {
    const dsh = await dshTree()
    const out = await release()
    expect(await stageLibGodotRuntime(dsh, { platform: 'darwin', arch: 'x64' }, { WASD_LIBGODOT_DIR: out })).toBeUndefined()
    expect(await stageLibGodotRuntime(dsh, TARGET, { WASD_LIBGODOT_DIR: out, WASD_LIBGODOT_BUNDLE: '0' })).toBeUndefined()
    await expect(stat(shipped(dsh))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an archive or runtime that does not match its manifest, and leaves no runtime behind', async () => {
    const cases: readonly (readonly [object, RegExp])[] = [
      [{ artifact: { sha256: '0'.repeat(64) } }, /does not match the SHA-256 its manifest lists/u],
      [{ artifact: { bytes: 1 } }, /larger than the 1 bytes its manifest lists/u],
      [{ record: { version: '9.8-test' } }, /does not describe 9\.9-test for linux-x64/u],
      [{ record: { arch: 'arm64' } }, /does not describe 9\.9-test for linux-x64/u],
      [{ record: { sha256: { godot_runner: '0'.repeat(64), 'libgodot.so': sha256(LIBRARY) } } }, /godot_runner does not match the SHA-256 its runtime\.json lists/u],
    ]
    for (const [change, message] of cases) {
      const dsh = await dshTree()
      await expect(stageLibGodotRuntime(dsh, TARGET, { WASD_LIBGODOT_DIR: await release(change) })).rejects.toThrow(message)
      expect(await readdir(shipped(dsh))).toEqual([])
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
    }
  })

  it('rejects an unreadable or invalid manifest and a tree without the Godot plugin', async () => {
    const out = await release()
    await expect(stageLibGodotRuntime(join(root, 'empty'), TARGET, { WASD_LIBGODOT_DIR: out })).rejects.toThrow('has no @deepseek-ai/dsh-godot package')
    await expect(stageLibGodotRuntime(await dshTree(), TARGET, { WASD_LIBGODOT_DIR: join(root, 'none') })).rejects.toThrow('cannot read the LibGodot manifest')
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ format: 2, version: '9.9-test', godot: '4.7.2-stable', artifacts: {} }))
    await expect(stageLibGodotRuntime(await dshTree(), TARGET, { WASD_LIBGODOT_DIR: out })).rejects.toThrow('is not a format 1 runtime manifest')
  })
})

describe('LibGodot packaging hooks', () => {
  it('keeps the shipped runtime outside app.asar in the ordinary release entry', async () => {
    expect(applyWasdengineLibGodot({ asarUnpack: ['first'] })).toEqual({ asarUnpack: ['first', LIBGODOT_ASAR_UNPACK] })
    expect(LIBGODOT_ASAR_UNPACK).toBe('**/node_modules/@deepseek-ai/dsh-godot/libgodot/**/*')
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      expect(createReleaseConfig().asarUnpack).toContain(LIBGODOT_ASAR_UNPACK)
    } finally { vi.unstubAllEnvs() }
  })

  it('ships the runtime before prepare-dsh signs the dsh tree and writes its runtime descriptor', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    const staging = prepare.indexOf("'runtime:libgodot', () => stageLibGodotRuntime(DSH_OUTPUT_ROOT, target)")
    expect(staging).toBeGreaterThan(prepare.indexOf("'runtime:materialize-modules'"))
    expect(staging).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
    expect(staging).toBeLessThan(prepare.indexOf("'runtime:write-descriptor'"))
  })

  it('reads the manifest the Godot plugin downloads from', async () => {
    const plugin = await readFile(new URL('../../../packages/gamedev/godot/src/index.ts', import.meta.url), 'utf8')
    expect(/runtimeManifestUrl: z\.string\(\)\.default\('([^']+)'\)/u.exec(plugin)?.[1]).toBe(LIBGODOT_MANIFEST_URL)
  })
})
