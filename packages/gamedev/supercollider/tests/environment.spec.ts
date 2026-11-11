/**
 * Worker environment resolution: the sclang and scsynth search, the shipped runtime's record, the worker's folders,
 * class library configuration, and bridge plan, and the worker start.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeServerOptions, type JsonLineWorkerSpec } from '@deepseek-ai/dsh-app-mcp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  bundledRuntimeRoot, classLibraryConfig, findBundledRuntime, findSuperCollider, nodeSuperColliderSetupHost, parseServerOptions,
  SCLANG_BRIDGE_ARGUMENT, sclangBridgePlan, SuperColliderSetupError, SuperColliderWorkers, superColliderFolders,
  type SuperColliderSetupHost,
} from '../src/environment.ts'
import type { SuperColliderRuntime, SuperColliderServerOptions } from '../src/types.ts'

const OPTIONS: SuperColliderServerOptions = {
  dataRoot: '/data/supercollider', sclangPath: '', scsynthPath: '', readyTimeoutMs: 60_000, requestTimeoutMs: 600_000,
  toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerMemoryBytes: 0, workerCores: 0,
  minAvailableMemoryBytes: 0, workerIdleTimeoutMs: 600_000,
}
const BUNDLED = '/app/node_modules/@deepseek-ai/dsh-supercollider/runtime'
const RUNTIME = `${BUNDLED}/darwin-arm64`
const APP = '/Applications/SuperCollider.app/Contents'
const RECORD = {
  format: 1, version: '3.14.1-wasd.1', supercollider: '3.14.1', platform: 'darwin', arch: 'arm64', sclang: 'sclang', scsynth: 'scsynth',
  plugins: 'plugins', classLibrary: 'SCClassLibrary', helpSource: 'HelpSource',
}

interface FakeHostOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executables?: readonly string[]
  directories?: Readonly<Record<string, readonly string[]>>
  files?: Readonly<Record<string, string>>
}

class FakeHost implements SuperColliderSetupHost {
  readonly platform: NodeJS.Platform
  readonly arch = 'arm64'
  readonly env: NodeJS.ProcessEnv
  readonly homeDirectory: string
  readonly made: string[] = []
  readonly written = new Map<string, string>()
  private readonly executables: Set<string>

  constructor(private readonly options: FakeHostOptions = {}) {
    this.platform = options.platform ?? 'darwin'
    this.env = options.env ?? { PATH: '/usr/bin:/bin' }
    this.homeDirectory = this.platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev'
    this.executables = new Set(options.executables ?? [])
  }

  async isExecutable(file: string): Promise<boolean> { return this.executables.has(file) }
  async listDirectory(directory: string): Promise<readonly string[]> { return this.options.directories?.[directory] ?? [] }
  async makeDirectory(directory: string): Promise<void> { this.made.push(directory) }
  async readTextFile(file: string): Promise<string | undefined> { return this.options.files?.[file] }
  async writeTextFile(file: string, text: string): Promise<void> { this.written.set(file, text) }
}

function bundledHost(record: unknown = RECORD, options: FakeHostOptions = {}): FakeHost {
  return new FakeHost({
    ...options,
    files: { [`${RUNTIME}/runtime.json`]: typeof record === 'string' ? record : JSON.stringify(record), ...options.files },
    executables: [`${RUNTIME}/sclang`, `${RUNTIME}/scsynth`, ...options.executables ?? []],
  })
}

const appHost = (options: FakeHostOptions = {}): FakeHost => new FakeHost({
  ...options,
  directories: { '/Applications': ['SuperCollider.app', 'Safari.app'], ...options.directories },
  executables: [`${APP}/MacOS/sclang`, `${APP}/Resources/scsynth`, ...options.executables ?? []],
})

const configured = (sclang: string, scsynth: string): SuperColliderRuntime => ({
  source: 'configured', sclang, scsynth, classLibrary: undefined, plugins: undefined, helpSource: undefined,
})

/** A machine with SuperCollider installed every way the tools must ignore: app bundles, PATH, and Program Files. */
const INSTALLED_EVERYWHERE: FakeHostOptions = {
  env: { PATH: '/usr/local/bin:/usr/bin' },
  directories: { '/Applications': ['SuperCollider.app'], '/Users/dev/Applications': ['SuperCollider 3.15.app'] },
  executables: [
    `${APP}/MacOS/sclang`, `${APP}/Resources/scsynth`, '/Users/dev/Applications/SuperCollider 3.15.app/Contents/MacOS/sclang',
    '/Users/dev/Applications/SuperCollider 3.15.app/Contents/Resources/scsynth', '/usr/local/bin/sclang', '/usr/local/bin/scsynth',
  ],
}

