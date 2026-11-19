/** Folder listings for reports: relative `/` paths in name order, capped, with the full count. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFolderFiles } from '../src/folder-files.ts'
import { temporaryDirectory } from './harness.ts'

describe('listFolderFiles', () => {
  it('names the files of the folder and its subfolders in name order, without the folders', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-files-')
    await mkdir(join(root, 'shots', 'empty'), { recursive: true })
    await writeFile(join(root, 'report.json'), '{}')
    await writeFile(join(root, 'shots', 'b.png'), '')
    await writeFile(join(root, 'shots', 'a.png'), '')
    expect(await listFolderFiles(root, 10)).toEqual({ files: ['report.json', 'shots/a.png', 'shots/b.png'], totalFiles: 3 })
  })

  it('names at most the limit and counts every file', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-files-')
    for (const name of ['c', 'a', 'b']) await writeFile(join(root, name), '')
    expect(await listFolderFiles(root, 2)).toEqual({ files: ['a', 'b'], totalFiles: 3 })
  })

  it('finds no files in a folder that is gone', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-files-')
    expect(await listFolderFiles(join(root, 'deleted'), 10)).toEqual({ files: [], totalFiles: 0 })
  })

  it('fails when the path is not a folder', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-files-')
    await writeFile(join(root, 'file'), '')
    await expect(listFolderFiles(join(root, 'file'), 10)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
