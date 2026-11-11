/** Worker environment resolution: executable search, bpy preparation, backend choice, and worker start. */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerError, findOnPath, runCommand, unpackedRuntimeDirectory } from '@deepseek-ai/dsh-app-mcp'
import type { CommandArgv, CommandOptions, CommandResult, WorkerReady } from '@deepseek-ai/dsh-app-mcp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BlenderSetupError, BlenderWorkers, bpyEnvironment, childEnvironment, findBlender, findPackedBpy, findShippedBpy, findUv,
  nodeBlenderSetupHost, parseServerOptions, prepareBpy, resolveWorkerLaunch, unpackShippedBpy,
} from '../src/environment.ts'
import type { BlenderSetupHost, BlenderWorkerDependencies } from '../src/environment.ts'
import type { BlenderServerOptions } from '../src/types.ts'

const OPTIONS: BlenderServerOptions = {
  dataRoot: '/data/blender', backend: 'auto', bpyVersion: '5.2.3', pythonVersion: '3.13', uvPath: '', blenderPath: '',
  startupTimeoutMs: 30_000, requestTimeoutMs: 600_000, toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
  maxWorkers: 4, workerMemoryBytes: 0, workerCores: 0, minAvailableMemoryBytes: 0, workerIdleTimeoutMs: 600_000,
}
const VENV = '/data/blender/venv-py3.13-bpy5.2.3'
const VENV_PYTHON = `${VENV}/bin/python`
const APP = '/Applications/Blender.app/Contents/MacOS/Blender'
const SCRIPT = '/data/blender/payload/abc/wasd_blender_worker.py'
/** The package's `runtime` folder, and the bpy runtime that a Desktop app ships in it for macOS on Apple silicon. */
const BUNDLED = '/app/dsh-blender/runtime'
const SHIPPED = `${BUNDLED}/darwin-arm64`
const SHIPPED_PYTHON = `${SHIPPED}/python/bin/python3.13`
const SHIPPED_RECORD = {
  format: 1, version: '5.2.3-wasd.1', bpy: '5.2.3', python: '3.13.18', platform: 'darwin', arch: 'arm64',
  executable: 'python/bin/python3.13', sha256: {},
}

interface FakeHostOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  executables?: readonly string[]
  directories?: Readonly<Record<string, readonly string[]>>
  /** Text files by absolute path. */
  files?: Readonly<Record<string, string>>
  run?: (argv: CommandArgv, options: CommandOptions) => CommandResult | Promise<CommandResult>
  rename?: (from: string, to: string) => void
}

/** A host whose package ships the bpy runtime, with the record changed as given. */
function shippedHost(record: object = SHIPPED_RECORD, executables: readonly string[] = [SHIPPED_PYTHON]): FakeHost {
  return new FakeHost({ executables, files: { [`${SHIPPED}/runtime.json`]: JSON.stringify(record) } })
}

class FakeHost implements BlenderSetupHost {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly env: NodeJS.ProcessEnv
  readonly homeDirectory: string
  readonly executables: Set<string>
  readonly files: Map<string, string>
  readonly commands: { argv: CommandArgv; options: CommandOptions }[] = []
  readonly made: string[] = []
  readonly renamed: [string, string][] = []
  readonly removed: string[] = []

  constructor(private readonly options: FakeHostOptions = {}) {
    this.platform = options.platform ?? 'darwin'
    this.arch = options.arch ?? 'arm64'
    this.env = options.env ?? { PATH: '/usr/bin:/bin' }
    this.homeDirectory = this.platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev'
    this.executables = new Set(options.executables ?? [])
    this.files = new Map(Object.entries(options.files ?? {}))
  }

  async isExecutable(file: string): Promise<boolean> { return this.executables.has(file) }
  async listDirectory(directory: string): Promise<readonly string[]> { return this.options.directories?.[directory] ?? [] }
  async readTextFile(file: string): Promise<string | undefined> { return this.files.get(file) }
  async makeDirectory(directory: string): Promise<void> { this.made.push(directory) }
  /** Renames move the files and executables below `from`; a renamed folder also gets a venv Python. */
  async rename(from: string, to: string): Promise<void> {
    this.options.rename?.(from, to)
    this.renamed.push([from, to])
    const below = (file: string): boolean => file.startsWith(`${from}/`) || file.startsWith(`${from}\\`)
    for (const [file, text] of [...this.files]) {
      if (!below(file)) continue
      this.files.delete(file)
      this.files.set(to + file.slice(from.length), text)
    }
    for (const file of [...this.executables].filter(below)) {
      this.executables.delete(file)
      this.executables.add(to + file.slice(from.length))
    }
    this.executables.add(`${to}/bin/python`)
  }

  async remove(target: string): Promise<void> { this.removed.push(target) }
  async run(argv: CommandArgv, options: CommandOptions): Promise<CommandResult> {
    this.commands.push({ argv, options })
    return await (this.options.run?.(argv, options) ?? { exitCode: 0, signal: null, output: '' })
  }
}

const signal = new AbortController().signal

/** The bpy runtime that a Windows Desktop app ships as its archive, and the folder under `dataRoot` it unpacks into. */
const WIN_BUNDLED = 'C:\\app\\dsh-blender\\runtime'
const WIN_PACKED = `${WIN_BUNDLED}\\win32-x64`
const WIN_ARCHIVE = `${WIN_PACKED}\\blender-5.2.3-wasd.1-win32-x64.tar.gz`
const WIN_DATA = 'C:\\Users\\dev\\.wasdengine\\blender'
const WIN_UNPACKED = `${WIN_DATA}\\runtime\\5.2.3-wasd.1`
const WIN_PYTHON = `${WIN_UNPACKED}\\python\\python.exe`
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe'
const WIN_RUNTIME = { format: 1, version: '5.2.3-wasd.1', bpy: '5.2.3', python: '3.13.18', platform: 'win32', arch: 'x64', executable: 'python/python.exe' }
const WIN_OPTIONS: BlenderServerOptions = { ...OPTIONS, dataRoot: WIN_DATA }