const signal = new AbortController().signal

/** The worker scope the pool would pass: a Session and its numbered folder. */
const SCOPE = { key: 'session:spec', directory: '/data/supercollider/workers/1' }

describe('parseServerOptions', () => {
  it('accepts the options the plugin sends and names invalid fields', () => {
    expect(parseServerOptions({ ...OPTIONS })).toEqual(OPTIONS)
    expect(() => parseServerOptions({ ...OPTIONS, readyTimeoutMs: 0 }))
      .toThrow(/^SuperCollider MCP server options are invalid[\s\S]*readyTimeoutMs/u)
    expect(() => parseServerOptions({ ...OPTIONS, sclangPath: 3 })).toThrow(/sclangPath/u)
    expect(() => parseServerOptions({ ...OPTIONS, extra: true })).toThrow(/extra/u)
  })
})

describe('bundledRuntimeRoot', () => {
  it('reads a package inside app.asar from app.asar.unpacked', () => {
    expect(bundledRuntimeRoot('/App/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-supercollider'))
      .toBe('/App/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-supercollider/runtime')
    expect(bundledRuntimeRoot('/repo/packages/gamedev/supercollider')).toBe('/repo/packages/gamedev/supercollider/runtime')
  })
})

describe('findBundledRuntime', () => {
  it('resolves the programs and folders that runtime.json names', async () => {
    await expect(findBundledRuntime(BUNDLED, bundledHost({ ...RECORD, sclang: 'bin/sclang', extra: true }, { executables: [`${RUNTIME}/bin/sclang`] })))
      .resolves.toEqual({
        source: 'bundled', sclang: `${RUNTIME}/bin/sclang`, scsynth: `${RUNTIME}/scsynth`, classLibrary: `${RUNTIME}/SCClassLibrary`,
        plugins: `${RUNTIME}/plugins`, helpSource: `${RUNTIME}/HelpSource`,
      })
  })

  it('returns nothing when no runtime is shipped for this platform', async () => {
    await expect(findBundledRuntime(BUNDLED, new FakeHost())).resolves.toBeUndefined()
  })

  it.each([
    ['not JSON', '{', 'runtime.json is not JSON'],
    ['another format', { ...RECORD, format: 2 }, 'is not a format 1 runtime record'],
    ['a path outside the folder', { ...RECORD, plugins: '../plugins' }, 'must be a relative path inside the runtime folder'],
    ['an absolute path', { ...RECORD, classLibrary: '/SCClassLibrary' }, 'must be a relative path inside the runtime folder'],
    ['another platform', { ...RECORD, arch: 'x64' }, 'its runtime.json describes darwin-x64'],
    ['a missing program', { ...RECORD, scsynth: 'gone' }, `${RUNTIME}/gone is not an executable file`],
  ])('refuses a runtime.json with %s', async (_case, record, message) => {
    const failure = findBundledRuntime(BUNDLED, bundledHost(record))
    await expect(failure).rejects.toBeInstanceOf(SuperColliderSetupError)
    await expect(failure).rejects.toMatchObject({ code: 'SUPERCOLLIDER_RUNTIME_INVALID' })
    await expect(failure).rejects.toThrow(message)
  })
})

