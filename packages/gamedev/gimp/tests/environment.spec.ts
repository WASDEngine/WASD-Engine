/** Worker environment resolution: gimp-console search, worker command line and environment, and worker start. */
import type { SetupHost } from '@deepseek-ai/dsh-app-mcp'
import { describe, expect, it, vi } from 'vitest'
import {
  GimpSetupError, GimpWorkers, findGimpConsole, gimpProfileDirectory, gimpWorkerArgv, parseServerOptions, workerEnvironment,
} from '../src/environment.ts'
import type { GimpServerOptions } from '../src/types.ts'

const OPTIONS: GimpServerOptions = {
  dataRoot: '/data/gimp', gimpConsolePath: '', readyTimeoutMs: 120_000, requestTimeoutMs: 600_000, toolCallTimeoutMs: 900_000,
  graceMs: 3000, maxLogBytes: 65_536,
}
const MACOS = '/Applications/GIMP.app/Contents/MacOS'
const CONSOLE = `${MACOS}/gimp-console-3.2`
const SCRIPT = '/data/gimp/payload/abc/wasd_gimp_worker.py'

interface FakeHostOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executables?: readonly string[]
  directories?: Readonly<Record<string, readonly string[]>>
}

class FakeHost implements SetupHost {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly homeDirectory: string
  readonly executables: Set<string>
  readonly made: string[] = []

  constructor(private readonly options: FakeHostOptions = {}) {
    this.platform = options.platform ?? 'darwin'
    this.env = options.env ?? { PATH: '/usr/bin:/bin' }
    this.homeDirectory = this.platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev'
    this.executables = new Set(options.executables ?? [])
  }

  async isExecutable(file: string): Promise<boolean> { return this.executables.has(file) }
  async listDirectory(directory: string): Promise<readonly string[]> { return this.options.directories?.[directory] ?? [] }
  async makeDirectory(directory: string): Promise<void> { this.made.push(directory) }
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

describe('parseServerOptions', () => {
  it('accepts the options the plugin sends and names invalid fields', () => {
    expect(parseServerOptions({ ...OPTIONS })).toEqual(OPTIONS)
    expect(() => parseServerOptions({ ...OPTIONS, readyTimeoutMs: 0 })).toThrow(/^GIMP MCP server options are invalid[\s\S]*readyTimeoutMs/)
    expect(() => parseServerOptions({ ...OPTIONS, maxLogBytes: 0 })).toThrow(/maxLogBytes/)
    expect(() => parseServerOptions({ ...OPTIONS, gimpConsolePath: 3 })).toThrow(/gimpConsolePath/)
    expect(() => parseServerOptions({ ...OPTIONS, extra: true })).toThrow(/extra/)
  })
})

describe('findGimpConsole', () => {
  it('uses a configured gimpConsolePath, then GIMP_CONSOLE, and rejects either when not executable', async () => {
    const host = macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '/env/gimp-console' }, executables: ['/custom/gimp-console', '/env/gimp-console'] })
    await expect(findGimpConsole({ gimpConsolePath: '/custom/gimp-console' }, host)).resolves.toBe('/custom/gimp-console')
    await expect(findGimpConsole({ gimpConsolePath: '' }, host)).resolves.toBe('/env/gimp-console')
    const missing = findGimpConsole({ gimpConsolePath: '/nope' }, host)
    await expect(missing).rejects.toBeInstanceOf(GimpSetupError)
    await expect(missing).rejects.toMatchObject({ code: 'GIMP_NOT_FOUND', message: expect.stringContaining('gimpConsolePath (/nope)') as string })
    const broken = macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '/gone' } })
    await expect(findGimpConsole({ gimpConsolePath: '' }, broken))
      .rejects.toMatchObject({ code: 'GIMP_NOT_FOUND', message: expect.stringContaining('GIMP_CONSOLE environment variable (/gone)') as string })
    await expect(findGimpConsole({ gimpConsolePath: '' }, macHost(['gimp-console-3.2'], { env: { GIMP_CONSOLE: '' } }))).resolves.toBe(CONSOLE)
  })

  it('picks the newest versioned console in GIMP application bundles', async () => {
    await expect(findGimpConsole({ gimpConsolePath: '' }, macHost(['gimp-console', 'gimp-console-3', 'gimp-console-3.2', 'gimp-console-3.0']))).resolves.toBe(CONSOLE)
    const personal = '/Users/dev/Applications/GIMP 3.4.app/Contents/MacOS'
    const both = macHost(['gimp-console-3.2'], {
      directories: { '/Users/dev/Applications': ['GIMP 3.4.app', 'Notes'], [personal]: ['gimp-console-3.4'] },
      executables: [`${personal}/gimp-console-3.4`],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, both)).resolves.toBe(`${personal}/gimp-console-3.4`)
    const tie = macHost(['gimp-console-3.2'], {
      directories: { '/Users/dev/Applications': ['GIMP.app'], '/Users/dev/Applications/GIMP.app/Contents/MacOS': ['gimp-console-3.2'] },
      executables: ['/Users/dev/Applications/GIMP.app/Contents/MacOS/gimp-console-3.2'],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, tie)).resolves.toBe(CONSOLE)
  })

  it('falls back to PATH on macOS when no bundle has an executable console', async () => {
    const host = new FakeHost({
      env: { PATH: 'relative/bin:/opt/a:/opt/b' },
      directories: { '/Applications': ['GIMP.app'], [MACOS]: ['gimp-console-3.2'], 'relative/bin': ['gimp-console-3.2'], '/opt/b': ['gimp-console-3.0', 'gimp-console-3.2', 'gimp-console-2.10'] },
      executables: ['relative/bin/gimp-console-3.2', '/opt/b/gimp-console-3.0'],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, host)).resolves.toBe('/opt/b/gimp-console-3.0')
  })

  it('prefers a versioned console on PATH over plain gimp-console on Linux and reports nothing when GIMP is absent', async () => {
    const plain = new FakeHost({ platform: 'linux', env: { PATH: '/usr/bin:/opt/gimp/bin' }, executables: ['/usr/bin/gimp-console', CONSOLE] })
    await expect(findGimpConsole({ gimpConsolePath: '' }, plain)).resolves.toBe('/usr/bin/gimp-console')
    const versioned = new FakeHost({
      platform: 'linux', env: { PATH: '/usr/bin:/opt/gimp/bin' },
      directories: { '/opt/gimp/bin': ['gimp-console-3.2'] }, executables: ['/usr/bin/gimp-console', '/opt/gimp/bin/gimp-console-3.2'],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, versioned)).resolves.toBe('/opt/gimp/bin/gimp-console-3.2')
    await expect(findGimpConsole({ gimpConsolePath: '' }, new FakeHost({ platform: 'linux', env: {} }))).resolves.toBeUndefined()
  })

  it('reads Path on Windows and then searches GIMP 3 installations, newest first', async () => {
    const onPath = new FakeHost({
      platform: 'win32', env: { Path: 'C:\\Tools;C:\\GIMP\\bin' },
      directories: { 'C:\\GIMP\\bin': ['gimp-console-3.0.exe', 'GIMP-CONSOLE-3.2.EXE', 'gimp-console-3.2'] },
      executables: ['C:\\GIMP\\bin\\gimp-console-3.0.exe', 'C:\\GIMP\\bin\\GIMP-CONSOLE-3.2.EXE'],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, onPath)).resolves.toBe('C:\\GIMP\\bin\\GIMP-CONSOLE-3.2.EXE')
    const plain = new FakeHost({ platform: 'win32', env: { PATH: 'C:\\bin' }, executables: ['C:\\bin\\gimp-console.exe'] })
    await expect(findGimpConsole({ gimpConsolePath: '' }, plain)).resolves.toBe('C:\\bin\\gimp-console.exe')
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
    await expect(findGimpConsole({ gimpConsolePath: '' }, installed)).resolves.toBe('D:\\Apps\\GIMP 3\\bin\\gimp-console-3.2.exe')
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
    await expect(findGimpConsole({ gimpConsolePath: '' }, perUser)).resolves.toBe('C:\\Users\\dev\\AppData\\Local\\Programs\\GIMP 3.2\\bin\\gimp-console-3.2.exe')
    const standard = new FakeHost({
      platform: 'win32', env: { LOCALAPPDATA: '' },
      directories: { 'C:\\Program Files': ['GIMP 3'], 'C:\\Program Files\\GIMP 3\\bin': ['gimp-console-3.2.exe'] },
      executables: ['C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe'],
    })
    await expect(findGimpConsole({ gimpConsolePath: '' }, standard)).resolves.toBe('C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe')
    await expect(findGimpConsole({ gimpConsolePath: '' }, new FakeHost({ platform: 'win32', env: {} }))).resolves.toBeUndefined()
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
  })
})

