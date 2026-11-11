/** Pinned archive downloads, the archive cache, and unpacking one folder of an archive. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedArchive, GameAddonArchiveError, readArchiveFile, unpackFolder } from '../src/archive.ts'
import { CAMERA_ARCHIVE, fakeDownloads, pin, scratch, URLS, zip, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

describe('cachedArchive', () => {
  it('downloads a pinned archive once into the cache by its SHA-256', async () => {
    dir = await scratch('archive')
    const downloads = fakeDownloads()
    const cacheDir = join(dir.root, 'archives')
    const archive = pin(URLS.camera, CAMERA_ARCHIVE, '')
    const path = await cachedArchive(archive, { cacheDir, fetch: downloads.fetch }, signal)
    expect(path).toBe(join(cacheDir, `${archive.sha256}.zip`))
    expect(new Uint8Array(await readFile(path))).toEqual(CAMERA_ARCHIVE)
    expect(await cachedArchive(archive, { cacheDir, fetch: downloads.fetch }, signal)).toBe(path)
    expect(downloads.requests).toEqual([URLS.camera])
    expect(await readdir(cacheDir)).toEqual([`${archive.sha256}.zip`])
  })

  it('refuses an archive whose digest, size, or response differs from the pin and keeps nothing', async () => {
    dir = await scratch('archive')
    const cacheDir = join(dir.root, 'archives')
    const archive = pin(URLS.camera, CAMERA_ARCHIVE, '')
    const tampered = CAMERA_ARCHIVE.slice()
    tampered[10] = (tampered[10] ?? 0) ^ 0xff
    await expect(cachedArchive(archive, { cacheDir, fetch: fakeDownloads({ [URLS.camera]: tampered }).fetch }, signal))
      .rejects.toThrow(/does not match the SHA-256 the catalog pins/u)
    await expect(cachedArchive(archive, { cacheDir, fetch: fakeDownloads({ [URLS.camera]: CAMERA_ARCHIVE.slice(0, 100) }).fetch }, signal))
      .rejects.toThrow(/arrived with 100 bytes/u)
    await expect(cachedArchive({ ...archive, bytes: 100 }, { cacheDir, fetch: fakeDownloads().fetch }, signal))
      .rejects.toThrow(/larger than the 100 bytes/u)
    await expect(cachedArchive(archive, { cacheDir, fetch: fakeDownloads({}).fetch }, signal)).rejects.toThrow(/HTTP 404/u)
    await expect(cachedArchive(archive, { cacheDir, fetch: () => Promise.reject(new Error('offline')) }, signal)).rejects.toThrow(/failed: offline/u)
    expect(await readdir(cacheDir)).toEqual([])
  })
})

describe('unpackFolder', () => {
  it('writes the files below the root, without macOS metadata, and reads single files', async () => {
    dir = await scratch('unpack')
    const archivePath = join(dir.root, 'a.zip')
    await writeFile(archivePath, CAMERA_ARCHIVE)
    const target = join(dir.root, 'out')
    expect(await unpackFolder(archivePath, 'camera-1.2.0/addons/test_camera', target, signal)).toEqual(['manager.gd', 'nodes/rig.gd', 'plugin.cfg', 'plugin.gd'])
    expect(await readFile(join(target, 'nodes', 'rig.gd'), 'utf8')).toBe('class_name TestRig\nextends Node3D\n')
    expect(new TextDecoder().decode(await readArchiveFile(archivePath, 'camera-1.2.0/LICENSE'))).toContain('Test Author')
    await expect(readArchiveFile(archivePath, 'nope')).rejects.toThrow(/no file nope/u)
    const whole = join(dir.root, 'whole')
    expect(await unpackFolder(archivePath, '', whole, signal)).toContain('camera-1.2.0/README.md')
    expect(await readdir(whole)).toEqual(['camera-1.2.0'])
  })

  it('refuses entries that leave the folder, an empty root, a damaged archive, and an existing destination', async () => {
    dir = await scratch('unpack')
    const evil = join(dir.root, 'evil.zip')
    await writeFile(evil, zip({ 'root/../../escape.txt': 'x' }))
    await expect(unpackFolder(evil, 'root', join(dir.root, 'e1'), signal)).rejects.toThrow(/would leave the add-on folder/u)
    const archivePath = join(dir.root, 'a.zip')
    await writeFile(archivePath, CAMERA_ARCHIVE)
    await expect(unpackFolder(archivePath, 'missing', join(dir.root, 'e2'), signal)).rejects.toThrow(/no files under missing/u)
    const damaged = join(dir.root, 'damaged.zip')
    await writeFile(damaged, 'not a zip')
    await expect(unpackFolder(damaged, '', join(dir.root, 'e3'), signal)).rejects.toThrow(GameAddonArchiveError)
    await expect(unpackFolder(archivePath, 'camera-1.2.0', dir.root, signal)).rejects.toThrow(/EEXIST/u)
  })
})