describe('findSuperCollider', () => {
  it('prefers sclangPath, with scsynthPath or the scsynth beside it', async () => {
    const host = bundledHost(RECORD, { executables: ['/opt/sc/sclang', '/opt/sc/scsynth', '/other/scsynth'] })
    await expect(findSuperCollider({ sclangPath: '/opt/sc/sclang', scsynthPath: '' }, BUNDLED, host)).resolves.toEqual({
      source: 'configured', sclang: '/opt/sc/sclang', scsynth: '/opt/sc/scsynth', classLibrary: undefined, plugins: undefined, helpSource: undefined,
    })
    await expect(findSuperCollider({ sclangPath: '/opt/sc/sclang', scsynthPath: '/other/scsynth' }, BUNDLED, host))
      .resolves.toMatchObject({ source: 'configured', scsynth: '/other/scsynth' })
  })

  it('refuses a configured sclang inside a macOS application bundle, which opens as an app', async () => {
    const failure = findSuperCollider({ sclangPath: `${APP}/MacOS/sclang`, scsynthPath: '' }, BUNDLED, appHost())
    await expect(failure).rejects.toMatchObject({ code: 'SUPERCOLLIDER_NOT_HEADLESS' })
    await expect(failure).rejects.toThrow(`sclangPath (${APP}/MacOS/sclang) names the sclang of a SuperCollider application`)
    // Outside macOS a `.app` folder is an ordinary folder.
    const linux = new FakeHost({ platform: 'linux', executables: ['/opt/sc.app/Contents/sclang', '/opt/sc.app/Contents/scsynth'] })
    await expect(findSuperCollider({ sclangPath: '/opt/sc.app/Contents/sclang', scsynthPath: '' }, BUNDLED, linux))
      .resolves.toEqual(configured('/opt/sc.app/Contents/sclang', '/opt/sc.app/Contents/scsynth'))
  })

  it('refuses configured paths that are not executable, and a configured sclang without scsynth', async () => {
    const host = new FakeHost({ executables: ['/opt/sc/sclang'] })
    await expect(findSuperCollider({ sclangPath: '/nope', scsynthPath: '' }, BUNDLED, host)).rejects.toThrow('sclangPath (/nope) is not an executable file')
    await expect(findSuperCollider({ sclangPath: '/opt/sc/sclang', scsynthPath: '' }, BUNDLED, host)).rejects.toThrow('No scsynth was found beside')
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '/nope' }, BUNDLED, bundledHost())).rejects.toThrow('scsynthPath (/nope) is not an executable file')
  })

  it('uses the shipped runtime and never an installed SuperCollider', async () => {
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, bundledHost(RECORD, INSTALLED_EVERYWHERE)))
      .resolves.toMatchObject({ source: 'bundled' })
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, new FakeHost(INSTALLED_EVERYWHERE))).resolves.toBeUndefined()
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, new FakeHost({ ...INSTALLED_EVERYWHERE, platform: 'linux' })))
      .resolves.toBeUndefined()
    const windows = new FakeHost({
      platform: 'win32',
      env: { Path: 'C:\\Windows', ProgramFiles: 'D:\\Programs' },
      directories: { 'D:\\Programs': ['SuperCollider-3.14.1'] },
      executables: ['D:\\Programs\\SuperCollider-3.14.1\\sclang.exe', 'D:\\Programs\\SuperCollider-3.14.1\\scsynth.exe'],
    })
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, 'C:\\app\\runtime', windows)).resolves.toBeUndefined()
  })
})

