/**
 * Worker environment resolution: the shipped runtime, packed or not, and the gimp-console search, worker command line and
 * environment, and worker start.
 */
import { WorkerError } from '@deepseek-ai/dsh-app-mcp'
import type { CommandArgv, CommandOptions, CommandResult } from '@deepseek-ai/dsh-app-mcp'
import { describe, expect, it, vi } from 'vitest'
import {
  findGimp, GimpSetupError, GimpWorkers, gimpProfileDirectory, gimpWorkerArgv, nodeGimpSetupHost, parseServerOptions, workerEnvironment,
  type GimpSetupHost,
} from '../src/environment.ts'
import type { GimpServerOptions } from '../src/types.ts'

const OPTIONS: GimpServerOptions = {
  dataRoot: '/data/gimp', gimpConsolePath: '', readyTimeoutMs: 120_000, requestTimeoutMs: 600_000, toolCallTimeoutMs: 900_000,
  graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerMemoryBytes: 0, workerCores: 0, minAvailableMemoryBytes: 0,
  workerIdleTimeoutMs: 600_000,
}
const MACOS = '/Applications/GIMP.app/Contents/MacOS'
const CONSOLE = `${MACOS}/gimp-console-3.2`
const SCRIPT = '/data/gimp/payload/abc/wasd_gimp_worker.py'

interface FakeHostOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  executables?: readonly string[]
  directories?: Readonly<Record<string, readonly string[]>>
  files?: Readonly<Record<string, string>>
  run?: (argv: CommandArgv, options: CommandOptions) => CommandResult
  rename?: ((from: string, to: string) => void) | undefined
}

class FakeHost implements GimpSetupHost {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly env: NodeJS.ProcessEnv
  readonly homeDirectory: string
  readonly executables: Set<string>
  readonly made: string[] = []

  constructor(private readonly options: FakeHostOptions = {}) {
    this.platform = options.platform ?? 'darwin'
    this.arch = options.arch ?? 'arm64'
    this.env = options.env ?? { PATH: '/usr/bin:/bin' }
    this.homeDirectory = this.platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev'
    this.executables = new Set(options.executables ?? [])
    this.files = new Map(Object.entries(options.files ?? {}))
  }

  readonly files: Map<string, string>
  readonly commands: { argv: CommandArgv; options: CommandOptions }[] = []
  readonly renamed: [string, string][] = []
  readonly removed: string[] = []

  async isExecutable(file: string): Promise<boolean> { return this.executables.has(file) }
  async listDirectory(directory: string): Promise<readonly string[]> { return this.options.directories?.[directory] ?? [] }
  async makeDirectory(directory: string): Promise<void> { this.made.push(directory) }
  async readTextFile(file: string): Promise<string | undefined> { return this.files.get(file) }
  /** Renames move the files and executables below `from`. */
  async rename(from: string, to: string): Promise<void> {
    this.options.rename?.(from, to)
    this.renamed.push([from, to])
    for (const [file, text] of [...this.files].filter(([file]) => file.startsWith(`${from}\\`))) {
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
    return this.options.run?.(argv, options) ?? { exitCode: 0, signal: null, output: '' }
  }
}

/** The package's runtime folder in the specs; a host without files there has no shipped runtime. */
const RUNTIMES = '/app/node_modules/@deepseek-ai/dsh-gimp/runtime'
const SHIPPED = `${RUNTIMES}/darwin-arm64`
const SHIPPED_CONSOLE = `${SHIPPED}/Contents/MacOS/gimp-console-3.2`
const SHIPPED_ENVIRONMENT = {
  GIMP3_DATADIR: `${SHIPPED}/Contents/share/gimp/3.0`,
  GIMP3_LOCALEDIR: `${SHIPPED}/Contents/share/locale`,
  GIMP3_SYSCONFDIR: `${SHIPPED}/Contents/etc/gimp/3.0`,
}

/** The runtime.json that wasdengine/gimp/runtime.py writes, with changes. */
function runtimeRecord(change: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 1, version: '3.2.8-wasd.1', gimp: '3.2.8', platform: 'darwin', arch: 'arm64', console: 'Contents/MacOS/gimp-console-3.2',
    dataDir: 'Contents/share/gimp/3.0', localeDir: 'Contents/share/locale', sysconfDir: 'Contents/etc/gimp/3.0', sha256: {}, ...change,
  })
}