interface PackedHostOptions {
  /** The runtime fields of archive.json. */
  readonly runtime?: object
  /** The runtime.json that tar unpacks. */
  readonly unpacked?: object
  /** Whether System32 holds tar.exe. */
  readonly tar?: boolean
  /** Whether the package folder lists the archive. */
  readonly archive?: boolean
  readonly executables?: readonly string[]
  readonly run?: FakeHostOptions['run']
  readonly rename?: FakeHostOptions['rename']
}

/** A Windows host whose package ships the bpy runtime's archive; its tar unpacks runtime.json and python.exe into the -C folder. */
function packedHost(options: PackedHostOptions = {}): FakeHost {
  const unpack: FakeHostOptions['run'] = (argv) => {
    const destination = argv.at(-1)!
    host.files.set(`${destination}\\runtime.json`, JSON.stringify({ ...options.unpacked ?? WIN_RUNTIME, sha256: {} }))
    host.executables.add(`${destination}\\python\\python.exe`)
    return { exitCode: 0, signal: null, output: '' }
  }
  const host: FakeHost = new FakeHost({
    platform: 'win32', arch: 'x64', env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    executables: [...options.tar ?? true ? [WIN_TAR] : [], ...options.executables ?? []],
    directories: { [WIN_PACKED]: ['archive.json', ...options.archive ?? true ? ['blender-5.2.3-wasd.1-win32-x64.tar.gz'] : []] },
    files: {
      [`${WIN_PACKED}\\archive.json`]: JSON.stringify({
        format: 1, archive: 'blender-5.2.3-wasd.1-win32-x64.tar.gz', bytes: 361_000_000, sha256: 'a'.repeat(64), runtime: options.runtime ?? WIN_RUNTIME,
      }),
    },
    run: options.run ?? unpack,
    ...options.rename === undefined ? {} : { rename: options.rename },
  })
  return host
}

/** What the server hands `BlenderWorkers`: the host, the worker script copy, the package's runtime folder, and the start. */
function workerDependencies<W extends { readonly ready: WorkerReady }>(
  host: FakeHost, start: BlenderWorkerDependencies<W>['start'],
): BlenderWorkerDependencies<W> {
  return { host, workerScript: async () => SCRIPT, bundledRoot: BUNDLED, start }
}

/** The worker scope the pool would pass: a Session and its numbered folder. */
const SCOPE = { key: 'session:spec', directory: '/data/blender/workers/1' }

describe('parseServerOptions', () => {
  it('accepts the options the plugin sends and names invalid fields', () => {
    expect(parseServerOptions({ ...OPTIONS })).toEqual(OPTIONS)
    expect(() => parseServerOptions({ ...OPTIONS, backend: 'gpu' })).toThrow(/^Blender MCP server options are invalid[\s\S]*backend/)
    expect(() => parseServerOptions({ ...OPTIONS, bpyVersion: 'latest' })).toThrow(/bpyVersion/)
    expect(() => parseServerOptions({ ...OPTIONS, startupTimeoutMs: 0 })).toThrow(/startupTimeoutMs/)
    expect(() => parseServerOptions({ ...OPTIONS, graceMs: 0 })).toThrow(/graceMs/)
    expect(() => parseServerOptions({ ...OPTIONS, extra: true })).toThrow(/extra/)
  })
})

describe('findOnPath', () => {
  it('searches absolute PATH entries in order and skips relative ones', async () => {
    const host = new FakeHost({ env: { PATH: 'relative/bin:/opt/a:/opt/b' }, executables: ['relative/bin/uv', '/opt/b/uv'] })
    await expect(findOnPath('uv', host)).resolves.toBe('/opt/b/uv')
  })

  it('reads Path on Windows, adds .exe, and returns undefined without a match', async () => {
    const host = new FakeHost({ platform: 'win32', env: { Path: 'C:\\Tools;C:\\uv' }, executables: ['C:\\uv\\uv.exe'] })
    await expect(findOnPath('uv', host)).resolves.toBe('C:\\uv\\uv.exe')
    await expect(findOnPath('uv', new FakeHost({ env: {} }))).resolves.toBeUndefined()
  })
})

describe('findUv', () => {
  it('uses a configured uvPath and rejects one that is not executable', async () => {
    const host = new FakeHost({ executables: ['/custom/uv'] })
    await expect(findUv({ uvPath: '/custom/uv' }, host)).resolves.toBe('/custom/uv')
    const missing = findUv({ uvPath: '/missing/uv' }, host)
    await expect(missing).rejects.toBeInstanceOf(BlenderSetupError)
    await expect(missing).rejects.toMatchObject({ code: 'UV_NOT_FOUND', message: expect.stringContaining('/missing/uv') as string })
  })

  it('prefers PATH, then the installer locations', async () => {
    await expect(findUv({ uvPath: '' }, new FakeHost({ executables: ['/usr/bin/uv', '/opt/homebrew/bin/uv'] }))).resolves.toBe('/usr/bin/uv')
    await expect(findUv({ uvPath: '' }, new FakeHost({ executables: ['/opt/homebrew/bin/uv', '/usr/local/bin/uv'] }))).resolves.toBe('/opt/homebrew/bin/uv')
    await expect(findUv({ uvPath: '' }, new FakeHost({ executables: ['/Users/dev/.local/bin/uv'] }))).resolves.toBe('/Users/dev/.local/bin/uv')
    await expect(findUv({ uvPath: '' }, new FakeHost({ executables: ['/usr/local/bin/uv'] }))).resolves.toBe('/usr/local/bin/uv')
    const windows = new FakeHost({ platform: 'win32', env: {}, executables: ['C:\\Users\\dev\\.local\\bin\\uv.exe'] })
    await expect(findUv({ uvPath: '' }, windows)).resolves.toBe('C:\\Users\\dev\\.local\\bin\\uv.exe')
    await expect(findUv({ uvPath: '' }, new FakeHost())).resolves.toBeUndefined()
  })
})

