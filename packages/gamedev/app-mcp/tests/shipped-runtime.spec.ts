/**
 * The runtime that the Desktop app ships in a plugin package: its folder, its record, the real host's file reads, and
 * the first-use unpack of a runtime that it ships as its archive.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CommandArgv, CommandOptions, CommandResult } from '../src/setup-host.ts'
import {
  ShippedRuntimeFields, ShippedRuntimePath, findOnPath, findTar, moveIntoPlace, nodeRuntimeUnpackHost, nodeShippedRuntimeHost,
  readPackedRuntime, readShippedRuntime, shippedRuntimeRoot, unpackPackedRuntime, unpackedRuntimeDirectory,
} from '../src/shipped-runtime.ts'
import type { PackedRuntime, RuntimeUnpackHost, ShippedRuntimeHost } from '../src/shipped-runtime.ts'
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

describe('findOnPath and findTar', () => {
  it('finds a program on the absolute PATH entries, with .exe on Windows', async () => {
    const posix = { ...host('linux', 'x64', {}), env: { PATH: 'relative:/opt/a:/opt/b' }, isExecutable: async (file: string) => file === '/opt/b/tar' }
    await expect(findOnPath('tar', posix)).resolves.toBe('/opt/b/tar')
    await expect(findOnPath('uv', posix)).resolves.toBeUndefined()
    const windows = { ...host('win32', 'x64', {}), env: { Path: 'C:\\Tools;tools' }, isExecutable: async (file: string) => file === 'C:\\Tools\\uv.exe' }
    await expect(findOnPath('uv', windows)).resolves.toBe('C:\\Tools\\uv.exe')
    await expect(findOnPath('uv', { ...windows, env: {} })).resolves.toBeUndefined()
  })

  it('uses System32 tar.exe on Windows, and /usr/bin/tar then PATH elsewhere', async () => {
    const executables = new Set(['D:\\Win\\System32\\tar.exe', 'C:\\Windows\\System32\\tar.exe', '/usr/bin/tar', '/opt/tools/tar'])
    const isExecutable = async (file: string): Promise<boolean> => executables.has(file)
    await expect(findTar({ ...host('win32', 'x64', {}), env: { SystemRoot: 'D:\\Win' }, isExecutable })).resolves.toBe('D:\\Win\\System32\\tar.exe')
    await expect(findTar({ ...host('win32', 'x64', {}), env: { windir: 'C:\\Windows' }, isExecutable })).resolves.toBe('C:\\Windows\\System32\\tar.exe')
    await expect(findTar({ ...host('win32', 'x64', {}), env: {}, isExecutable })).resolves.toBe('C:\\Windows\\System32\\tar.exe')
    await expect(findTar({ ...host('win32', 'x64', {}), env: {}, isExecutable: async () => false })).resolves.toBeUndefined()
    await expect(findTar({ ...host('darwin', 'arm64', {}), env: { PATH: '/opt/tools' }, isExecutable })).resolves.toBe('/usr/bin/tar')
    executables.delete('/usr/bin/tar')
    await expect(findTar({ ...host('darwin', 'arm64', {}), env: { PATH: '/opt/tools' }, isExecutable })).resolves.toBe('/opt/tools/tar')
  })
})

/** The archive record and folders of a runtime that a Windows app ships packed, and where it unpacks. */
const PACKED_RUNTIME = { format: 1, version: '3.2.8-wasd.1', platform: 'win32', arch: 'x64', program: 'bin/gimp-console-3.2.exe' }
const PACKED: PackedRuntime<typeof PACKED_RUNTIME> = {
  directory: 'C:\\app\\runtime\\win32-x64', archive: 'C:\\app\\runtime\\win32-x64\\gimp.tar.gz', bytes: 1, sha256: 'a'.repeat(64), record: PACKED_RUNTIME,
}
const DATA = 'C:\\Users\\dev\\.wasdengine\\gimp'
const UNPACKED = `${DATA}\\runtime\\3.2.8-wasd.1`
const PROGRAM = `${UNPACKED}\\bin\\gimp-console-3.2.exe`
const TAR = 'C:\\Windows\\System32\\tar.exe'
const FAILURES = {
  invalid: (directory: string, reason: string) => new Error(`invalid ${directory}: ${reason}`),
  moveFailed: (directory: string, cause: unknown) => new Error(`move ${directory}: ${(cause as Error).message}`),
}

