/** Payload copies: content-addressed, idempotent, atomic, and readable as ordinary files. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { materializePayload } from '../src/materialize.ts'
import { temporaryDirectory } from './harness.ts'

async function shipped(directory: string, name: string, content: string): Promise<URL> {
  const path = join(directory, name)
  await writeFile(path, content)
  return pathToFileURL(path)
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

describe('materializePayload', () => {
  it('copies the file under its content hash and returns the real path', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    const source = await shipped(root, 'wasd_worker.py', 'print("hello")\n')
    const copy = await materializePayload(source, join(root, 'data'))
    expect(copy).toBe(join(await realpath(root), 'data', 'payload', digest('print("hello")\n'), 'wasd_worker.py'))
    expect(await readFile(copy, 'utf8')).toBe('print("hello")\n')
    const reference = join(root, 'reference')
    await writeFile(reference, '', { mode: 0o644 })
    expect((await stat(copy)).mode & 0o777).toBe((await stat(reference)).mode & 0o777)
  })

  it('reuses an identical copy without rewriting it', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    const source = await shipped(root, 'harness.gd', 'extends SceneTree\n')
    const first = await materializePayload(source, root)
    const before = await stat(first)
    const second = await materializePayload(source, root)
    expect(second).toBe(first)
    expect((await stat(second)).ino).toBe(before.ino)
    expect(await readdir(join(root, 'payload', digest('extends SceneTree\n')))).toEqual(['harness.gd'])
  })

  it('gives each content version its own directory', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    const shippedDir = join(root, 'shipped')
    await mkdir(shippedDir)
    const one = await materializePayload(await shipped(shippedDir, 'worker.py', 'v1'), root)
    const two = await materializePayload(await shipped(shippedDir, 'worker.py', 'v2'), root)
    expect(one).not.toBe(two)
    expect(await readFile(one, 'utf8')).toBe('v1')
    expect(await readFile(two, 'utf8')).toBe('v2')
  })

  it('replaces a copy whose bytes changed', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    const source = await shipped(root, 'worker.py', 'original')
    const copy = await materializePayload(source, root)
    await writeFile(copy, 'tampered')
    expect(await materializePayload(source, root)).toBe(copy)
    expect(await readFile(copy, 'utf8')).toBe('original')
  })

  it('resolves symlinks in the data root', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'link'))
    const copy = await materializePayload(await shipped(root, 'worker.py', 'linked'), join(root, 'link'))
    expect(copy).toBe(join(await realpath(root), 'real', 'payload', digest('linked'), 'worker.py'))
  })

  it('removes its temporary file when the copy cannot be put in place', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    const source = await shipped(root, 'worker.py', 'blocked')
    const directory = join(root, 'payload', digest('blocked'))
    // A non-empty directory where the copy belongs makes the rename fail.
    await mkdir(join(directory, 'worker.py', 'occupied'), { recursive: true })
    await expect(materializePayload(source, root)).rejects.toMatchObject({ syscall: 'rename' })
    expect(await readdir(directory)).toEqual(['worker.py'])
  })

  it('rejects a source that is not a file URL', async () => {
    await expect(materializePayload(new URL('https://example.com/worker.py'), '/tmp')).rejects.toThrow(TypeError)
  })

  it('reports a missing source', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-payload-')
    await expect(materializePayload(pathToFileURL(join(root, 'absent.py')), root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