describe('findBlender', () => {
  it('uses blenderPath, then BLENDER_PATH, and rejects either when not executable', async () => {
    const host = new FakeHost({ env: { BLENDER_PATH: '/env/blender' }, executables: ['/custom/blender', '/env/blender', APP] })
    await expect(findBlender({ blenderPath: '/custom/blender' }, host)).resolves.toBe('/custom/blender')
    await expect(findBlender({ blenderPath: '' }, host)).resolves.toBe('/env/blender')
    await expect(findBlender({ blenderPath: '/nope' }, host)).rejects.toMatchObject({ code: 'BLENDER_NOT_FOUND', message: expect.stringContaining('blenderPath') as string })
    const broken = new FakeHost({ env: { BLENDER_PATH: '/gone' }, executables: [APP] })
    await expect(findBlender({ blenderPath: '' }, broken)).rejects.toMatchObject({ code: 'BLENDER_NOT_FOUND', message: expect.stringContaining('BLENDER_PATH') as string })
  })

  it('finds the macOS application bundle in /Applications or ~/Applications before PATH', async () => {
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ env: { BLENDER_PATH: '', PATH: '/usr/bin' }, executables: [APP, '/usr/bin/blender'] })))
      .resolves.toBe(APP)
    const personal = '/Users/dev/Applications/Blender.app/Contents/MacOS/Blender'
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ executables: [personal, '/usr/bin/blender'] }))).resolves.toBe(personal)
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ executables: ['/usr/bin/blender'] }))).resolves.toBe('/usr/bin/blender')
  })

  it('searches PATH on Linux and reports nothing when Blender is absent', async () => {
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ platform: 'linux', executables: [APP, '/bin/blender'] }))).resolves.toBe('/bin/blender')
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ platform: 'linux', executables: [APP] }))).resolves.toBeUndefined()
  })

  it('picks the newest Windows installation under Program Files', async () => {
    const root = 'D:\\Apps\\Blender Foundation'
    const host = new FakeHost({
      platform: 'win32', env: { ProgramFiles: 'D:\\Apps' },
      directories: { [root]: ['Blender 4.2', 'Blender', 'Blender 4.10', 'Blender 4.10.1', 'blender', 'Other', 'Blender 3'] },
      executables: [`${root}\\Blender 4.2\\blender.exe`, `${root}\\Blender 4.10\\blender.exe`, `${root}\\Blender\\blender.exe`],
    })
    await expect(findBlender({ blenderPath: '' }, host)).resolves.toBe(`${root}\\Blender 4.10\\blender.exe`)
    const onPath = new FakeHost({ platform: 'win32', env: { PATH: 'C:\\bin' }, executables: ['C:\\bin\\blender.exe'] })
    await expect(findBlender({ blenderPath: '' }, onPath)).resolves.toBe('C:\\bin\\blender.exe')
    const standard = new FakeHost({
      platform: 'win32', env: {},
      directories: { 'C:\\Program Files\\Blender Foundation': ['Blender 5.2'] },
      executables: ['C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'],
    })
    await expect(findBlender({ blenderPath: '' }, standard)).resolves.toBe('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe')
    await expect(findBlender({ blenderPath: '' }, new FakeHost({ platform: 'win32', env: {} }))).resolves.toBeUndefined()
  })
})

describe('bpyEnvironment and childEnvironment', () => {
  it('lays out the managed environment per platform', () => {
    expect(bpyEnvironment(OPTIONS, 'linux')).toEqual({ directory: VENV, python: VENV_PYTHON })
    expect(bpyEnvironment({ ...OPTIONS, dataRoot: 'C:\\data' }, 'win32'))
      .toEqual({ directory: 'C:\\data\\venv-py3.13-bpy5.2.3', python: 'C:\\data\\venv-py3.13-bpy5.2.3\\Scripts\\python.exe' })
  })

  it('drops variables that redirect Python or Electron', () => {
    const env = { PATH: '/bin', HOME: '/home', PYTHONPATH: 'x', PYTHONHOME: 'y', PYTHONSTARTUP: 'z', VIRTUAL_ENV: 'v', ELECTRON_RUN_AS_NODE: '1' }
    expect(childEnvironment(env)).toEqual({ PATH: '/bin', HOME: '/home' })
    expect(env.PYTHONPATH).toBe('x')
  })
})

describe('findShippedBpy', () => {
  it('reads the runtime of this platform and its Python', async () => {
    await expect(findShippedBpy(BUNDLED, shippedHost())).resolves.toEqual({ directory: SHIPPED, python: SHIPPED_PYTHON, bpy: '5.2.3' })
    await expect(findShippedBpy(BUNDLED, new FakeHost())).resolves.toBeUndefined()
    const intel = new FakeHost({ arch: 'x64', executables: [SHIPPED_PYTHON], files: { [`${SHIPPED}/runtime.json`]: JSON.stringify(SHIPPED_RECORD) } })
    await expect(findShippedBpy(BUNDLED, intel)).resolves.toBeUndefined()
  })

  it('reports a runtime that cannot run, with how to recover', async () => {
    const cases: readonly (readonly [FakeHost, RegExp])[] = [
      [shippedHost(SHIPPED_RECORD, []), /python3\.13 is not an executable file\. Reinstall WASD Engine, or set .* backend to app/u],
      [shippedHost({ ...SHIPPED_RECORD, arch: 'x64' }), /its runtime\.json describes darwin-x64/u],
      [shippedHost({ ...SHIPPED_RECORD, bpy: 'latest' }), /is not a format 1 runtime record/u],
      [shippedHost({ ...SHIPPED_RECORD, executable: '/usr/bin/python3' }), /must be a relative path inside the runtime folder/u],
      [new FakeHost({ files: { [`${SHIPPED}/runtime.json`]: '{' } }), /runtime\.json is not JSON/u],
    ]
    for (const [host, message] of cases) {
      const failure = findShippedBpy(BUNDLED, host)
      await expect(failure).rejects.toBeInstanceOf(BlenderSetupError)
      await expect(failure).rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID', message: expect.stringMatching(message) as string })
    }
  })
})