/** Host options with a shipped darwin-arm64 runtime whose console is executable. */
function shipped(options: FakeHostOptions = {}, record = runtimeRecord()): FakeHostOptions {
  return { ...options, files: { [`${SHIPPED}/runtime.json`]: record }, executables: [SHIPPED_CONSOLE, ...options.executables ?? []] }
}

/** The console that {@link findGimp} picks. */
async function search(options: Pick<GimpServerOptions, 'gimpConsolePath'>, host: FakeHost): Promise<string | undefined> {
  return (await findGimp({ ...options, dataRoot: OPTIONS.dataRoot }, RUNTIMES, host, signal))?.console
}

/** A macOS host with GIMP.app in /Applications holding the given console names, all executable. */
function macHost(consoles: readonly string[], options: FakeHostOptions = {}): FakeHost {
  return new FakeHost({
    ...options,
    directories: { '/Applications': ['GIMP.app', 'Safari.app'], [MACOS]: [...consoles, 'gimp-3.2', 'gimp-console-3.2.dSYM'], ...options.directories },
    executables: [...consoles.map(name => `${MACOS}/${name}`), ...options.executables ?? []],
  })
}

const signal = new AbortController().signal

/** The worker scope the pool would pass: a Session and its numbered folder. */
const SCOPE = { key: 'session:spec', directory: '/data/gimp/workers/1' }

describe('parseServerOptions', () => {
  it('accepts the options the plugin sends and names invalid fields', () => {
    expect(parseServerOptions({ ...OPTIONS })).toEqual(OPTIONS)
    expect(() => parseServerOptions({ ...OPTIONS, readyTimeoutMs: 0 })).toThrow(/^GIMP MCP server options are invalid[\s\S]*readyTimeoutMs/)
    expect(() => parseServerOptions({ ...OPTIONS, maxLogBytes: 0 })).toThrow(/maxLogBytes/)
    expect(() => parseServerOptions({ ...OPTIONS, gimpConsolePath: 3 })).toThrow(/gimpConsolePath/)
    expect(() => parseServerOptions({ ...OPTIONS, extra: true })).toThrow(/extra/)
  })
})

