/** A template download reads only the template's entry of the export templates archive and checks it. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledTemplatesDir, ExportTemplateManager, GodotTemplateError, type ExportTemplateSettings, type TemplateFetch } from '../src/export-template.ts'

const ENTRY = 'templates/web_nothreads_release.zip'
const TEMPLATE = Buffer.from('PK fake web template '.repeat(400))
const SHA256 = createHash('sha256').update(TEMPLATE).digest('hex')
const URL_ = 'https://example.test/Godot_v4.7.2-stable_export_templates.tpz'

/** A ZIP archive of `entries`, deflated, as Godot's export templates archive is. */
function archive(entries: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(entries)) {
    const packed = deflateRawSync(data)
    const encoded = Buffer.from(name)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(packed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(encoded.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc32(data), 16)
    record.writeUInt32LE(packed.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(encoded.length, 28)
    record.writeUInt32LE(offset, 42)
    parts.push(header, encoded, packed)
    directory.push(record, encoded)
    offset += header.length + encoded.length + packed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, end])
}

/** A server of `body` that answers range requests, counting the bytes it sent. */
/** What a test's range server sent. */
interface RangeServer {
  readonly fetch: TemplateFetch
  sent: number
  requests: number
}

function rangeServer(body: Buffer, options: { readonly ranges?: boolean } = {}): RangeServer {
  const server = {
    sent: 0,
    requests: 0,
    fetch: (_url: string, init: { readonly headers: Record<string, string> }): Promise<Response> => {
      server.requests++
      if (options.ranges === false) return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }))
      const range = /^bytes=(\d+)-(\d+)$/u.exec(init.headers.range as string)
      // GitHub's release storage refuses suffix ranges (bytes=-N), so this server does too.
      if (range === null) return Promise.resolve(new Response('Not Implemented', { status: 501 }))
      const [start, end] = range.slice(1).map(Number) as [number, number]
      const slice = body.subarray(start, end + 1)
      server.sent += slice.length
      return Promise.resolve(new Response(new Uint8Array(slice), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } }))
    },
  }
  return server
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function settings(overrides: Partial<ExportTemplateSettings> = {}): Promise<ExportTemplateSettings> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-godot-template-'))
  folders.push(dataRoot)
  return { dataRoot, platform: 'Web', field: 'webTemplate', archiveUrl: URL_, entry: ENTRY, sha256: SHA256, path: '', bundledDir: '', extension: '.zip', ...overrides }
}

const signal = new AbortController().signal