describe('findPackedBpy and unpackShippedBpy', () => {
  it('reads the archive that the Windows app ships', async () => {
    await expect(findPackedBpy(WIN_BUNDLED, packedHost())).resolves.toEqual({
      directory: WIN_PACKED, archive: WIN_ARCHIVE, bytes: 361_000_000, sha256: 'a'.repeat(64), record: WIN_RUNTIME,
    })
    await expect(findPackedBpy(BUNDLED, new FakeHost())).resolves.toBeUndefined()
    expect(unpackedRuntimeDirectory('/data/blender', '5.2.3-wasd.1', 'darwin')).toBe('/data/blender/runtime/5.2.3-wasd.1')
  })

  it('unpacks the archive with Windows tar beside its final folder once, then reuses it', async () => {
    const host = packedHost()
    const packed = (await findPackedBpy(WIN_BUNDLED, host))!
    await expect(unpackShippedBpy(packed, WIN_DATA, host, signal)).resolves.toEqual({ directory: WIN_UNPACKED, python: WIN_PYTHON, bpy: '5.2.3', unpacked: true })
    const [command] = host.commands
    const partial = command!.argv[4]!
    expect(partial).toMatch(/^C:\\Users\\dev\\\.wasdengine\\blender\\runtime\\5\.2\.3-wasd\.1\.partial-[0-9a-f]{8}$/u)
    expect(command!.argv).toEqual([WIN_TAR, '-xzf', WIN_ARCHIVE, '-C', partial])
    expect(command!.options).toMatchObject({ cwd: WIN_DATA, signal })
    expect(host.made).toEqual([`${WIN_DATA}\\runtime`, partial])
    expect(host.renamed).toEqual([[partial, WIN_UNPACKED]])
    expect(host.removed).toEqual([partial])
    await expect(unpackShippedBpy(packed, WIN_DATA, host, signal)).resolves.toMatchObject({ unpacked: false })
    expect(host.commands).toHaveLength(1)
  })

  it('reports a missing archive or tar, a failing tar, and an archive of another runtime, and leaves nothing behind', async () => {
    const cases: readonly (readonly [PackedHostOptions, RegExp])[] = [
      [{ archive: false }, /its archive\.json names C:\\.*\.tar\.gz, which is missing/u],
      [{ tar: false }, /cannot run: no tar program was found to unpack C:\\.*\.tar\.gz; Windows 10 and later have one in System32\. /u],
      [{ run: () => ({ exitCode: 1, signal: null, output: 'tar: Truncated input file\n' }) }, /tar could not unpack .* \(exit code 1\): tar: Truncated input file/u],
      [{ unpacked: { ...WIN_RUNTIME, version: '5.2.3-wasd.0' } }, /does not describe the runtime 5\.2\.3-wasd\.1 that its archive\.json names/u],
    ]
    for (const [options, message] of cases) {
      const host = packedHost(options)
      const failure = unpackShippedBpy((await findPackedBpy(WIN_BUNDLED, host))!, WIN_DATA, host, signal)
      await expect(failure).rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID', message: expect.stringMatching(message) as string })
      expect(host.renamed).toEqual([])
      expect(host.removed).toEqual(host.commands.length === 0 ? [] : [host.commands[0]!.argv[4]])
    }
  })

  it('reports an unpacked runtime that cannot be moved into place as an install failure', async () => {
    const host = packedHost({ rename: () => { throw new Error('access denied') } })
    await expect(unpackShippedBpy((await findPackedBpy(WIN_BUNDLED, host))!, WIN_DATA, host, signal)).rejects.toMatchObject({
      code: 'BPY_INSTALL_FAILED', message: `Could not move the new bpy runtime to ${WIN_UNPACKED}: access denied. Remove that folder, then call the tool again.`,
    })
  })

  it('looks for tar in /usr/bin, then on PATH, outside Windows', async () => {
    const record = { ...WIN_RUNTIME, platform: 'darwin', arch: 'arm64', executable: 'python/bin/python3.13' }
    const host = new FakeHost({
      env: { PATH: '/opt/tools' }, executables: ['/opt/tools/tar'],
      directories: { [SHIPPED]: ['archive.json', 'blender.tar.gz'] },
      files: { [`${SHIPPED}/archive.json`]: JSON.stringify({ format: 1, archive: 'blender.tar.gz', bytes: 1, sha256: 'b'.repeat(64), runtime: record }) },
      run: () => ({ exitCode: 2, signal: null, output: '' }),
    })
    await expect(unpackShippedBpy((await findPackedBpy(BUNDLED, host))!, '/data/blender', host, signal)).rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID' })
    expect(host.commands[0]!.argv[0]).toBe('/opt/tools/tar')
  })
})