describe('findGimp', () => {
  it('uses a configured gimpConsolePath, then GIMP_CONSOLE, and rejects either when not executable', async () => {
    const host = macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '/env/gimp-console' }, executables: ['/custom/gimp-console', '/env/gimp-console'] })
    await expect(search({ gimpConsolePath: '/custom/gimp-console' }, host)).resolves.toBe('/custom/gimp-console')
    await expect(search({ gimpConsolePath: '' }, host)).resolves.toBe('/env/gimp-console')
    const missing = search({ gimpConsolePath: '/nope' }, host)
    await expect(missing).rejects.toBeInstanceOf(GimpSetupError)
    await expect(missing).rejects.toMatchObject({ code: 'GIMP_NOT_FOUND', message: expect.stringContaining('gimpConsolePath (/nope)') as string })
    const broken = macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '/gone' } })
    await expect(search({ gimpConsolePath: '' }, broken))
      .rejects.toMatchObject({ code: 'GIMP_NOT_FOUND', message: expect.stringContaining('GIMP_CONSOLE environment variable (/gone)') as string })
    await expect(search({ gimpConsolePath: '' }, macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '' } }))).resolves.toBe(CONSOLE)
  })

  it('picks the newest versioned console in GIMP application bundles', async () => {
    await expect(search({ gimpConsolePath: '' }, macHost(['gimp-console', 'gimp-console-3', 'gimp-console-3.2', 'gimp-console-3.0']))).resolves.toBe(CONSOLE)
    const personal = '/Users/dev/Applications/GIMP 3.4.app/Contents/MacOS'
    const both = macHost(['gimp-console-3.2'], {
      directories: { '/Users/dev/Applications': ['GIMP 3.4.app', 'Notes'], [personal]: ['gimp-console-3.4'] },
      executables: [`${personal}/gimp-console-3.4`],
    })
    await expect(search({ gimpConsolePath: '' }, both)).resolves.toBe(`${personal}/gimp-console-3.4`)
    const tie = macHost(['gimp-console-3.2'], {
      directories: { '/Users/dev/Applications': ['GIMP.app'], '/Users/dev/Applications/GIMP.app/Contents/MacOS': ['gimp-console-3.2'] },
      executables: ['/Users/dev/Applications/GIMP.app/Contents/MacOS/gimp-console-3.2'],
    })
    await expect(search({ gimpConsolePath: '' }, tie)).resolves.toBe(CONSOLE)
  })

  it('falls back to PATH on macOS when no bundle has an executable console', async () => {
    const host = new FakeHost({
      env: { PATH: 'relative/bin:/opt/a:/opt/b' },
      directories: { '/Applications': ['GIMP.app'], [MACOS]: ['gimp-console-3.2'], 'relative/bin': ['gimp-console-3.2'], '/opt/b': ['gimp-console-3.0', 'gimp-console-3.2', 'gimp-console-2.10'] },
      executables: ['relative/bin/gimp-console-3.2', '/opt/b/gimp-console-3.0'],
    })
    await expect(search({ gimpConsolePath: '' }, host)).resolves.toBe('/opt/b/gimp-console-3.0')
  })

  it('prefers a versioned console on PATH over plain gimp-console on Linux and reports nothing when GIMP is absent', async () => {
    const plain = new FakeHost({ platform: 'linux', env: { PATH: '/usr/bin:/opt/gimp/bin' }, executables: ['/usr/bin/gimp-console', CONSOLE] })
    await expect(search({ gimpConsolePath: '' }, plain)).resolves.toBe('/usr/bin/gimp-console')
    const versioned = new FakeHost({
      platform: 'linux', env: { PATH: '/usr/bin:/opt/gimp/bin' },
      directories: { '/opt/gimp/bin': ['gimp-console-3.2'] }, executables: ['/usr/bin/gimp-console', '/opt/gimp/bin/gimp-console-3.2'],
    })
    await expect(search({ gimpConsolePath: '' }, versioned)).resolves.toBe('/opt/gimp/bin/gimp-console-3.2')
    await expect(search({ gimpConsolePath: '' }, new FakeHost({ platform: 'linux', env: {} }))).resolves.toBeUndefined()
  })

  it('reads Path on Windows and then searches GIMP 3 installations, newest first', async () => {
    const onPath = new FakeHost({
      platform: 'win32', env: { Path: 'C:\\Tools;C:\\GIMP\\bin' },
      directories: { 'C:\\GIMP\\bin': ['gimp-console-3.0.exe', 'GIMP-CONSOLE-3.2.EXE', 'gimp-console-3.2'] },
      executables: ['C:\\GIMP\\bin\\gimp-console-3.0.exe', 'C:\\GIMP\\bin\\GIMP-CONSOLE-3.2.EXE'],
    })
    await expect(search({ gimpConsolePath: '' }, onPath)).resolves.toBe('C:\\GIMP\\bin\\GIMP-CONSOLE-3.2.EXE')
    const plain = new FakeHost({ platform: 'win32', env: { PATH: 'C:\\bin' }, executables: ['C:\\bin\\gimp-console.exe'] })
    await expect(search({ gimpConsolePath: '' }, plain)).resolves.toBe('C:\\bin\\gimp-console.exe')
    const installed = new FakeHost({
      platform: 'win32', env: { ProgramFiles: 'D:\\Apps', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      directories: {
        'D:\\Apps': ['GIMP 2', 'GIMP 3', 'Other'],
        'D:\\Apps\\GIMP 3\\bin': ['gimp-3.2.exe', 'gimp-console-3.2.exe'],
        'C:\\Users\\dev\\AppData\\Local\\Programs': ['GIMP 3'],
        'C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3\\bin': ['gimp-console-3.4.exe'],
      },
      executables: ['D:\\Apps\\GIMP 3\\bin\\gimp-console-3.2.exe', 'C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-console-3.4.exe'],
    })
    await expect(search({ gimpConsolePath: '' }, installed)).resolves.toBe('D:\\Apps\\GIMP 3\\bin\\gimp-console-3.2.exe')
    const perUser = new FakeHost({
      platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      directories: {
        'C:\\Program Files': ['GIMP 3'],
        'C:\\Users\\dev\\AppData\\Local\\Programs': ['GIMP 3.0', 'GIMP 3.2'],
        'C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.2\\bin': ['gimp-console-3.2.exe'],
        'C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.0\\bin': ['gimp-console-3.0.exe'],
      },
      executables: ['C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.2\\bin\\gimp-console-3.2.exe', 'C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.0\\bin\\gimp-console-3.0.exe'],
    })
    await expect(search({ gimpConsolePath: '' }, perUser)).resolves.toBe('C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.2\\bin\\gimp-console-3.2.exe')
    const standard = new FakeHost({
      platform: 'win32', env: { LOCALAPPDATA: '' },
      directories: { 'C:\\Program Files': ['GIMP 3'], 'C:\\Program Files\\GIMP 3\\bin': ['gimp-console-3.2.exe'] },
      executables: ['C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe'],
    })
    await expect(search({ gimpConsolePath: '' }, standard)).resolves.toBe('C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe')
    await expect(search({ gimpConsolePath: '' }, new FakeHost({ platform: 'win32', env: {} }))).resolves.toBeUndefined()
  })
})

