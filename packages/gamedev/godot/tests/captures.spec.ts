/** Capture files: names after the project and the time, marked folders, and holds that keep two saves off one path. */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureStem, holdCaptureFile, holdPath, markCaptureFolder, newScreenshotFile, SCREENSHOTS_GITIGNORE } from '../src/captures.ts'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-godot-captures-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('captureStem', () => {
  it('names a capture after the project, in characters that every file system takes, and the local time', () => {
    const now = new Date(2026, 10, 15, 9, 5, 3, 250)
    expect(captureStem({ dir: join(root, 'game'), name: 'My Game!' }, now)).toBe('My-Game_2026-11-15_09-05-03')
    expect(captureStem({ dir: join(root, 'space game') }, now)).toBe('space-game_2026-11-15_09-05-03')
    expect(captureStem({ dir: join(root, 'game'), name: '!!!' }, now)).toBe('game_2026-11-15_09-05-03')
  })

  it('cuts a long name, so a capture file\'s name stays within what file systems take', () => {
    const now = new Date(2026, 10, 15, 9, 5, 3)
    expect(captureStem({ dir: root, name: 'A'.repeat(240) }, now)).toBe(`${'A'.repeat(80)}_2026-11-15_09-05-03`)
    // A cut that ends between words leaves no dash behind.
    expect(captureStem({ dir: root, name: `${'A'.repeat(79)} B` }, now)).toBe(`${'A'.repeat(79)}_2026-11-15_09-05-03`)
  })
})

describe('newScreenshotFile', () => {
  it('holds new files in WASD Engine\'s marked screenshots folder and numbers the names that one second shares', async () => {
    const project = { dir: join(root, 'game'), name: 'Game' }
    const folder = join(root, 'game', '.wasdengine', 'screenshots')
    await mkdir(project.dir)
    const now = new Date(2026, 10, 15, 9, 5, 3)
    const first = await newScreenshotFile(project, now)
    const second = await newScreenshotFile(project, now)
    expect([first.path, second.path]).toEqual([join(folder, 'Game_2026-11-15_09-05-03.png'), join(folder, 'Game_2026-11-15_09-05-03_2.png')])
    expect(await readFile(join(folder, '.gdignore'), 'utf8')).toBe('')
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(SCREENSHOTS_GITIGNORE)
    await first.write(Buffer.from('image'))
    await second.release()
    // The folder stays, with its markers and the saved image; a name that a hold gave up is free again.
    expect((await readdir(folder)).sort()).toEqual(['.gdignore', '.gitignore', 'Game_2026-11-15_09-05-03.png'])
    expect(await readFile(first.path, 'utf8')).toBe('image')
    await first.release()
    expect(await readFile(first.path, 'utf8')).toBe('image')
    expect((await newScreenshotFile(project, now)).path).toBe(second.path)
    // Only the screenshots folder is marked.
    expect(await readdir(join(root, 'game', '.wasdengine'))).toEqual(['screenshots'])
    const long = await newScreenshotFile({ dir: project.dir, name: 'A'.repeat(240) }, now)
    expect(long.path).toBe(join(folder, `${'A'.repeat(80)}_2026-11-15_09-05-03.png`))
  })

  it('refuses a .wasdengine or screenshots entry that is not a folder, and leaves it as it is', async () => {
    const project = { dir: join(root, 'game'), name: 'Game' }
    const state = join(project.dir, '.wasdengine')
    const refusal = (path: string): string => `${path} is not a folder, so save cannot keep the image in ${join(state, 'screenshots')}; `
      + `move ${path} away, or pass path instead.`
    const now = new Date(2026, 10, 15, 9, 5, 3)
    await mkdir(project.dir)
    await writeFile(state, 'not a folder')
    await expect(newScreenshotFile(project, now)).rejects.toThrow(refusal(state))
    await rm(state)
    // A link is not a folder that WASD Engine made, even when it leads to one.
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), state)
    await expect(newScreenshotFile(project, now)).rejects.toThrow(refusal(state))
    expect(await readdir(join(root, 'elsewhere'))).toEqual([])
    await rm(state)
    await mkdir(state)
    await symlink(join(root, 'nowhere'), join(state, 'screenshots'))
    await expect(newScreenshotFile(project, now)).rejects.toThrow(refusal(join(state, 'screenshots')))
    expect(await readdir(state)).toEqual(['screenshots'])
  })
})