describe('prepareBpy', () => {
  it('reuses an existing environment without running uv', async () => {
    const host = new FakeHost({ executables: [VENV_PYTHON] })
    await expect(prepareBpy('/uv', OPTIONS, host, signal)).resolves.toEqual({ python: VENV_PYTHON, installed: false })
    expect(host.commands).toEqual([])
  })

  it('builds the environment beside its final path with managed Python, then renames it into place', async () => {
    const host = new FakeHost({ env: { PATH: '/bin', PYTHONPATH: '/elsewhere' } })
    await expect(prepareBpy('/uv', OPTIONS, host, signal)).resolves.toEqual({ python: VENV_PYTHON, installed: true })
    const [venv, install] = host.commands
    const partial = venv!.argv[6]!
    expect(partial).toMatch(new RegExp(`^${VENV}\\.partial-[0-9a-f-]{36}$`))
    expect(venv!.argv).toEqual(['/uv', 'venv', '--managed-python', '--no-progress', '--python', '3.13', partial])
    expect(install!.argv).toEqual(['/uv', 'pip', 'install', '--no-progress', '--python', `${partial}/bin/python`, 'bpy==5.2.3'])
    expect(venv!.options).toMatchObject({ cwd: '/data/blender', env: { PATH: '/bin', UV_PYTHON_INSTALL_DIR: '/data/blender/uv-python' }, signal })
    expect(venv!.options.env.PYTHONPATH).toBeUndefined()
    expect(host.made).toEqual(['/data/blender'])
    expect(host.renamed).toEqual([[partial, VENV]])
    expect(host.removed).toEqual([partial])
  })

  it('reports uv failures with their output and removes the partial environment', async () => {
    const failing = new FakeHost({ run: () => ({ exitCode: 2, signal: null, output: '  error: no Python 3.13 download  \n' }) })
    const venv = prepareBpy('/uv', OPTIONS, failing, signal)
    await expect(venv).rejects.toMatchObject({
      code: 'BPY_INSTALL_FAILED',
      message: 'Could not create a Python 3.13 environment: uv venv --managed-python failed with exit code 2.\nerror: no Python 3.13 download',
    })
    expect(failing.removed).toHaveLength(1)
    const killed = new FakeHost({ run: argv => argv[1] === 'pip' ? { exitCode: null, signal: 'SIGKILL', output: '' } : { exitCode: 0, signal: null, output: '' } })
    await expect(prepareBpy('/uv', OPTIONS, killed, signal)).rejects.toThrow('Could not install bpy 5.2.3: uv pip install failed with signal SIGKILL.')
    expect(killed.renamed).toEqual([])
  })

  it('accepts an environment another installer renamed into place first', async () => {
    const host = new FakeHost({ rename: () => { host.executables.add(VENV_PYTHON); throw Object.assign(new Error('exists'), { code: 'ENOTEMPTY' }) } })
    await expect(prepareBpy('/uv', OPTIONS, host, signal)).resolves.toEqual({ python: VENV_PYTHON, installed: true })
    expect(host.renamed).toEqual([])
  })

  it('replaces a directory at the final path whose Python is not executable', async () => {
    let renames = 0
    const host = new FakeHost({ rename: () => { if (renames++ === 0) throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' }) } })
    await expect(prepareBpy('/uv', OPTIONS, host, signal)).resolves.toEqual({ python: VENV_PYTHON, installed: true })
    const [[from, stale], [partial, target]] = host.renamed as [[string, string], [string, string]]
    expect([from, target]).toEqual([VENV, VENV])
    expect(stale).toMatch(new RegExp(`^${VENV}\\.stale-[0-9a-f-]{36}$`))
    expect(partial).toMatch(new RegExp(`^${VENV}\\.partial-[0-9a-f-]{36}$`))
    expect(host.removed).toEqual([stale, partial])
  })

  it('reports an environment it cannot move into place as an install failure', async () => {
    const lost = new FakeHost({ rename: () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }) } })
    await expect(prepareBpy('/uv', OPTIONS, lost, signal)).rejects.toMatchObject({
      code: 'BPY_INSTALL_FAILED',
      message: `Could not move the new bpy environment to ${VENV}: read-only file system. Remove that folder, then call the tool again.`,
    })
    expect(lost.removed).toHaveLength(1)
    let renames = 0
    const retry = new FakeHost({ rename: () => { if (renames++ !== 1) throw new Error(renames === 1 ? 'directory not empty' : 'disk full') } })
    await expect(prepareBpy('/uv', OPTIONS, retry, signal)).rejects.toMatchObject({ code: 'BPY_INSTALL_FAILED', message: expect.stringContaining(': disk full.') as string })
    expect(retry.removed).toHaveLength(2)
    renames = 0
    const raced = new FakeHost({
      rename: () => {
        if (renames++ === 1) return
        if (renames === 3) raced.executables.add(VENV_PYTHON)
        throw new Error('directory not empty')
      },
    })
    await expect(prepareBpy('/uv', OPTIONS, raced, signal)).resolves.toEqual({ python: VENV_PYTHON, installed: true })
    const odd = new FakeHost({ rename: () => { throw 'locked' } })
    await expect(prepareBpy('/uv', OPTIONS, odd, signal)).rejects.toMatchObject({ code: 'BPY_INSTALL_FAILED', message: expect.stringContaining(': locked.') as string })
  })

  it('repairs a real environment whose Python link dangles', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-blender-stale-'))
    try {
      const options = { ...OPTIONS, dataRoot }
      const { directory, python } = bpyEnvironment(options, process.platform)
      await mkdir(join(directory, 'bin'), { recursive: true })
      await writeFile(join(directory, 'pyvenv.cfg'), 'home = /removed/uv-python/bin\n')
      await symlink(join(dataRoot, 'uv-python', 'removed', 'python3.13'), python)
      const host: BlenderSetupHost = {
        ...nodeBlenderSetupHost(1024),
        async run(argv) {
          if (argv[1] === 'venv') {
            const partial = argv.at(-1)!
            await mkdir(join(partial, 'bin'), { recursive: true })
            await writeFile(join(partial, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
          }
          return { exitCode: 0, signal: null, output: '' }
        },
      }
      await expect(prepareBpy('/uv', options, host, signal)).resolves.toEqual({ python, installed: true })
      await expect(host.isExecutable(python)).resolves.toBe(true)
      expect(await readdir(dataRoot)).toEqual(['venv-py3.13-bpy5.2.3'])
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('resolveWorkerLaunch', () => {
  const uvHost = (options: FakeHostOptions = {}): FakeHost => new FakeHost({ executables: ['/usr/bin/uv', ...options.executables ?? []], ...options.run ? { run: options.run } : {} })
  const failingInstall: FakeHostOptions['run'] = () => ({ exitCode: 1, signal: null, output: 'no wheel for this platform' })

  it('runs the bpy module with an isolated, unbuffered Python and reports a first-use install', async () => {
    const host = uvHost()
    const launch = await resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, host, signal)
    expect(launch).toEqual({
      backend: 'bpy', shipped: false, argv: [VENV_PYTHON, '-I', '-u', SCRIPT], env: { PATH: '/usr/bin:/bin' },
      notes: [`Installed Python 3.13 and bpy 5.2.3 into ${VENV} (first use).`],
      repair: `If the bpy environment at ${VENV} is damaged, delete that folder so that the next start installs it again.`,
    })
    expect((await resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, host, signal)).notes).toEqual([])
  })

  it('runs the shipped bpy runtime first, without uv and without writing bytecode into it', async () => {
    for (const backend of ['auto', 'bpy'] as const) {
      const host = shippedHost(SHIPPED_RECORD, [SHIPPED_PYTHON, '/usr/bin/uv', APP])
      await expect(resolveWorkerLaunch({ ...OPTIONS, backend }, SCRIPT, BUNDLED, host, signal)).resolves.toEqual({
        backend: 'bpy', shipped: true, argv: [SHIPPED_PYTHON, '-I', '-B', '-u', SCRIPT], env: { PATH: '/usr/bin:/bin' }, notes: [],
        repair: `If the bpy runtime that WASD Engine ships in ${SHIPPED} is damaged, reinstall WASD Engine.`,
      })
      expect(host.commands).toEqual([])
    }
  })

  it('passes over the shipped runtime for another bpyVersion and for the app backend', async () => {
    const other = shippedHost(SHIPPED_RECORD, [SHIPPED_PYTHON, '/usr/bin/uv'])
    const managed = await resolveWorkerLaunch({ ...OPTIONS, bpyVersion: '5.3.0' }, SCRIPT, BUNDLED, other, signal)
    expect(managed).toMatchObject({ backend: 'bpy', argv: ['/data/blender/venv-py3.13-bpy5.3.0/bin/python', '-I', '-u', SCRIPT] })
    expect(managed.shipped).toBe(false)
    const app = shippedHost({ ...SHIPPED_RECORD, arch: 'x64' }, [SHIPPED_PYTHON, APP])
    await expect(resolveWorkerLaunch({ ...OPTIONS, backend: 'app' }, SCRIPT, BUNDLED, app, signal)).resolves.toMatchObject({ backend: 'app', argv: [APP, '--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', SCRIPT] })
    await expect(resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, app, signal)).rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID' })
  })

  it('unpacks and runs the archive that the Windows app ships, which keeps its bytecode caches under dataRoot', async () => {
    const host = packedHost({ executables: ['C:\\Users\\dev\\.local\\bin\\uv.exe'] })
    await expect(resolveWorkerLaunch(WIN_OPTIONS, SCRIPT, WIN_BUNDLED, host, signal)).resolves.toEqual({
      backend: 'bpy', shipped: true, argv: [WIN_PYTHON, '-I', '-u', SCRIPT], env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
      notes: [`Unpacked the bpy runtime that WASD Engine ships into ${WIN_UNPACKED} (first use).`],
      repair: `If the bpy runtime that WASD Engine unpacked into ${WIN_UNPACKED} is damaged, delete that folder so that the next start unpacks it again.`,
    })
    expect((await resolveWorkerLaunch(WIN_OPTIONS, SCRIPT, WIN_BUNDLED, host, signal)).notes).toEqual([])
    expect(host.commands.map(command => command.argv[0])).toEqual([WIN_TAR])
  })

  it('falls back to an installed Blender under auto when the archive does not unpack, and fails for the bpy backend', async () => {
    const blender = 'C:\\Blender\\blender.exe'
    const failing = (): FakeHost => packedHost({ executables: [blender], run: () => ({ exitCode: 1, signal: null, output: 'tar: Error opening archive' }) })
    const launch = await resolveWorkerLaunch({ ...WIN_OPTIONS, blenderPath: blender }, SCRIPT, WIN_BUNDLED, failing(), signal)
    expect(launch).toMatchObject({ backend: 'app', shipped: false, repair: '' })
    expect(launch.notes).toHaveLength(1)
    expect(launch.notes[0]).toMatch(/^The bpy runtime that WASD Engine ships could not be unpacked, so Blender at /u)
    expect(launch.notes[0]).toContain(`${blender} runs the tools instead. The bpy runtime shipped in ${WIN_PACKED} cannot run: tar could not unpack`)
    await expect(resolveWorkerLaunch({ ...WIN_OPTIONS, backend: 'bpy', blenderPath: blender }, SCRIPT, WIN_BUNDLED, failing(), signal))
      .rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID' })
    await expect(resolveWorkerLaunch(WIN_OPTIONS, SCRIPT, WIN_BUNDLED, failing(), signal)).rejects.toMatchObject({ code: 'BLENDER_RUNTIME_INVALID' })
  })

  it('falls back to an installed Blender when auto cannot install bpy', async () => {
    const launch = await resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, uvHost({ executables: [APP], run: failingInstall }), signal)
    expect(launch.backend).toBe('app')
    expect(launch.argv).toEqual([APP, '--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', SCRIPT])
    const fallback = /^The bpy module could not be installed, so Blender at .* runs the tools instead\. Could not create/
    expect(launch.notes).toEqual([expect.stringMatching(fallback) as string])
  })

  it('adds installation help when auto has neither bpy nor Blender', async () => {
    const failure = resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, uvHost({ run: failingInstall }), signal)
    await expect(failure).rejects.toMatchObject({ code: 'BPY_INSTALL_FAILED', message: expect.stringContaining('Install uv (https://docs.astral.sh/uv/getting-started/installation/)') as string })
  })

  it('rethrows cancellation and forced-bpy failures without falling back', async () => {
    const aborted = uvHost({ executables: [APP], run: () => { throw new DOMException('stopped', 'AbortError') } })
    await expect(resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, aborted, signal)).rejects.toThrow('stopped')
    const forced = resolveWorkerLaunch({ ...OPTIONS, backend: 'bpy' }, SCRIPT, BUNDLED, uvHost({ executables: [APP], run: failingInstall }), signal)
    await expect(forced).rejects.toMatchObject({ code: 'BPY_INSTALL_FAILED', message: expect.not.stringContaining('Install uv') as string })
  })

  it('requires uv for the bpy backend', async () => {
    await expect(resolveWorkerLaunch({ ...OPTIONS, backend: 'bpy' }, SCRIPT, BUNDLED, new FakeHost({ executables: [APP] }), signal))
      .rejects.toMatchObject({ code: 'UV_NOT_FOUND', message: expect.stringContaining('set to the bpy backend') as string })
  })

  it('uses Blender when auto finds no uv, and only Blender for the app backend', async () => {
    const host = new FakeHost({ executables: [APP] })
    expect((await resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, host, signal)).backend).toBe('app')
    const withUv = uvHost({ executables: [APP] })
    expect(await resolveWorkerLaunch({ ...OPTIONS, backend: 'app' }, SCRIPT, BUNDLED, withUv, signal)).toMatchObject({ backend: 'app', notes: [] })
    expect(withUv.commands).toEqual([])
  })

  it('explains how to install Blender when nothing is found', async () => {
    await expect(resolveWorkerLaunch(OPTIONS, SCRIPT, BUNDLED, new FakeHost(), signal))
      .rejects.toMatchObject({ code: 'BLENDER_NOT_FOUND', message: expect.stringContaining('Neither uv nor Blender was found') as string })
    await expect(resolveWorkerLaunch({ ...OPTIONS, backend: 'app' }, SCRIPT, BUNDLED, new FakeHost(), signal))
      .rejects.toMatchObject({ code: 'BLENDER_NOT_FOUND', message: expect.stringContaining('set to the app backend') as string })
  })
})