describe('ExportTemplateManager', () => {
  it('downloads only the template entry, publishes it once, and reuses it', async () => {
    const body = archive({ 'templates/version.txt': Buffer.from('4.7.2.stable'), [ENTRY]: TEMPLATE, 'templates/linux_release.x86_64': randomBytes(400_000) })
    const server = rangeServer(body)
    const manager = new ExportTemplateManager(await settings(), server.fetch)
    const [first, second] = await Promise.all([manager.resolve(signal), manager.resolve(signal)])
    expect(first).toBe(second)
    expect(first).toBe(manager.installedPath())
    expect(await readFile(first)).toEqual(TEMPLATE)
    expect(server.sent).toBeLessThan(body.length / 2)
    const requests = server.requests
    expect(await manager.resolve(signal)).toBe(first)
    expect(server.requests).toBe(requests)
  })

  it('refuses a template whose SHA-256 differs from the pinned one', async () => {
    const manager = new ExportTemplateManager(await settings({ sha256: '0'.repeat(64) }), rangeServer(archive({ [ENTRY]: TEMPLATE })).fetch)
    await expect(manager.resolve(signal)).rejects.toThrow(/Web export template does not match the SHA-256[\s\S]*webTemplateSha256/u)
  })

  it('explains a server without range requests instead of downloading the whole archive', async () => {
    const manager = new ExportTemplateManager(await settings(), rangeServer(archive({ [ENTRY]: TEMPLATE }), { ranges: false }).fetch)
    await expect(manager.resolve(signal)).rejects.toThrow(/does not answer range requests[\s\S]*webTemplatePath/u)
  })

  it('reports an archive without the template', async () => {
    const manager = new ExportTemplateManager(await settings(), rangeServer(archive({ 'templates/version.txt': Buffer.from('x') })).fetch)
    const failure = manager.resolve(signal)
    await expect(failure).rejects.toBeInstanceOf(GodotTemplateError)
    await expect(failure).rejects.toThrow(/has no templates\/web_nothreads_release\.zip/u)
  })

  it('uses a configured template without downloading, and refuses a missing one', async () => {
    const base = await settings()
    const path = join(base.dataRoot, 'mine.zip')
    await writeFile(path, 'zip')
    const server = rangeServer(Buffer.alloc(0))
    expect(await new ExportTemplateManager({ ...base, path }, server.fetch).resolve(signal)).toBe(path)
    expect(server.requests).toBe(0)
    await expect(new ExportTemplateManager({ ...base, path: join(base.dataRoot, 'missing.zip') }, server.fetch).resolve(signal)).rejects.toThrow(/is not a file/u)
  })

  it('uses the template that the Desktop app ships under its SHA-256 without downloading, and downloads when the app ships another', async () => {
    const base = await settings()
    const bundledDir = join(base.dataRoot, 'shipped')
    await mkdir(bundledDir)
    const shipped = join(bundledDir, `${SHA256}.zip`)
    await writeFile(shipped, TEMPLATE)
    const server = rangeServer(archive({ [ENTRY]: TEMPLATE }))
    expect(await new ExportTemplateManager({ ...base, bundledDir }, server.fetch).resolve(signal)).toBe(shipped)
    expect(server.requests).toBe(0)
    const configured = join(base.dataRoot, 'mine.zip')
    await writeFile(configured, 'zip')
    expect(await new ExportTemplateManager({ ...base, bundledDir, path: configured }, server.fetch).resolve(signal)).toBe(configured)
    await rm(shipped)
    await writeFile(join(bundledDir, `${'1'.repeat(64)}.zip`), TEMPLATE)
    const manager = new ExportTemplateManager({ ...base, bundledDir }, server.fetch)
    expect(await manager.resolve(signal)).toBe(manager.installedPath())
    expect(server.requests).toBeGreaterThan(0)
  })

  it('finds the shipped templates of a packaged app outside app.asar', () => {
    const resources = join('/', 'Applications', 'WASD Engine.app', 'Contents', 'Resources')
    expect(bundledTemplatesDir(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-godot')))
      .toBe(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-godot', 'templates'))
    expect(bundledTemplatesDir(join('/', 'repo', 'packages', 'gamedev', 'godot'))).toBe(join('/', 'repo', 'packages', 'gamedev', 'godot', 'templates'))
  })

  it('names a desktop template after its own SHA-256 and extension, and its own fields in messages', async () => {
    const exe = Buffer.from('MZ fake windows template '.repeat(300))
    const entry = 'templates/windows_release_x86_64.exe'
    const sha256 = createHash('sha256').update(exe).digest('hex')
    const body = archive({ [ENTRY]: TEMPLATE, [entry]: exe })
    const windows = await settings({ platform: 'Windows', field: 'windowsTemplate', entry, sha256, extension: '.exe' })
    const manager = new ExportTemplateManager(windows, rangeServer(body).fetch)
    const path = await manager.resolve(signal)
    expect(path).toBe(join(windows.dataRoot, 'templates', `${sha256}.exe`))
    expect(await readFile(path)).toEqual(exe)
    const refused = new ExportTemplateManager({ ...windows, sha256: '1'.repeat(64) }, rangeServer(body).fetch)
    await expect(refused.resolve(signal)).rejects.toThrow(/Windows export template does not match[\s\S]*windowsTemplateSha256/u)
    // Another data folder has no template yet, so it asks the server, which answers without ranges.
    const elsewhere = new ExportTemplateManager({ ...windows, dataRoot: join(windows.dataRoot, 'other') }, rangeServer(body, { ranges: false }).fetch)
    await expect(elsewhere.resolve(signal)).rejects.toThrow(/only the Windows template[\s\S]*windowsTemplatePath/u)
  })
})
