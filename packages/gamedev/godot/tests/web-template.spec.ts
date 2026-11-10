/** The Web template download reads only the template entry of the export templates archive and checks it. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { GodotTemplateError, WebTemplateManager, type TemplateFetch, type WebTemplateSettings } from '../src/web-template.ts'

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

async function settings(overrides: Partial<WebTemplateSettings> = {}): Promise<WebTemplateSettings> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-godot-template-'))
  folders.push(dataRoot)
  return { dataRoot, webTemplateArchiveUrl: URL_, webTemplateEntry: ENTRY, webTemplateSha256: SHA256, webTemplatePath: '', ...overrides }
}

const signal = new AbortController().signal

describe('WebTemplateManager', () => {
  it('downloads only the template entry, publishes it once, and reuses it', async () => {
    const body = archive({ 'templates/version.txt': Buffer.from('4.7.2.stable'), [ENTRY]: TEMPLATE, 'templates/linux_release.x86_64': randomBytes(400_000) })
    const server = rangeServer(body)
    const manager = new WebTemplateManager(await settings(), server.fetch)
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
    const manager = new WebTemplateManager(await settings({ webTemplateSha256: '0'.repeat(64) }), rangeServer(archive({ [ENTRY]: TEMPLATE })).fetch)
    await expect(manager.resolve(signal)).rejects.toThrow(/does not match the SHA-256/u)
  })

  it('explains a server without range requests instead of downloading the whole archive', async () => {
    const manager = new WebTemplateManager(await settings(), rangeServer(archive({ [ENTRY]: TEMPLATE }), { ranges: false }).fetch)
    await expect(manager.resolve(signal)).rejects.toThrow(/does not answer range requests[\s\S]*webTemplatePath/u)
  })

  it('reports an archive without the template', async () => {
    const manager = new WebTemplateManager(await settings(), rangeServer(archive({ 'templates/version.txt': Buffer.from('x') })).fetch)
    const failure = manager.resolve(signal)
    await expect(failure).rejects.toBeInstanceOf(GodotTemplateError)
    await expect(failure).rejects.toThrow(/has no templates\/web_nothreads_release\.zip/u)
  })

  it('uses a configured template without downloading, and refuses a missing one', async () => {
    const base = await settings()
    const path = join(base.dataRoot, 'mine.zip')
    await writeFile(path, 'zip')
    const server = rangeServer(Buffer.alloc(0))
    expect(await new WebTemplateManager({ ...base, webTemplatePath: path }, server.fetch).resolve(signal)).toBe(path)
    expect(server.requests).toBe(0)
    await expect(new WebTemplateManager({ ...base, webTemplatePath: join(base.dataRoot, 'missing.zip') }, server.fetch).resolve(signal)).rejects.toThrow(/is not a file/u)
  })
})