describe('GimpWorkers', () => {
  it('starts a worker with its own profile and reports the GIMP version once', async () => {
    const host = macHost(['gimp-console-3.2'], { env: { PATH: '/bin', PYTHONHOME: '/py' } })
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.14.10' } }))
    const workerScript = vi.fn(async () => SCRIPT)
    const workers = new GimpWorkers(OPTIONS, { host, workerScript, start })
    const worker = await workers.start(signal)
    expect(worker.ready.version).toBe('3.2.8')
    expect(start).toHaveBeenCalledWith({
      argv: gimpWorkerArgv(CONSOLE, SCRIPT), cwd: '/data/gimp', env: { PATH: '/bin', GIMP3_DIRECTORY: '/data/gimp/profile' },
      readyTimeoutMs: 120_000, logTailBytes: 65_536,
    }, signal)
    expect(host.made).toEqual(['/data/gimp/profile'])
    expect(workers.takeNotes()).toEqual(['GIMP 3.2.8 started (Python 3.14.10) with no images open.'])
    expect(workers.takeNotes()).toEqual([])
  })

  it('explains how to install GIMP 3 before touching the data directory', async () => {
    const workerScript = vi.fn(async () => SCRIPT)
    const start = vi.fn(async () => ({ ready: { app: 'gimp', version: '3.2.8', python: '3.14.10' } }))
    const mac = new FakeHost()
    const failure = new GimpWorkers(OPTIONS, { host: mac, workerScript, start }).start(signal)
    await expect(failure).rejects.toBeInstanceOf(GimpSetupError)
    await expect(failure).rejects.toMatchObject({
      code: 'GIMP_NOT_FOUND',
      message: 'GIMP 3 was not found. Install GIMP 3 from https://www.gimp.org/downloads/ (on macOS, `brew install --cask gimp` also works), '
        + 'then call the tool again. The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific '
        + 'gimp-console executable.',
    })
    const linux = new GimpWorkers(OPTIONS, { host: new FakeHost({ platform: 'linux', env: {} }), workerScript, start }).start(signal)
    await expect(linux).rejects.toMatchObject({ message: expect.not.stringContaining('brew') as string })
    expect(mac.made).toEqual([])
    expect(workerScript).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })
})