describe('BlenderWorkers', () => {
  const ready = { app: 'blender', version: '5.2.3', python: '3.11.9' }
  const exitedBeforeReady = (logTail?: string): WorkerError =>
    new WorkerError('WORKER_START_FAILED', 'worker python: exited with code 1 before it reported ready', { logTail })
  const reinstall = `If the bpy environment at ${VENV} is damaged, delete that folder so that the next start installs it again.`
  /** A host where bpy is installed, and Blender too unless `app` is false. */
  const installedHost = (app = true): FakeHost => new FakeHost({ executables: ['/usr/bin/uv', VENV_PYTHON, ...app ? [APP] : []] })

  it('starts an installed Blender under auto when the bpy module does not start, and quotes the failure', async () => {
    const start = vi.fn(async (spec: { argv: readonly string[] }) => {
      if (spec.argv[0] === VENV_PYTHON) throw exitedBeforeReady('Traceback (most recent call last):\n  File "x"\nImportError: libGL.so.1: cannot open shared object file\n\n')
      return { ready }
    })
    const workers = new BlenderWorkers(OPTIONS, workerDependencies(installedHost(), start))
    await expect(workers.start(signal, SCOPE)).resolves.toEqual({ ready })
    expect(start.mock.calls.map(([spec]) => spec.argv[0])).toEqual([VENV_PYTHON, APP])
    expect(workers.takeNotes()).toEqual([
      'The bpy module did not start (worker python: exited with code 1 before it reported ready; its last output line was: '
        + `ImportError: libGL.so.1: cannot open shared object file), so Blender at ${APP} runs the tools instead. ${reinstall}`,
      'Blender 5.2.3 started (Blender app, Python 3.11.9) with its default scene.',
    ])
  })

  it('quotes at most 300 characters of the last output line and none without output', async () => {
    for (const [logTail, quoted] of [[`${'x'.repeat(400)}\n`, `; its last output line was: ${'x'.repeat(300)}`], ['  \n', ''], [undefined, '']] as const) {
      const start = vi.fn(async (spec: { argv: readonly string[] }) => {
        if (spec.argv[0] === VENV_PYTHON) throw exitedBeforeReady(logTail)
        return { ready }
      })
      const workers = new BlenderWorkers(OPTIONS, workerDependencies(installedHost(), start))
      await workers.start(signal, SCOPE)
      expect(workers.takeNotes()[0]).toBe(`The bpy module did not start (worker python: exited with code 1 before it reported ready${quoted}), so Blender at ${APP} runs the tools instead. ${reinstall}`)
    }
  })

  it('adds reinstall advice to the start failure when auto finds no Blender and for the bpy backend', async () => {
    for (const [backend, app] of [['auto', false], ['bpy', true]] as const) {
      const start = vi.fn(async (): Promise<{ ready: typeof ready }> => { throw exitedBeforeReady('ImportError: no module\n') })
      const workers = new BlenderWorkers({ ...OPTIONS, backend }, workerDependencies(installedHost(app), start))
      const failure = workers.start(signal, SCOPE)
      await expect(failure).rejects.toBeInstanceOf(WorkerError)
      await expect(failure).rejects.toMatchObject({
        code: 'WORKER_START_FAILED', logTail: 'ImportError: no module\n',
        message: `worker python: exited with code 1 before it reported ready. ${reinstall}`,
      })
      expect(start).toHaveBeenCalledOnce()
      expect(workers.takeNotes()).toEqual([])
    }
  })

  it('passes other start failures through without falling back', async () => {
    const failures = [
      new DOMException('stopped', 'AbortError'),
      new WorkerError('WORKER_EXITED', 'the worker supervisor is closed, so no further calls run'),
    ]
    for (const failure of failures) {
      const start = vi.fn(async (): Promise<{ ready: typeof ready }> => { throw failure })
      const workers = new BlenderWorkers(OPTIONS, workerDependencies(installedHost(), start))
      await expect(workers.start(signal, SCOPE)).rejects.toBe(failure)
      expect(start).toHaveBeenCalledOnce()
    }
    const appFailure = exitedBeforeReady()
    const app = vi.fn(async (): Promise<{ ready: typeof ready }> => { throw appFailure })
    await expect(new BlenderWorkers({ ...OPTIONS, backend: 'app' }, workerDependencies(installedHost(), app)).start(signal, SCOPE))
      .rejects.toBe(appFailure)
  })

  it('starts a worker from the resolved launch and reports setup notes once', async () => {
    const host = new FakeHost({ executables: ['/usr/bin/uv'] })
    const start = vi.fn(async () => ({ ready: { app: 'blender', version: '5.2.3', python: '3.13.16' } }))
    const workers = new BlenderWorkers(OPTIONS, workerDependencies(host, start))
    const worker = await workers.start(signal, SCOPE)
    expect(worker.ready.version).toBe('5.2.3')
    expect(start).toHaveBeenCalledWith({
      argv: [VENV_PYTHON, '-I', '-u', SCRIPT], cwd: '/data/blender/workers/1', env: { PATH: '/usr/bin:/bin' }, readyTimeoutMs: 30_000, logTailBytes: 65_536,
    }, signal)
    expect(host.made[0]).toBe('/data/blender')
    expect(workers.takeNotes()).toEqual([
      `Installed Python 3.13 and bpy 5.2.3 into ${VENV} (first use).`,
      'Blender 5.2.3 started (bpy module, Python 3.13.16) with its default scene.',
    ])
    expect(workers.takeNotes()).toEqual([])
  })

  it('names the shipped bpy module, and says to reinstall WASD Engine when it does not start', async () => {
    const ready = { app: 'blender', version: '5.2.3', python: '3.13.18' }
    const started = new BlenderWorkers(OPTIONS, workerDependencies(shippedHost(), async () => ({ ready })))
    await started.start(signal, SCOPE)
    expect(started.takeNotes()).toEqual(['Blender 5.2.3 started (the bpy module that WASD Engine ships, Python 3.13.18) with its default scene.'])
    const repair = `If the bpy runtime that WASD Engine ships in ${SHIPPED} is damaged, reinstall WASD Engine.`
    const failing = async (spec: { argv: readonly string[] }): Promise<{ ready: typeof ready }> => {
      if (spec.argv[0] === SHIPPED_PYTHON) throw exitedBeforeReady('Killed: 9\n')
      return { ready: { ...ready, python: '3.11.9' } }
    }
    const fallback = new BlenderWorkers(OPTIONS, workerDependencies(shippedHost(SHIPPED_RECORD, [SHIPPED_PYTHON, APP]), failing))
    await fallback.start(signal, SCOPE)
    expect(fallback.takeNotes()).toEqual([
      `The bpy module did not start (worker python: exited with code 1 before it reported ready; its last output line was: Killed: 9), so Blender at ${APP} runs the tools instead. ${repair}`,
      'Blender 5.2.3 started (Blender app, Python 3.11.9) with its default scene.',
    ])
    const alone = new BlenderWorkers(OPTIONS, workerDependencies(shippedHost(), failing))
    await expect(alone.start(signal, SCOPE)).rejects.toMatchObject({
      code: 'WORKER_START_FAILED', message: `worker python: exited with code 1 before it reported ready. ${repair}`,
    })
  })

  it('names the Blender app runtime', async () => {
    const start = async (): Promise<{ ready: { app: string; version: string; python: string } }> => ({ ready: { app: 'blender', version: '4.2.0', python: '3.11.9' } })
    const workers = new BlenderWorkers({ ...OPTIONS, backend: 'app' }, workerDependencies(new FakeHost({ executables: [APP] }), start))
    await workers.start(signal, SCOPE)
    expect(workers.takeNotes()).toEqual(['Blender 4.2.0 started (Blender app, Python 3.11.9) with its default scene.'])
  })
})