describe('markCaptureFolder', () => {
  it('writes the marker files that the folder lacks and leaves the others', async () => {
    await writeFile(join(root, '.gitignore'), '*\n')
    await markCaptureFolder(root, 'ignored\n')
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readFile(join(root, '.gdignore'), 'utf8')).toBe('')
    await expect(markCaptureFolder(join(root, 'missing'), 'x\n')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('holdCaptureFile', () => {
  it('refuses a folder, and a file that the call may not replace, and replaces one that it may', async () => {
    await expect(holdCaptureFile(root, true, '.png')).rejects.toThrow(`${root} is a folder; pass the path of a .png file.`)
    const path = join(root, 'shot.png')
    await writeFile(path, 'old')
    await expect(holdCaptureFile(path, false, '.png')).rejects.toThrow(`${path} already exists; pass replace: true to overwrite it, or choose another path.`)
    const replacing = await holdCaptureFile(path, true, '.png')
    await replacing.release()
    expect(await readFile(path, 'utf8')).toBe('old')
    await replacing.write(Buffer.from('new'))
    expect(await readFile(path, 'utf8')).toBe('new')
    await writeFile(join(root, 'file'), '')
    await expect(holdCaptureFile(join(root, 'file', 'shot.png'), false, '.png')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('holds a free path with an empty file, so a second hold of the path fails, until the first gives it up', async () => {
    const path = join(root, 'shots', 'deeper', 'shot.png')
    const held = await holdCaptureFile(path, false, '.png')
    expect(await readFile(path, 'utf8')).toBe('')
    await expect(holdCaptureFile(path, false, '.png')).rejects.toThrow(`${path} already exists; pass replace: true to overwrite it`)
    await held.release()
    // The hold made the folders, so it removes them too.
    expect(existsSync(join(root, 'shots'))).toBe(false)
    const again = await holdCaptureFile(path, false, '.png')
    await again.write(Buffer.from('image'))
    await again.release()
    expect(await readFile(path, 'utf8')).toBe('image')
  })
})

describe('holdPath', () => {
  it('reports a taken path, and leaves what other writers made when it gives the path up', async () => {
    await mkdir(join(root, 'shots'))
    await writeFile(join(root, 'shots', 'taken.png'), '')
    expect(await holdPath(join(root, 'shots', 'taken.png'))).toBeUndefined()
    const path = join(root, 'new', 'deeper', 'shot.png')
    const changed = await holdPath(path)
    await writeFile(path, 'written by another program')
    await changed?.release()
    expect(await readFile(path, 'utf8')).toBe('written by another program')
    await rm(join(root, 'new'), { recursive: true })
    const gone = await holdPath(path)
    await writeFile(join(root, 'new', 'other.png'), '')
    await rm(path)
    await gone?.release()
    // The deeper folder that only the hold used is gone; the one that holds another file stays.
    expect(existsSync(join(root, 'new', 'deeper'))).toBe(false)
    expect(await readdir(join(root, 'new'))).toEqual(['other.png'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('gives the path up without failing when it cannot remove the file', async () => {
    const folder = join(root, 'locked')
    await mkdir(folder)
    const hold = await holdPath(join(folder, 'shot.png'))
    await chmod(folder, 0o555)
    try {
      await expect(hold?.release()).resolves.toBeUndefined()
      expect(await readFile(join(folder, 'shot.png'), 'utf8')).toBe('')
    } finally {
      await chmod(folder, 0o755)
    }
  })

  it('fails for a path that the file system refuses, and removes the folders it made for it', async () => {
    await expect(holdPath(join(root, 'new', `${'x'.repeat(300)}.png`))).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(existsSync(join(root, 'new'))).toBe(false)
  })
})
