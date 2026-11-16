/**
 * The temporary folders where connected agents keep throwaway work: the system's by default, and a path is in one when
 * its canonical spelling is the folder or below it, whether or not the path exists yet.
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { inTemporaryFolder, systemTemporaryFolders, within } from '../src/temporary-folders.ts'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-mcp-temporary-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('systemTemporaryFolders', () => {
  it('names the Host\'s temporary folder, and outside Windows /tmp and /var/tmp, for the Host\'s platform by default', () => {
    expect(systemTemporaryFolders('win32')).toEqual([tmpdir()])
    expect(systemTemporaryFolders('darwin')).toEqual(expect.arrayContaining([tmpdir(), '/tmp', '/var/tmp']))
    expect(systemTemporaryFolders()).toEqual(systemTemporaryFolders(process.platform))
  })

  it.runIf(process.platform !== 'win32')('names each folder once, as when the Host\'s temporary folder is /tmp', () => {
    vi.stubEnv('TMPDIR', '/tmp')
    onTestFinished(() => { vi.unstubAllEnvs() })
    expect(systemTemporaryFolders('linux')).toEqual(['/tmp', '/var/tmp'])
  })
})

describe('within', () => {
  it('holds the folder and the paths below it, and not a sibling whose name starts the same', () => {
    const folder = join(root, 'tmp')
    expect(within(folder, folder)).toBe(true)
    expect(within(folder, join(folder, 'game', 'art'))).toBe(true)
    expect(within(`${folder}${sep}`, join(folder, 'game'))).toBe(true)
    expect(within(folder, `${folder}-other`)).toBe(false)
    expect(within(folder, root)).toBe(false)
  })
})

describe('inTemporaryFolder', () => {
  it('finds paths in a temporary folder, through a symbolic link and before they exist, and nothing outside it', async () => {
    const real = join(root, 'private', 'tmp')
    await mkdir(join(real, 'game'), { recursive: true })
    await mkdir(join(root, 'Documents'))
    // A junction on Windows, which needs no privilege; other systems ignore the type.
    await symlink(real, join(root, 'tmp'), 'junction')
    const folders = [join(root, 'tmp')]
    for (const path of [real, join(real, 'game'), join(root, 'tmp', 'game'), join(root, 'tmp', 'new', 'folders'), join(real, 'missing')]) {
      expect(await inTemporaryFolder(folders, path), path).toBe(true)
    }
    for (const path of [root, join(root, 'Documents'), join(root, 'Documents', 'missing'), join(root, 'tmp-other')]) {
      expect(await inTemporaryFolder(folders, path), path).toBe(false)
    }
    // A temporary folder that does not exist holds the paths below its spelling.
    expect(await inTemporaryFolder([join(root, 'gone')], join(root, 'gone', 'game'))).toBe(true)
    expect(await inTemporaryFolder([], real)).toBe(false)
  })
})