describe('worker folders, class library configuration, and bridge plan', () => {
  const bundled: SuperColliderRuntime = {
    source: 'bundled', sclang: `${RUNTIME}/sclang`, scsynth: `${RUNTIME}/scsynth`, classLibrary: `${RUNTIME}/SCClassLibrary`,
    plugins: `${RUNTIME}/plugins`, helpSource: `${RUNTIME}/HelpSource`,
  }

  it('keeps every folder in the worker\'s own directory', () => {
    expect(superColliderFolders('/data/sc', 'darwin')).toEqual({
      directory: '/data/sc', configHome: '/data/sc/home/config', dataHome: '/data/sc/home/data', scratch: '/data/sc/scratch', classLibraryConfig: '/data/sc/sclang_conf.yaml',
    })
    expect(superColliderFolders('C:\\data', 'win32').scratch).toBe('C:\\data\\scratch')
  })

  it('replaces the default paths with a shipped class library and keeps them for a configured sclang', () => {
    expect(classLibraryConfig(bundled, '/data/sc/payload/abc')).toBe([
      'includePaths:', `  - "${RUNTIME}/SCClassLibrary"`, '  - "/data/sc/payload/abc"', 'excludePaths: []', 'postInlineWarnings: false',
      'excludeDefaultPaths: true', '',
    ].join('\n'))
    expect(classLibraryConfig(configured('/a/sclang', '/a/scsynth'), 'C:\\payload "x"'))
      .toContain('includePaths:\n  - "C:\\\\payload \\"x\\""\nexcludePaths: []\npostInlineWarnings: false\nexcludeDefaultPaths: false')
  })

  it('plans sclang in its IDE mode, off screen, with the user folders under the data directory', () => {
    const folders = superColliderFolders('/data/sc', 'darwin')
    expect(sclangBridgePlan(bundled, folders, { graceMs: 3000 })).toEqual({
      sclang: [`${RUNTIME}/sclang`, '-i', 'wasd', '-l', 'sclang_conf.yaml'],
      env: {
        set: { XDG_CONFIG_HOME: '/data/sc/home/config', XDG_DATA_HOME: '/data/sc/home/data', QT_QPA_PLATFORM: 'offscreen' },
        unset: ['ELECTRON_RUN_AS_NODE'],
      },
      cwd: '/data/sc',
      requestDirectory: '/data/sc/scratch',
      boot: { scsynth: `${RUNTIME}/scsynth`, plugins: `${RUNTIME}/plugins`, scratch: '/data/sc/scratch', helpSource: `${RUNTIME}/HelpSource` },
      graceMs: 3000,
    })
    expect(sclangBridgePlan(configured('/a/sclang', '/a/scsynth'), folders, { graceMs: 1 }).boot)
      .toEqual({ scsynth: '/a/scsynth', plugins: null, scratch: '/data/sc/scratch', helpSource: null })
  })
})