/** A Windows host whose tar unpacks the given runtime.json and the program into the -C folder. */
class FakeUnpackHost implements RuntimeUnpackHost {
  readonly platform: NodeJS.Platform = 'win32'
  readonly arch = 'x64'
  readonly env: NodeJS.ProcessEnv = { SystemRoot: 'C:\\Windows' }
  readonly homeDirectory = 'C:\\Users\\dev'
  readonly files = new Map<string, string>()
  readonly executables = new Set<string>([TAR])
  readonly commands: { argv: CommandArgv; options: CommandOptions }[] = []
  readonly made: string[] = []
  readonly renamed: [string, string][] = []
  readonly removed: string[] = []

  constructor(
    private readonly listing: readonly string[] = ['archive.json', 'gimp.tar.gz'],
    private readonly unpack: (destination: string) => CommandResult = (destination) => {
      this.files.set(`${destination}\\runtime.json`, JSON.stringify({ ...PACKED_RUNTIME, sha256: {} }))
      this.executables.add(`${destination}\\bin\\gimp-console-3.2.exe`)
      return { exitCode: 0, signal: null, output: '' }
    },
    private readonly renaming: (from: string, to: string) => void = () => {},
  ) {}

  async isExecutable(file: string): Promise<boolean> { return this.executables.has(file) }
  async listDirectory(directory: string): Promise<readonly string[]> { return directory === PACKED.directory ? this.listing : [] }
  async readTextFile(file: string): Promise<string | undefined> { return this.files.get(file) }
  async makeDirectory(directory: string): Promise<void> { this.made.push(directory) }
  async rename(from: string, to: string): Promise<void> {
    this.renaming(from, to)
    this.renamed.push([from, to])
    for (const [file, text] of [...this.files]) {
      if (!file.startsWith(`${from}\\`)) continue
      this.files.delete(file)
      this.files.set(to + file.slice(from.length), text)
    }
    for (const file of [...this.executables].filter(file => file.startsWith(`${from}\\`))) {
      this.executables.delete(file)
      this.executables.add(to + file.slice(from.length))
    }
  }

  async remove(target: string): Promise<void> { this.removed.push(target) }
  async run(argv: CommandArgv, options: CommandOptions): Promise<CommandResult> {
    this.commands.push({ argv, options })
    return this.unpack(argv.at(-1)!)
  }
}