describe('the shipped runtime', () => {
  const other = (console: string): object => ({ console, shipped: false, environment: {}, notes: [], repair: '' })

  it('binds the real host to this process', () => {
    expect(nodeGimpSetupHost(1024)).toMatchObject({ platform: process.platform, arch: process.arch, env: process.env })
  })

  it('runs it with its folders unless a setting names another GIMP, and before an installed GIMP', async () => {
    const host = macHost(['gimp-console-3.2'], shipped())
    await expect(findGimp(OPTIONS, RUNTIMES, host, signal))
      .resolves.toEqual({ console: SHIPPED_CONSOLE, shipped: true, environment: SHIPPED_ENVIRONMENT, notes: [], repair: '' })
    const configured = macHost(['gimp-console-3.2'], shipped({ executables: ['/custom/gimp-console'], env: { GIMP_CONSOLE: '/custom/gimp-console' } }))
    await expect(findGimp(OPTIONS, RUNTIMES, configured, signal)).resolves.toEqual(other('/custom/gimp-console'))
    await expect(findGimp({ ...OPTIONS, gimpConsolePath: CONSOLE }, RUNTIMES, host, signal)).resolves.toEqual(other(CONSOLE))
    const intel = macHost(['gimp-console-3.2'], shipped({ arch: 'x64' }))
    await expect(findGimp(OPTIONS, RUNTIMES, intel, signal)).resolves.toEqual(other(CONSOLE))
  })

  it('refuses a runtime that its runtime.json does not describe', async () => {
    const cases: Array<[FakeHostOptions, string]> = [
      [shipped({}, '{'), `${SHIPPED}/runtime.json is not JSON`],
      [shipped({}, runtimeRecord({ format: 2 })), 'is not a format 1 runtime record'],
      [shipped({}, runtimeRecord({ console: '../gimp-console' })), 'is not a format 1 runtime record'],
      [shipped({}, runtimeRecord({ arch: 'x64' })), 'its runtime.json describes darwin-x64'],
      [{ ...shipped(), executables: [] }, `${SHIPPED_CONSOLE} is not an executable file`],
    ]
    for (const [options, reason] of cases) {
      const failure = findGimp(OPTIONS, RUNTIMES, new FakeHost(options), signal)
      await expect(failure).rejects.toBeInstanceOf(GimpSetupError)
      await expect(failure).rejects.toMatchObject({ code: 'GIMP_RUNTIME_INVALID', message: expect.stringContaining(reason) as string })
      await expect(failure).rejects.toMatchObject({ message: expect.stringContaining('set the GIMP plugin setting gimpConsolePath') as string })
    }
  })
})

