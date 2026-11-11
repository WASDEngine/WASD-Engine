/** The runtime that the Desktop app ships in a plugin package: its folder, its record, and the real host's file reads. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ShippedRuntimeFields, ShippedRuntimePath, nodeShippedRuntimeHost, readPackedRuntime, readShippedRuntime, shippedRuntimeRoot,
} from '../src/shipped-runtime.ts'
import type { ShippedRuntimeHost } from '../src/shipped-runtime.ts'
import { temporaryDirectory } from './harness.ts'

const Record = z.object({ ...ShippedRuntimeFields, program: ShippedRuntimePath })
const invalid = (directory: string, reason: string): Error => new Error(`${directory}: ${reason}`)

/** A host on another machine that holds one file. */
function host(platform: NodeJS.Platform, arch: string, files: Readonly<Record<string, string>>): ShippedRuntimeHost {
  return {
    platform, arch, env: {}, homeDirectory: '/home/dev',
    isExecutable: async () => false, listDirectory: async () => [], makeDirectory: async () => {},
    readTextFile: async file => files[file],
  }
}

describe('shippedRuntimeRoot', () => {
  it('reads a package inside app.asar from app.asar.unpacked', () => {
    expect(shippedRuntimeRoot('/App/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-blender'))
      .toBe(join('/App/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-blender', 'runtime'))
    expect(shippedRuntimeRoot('/repo/packages/gamedev/blender')).toBe(join('/repo/packages/gamedev/blender', 'runtime'))
    expect(shippedRuntimeRoot('/repo/app.asarx/blender')).toBe(join('/repo/app.asarx/blender', 'runtime'))
  })
})

describe('readShippedRuntime', () => {
  const record = { format: 1, version: '5.2.3-wasd.1', platform: 'darwin', arch: 'arm64', program: 'python/bin/python3.13' }

  it('reads the record of this platform and resolves its paths', async () => {
    const files = { '/pkg/runtime/darwin-arm64/runtime.json': JSON.stringify(record) }
    const runtime = await readShippedRuntime('/pkg/runtime', host('darwin', 'arm64', files), Record, invalid)
    expect(runtime?.directory).toBe('/pkg/runtime/darwin-arm64')
    expect(runtime?.record).toEqual(record)
    expect(runtime?.resolve(record.program)).toBe('/pkg/runtime/darwin-arm64/python/bin/python3.13')
    const windows = { 'C:\\pkg\\runtime\\win32-x64\\runtime.json': JSON.stringify({ ...record, platform: 'win32', arch: 'x64', program: 'python/python.exe' }) }
    const shipped = await readShippedRuntime('C:\\pkg\\runtime', host('win32', 'x64', windows), Record, invalid)
    expect(shipped?.resolve('python/python.exe')).toBe('C:\\pkg\\runtime\\win32-x64\\python\\python.exe')
  })

  it('finds nothing without a record for this platform', async () => {
    const files = { '/pkg/runtime/darwin-arm64/runtime.json': JSON.stringify(record) }
    await expect(readShippedRuntime('/pkg/runtime', host('darwin', 'x64', files), Record, invalid)).resolves.toBeUndefined()
  })

  it('reports a record that is not JSON, does not match the schema, or describes another platform', async () => {
    const file = '/pkg/runtime/linux-x64/runtime.json'
    const cases: readonly (readonly [string, RegExp])[] = [
      ['{', /^\/pkg\/runtime\/linux-x64: \/pkg\/runtime\/linux-x64\/runtime\.json is not JSON$/u],
      [JSON.stringify({ ...record, platform: 'linux', arch: 'x64', format: 2 }), /is not a format 1 runtime record: .*format/su],
      [JSON.stringify({ ...record, platform: 'linux', arch: 'x64', program: '../python' }), /must be a relative path inside the runtime folder/u],
      [JSON.stringify({ ...record, platform: 'linux', arch: 'x64', program: 'python\\python.exe' }), /must be a relative path inside the runtime folder/u],
      [JSON.stringify(record), /its runtime\.json describes darwin-arm64$/u],
    ]
    for (const [text, message] of cases) {
      await expect(readShippedRuntime('/pkg/runtime', host('linux', 'x64', { [file]: text }), Record, invalid)).rejects.toThrow(message)
    }
  })
})

describe('readPackedRuntime', () => {
  const runtime = { format: 1, version: '5.2.3-wasd.1', platform: 'win32', arch: 'x64', program: 'python/python.exe' }
  const packed = { format: 1, archive: 'blender-5.2.3-wasd.1-win32-x64.tar.gz', bytes: 361_000_000, sha256: 'a'.repeat(64), runtime }
  const file = 'C:\\pkg\\runtime\\win32-x64\\archive.json'

  it('reads the archive of this platform and the fields of its runtime.json', async () => {
    const shipped = await readPackedRuntime('C:\\pkg\\runtime', host('win32', 'x64', { [file]: JSON.stringify(packed) }), Record, invalid)
    expect(shipped).toEqual({
      directory: 'C:\\pkg\\runtime\\win32-x64', archive: 'C:\\pkg\\runtime\\win32-x64\\blender-5.2.3-wasd.1-win32-x64.tar.gz',
      bytes: 361_000_000, sha256: 'a'.repeat(64), record: runtime,
    })
    await expect(readPackedRuntime('C:\\pkg\\runtime', host('win32', 'x64', {}), Record, invalid)).resolves.toBeUndefined()
  })

  it('reports an archive record that does not match, names a path, or describes another platform', async () => {
    const cases: readonly (readonly [object, RegExp])[] = [
      [{ ...packed, archive: '..\\outside.tar.gz' }, /must be a file name inside the runtime folder/u],
      [{ ...packed, archive: 'sub/archive.tar.gz' }, /must be a file name inside the runtime folder/u],
      [{ ...packed, sha256: 'not a digest' }, /is not a format 1 runtime record: .*sha256/su],
      [{ ...packed, bytes: 0 }, /is not a format 1 runtime record: .*bytes/su],
      [{ ...packed, runtime: { ...runtime, program: '..\\python.exe' } }, /must be a relative path inside the runtime folder/u],
      [{ ...packed, runtime: { ...runtime, arch: 'arm64' } }, /its archive\.json describes win32-arm64$/u],
    ]
    for (const [record, message] of cases) {
      await expect(readPackedRuntime('C:\\pkg\\runtime', host('win32', 'x64', { [file]: JSON.stringify(record) }), Record, invalid))
        .rejects.toThrow(message)
    }
  })
})

describe('nodeShippedRuntimeHost', () => {
  it('reads text files, and reads a missing one as undefined', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-shipped-')
    const runtime = nodeShippedRuntimeHost()
    expect(runtime.arch).toBe(process.arch)
    expect(runtime.platform).toBe(process.platform)
    await mkdir(join(root, 'runtime'))
    await writeFile(join(root, 'runtime', 'runtime.json'), '{"format":1}')
    await expect(runtime.readTextFile(join(root, 'runtime', 'runtime.json'))).resolves.toBe('{"format":1}')
    await expect(runtime.readTextFile(join(root, 'missing.json'))).resolves.toBeUndefined()
    await expect(runtime.readTextFile(join(root, 'runtime'))).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
