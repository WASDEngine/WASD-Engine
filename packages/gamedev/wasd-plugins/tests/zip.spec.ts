/** Upload archives hold every file of the build, readable by any ZIP reader, without loading the build into memory. */
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip.ts'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-wasd-zip-'))
  folders.push(created)
  return created
}

const signal = new AbortController().signal

describe('writeZip', () => {
  it('stores every file under its name, deflating text and keeping compressed formats as they are', async () => {
    const root = await folder()
    const files: Record<string, Buffer> = {
      'index.html': Buffer.from('<!doctype html>'.repeat(500)),
      'index.wasm': Buffer.concat([Buffer.from('\0asm'), Buffer.alloc(100_000)]),
      'index.png': randomBytes(5000),
      'assets/menü.json': Buffer.from('{"a":1}'),
      'empty.txt': Buffer.alloc(0),
    }
    await mkdir(join(root, 'assets'))
    for (const [name, data] of Object.entries(files)) await writeFile(join(root, name), data)
    const archive = join(await folder(), 'build.zip')
    const size = await writeZip(root, Object.keys(files), archive, signal)
    const bytes = await readFile(archive)
    expect(size).toBe(bytes.length)
    expect(size).toBeLessThan(Object.values(files).reduce((sum, data) => sum + data.length, 0))
    const entries = unzipSync(new Uint8Array(bytes))
    expect(Object.keys(entries).sort()).toEqual(Object.keys(files).sort())
    for (const [name, data] of Object.entries(files)) expect(Buffer.from(entries[name] as Uint8Array)).toEqual(data)
  })

  it('never overwrites an existing file', async () => {
    const root = await folder()
    await writeFile(join(root, 'index.html'), 'x')
    const archive = join(root, 'exists.zip')
    await writeFile(archive, 'keep')
    await expect(writeZip(root, ['index.html'], archive, signal)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(archive, 'utf8')).toBe('keep')
  })
})