/** The GIMP runtime that a Windows Desktop app ships as its archive, and the folder under `dataRoot` it unpacks into. */
const WIN_RUNTIMES = 'C:\\app\\dsh-gimp\\runtime'
const WIN_PACKED = `${WIN_RUNTIMES}\\win32-x64`
const WIN_ARCHIVE = `${WIN_PACKED}\\gimp-3.2.8-wasd.1-win32-x64.tar.gz`
const WIN_DATA = 'C:\\Users\\dev\\.wasdengine\\gimp'
const WIN_UNPACKED = `${WIN_DATA}\\runtime\\3.2.8-wasd.1`
const WIN_CONSOLE = `${WIN_UNPACKED}\\bin\\gimp-console-3.2.exe`
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe'
const WIN_RUNTIME = {
  format: 1, version: '3.2.8-wasd.1', gimp: '3.2.8', platform: 'win32', arch: 'x64', console: 'bin/gimp-console-3.2.exe',
  dataDir: 'share/gimp/3.0', localeDir: 'share/locale', sysconfDir: 'etc/gimp/3.0',
}
const WIN_OPTIONS: GimpServerOptions = { ...OPTIONS, dataRoot: WIN_DATA }
const WIN_ENVIRONMENT = {
  GIMP3_DATADIR: `${WIN_UNPACKED}\\share\\gimp\\3.0`, GIMP3_LOCALEDIR: `${WIN_UNPACKED}\\share\\locale`, GIMP3_SYSCONFDIR: `${WIN_UNPACKED}\\etc\\gimp\\3.0`,
}
const WIN_REPAIR = `If the GIMP runtime that WASD Engine unpacked into ${WIN_UNPACKED} is damaged, delete that folder so that the next start unpacks it again.`

/** A Windows host whose package ships the GIMP runtime's archive; its tar unpacks runtime.json and the console into its working folder. */
function packedHost(options: Pick<FakeHostOptions, 'rename' | 'run'> & { readonly archive?: boolean } = {}): FakeHost {
  const host: FakeHost = new FakeHost({
    platform: 'win32', arch: 'x64', env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    executables: [WIN_TAR],
    directories: { [WIN_PACKED]: ['archive.json', ...options.archive ?? true ? ['gimp-3.2.8-wasd.1-win32-x64.tar.gz'] : []] },
    files: {
      [`${WIN_PACKED}\\archive.json`]: JSON.stringify({
        format: 1, archive: 'gimp-3.2.8-wasd.1-win32-x64.tar.gz', bytes: 150_000_000, sha256: 'a'.repeat(64), runtime: WIN_RUNTIME,
      }),
    },
    rename: options.rename,
    run: options.run ?? ((_argv, { cwd: destination }) => {
      host.files.set(`${destination}\\runtime.json`, JSON.stringify({ ...WIN_RUNTIME, sha256: {} }))
      host.executables.add(`${destination}\\bin\\gimp-console-3.2.exe`)
      return { exitCode: 0, signal: null, output: '' }
    }),
  })
  return host
}

describe('the packed runtime', () => {
  it('unpacks it under the data directory on first use, runs it with its folders, and reuses it', async () => {
    const host = packedHost()
    await expect(findGimp(WIN_OPTIONS, WIN_RUNTIMES, host, signal)).resolves.toEqual({
      console: WIN_CONSOLE, shipped: true, environment: WIN_ENVIRONMENT, repair: WIN_REPAIR,
      notes: [`Unpacked the GIMP runtime that WASD Engine ships into ${WIN_UNPACKED} (first use).`],
    })
    expect(host.commands.map(command => [command.argv, command.options.stdinFile])).toEqual([[[WIN_TAR, '-xzf', '-'], WIN_ARCHIVE]])
    await expect(findGimp(WIN_OPTIONS, WIN_RUNTIMES, host, signal)).resolves.toMatchObject({ console: WIN_CONSOLE, notes: [] })
    expect(host.commands).toHaveLength(1)
  })

  it('reports an archive that cannot be unpacked or moved into place as a broken shipped runtime', async () => {
    const cases: readonly (readonly [FakeHost, string])[] = [
      [packedHost({ archive: false }), `its archive.json names ${WIN_ARCHIVE}, which is missing`],
      [packedHost({ run: () => ({ exitCode: 1, signal: null, output: 'tar: Damaged archive' }) }), '(exit code 1): tar: Damaged archive. Reinstall WASD Engine'],
      [packedHost({ rename: () => { throw new Error('access denied') } }), `Could not move the unpacked GIMP runtime to ${WIN_UNPACKED}: access denied. Remove that folder`],
      [packedHost({ rename: () => { throw 'busy' } }), `Could not move the unpacked GIMP runtime to ${WIN_UNPACKED}: busy. Remove that folder`],
    ]
    for (const [host, message] of cases) {
      const failure = findGimp(WIN_OPTIONS, WIN_RUNTIMES, host, signal)
      await expect(failure).rejects.toBeInstanceOf(GimpSetupError)
      await expect(failure).rejects.toMatchObject({ code: 'GIMP_RUNTIME_INVALID', message: expect.stringContaining(message) as string })
    }
  })
})