describe('nodeBlenderSetupHost', () => {
  let root = ''
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-blender-env-')) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('binds the shared host to the current process', () => {
    const host = nodeBlenderSetupHost(1024)
    expect(host.platform).toBe(process.platform)
    expect(host.env).toBe(process.env)
  })

  it('lists, creates, renames, and removes directories', async () => {
    const host = nodeBlenderSetupHost(1024)
    const made = join(root, 'a', 'b')
    await host.makeDirectory(made)
    await expect(host.listDirectory(join(root, 'a'))).resolves.toEqual(['b'])
    await expect(host.listDirectory(join(root, 'nothing'))).resolves.toEqual([])
    await expect(host.listDirectory(`${root}/bad\0name`)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
    await host.rename(made, join(root, 'a', 'c'))
    await expect(readdir(join(root, 'a'))).resolves.toEqual(['c'])
    await mkdir(join(root, 'a', 'c', 'd'))
    await host.remove(join(root, 'a'))
    await host.remove(join(root, 'a'))
    await expect(host.listDirectory(join(root, 'a'))).resolves.toEqual([])
  })

  it('runs commands and keeps the tail of their output', async () => {
    const host = nodeBlenderSetupHost(8)
    const options = { cwd: root, env: process.env, signal }
    const result = await host.run([process.execPath, '-e', 'process.stdout.write("0123456789"); process.stderr.write("ab"); process.exit(3)'], options)
    expect(result).toEqual({ exitCode: 3, signal: null, output: expect.stringMatching(/^.{8}$/) as string })
    expect(result.output.endsWith('89') || result.output.endsWith('ab')).toBe(true)
    await expect(runCommand([process.execPath, '-e', 'console.log(process.cwd())'], options, 4096)).resolves.toMatchObject({ exitCode: 0 })
    await expect(runCommand([join(root, 'no-such-command')], options, 64)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('unpacks a packed runtime with the real tar once, and reuses the unpacked folder', async () => {
    const runtime = { ...WIN_RUNTIME, platform: process.platform, arch: process.arch, executable: 'python/bin/python3.13' }
    const content = join(root, 'content')
    await mkdir(join(content, 'python', 'bin'), { recursive: true })
    await writeFile(join(content, 'python', 'bin', 'python3.13'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(content, 'runtime.json'), JSON.stringify({ ...runtime, sha256: {} }))
    const packedFolder = join(root, 'pkg', 'runtime', `${process.platform}-${process.arch}`)
    await mkdir(packedFolder, { recursive: true })
    const { execFileSync } = await import('node:child_process')
    execFileSync('tar', ['-czf', join(packedFolder, 'runtime.tar.gz'), '-C', content, 'python', 'runtime.json'])
    await writeFile(join(packedFolder, 'archive.json'), JSON.stringify({ format: 1, archive: 'runtime.tar.gz', bytes: 1, sha256: 'c'.repeat(64), runtime }))
    const host = nodeBlenderSetupHost(4096)
    const dataRoot = join(root, 'data ü')
    const packed = (await findPackedBpy(join(root, 'pkg', 'runtime'), host))!
    const directory = join(dataRoot, 'runtime', '5.2.3-wasd.1')
    await expect(unpackShippedBpy(packed, dataRoot, host, signal)).resolves.toEqual({
      directory, python: join(directory, 'python', 'bin', 'python3.13'), bpy: '5.2.3', unpacked: true,
    })
    await expect(readdir(join(dataRoot, 'runtime'))).resolves.toEqual(['5.2.3-wasd.1'])
    await expect(host.isExecutable(join(directory, 'python', 'bin', 'python3.13'))).resolves.toBe(true)
    await expect(unpackShippedBpy(packed, dataRoot, host, signal)).resolves.toMatchObject({ unpacked: false })
  })

  it('kills a command when its signal aborts', async () => {
    const controller = new AbortController()
    const running = runCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { cwd: root, env: process.env, signal: controller.signal }, 64)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })
})
