/** Runtime resolution follows the documented order; the managed install verifies, extracts, and publishes atomically. */
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledRuntimeRoot, createRuntimeHost, GodotRuntimeError, GodotRuntimeManager, RUNTIME_MISSING_MESSAGE,
  type RuntimeHost, type RuntimeSettings,
} from '../src/runtime.ts'
import type { GodotRuntimeView } from '../src/types.ts'
import { subprocessFixture, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

let root: string
let host: SubprocessFixture | undefined
let server: Server | undefined

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-godot-runtime-')) })
afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise(resolve => server?.close(resolve))
    server = undefined
  }
  await host?.ctx.fiber.dispose()
  host = undefined
  await rm(root, { recursive: true, force: true })
})

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    dataRoot: join(root, 'data'), bundledRoot: join(root, 'bundled'), runtimeVersion: '1.0-test', runtimeManifestUrl: 'http://127.0.0.1:1/manifest.json',
    libgodotPath: '', runnerPath: '', ...overrides,
  }
}

function fakeHost(overrides: Partial<RuntimeHost> = {}): RuntimeHost {
  return {
    platform: 'linux', arch: 'x64',
    fetch: (url, init) => fetch(url, { signal: init.signal }),
    extract: async () => { throw new Error('unexpected extract') },
    ...overrides,
  }
}

async function file(path: string, mode = 0o755, content = '#!/bin/sh\n'): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  await chmod(path, mode)
  return path
}

async function managedRecord(version = '1.0-test', platform = 'linux', extra: Record<string, unknown> = {}): Promise<string> {
  const directory = join(root, 'data', 'runtime', version)
  await file(join(directory, 'godot_runner'))
  await file(join(directory, 'libgodot.so'), 0o644)
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ format: 1, version, godot: '4.7.2', platform, arch: 'x64', runner: 'godot_runner', library: 'libgodot.so', ...extra }))
  return directory
}

