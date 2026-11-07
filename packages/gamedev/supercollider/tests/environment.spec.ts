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
  toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
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

const installed = (sclang: string, scsynth: string): SuperColliderRuntime => ({
  source: 'installed', sclang, scsynth, classLibrary: undefined, plugins: undefined, helpSource: undefined,
})

const signal = new AbortController().signal

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

  it('finds the scsynth of a configured sclang inside a macOS application bundle', async () => {
    const host = appHost({ directories: { '/Applications': [] } })
    await expect(findSuperCollider({ sclangPath: `${APP}/MacOS/sclang`, scsynthPath: '' }, BUNDLED, host))
      .resolves.toMatchObject({ scsynth: `${APP}/Resources/scsynth` })
  })

  it('refuses configured paths that are not executable, and a configured sclang without scsynth', async () => {
    const host = new FakeHost({ executables: ['/opt/sc/sclang'] })
    await expect(findSuperCollider({ sclangPath: '/nope', scsynthPath: '' }, BUNDLED, host)).rejects.toThrow('sclangPath (/nope) is not an executable file')
    await expect(findSuperCollider({ sclangPath: '/opt/sc/sclang', scsynthPath: '' }, BUNDLED, host)).rejects.toThrow('No scsynth was found beside')
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '/nope' }, BUNDLED, appHost())).rejects.toThrow('scsynthPath (/nope) is not an executable file')
  })

  it('uses the shipped runtime, then the newest application bundle, then PATH', async () => {
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, bundledHost(RECORD, { executables: [`${APP}/MacOS/sclang`] })))
      .resolves.toMatchObject({ source: 'bundled' })
    const bundles = new FakeHost({
      directories: { '/Applications': ['SuperCollider.app'], '/Users/dev/Applications': ['SuperCollider 3.15.app', 'SuperCollider 3.16.app'] },
      executables: [
        `${APP}/MacOS/sclang`, `${APP}/Resources/scsynth`, '/Users/dev/Applications/SuperCollider 3.15.app/Contents/MacOS/sclang',
        '/Users/dev/Applications/SuperCollider 3.15.app/Contents/Resources/scsynth', '/Users/dev/Applications/SuperCollider 3.16.app/Contents/MacOS/sclang',
      ],
    })
    // 3.16 has no scsynth, so the next newest bundle wins.
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, bundles)).resolves.toEqual(installed(
      '/Users/dev/Applications/SuperCollider 3.15.app/Contents/MacOS/sclang', '/Users/dev/Applications/SuperCollider 3.15.app/Contents/Resources/scsynth',
    ))
    const path = new FakeHost({ platform: 'linux', env: { PATH: 'relative:/usr/local/bin:/usr/bin' }, executables: ['/usr/local/bin/sclang', '/usr/bin/sclang', '/usr/bin/scsynth'] })
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, path)).resolves.toEqual(installed('/usr/bin/sclang', '/usr/bin/scsynth'))
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, BUNDLED, new FakeHost({ env: {} }))).resolves.toBeUndefined()
  })

  it('searches Program Files on Windows, newest first', async () => {
    const host = new FakeHost({
      platform: 'win32',
      env: { Path: 'C:\\Windows', ProgramFiles: 'D:\\Programs' },
      directories: { 'D:\\Programs': ['SuperCollider-3.13.0', 'SuperCollider-3.14.1', 'Other'] },
      executables: ['D:\\Programs\\SuperCollider-3.14.1\\sclang.exe', 'D:\\Programs\\SuperCollider-3.14.1\\scsynth.exe'],
    })
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, 'C:\\app\\runtime', host))
      .resolves.toEqual(installed('D:\\Programs\\SuperCollider-3.14.1\\sclang.exe', 'D:\\Programs\\SuperCollider-3.14.1\\scsynth.exe'))
    await expect(findSuperCollider({ sclangPath: '', scsynthPath: '' }, 'C:\\app\\runtime', new FakeHost({ platform: 'win32', env: {} })))
      .resolves.toBeUndefined()
  })
})