describe('worker command line and environment', () => {
  it('lays out the profile per platform', () => {
    expect(gimpProfileDirectory('/data/gimp', 'darwin')).toBe('/data/gimp/profile')
    expect(gimpProfileDirectory('C:\\data\\gimp', 'win32')).toBe('C:\\data\\gimp\\profile')
  })

  it('runs the worker script as a python-fu-eval batch command with a Python string literal path', () => {
    expect(gimpWorkerArgv(CONSOLE, SCRIPT)).toEqual([
      CONSOLE, '-n', '-s', '-c', '--batch-interpreter=python-fu-eval', '-b',
      `import runpy; runpy.run_path("${SCRIPT}", run_name="__main__")`, '--quit',
    ])
    expect(gimpWorkerArgv('C:\\GIMP 3\\bin\\gimp-console-3.2.exe', 'C:\\data\\it\'s "here"\\w.py')[6])
      .toBe('import runpy; runpy.run_path("C:\\\\data\\\\it\'s \\"here\\"\\\\w.py", run_name="__main__")')
  })

  it('drops variables that redirect Python or Electron and names the profile', () => {
    const env = { PATH: '/bin', HOME: '/home', PYTHONPATH: 'x', PYTHONHOME: 'y', PYTHONSTARTUP: 'z', VIRTUAL_ENV: 'v', ELECTRON_RUN_AS_NODE: '1', GIMP3_DIRECTORY: '/mine' }
    expect(workerEnvironment(env, '/data/gimp/profile')).toEqual({ PATH: '/bin', HOME: '/home', GIMP3_DIRECTORY: '/data/gimp/profile' })
    expect(env.GIMP3_DIRECTORY).toBe('/mine')
    expect(workerEnvironment({ PATH: '/bin', GIMP3_DATADIR: '/mine' }, '/data/gimp/profile', SHIPPED_ENVIRONMENT))
      .toEqual({ PATH: '/bin', ...SHIPPED_ENVIRONMENT, GIMP3_DIRECTORY: '/data/gimp/profile' })
  })
})