describe('unpackPackedRuntime', () => {
  const signal = new AbortController().signal

  it('names the folder under the data root by runtime version', () => {
    expect(unpackedRuntimeDirectory('/data/gimp', '3.2.8-wasd.1', 'darwin')).toBe('/data/gimp/runtime/3.2.8-wasd.1')
    expect(unpackedRuntimeDirectory(DATA, '3.2.8-wasd.1', 'win32')).toBe(UNPACKED)
  })

  it('unpacks the archive with Windows tar beside its final folder once, then reuses it', async () => {
    const host = new FakeUnpackHost()
    const runtime = await unpackPackedRuntime(PACKED, PACKED_RUNTIME.program, DATA, host, signal, FAILURES)
    expect(runtime).toMatchObject({ directory: UNPACKED, unpacked: true })
    expect(runtime.resolve(PACKED_RUNTIME.program)).toBe(PROGRAM)
    const [command] = host.commands
    const partial = command!.argv[4]!
    expect(partial).toMatch(/^C:\\Users\\dev\\\.wasdengine\\gimp\\runtime\\3\.2\.8-wasd\.1\.partial-[0-9a-f]{8}$/u)
    expect(command!.argv).toEqual([TAR, '-xzf', PACKED.archive, '-C', partial])
    expect(command!.options).toEqual({ cwd: DATA, env: host.env, signal })
    expect(host.made).toEqual([`${DATA}\\runtime`, partial])
    expect(host.renamed).toEqual([[partial, UNPACKED]])
    expect(host.removed).toEqual([partial])
    await expect(unpackPackedRuntime(PACKED, PACKED_RUNTIME.program, DATA, host, signal, FAILURES))
      .resolves.toMatchObject({ unpacked: false })
    expect(host.commands).toHaveLength(1)
  })

  it('unpacks again over a folder whose runtime.json is not JSON or describes another runtime', async () => {
    for (const text of ['{', '[]', JSON.stringify({ ...PACKED_RUNTIME, version: '3.2.8-wasd.0' })]) {
      const host = new FakeUnpackHost()
      host.files.set(`${UNPACKED}\\runtime.json`, text)
      host.executables.add(PROGRAM)
      await expect(unpackPackedRuntime(PACKED, PACKED_RUNTIME.program, DATA, host, signal, FAILURES))
        .resolves.toMatchObject({ unpacked: true })
    }
  })

  it('reports a missing archive or tar, a failing tar, and an archive of another runtime, and leaves nothing behind', async () => {
    const other = (destination: string): CommandResult => {
      host.files.set(`${destination}\\runtime.json`, JSON.stringify({ ...PACKED_RUNTIME, version: '3.2.8-wasd.0' }))
      return { exitCode: 0, signal: null, output: '' }
    }
    let host = new FakeUnpackHost()
    const cases: readonly (readonly [() => FakeUnpackHost, RegExp])[] = [
      [() => new FakeUnpackHost(['archive.json']), /its archive\.json names C:\\app\\runtime\\win32-x64\\gimp\.tar\.gz, which is missing$/u],
      [() => {
        const fake = new FakeUnpackHost()
        fake.executables.delete(TAR)
        return fake
      }, /no tar program was found to unpack .*gimp\.tar\.gz; Windows 10 and later have one in System32$/u],
      [() => new FakeUnpackHost(undefined, () => ({ exitCode: 1, signal: null, output: ' tar: Truncated input file\n' })), /tar could not unpack .* \(exit code 1\): tar: Truncated input file$/u],
      [() => new FakeUnpackHost(undefined, () => ({ exitCode: null, signal: 'SIGKILL', output: '' })), /\(signal SIGKILL\): $/u],
      [() => new FakeUnpackHost(undefined, other), /does not describe the runtime 3\.2\.8-wasd\.1 that its archive\.json names$/u],
    ]
    for (const [make, message] of cases) {
      host = make()
      await expect(unpackPackedRuntime(PACKED, PACKED_RUNTIME.program, DATA, host, signal, FAILURES)).rejects.toThrow(message)
      expect(host.renamed).toEqual([])
      expect(host.removed).toEqual(host.commands.length === 0 ? [] : [host.commands[0]!.argv[4]])
    }
  })

  it('reports a runtime it cannot move into place through moveFailed', async () => {
    const host = new FakeUnpackHost(undefined, undefined, () => { throw new Error('read-only file system') })
    await expect(unpackPackedRuntime(PACKED, PACKED_RUNTIME.program, DATA, host, signal, FAILURES))
      .rejects.toThrow(`move ${UNPACKED}: read-only file system`)
  })
})