describe('worker folders, class library configuration, and bridge plan', () => {
  const bundled: SuperColliderRuntime = {
    source: 'bundled', sclang: `${RUNTIME}/sclang`, scsynth: `${RUNTIME}/scsynth`, classLibrary: `${RUNTIME}/SCClassLibrary`,
    plugins: `${RUNTIME}/plugins`, helpSource: `${RUNTIME}/HelpSource`,
  }

  it('keeps every folder under the data directory', () => {
    expect(superColliderFolders('/data/sc', 'darwin')).toEqual({
      configHome: '/data/sc/home/config', dataHome: '/data/sc/home/data', scratch: '/data/sc/scratch', classLibraryConfig: '/data/sc/sclang_conf.yaml',
    })
    expect(superColliderFolders('C:\\data', 'win32').scratch).toBe('C:\\data\\scratch')
  })

  it('replaces the default paths with a shipped class library and keeps them for an installation', () => {
    expect(classLibraryConfig(bundled, '/data/sc/payload/abc')).toBe([
      'includePaths:', `  - "${RUNTIME}/SCClassLibrary"`, '  - "/data/sc/payload/abc"', 'excludePaths: []', 'postInlineWarnings: false',
      'excludeDefaultPaths: true', '',
    ].join('\n'))
    expect(classLibraryConfig(installed('/a/sclang', '/a/scsynth'), 'C:\\payload "x"'))
      .toContain('includePaths:\n  - "C:\\\\payload \\"x\\""\nexcludePaths: []\npostInlineWarnings: false\nexcludeDefaultPaths: false')
  })

  it('plans sclang in its IDE mode with the user folders under the data directory', () => {
    const folders = superColliderFolders('/data/sc', 'darwin')
    expect(sclangBridgePlan(bundled, folders, { dataRoot: '/data/sc', graceMs: 3000 })).toEqual({
      sclang: [`${RUNTIME}/sclang`, '-i', 'wasd', '-l', '/data/sc/sclang_conf.yaml'],
      env: { set: { XDG_CONFIG_HOME: '/data/sc/home/config', XDG_DATA_HOME: '/data/sc/home/data' }, unset: ['ELECTRON_RUN_AS_NODE'] },
      cwd: '/data/sc',
      requestDirectory: '/data/sc/scratch',
      boot: { scsynth: `${RUNTIME}/scsynth`, plugins: `${RUNTIME}/plugins`, scratch: '/data/sc/scratch', helpSource: `${RUNTIME}/HelpSource` },
      graceMs: 3000,
    })
    expect(sclangBridgePlan(installed('/a/sclang', '/a/scsynth'), folders, { dataRoot: '/data/sc', graceMs: 1 }).boot)
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
    await expect(workers.start(signal)).resolves.toEqual({ ready: { app: 'supercollider', version: '3.14.1' } })
    expect(host.made).toEqual(['/data/supercollider/home/config', '/data/supercollider/home/data', '/data/supercollider/scratch'])
    expect(host.written.get('/data/supercollider/sclang_conf.yaml')).toContain('  - "/data/supercollider/payload/abc"')
    const [spec, startSignal] = start.mock.calls[0] ?? []
    expect(startSignal).toBe(signal)
    expect(spec).toMatchObject({ cwd: '/data/supercollider', env: host.env, readyTimeoutMs: 60_000, logTailBytes: 65_536 })
    expect(spec?.argv.slice(0, 4)).toEqual(['/node', '--import', 'tsx', '/pkg/src/worker.ts'])
    expect(spec?.argv[5]).toBe(SCLANG_BRIDGE_ARGUMENT)
    expect(decodeServerOptions(['', '', spec?.argv[4] ?? ''])).toMatchObject({ sclang: [`${RUNTIME}/sclang`, '-i', 'wasd', '-l', '/data/supercollider/sclang_conf.yaml'] })
    expect(workers.takeNotes()).toEqual(['SuperCollider 3.14.1 started (the runtime that WASD Engine ships) with no SynthDefs or variables defined.'])
    expect(workers.takeNotes()).toEqual([])
  })

  it('names configured and installed SuperCollider in its note', async () => {
    const start = async (): Promise<{ ready: { app: string; version: string } }> => ({ ready: { app: 'supercollider', version: '3.14.1' } })
    const dependencies = { bundledRoot: BUNDLED, bridge: ['/node', '/worker.js'] as const, start, workerScript: async () => '/p/WasdWorker.sc' }
    const configured = new SuperColliderWorkers({ ...OPTIONS, sclangPath: `${APP}/MacOS/sclang` }, { ...dependencies, host: appHost() })
    await configured.start(signal)
    expect(configured.takeNotes()[0]).toContain(`(sclang at ${APP}/MacOS/sclang)`)
    const found = new SuperColliderWorkers(OPTIONS, { ...dependencies, host: appHost() })
    await found.start(signal)
    expect(found.takeNotes()[0]).toContain(`(installed at ${APP}/MacOS/sclang)`)
  })

  it('explains how to install SuperCollider when none is found', async () => {
    const workers = new SuperColliderWorkers(OPTIONS, {
      host: new FakeHost({ env: {} }), bundledRoot: BUNDLED, bridge: ['/node'], start: vi.fn(), workerScript: async () => '/p/WasdWorker.sc',
    })
    const failure = workers.start(signal)
    await expect(failure).rejects.toMatchObject({ code: 'SUPERCOLLIDER_NOT_FOUND' })
    await expect(failure).rejects.toThrow('brew install --cask supercollider')
    const linux = new SuperColliderWorkers(OPTIONS, {
      host: new FakeHost({ platform: 'linux', env: {} }), bundledRoot: BUNDLED, bridge: ['/node'], start: vi.fn(), workerScript: async () => '/p/WasdWorker.sc',
    })
    await expect(linux.start(signal)).rejects.toThrow('SuperCollider was not found. The WASD Engine desktop app ships it; elsewhere, install '
      + 'SuperCollider 3.13 or newer from https://supercollider.github.io/downloads, then')
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