describe('SuperColliderWorkers', () => {
  it('prepares the folders and configuration, starts the bridge with its plan, and notes the version', async () => {
    const host = bundledHost()
    const start = vi.fn(async (_spec: JsonLineWorkerSpec, _signal: AbortSignal) => ({ ready: { app: 'supercollider', version: '3.14.1' } }))
    const workers = new SuperColliderWorkers(OPTIONS, {
      host, bundledRoot: BUNDLED, bridge: ['/node', '--import', 'tsx', '/pkg/src/worker.ts'], start,
      workerScript: async () => '/data/supercollider/payload/abc/WasdWorker.sc',
    })
    await expect(workers.start(signal, SCOPE)).resolves.toEqual({ ready: { app: 'supercollider', version: '3.14.1' } })
    expect(host.made).toEqual(['/data/supercollider/workers/1/home/config', '/data/supercollider/workers/1/home/data', '/data/supercollider/workers/1/scratch'])
    expect(host.written.get('/data/supercollider/workers/1/sclang_conf.yaml')).toContain('  - "/data/supercollider/payload/abc"')
    const [spec, startSignal] = start.mock.calls[0] ?? []
    expect(startSignal).toBe(signal)
    expect(spec).toMatchObject({ cwd: '/data/supercollider/workers/1', env: host.env, readyTimeoutMs: 60_000, logTailBytes: 65_536 })
    expect(spec?.argv.slice(0, 4)).toEqual(['/node', '--import', 'tsx', '/pkg/src/worker.ts'])
    expect(spec?.argv[5]).toBe(SCLANG_BRIDGE_ARGUMENT)
    expect(decodeServerOptions(['', '', spec?.argv[4] ?? ''])).toMatchObject({ sclang: [`${RUNTIME}/sclang`, '-i', 'wasd', '-l', 'sclang_conf.yaml'], cwd: '/data/supercollider/workers/1' })
    expect(workers.takeNotes()).toEqual(['SuperCollider 3.14.1 started (the runtime that WASD Engine ships) with no SynthDefs or variables defined.'])
    expect(workers.takeNotes()).toEqual([])
  })

  it('names a configured sclang in its note', async () => {
    const start = async (): Promise<{ ready: { app: string; version: string } }> => ({ ready: { app: 'supercollider', version: '3.14.1' } })
    const host = new FakeHost({ executables: ['/opt/sc/sclang', '/opt/sc/scsynth'] })
    const workers = new SuperColliderWorkers({ ...OPTIONS, sclangPath: '/opt/sc/sclang' }, {
      host, bundledRoot: BUNDLED, bridge: ['/node', '/worker.js'], start, workerScript: async () => '/p/WasdWorker.sc',
    })
    await workers.start(signal, SCOPE)
    expect(workers.takeNotes()[0]).toContain('(sclang at /opt/sc/sclang)')
  })

  it('refuses Windows paths with %, which cmd.exe would change, before it makes folders or starts sclang', async () => {
    const start = vi.fn()
    const windows = (): FakeHost => new FakeHost({
      platform: 'win32', executables: ['C:\\sc\\sclang.exe', 'C:\\sc\\scsynth.exe', 'C:\\100%\\sclang.exe', 'C:\\100%\\scsynth.exe'],
    })
    const workers = (sclangPath: string, host: FakeHost): SuperColliderWorkers<never> => new SuperColliderWorkers(
      { ...OPTIONS, sclangPath },
      { host, bundledRoot: 'C:\\app\\runtime', bridge: ['C:\\node.exe'], start, workerScript: async () => 'C:\\p\\WasdWorker.sc' },
    )
    const home = windows()
    const inHome = workers('C:\\sc\\sclang.exe', home).start(signal, { key: 'session:spec', directory: 'C:\\Users\\me\\100%off\\supercollider\\workers\\1' })
    await expect(inHome).rejects.toMatchObject({ code: 'SUPERCOLLIDER_PATH_UNSUPPORTED' })
    await expect(inHome).rejects.toThrow('Set DSH_HOME to a folder whose path has no %')
    expect(home.made).toEqual([])
    const install = workers('C:\\100%\\sclang.exe', windows()).start(signal, { key: 'session:spec', directory: 'C:\\data\\workers\\1' })
    await expect(install).rejects.toThrow('SuperCollider cannot run from C:\\100%\\scsynth.exe on Windows')
    expect(start).not.toHaveBeenCalled()
  })

  it('explains how to get the headless runtime, and starts no installed SuperCollider, when none is shipped', async () => {
    const start = vi.fn()
    const workers = new SuperColliderWorkers(OPTIONS, {
      host: new FakeHost(INSTALLED_EVERYWHERE), bundledRoot: BUNDLED, bridge: ['/node'], start, workerScript: async () => '/p/WasdWorker.sc',
    })
    const failure = workers.start(signal, SCOPE)
    await expect(failure).rejects.toMatchObject({ code: 'SUPERCOLLIDER_NOT_FOUND' })
    await expect(failure).rejects.toThrow('WASD Engine\'s headless SuperCollider is not installed for darwin-arm64. The WASD Engine desktop app ships '
      + 'it for macOS on Apple silicon and for Windows x64; a source checkout installs it with `wasdengine/supercollider/build.sh --out <folder> '
      + '--install packages/gamedev/supercollider/runtime`. WASD Engine does not start an installed SuperCollider, whose application opens as an app.')
    expect(start).not.toHaveBeenCalled()
  })
})

describe('nodeSuperColliderSetupHost', () => {
  let directory = ''
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-supercollider-host-')) })
  afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

  it('reads and writes text files and reads a missing file as undefined', async () => {
    const host = nodeSuperColliderSetupHost()
    expect(host.arch).toBe(process.arch)
    const file = join(directory, 'conf.yaml')
    await host.writeTextFile(file, 'includePaths: []\n')
    await expect(readFile(file, 'utf8')).resolves.toBe('includePaths: []\n')
    await expect(host.readTextFile(file)).resolves.toBe('includePaths: []\n')
    await expect(host.readTextFile(join(directory, 'missing.json'))).resolves.toBeUndefined()
    await expect(host.readTextFile(directory)).rejects.toThrow()
  })
})