describe('GimpWorkers', () => {
  it('starts a worker with its own profile and reports the GIMP version once', async () => {
    const host = macHost(['gimp-console-3.2'], { env: { PATH: '/bin', PYTHONHOME: '/py' } })
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.14.10' } }))
    const workerScript = vi.fn(async () => SCRIPT)
    const workers = new GimpWorkers(OPTIONS, { host, workerScript, start, bundledRoot: RUNTIMES })
    const worker = await workers.start(signal, SCOPE)
    expect(worker.ready.version).toBe('3.2.8')
    expect(start).toHaveBeenCalledWith({
      argv: gimpWorkerArgv(CONSOLE, SCRIPT), cwd: '/data/gimp/workers/1', env: { PATH: '/bin', GIMP3_DIRECTORY: '/data/gimp/profile' },
      readyTimeoutMs: 120_000, logTailBytes: 65_536,
    }, signal)
    expect(host.made).toEqual(['/data/gimp/profile'])
    expect(workers.takeNotes()).toEqual(['GIMP 3.2.8 started (Python 3.14.10) with no images open.'])
    expect(workers.takeNotes()).toEqual([])
  })

  it('starts the shipped runtime with its folders and says so', async () => {
    const host = new FakeHost(shipped({ env: { PATH: '/bin' } }))
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.14.10' } }))
    const workers = new GimpWorkers(OPTIONS, { host, workerScript: vi.fn(async () => SCRIPT), start, bundledRoot: RUNTIMES })
    await workers.start(signal, SCOPE)
    expect(start).toHaveBeenCalledWith({
      argv: gimpWorkerArgv(SHIPPED_CONSOLE, SCRIPT), cwd: '/data/gimp/workers/1',
      env: { PATH: '/bin', ...SHIPPED_ENVIRONMENT, GIMP3_DIRECTORY: '/data/gimp/profile' }, readyTimeoutMs: 120_000, logTailBytes: 65_536,
    }, signal)
    expect(workers.takeNotes()).toEqual(['GIMP 3.2.8 started (the runtime that WASD Engine ships, Python 3.14.10) with no images open.'])
  })

  it('reports a first-use unpack, and says how to unpack a runtime again that does not start', async () => {
    const host = packedHost()
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.13.11' } }))
    const workers = new GimpWorkers(WIN_OPTIONS, { host, workerScript: vi.fn(async () => SCRIPT), start, bundledRoot: WIN_RUNTIMES })
    await workers.start(signal, SCOPE)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ argv: gimpWorkerArgv(WIN_CONSOLE, SCRIPT) }), signal)
    expect(workers.takeNotes()).toEqual([
      `Unpacked the GIMP runtime that WASD Engine ships into ${WIN_UNPACKED} (first use).`,
      'GIMP 3.2.8 started (the runtime that WASD Engine ships, Python 3.13.11) with no images open.',
    ])
    const crash = new WorkerError('WORKER_START_FAILED', 'GIMP exited with code 3 before it was ready', { logTail: 'missing DLL' })
    const failing = new GimpWorkers(WIN_OPTIONS, {
      host, workerScript: vi.fn(async () => SCRIPT), start: vi.fn(async () => { throw crash }), bundledRoot: WIN_RUNTIMES,
    })
    await expect(failing.start(signal, SCOPE)).rejects.toMatchObject({
      code: 'WORKER_START_FAILED', message: `GIMP exited with code 3 before it was ready. ${WIN_REPAIR}`, logTail: 'missing DLL', cause: crash,
    })
    const timeout = new WorkerError('WORKER_TIMEOUT', 'GIMP was not ready in time')
    const slow = new GimpWorkers(WIN_OPTIONS, {
      host, workerScript: vi.fn(async () => SCRIPT), start: vi.fn(async () => { throw timeout }), bundledRoot: WIN_RUNTIMES,
    })
    await expect(slow.start(signal, SCOPE)).rejects.toBe(timeout)
    const installed = new GimpWorkers(OPTIONS, { host: macHost(['gimp-console-3.2']), workerScript: vi.fn(async () => SCRIPT), start: vi.fn(async () => { throw crash }), bundledRoot: RUNTIMES })
    await expect(installed.start(signal, SCOPE)).rejects.toBe(crash)
  })

  it('reports a GIMP that names no Python without details', async () => {
    const workers = new GimpWorkers(OPTIONS, {
      host: macHost(['gimp-console-3.2']), workerScript: vi.fn(async () => SCRIPT), bundledRoot: RUNTIMES,
      start: vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8' } })),
    })
    await workers.start(signal, SCOPE)
    expect(workers.takeNotes()).toEqual(['GIMP 3.2.8 started with no images open.'])
  })

  it('explains how to install GIMP 3 before touching the data directory', async () => {
    const workerScript = vi.fn(async () => SCRIPT)
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.14.10' } }))
    const mac = new FakeHost()
    const failure = new GimpWorkers(OPTIONS, { host: mac, workerScript, start, bundledRoot: RUNTIMES }).start(signal, SCOPE)
    await expect(failure).rejects.toBeInstanceOf(GimpSetupError)
    await expect(failure).rejects.toMatchObject({
      code: 'GIMP_NOT_FOUND',
      message: 'GIMP 3 was not found: this installation of WASD Engine has no GIMP runtime for darwin-arm64, and no GIMP 3 is installed. '
        + 'Install GIMP 3 from https://www.gimp.org/downloads/ (on macOS, `brew install --cask gimp` also works), '
        + 'then call the tool again. The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific '
        + 'gimp-console executable.',
    })
    const linux = new GimpWorkers(OPTIONS, { host: new FakeHost({ platform: 'linux', env: {} }), workerScript, start, bundledRoot: RUNTIMES })
      .start(signal, SCOPE)
    await expect(linux).rejects.toMatchObject({ message: expect.not.stringContaining('brew') as string })
    await expect(linux).rejects.toMatchObject({ message: expect.stringContaining('has no GIMP runtime for linux-arm64,') as string })
    expect(mac.made).toEqual([])
    expect(workerScript).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })
})