posix('runtime resolution', () => {
  it('prefers configured LibGodot paths and validates them', async () => {
    const runner = await file(join(root, 'bin', 'godot_runner'))
    const library = await file(join(root, 'bin', 'libgodot.so'), 0o644)
    const manager = new GodotRuntimeManager(settings({ runnerPath: runner, libgodotPath: library }), fakeHost({ platform: 'darwin' }), () => {})
    expect(await manager.resolve(signal)).toEqual({ kind: 'libgodot', runner, library })
    expect(await manager.view(signal)).toEqual({ state: 'ready', kind: 'libgodot', windowless: true })
    const unusable = new GodotRuntimeManager(settings({ runnerPath: library, libgodotPath: library }), fakeHost(), () => {})
    await expect(unusable.resolve(signal)).rejects.toMatchObject({ code: 'RUNTIME_CONFIG', message: expect.stringContaining('runnerPath') as string })
    expect(await unusable.view(signal)).toMatchObject({ state: 'failed', message: expect.stringContaining('not an executable file') as string })
    const missing = new GodotRuntimeManager(settings({ runnerPath: runner, libgodotPath: join(root, 'nope.so') }), fakeHost(), () => {})
    await expect(missing.resolve(signal)).rejects.toThrow('libgodotPath')
    await expect(missing.resolve(signal)).rejects.toThrow('is not a file')
  })

  it('uses a managed runtime only with a matching runtime.json and files', async () => {
    const manager = new GodotRuntimeManager(settings(), fakeHost(), () => {})
    expect(manager.managedDirectory()).toBe(join(root, 'data', 'runtime', '1.0-test'))
    expect(await manager.resolve(signal)).toBeUndefined()
    const directory = await managedRecord()
    expect(await manager.resolve(signal)).toEqual({ kind: 'libgodot', runner: join(directory, 'godot_runner'), library: join(directory, 'libgodot.so'), version: '4.7.2' })
    expect(await manager.view(signal)).toEqual({ state: 'ready', kind: 'libgodot', version: '4.7.2', windowless: false })
    for (const record of [
      { platform: 'darwin' },
      { arch: 'arm64' },
      { version: 'other' },
      { runner: '../escape' },
      { runner: '..' },
    ]) {
      await managedRecord('1.0-test', 'linux', record)
      expect(await manager.resolve(signal)).toBeUndefined()
    }
    await managedRecord()
    await chmod(join(directory, 'godot_runner'), 0o644)
    expect(await manager.resolve(signal)).toBeUndefined()
    await rm(join(directory, 'libgodot.so'))
    await chmod(join(directory, 'godot_runner'), 0o755)
    expect(await manager.resolve(signal)).toBeUndefined()
    await writeFile(join(directory, 'runtime.json'), '{')
    expect(await manager.resolve(signal)).toBeUndefined()
    await rm(join(directory, 'runtime.json'))
    await mkdir(join(directory, 'runtime.json'))
    await expect(manager.resolve(signal)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('uses the runtime the application ships before the managed one, under the same runtime.json rules', async () => {
    const bundled = join(root, 'bundled', 'linux-x64')
    await file(join(bundled, 'godot_runner'))
    await file(join(bundled, 'libgodot.so'), 0o644)
    const record = { format: 1, version: '1.0-test', godot: '4.7.3', platform: 'linux', arch: 'x64', runner: 'godot_runner', library: 'libgodot.so' }
    await writeFile(join(bundled, 'runtime.json'), JSON.stringify(record))
    const managed = await managedRecord()
    const manager = new GodotRuntimeManager(settings(), fakeHost(), () => {})
    expect(manager.bundledDirectory()).toBe(bundled)
    expect(await manager.resolve(signal)).toEqual({ kind: 'libgodot', runner: join(bundled, 'godot_runner'), library: join(bundled, 'libgodot.so'), version: '4.7.3' })
    // A shipped runtime of another version yields to the managed runtime of the configured one.
    await writeFile(join(bundled, 'runtime.json'), JSON.stringify({ ...record, version: '0.9-test' }))
    expect(await manager.resolve(signal)).toEqual({ kind: 'libgodot', runner: join(managed, 'godot_runner'), library: join(managed, 'libgodot.so'), version: '4.7.2' })
    await writeFile(join(bundled, 'runtime.json'), JSON.stringify(record))
    const configured = await file(join(root, 'bin', 'godot_runner'))
    const library = await file(join(root, 'bin', 'libgodot.so'), 0o644)
    const override = new GodotRuntimeManager(settings({ runnerPath: configured, libgodotPath: library }), fakeHost(), () => {})
    expect(await override.resolve(signal)).toEqual({ kind: 'libgodot', runner: configured, library })
  })

  it('reads the runtimes shipped beside an Electron app.asar archive from app.asar.unpacked', () => {
    expect(bundledRuntimeRoot('/A/WASD Engine.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-godot'))
      .toBe('/A/WASD Engine.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-godot/libgodot')
    expect(bundledRuntimeRoot('/repo/packages/gamedev/godot')).toBe('/repo/packages/gamedev/godot/libgodot')
    expect(bundledRuntimeRoot('/x/app.asarx/godot')).toBe('/x/app.asarx/godot/libgodot')
  })

  it('renders without a window on macOS, the platform whose LibGodot runs embedded', () => {
    expect(new GodotRuntimeManager(settings(), fakeHost({ platform: 'darwin' }), () => {}).windowless()).toBe(true)
    expect(new GodotRuntimeManager(settings(), fakeHost({ platform: 'linux' }), () => {}).windowless()).toBe(false)
    expect(new GodotRuntimeManager(settings(), fakeHost({ platform: 'win32' }), () => {}).windowless()).toBe(false)
  })

  it('reports a missing runtime without starting an installed Godot editor', async () => {
    const published: GodotRuntimeView[] = []
    // An editor beside the data folder, where a PATH or /Applications search would have found one, changes nothing.
    await file(join(root, 'bin', 'godot'))
    const manager = new GodotRuntimeManager(settings(), fakeHost({ platform: 'darwin' }), (view) => { published.push(view) })
    expect(manager.latest()).toEqual({ state: 'missing', message: RUNTIME_MISSING_MESSAGE })
    expect(await manager.view(signal)).toEqual({ state: 'missing', message: RUNTIME_MISSING_MESSAGE })
    expect(published).toEqual([])
    const aborted = new AbortController()
    aborted.abort(new Error('stop'))
    await expect(new GodotRuntimeManager(settings(), fakeHost({ platform: 'darwin' }), () => {}).resolve(aborted.signal)).rejects.toThrow('stop')
  })

  it('treats any regular file as launchable on Windows and reports file system loops', async () => {
    const plain = await file(join(root, 'bin', 'godot_runner.exe'), 0o644)
    const library = await file(join(root, 'bin', 'libgodot.dll'), 0o644)
    expect(await new GodotRuntimeManager(settings({ runnerPath: plain, libgodotPath: library }), fakeHost({ platform: 'win32' }), () => {}).resolve(signal))
      .toEqual({ kind: 'libgodot', runner: plain, library })
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    await expect(new GodotRuntimeManager(settings({ runnerPath: join(root, 'loop-a'), libgodotPath: library }), fakeHost(), () => {}).resolve(signal))
      .rejects.toMatchObject({ code: 'ELOOP' })
  })
})

interface Release {
  readonly manifestUrl: string
  readonly hits: string[]
  readonly sha256: string
  readonly bytes: number
}

interface ReleaseOptions {
  readonly manifest?: (artifact: Record<string, unknown>) => unknown
  readonly archiveStatus?: number
  readonly archive?: Buffer
  readonly files?: Record<string, string>
}

async function release(options: ReleaseOptions = {}): Promise<Release> {
  const staging = join(root, 'staging')
  for (const [name, content] of Object.entries(options.files ?? { godot_runner: '#!/bin/sh\n', 'libgodot.so': randomBytes(8 * 1024 * 1024).toString('base64') })) {
    await file(join(staging, name), 0o644, content)
  }
  const archivePath = join(root, 'artifact.tar.gz')
  execFileSync('tar', ['-czf', archivePath, '-C', staging, '.'])
  const archive = options.archive ?? await readFile(archivePath)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const artifact = { url: 'files/artifact.tar.gz', bytes: archive.length, sha256, runner: 'godot_runner', library: 'libgodot.so' }
  const manifest = options.manifest?.(artifact) ?? { format: 1, version: '1.0-test', godot: '4.7.2', artifacts: { 'linux-x64': artifact } }
  const hits: string[] = []
  server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if (request.url === '/release/manifest.json') {
      response.writeHead(typeof manifest === 'string' && manifest === '404' ? 404 : 200, { 'content-type': 'application/json' })
      response.end(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
      return
    }
    if (request.url === '/release/files/artifact.tar.gz') {
      response.writeHead(options.archiveStatus ?? 200)
      response.end(archive)
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP listener')
  return { manifestUrl: `http://127.0.0.1:${address.port}/release/manifest.json`, hits, sha256, bytes: archive.length }
}

async function installer(manifestUrl: string, published: GodotRuntimeView[] = []): Promise<GodotRuntimeManager> {
  host = await subprocessFixture()
  const real = createRuntimeHost(host.subprocess, { outputBytes: 4096, graceMs: 1000 })
  return new GodotRuntimeManager(settings({ runtimeManifestUrl: manifestUrl }), { ...real, platform: 'linux', arch: 'x64' }, (view) => { published.push(view) })
}

posix('managed install', () => {
  it('downloads, verifies, extracts, and publishes the runtime once', async () => {
    const { manifestUrl, hits } = await release()
    const published: GodotRuntimeView[] = []
    const manager = await installer(manifestUrl, published)
    const [first, second] = await Promise.all([manager.install(signal), manager.install(signal)])
    expect(first).toEqual({ state: 'ready', kind: 'libgodot', version: '4.7.2', windowless: false })
    expect(second).toEqual(first)
    expect(hits).toEqual(['/release/manifest.json', '/release/files/artifact.tar.gz'])
    const directory = manager.managedDirectory()
    expect(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))).toEqual({
      format: 1, version: '1.0-test', godot: '4.7.2', platform: 'linux', arch: 'x64', runner: 'godot_runner', library: 'libgodot.so',
    })
    expect((await stat(join(directory, 'godot_runner'))).mode & 0o111).not.toBe(0)
    const phases = published.map(view => view.state === 'installing' ? view.progress?.phase ?? 'starting' : view.state)
    expect(phases[0]).toBe('starting')
    expect(phases).toContain('downloading')
    expect(phases).toContain('verifying')
    expect(phases).toContain('extracting')
    expect(phases.at(-1)).toBe('ready')
    expect(published.filter(view => view.progress?.phase === 'downloading').length).toBeLessThanOrEqual(101)
    expect(await manager.install(signal)).toEqual(first)
    expect(hits).toHaveLength(2)
  })

  it('reports the installing state to views and lets a caller stop waiting', async () => {
    const { manifestUrl } = await release()
    const manager = await installer(manifestUrl)
    const resolving = manager.view(signal)
    const controller = new AbortController()
    const waiting = manager.install(controller.signal)
    expect(await resolving).toMatchObject({ state: 'installing' })
    expect(await manager.view(signal)).toMatchObject({ state: 'installing' })
    controller.abort(new Error('left'))
    await expect(waiting).rejects.toThrow('left')
    expect(await manager.install(signal)).toMatchObject({ state: 'ready' })
  })

  it.each([
    ['an HTTP failure', { manifest: () => '404' }, 'failed with HTTP 404'],
    ['invalid JSON', { manifest: () => '{' }, 'is not JSON'],
    ['an invalid manifest', { manifest: () => ({ format: 2 }) }, 'is invalid'],
    ['another version', { manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '9', godot: '4', artifacts: { 'linux-x64': artifact } }) }, 'describes version 9'],
    ['no build for this platform', { manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '1.0-test', godot: '4', artifacts: { 'win32-x64': artifact } }) }, 'no build for linux-x64'],
    ['a download failure', { archiveStatus: 500 }, 'failed with HTTP 500'],
    ['a short download', { manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '1.0-test', godot: '4', artifacts: { 'linux-x64': { ...artifact, bytes: (artifact.bytes as number) + 1 } } }) }, 'its manifest declares'],
    ['a long download', { manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '1.0-test', godot: '4', artifacts: { 'linux-x64': { ...artifact, bytes: 10 } } }) }, 'larger than the 10 bytes'],
    ['a hash mismatch', { manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '1.0-test', godot: '4', artifacts: { 'linux-x64': { ...artifact, sha256: '0'.repeat(64) } } }) }, 'does not match the SHA-256'],
    ['an archive without the runtime', { files: { 'README.txt': 'hi' } }, 'does not contain godot_runner'],
    ['a corrupt archive', { archive: Buffer.from('not a tarball') }, 'Extracting the Godot runtime failed'],
  ])('fails with an actionable message for %s and leaves nothing behind', async (_case, options, message) => {
    const { manifestUrl } = await release(options)
    const manager = await installer(manifestUrl)
    const view = await manager.install(signal)
    expect(view).toMatchObject({ state: 'failed', message: expect.stringContaining(message) as string })
    expect(await manager.view(signal)).toEqual(view)
    expect(await readdir(join(root, 'data', 'runtime'))).toEqual([])
  })

  it('handles failed responses without bodies', async () => {
    const manifest = { format: 1, version: '1.0-test', godot: '4', artifacts: { 'linux-x64': { url: 'a.tar.gz', bytes: 1, sha256: '0'.repeat(64), runner: 'r', library: 'l' } } }
    const noManifest = new GodotRuntimeManager(settings(), fakeHost({ fetch: async () => new Response(null, { status: 503 }) }), () => {})
    expect(await noManifest.install(signal)).toMatchObject({ state: 'failed', message: expect.stringContaining('HTTP 503') as string })
    const noBody = new GodotRuntimeManager(settings(), fakeHost({
      fetch: async url => url.endsWith('manifest.json') ? Response.json(manifest) : new Response(null, { status: 200 }),
    }), () => {})
    expect(await noBody.install(signal)).toMatchObject({ state: 'failed', message: expect.stringContaining('failed with HTTP 200') as string })
  })

  it('reports unreachable manifests and cancellation by disposal', async () => {
    const unreachable = await installer('http://127.0.0.1:1/manifest.json')
    expect(await unreachable.install(signal)).toMatchObject({ state: 'failed', message: expect.stringContaining('Cannot reach') as string })
    await host?.ctx.fiber.dispose()
    const { manifestUrl } = await release()
    const manager = await installer(manifestUrl)
    const pending = manager.install(signal)
    manager.dispose()
    expect(await pending).toEqual({ state: 'failed', message: 'The Godot runtime install was cancelled.' })
    expect(() => manager.install(signal)).toThrow('disposed')
  })

  it('installs Windows builds without changing file modes', async () => {
    const { manifestUrl } = await release({
      manifest: (artifact: Record<string, unknown>) => ({ format: 1, version: '1.0-test', godot: '4.7.2', artifacts: { 'win32-x64': artifact } }),
      files: { godot_runner: 'MZ', 'libgodot.so': 'dll' },
    })
    host = await subprocessFixture()
    const real = createRuntimeHost(host.subprocess, { outputBytes: 4096, graceMs: 1000 })
    const manager = new GodotRuntimeManager(settings({ runtimeManifestUrl: manifestUrl }), { ...real, platform: 'win32', arch: 'x64' }, () => {})
    expect(await manager.install(signal)).toMatchObject({ state: 'ready', kind: 'libgodot' })
    expect((await stat(join(manager.managedDirectory(), 'godot_runner'))).mode & 0o111).toBe(0)
  })

  it('publishes nothing when another Host completed the runtime first', async () => {
    const { manifestUrl } = await release()
    const manager = await installer(manifestUrl)
    const other = new GodotRuntimeManager(settings({ runtimeManifestUrl: manifestUrl }), { ...createRuntimeHost((host as SubprocessFixture).subprocess, { outputBytes: 4096, graceMs: 1000 }), platform: 'linux', arch: 'x64' }, () => {})
    const [one, two] = await Promise.all([manager.install(signal), other.install(signal)])
    expect(one).toMatchObject({ state: 'ready' })
    expect(two).toMatchObject({ state: 'ready' })
  })
})

posix('createRuntimeHost', () => {
  it('describes this process and searches for no Godot executable', async () => {
    host = await subprocessFixture()
    const real = createRuntimeHost(host.subprocess, { outputBytes: 4096, graceMs: 1000 })
    expect(real.platform).toBe(process.platform)
    expect(real.arch).toBe(process.arch)
    expect(Object.keys(real).sort()).toEqual(['arch', 'extract', 'fetch', 'platform'])
    expect(GodotRuntimeError.name).toBe('GodotRuntimeError')
  })
})