describe('moveIntoPlace', () => {
  const target = { directory: UNPACKED, program: PROGRAM }
  const failure = (cause: unknown): Error => new Error(`failed: ${(cause as Error).message}`)

  it('accepts a working folder that another server moved into place first', async () => {
    const host: FakeUnpackHost = new FakeUnpackHost(undefined, undefined, () => {
      host.executables.add(PROGRAM)
      throw new Error('directory not empty')
    })
    await expect(moveIntoPlace(host, 'C:\\built', target, failure)).resolves.toBeUndefined()
    expect(host.removed).toEqual([])
  })

  it('moves a broken folder aside, replaces it, and deletes it', async () => {
    let renames = 0
    const host = new FakeUnpackHost(undefined, undefined, () => { if (renames++ === 0) throw new Error('directory not empty') })
    await moveIntoPlace(host, 'C:\\built', target, failure)
    const [[from, stale], [built, to]] = host.renamed as [[string, string], [string, string]]
    expect([from, built, to]).toEqual([UNPACKED, 'C:\\built', UNPACKED])
    expect(stale).toMatch(/\.stale-[0-9a-f-]{36}$/u)
    expect(host.removed).toEqual([stale])
  })

  it('reports the first rename when nothing can be moved aside, and the retry when it fails', async () => {
    const stuck = new FakeUnpackHost(undefined, undefined, () => { throw new Error('busy') })
    await expect(moveIntoPlace(stuck, 'C:\\built', target, failure)).rejects.toThrow('failed: busy')
    let renames = 0
    const retry = new FakeUnpackHost(undefined, undefined, () => { if (renames++ !== 1) throw new Error(renames === 1 ? 'directory not empty' : 'disk full') })
    await expect(moveIntoPlace(retry, 'C:\\built', target, failure)).rejects.toThrow('failed: disk full')
    expect(retry.removed).toHaveLength(1)
    renames = 0
    const raced: FakeUnpackHost = new FakeUnpackHost(undefined, undefined, () => {
      renames++
      if (renames === 3) raced.executables.add(PROGRAM)
      if (renames !== 2) throw new Error('directory not empty')
    })
    await expect(moveIntoPlace(raced, 'C:\\built', target, failure)).resolves.toBeUndefined()
  })
})

describe('nodeRuntimeUnpackHost', () => {
  it('lists, creates, renames, and removes directories', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-unpack-')
    const host = nodeRuntimeUnpackHost(1024)
    const made = join(root, 'a', 'b')
    await host.makeDirectory(made)
    await host.rename(made, join(root, 'a', 'c'))
    await expect(readdir(join(root, 'a'))).resolves.toEqual(['c'])
    await host.remove(join(root, 'a'))
    await host.remove(join(root, 'a'))
    await expect(host.listDirectory(join(root, 'a'))).resolves.toEqual([])
    await expect(host.run([process.execPath, '-e', 'process.stdout.write("0123456789")'], { cwd: root, env: process.env, signal: new AbortController().signal }))
      .resolves.toEqual({ exitCode: 0, signal: null, output: '0123456789' })
  })

  it.skipIf(process.platform === 'win32')('unpacks a packed runtime with the real tar once, and reuses the unpacked folder', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-unpack-')
    const runtime = { ...PACKED_RUNTIME, platform: process.platform, arch: process.arch, program: 'bin/gimp-console-3.2' }
    const content = join(root, 'content')
    await mkdir(join(content, 'bin'), { recursive: true })
    await writeFile(join(content, 'bin', 'gimp-console-3.2'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(content, 'runtime.json'), JSON.stringify({ ...runtime, sha256: {} }))
    const packedFolder = join(root, 'pkg', 'runtime', `${process.platform}-${process.arch}`)
    await mkdir(packedFolder, { recursive: true })
    execFileSync('tar', ['-czf', join(packedFolder, 'runtime.tar.gz'), '-C', content, 'bin', 'runtime.json'])
    await writeFile(join(packedFolder, 'archive.json'), JSON.stringify({ format: 1, archive: 'runtime.tar.gz', bytes: 1, sha256: 'c'.repeat(64), runtime }))
    const host = nodeRuntimeUnpackHost(4096)
    const dataRoot = join(root, 'data ü')
    const packed = (await readPackedRuntime(join(root, 'pkg', 'runtime'), host, Record, invalid))!
    const directory = join(dataRoot, 'runtime', '3.2.8-wasd.1')
    const unpacked = await unpackPackedRuntime(packed, runtime.program, dataRoot, host, new AbortController().signal, FAILURES)
    expect(unpacked).toMatchObject({ directory, unpacked: true })
    await expect(readdir(join(dataRoot, 'runtime'))).resolves.toEqual(['3.2.8-wasd.1'])
    await expect(host.isExecutable(unpacked.resolve(runtime.program))).resolves.toBe(true)
    await expect(unpackPackedRuntime(packed, runtime.program, dataRoot, host, new AbortController().signal, FAILURES))
      .resolves.toMatchObject({ unpacked: false })
  })
})
