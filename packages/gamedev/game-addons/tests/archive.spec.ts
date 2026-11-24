/** Pinned archive downloads, the archive cache, the archives the Desktop app ships, and unpacking one folder of an archive. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledArchivesDir, cachedArchive, GameAddonArchiveError, readArchiveFile, unpackFolder, type ArchiveDownloads } from '../src/archive.ts'
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
    const local = await cachedArchive(archive, { cacheDir, fetch: downloads.fetch }, signal)
    expect(local).toEqual({ path: join(cacheDir, `${archive.sha256}.zip`), bundled: false })
    expect(new Uint8Array(await readFile(local.path))).toEqual(CAMERA_ARCHIVE)
    expect(await cachedArchive(archive, { cacheDir, fetch: downloads.fetch }, signal)).toEqual(local)
    expect(downloads.requests).toEqual([URLS.camera])
    expect(await readdir(cacheDir)).toEqual([`${archive.sha256}.zip`])
  })

  it('reads an archive that the Desktop app ships in place, and downloads one whose shipped file has another size', async () => {
    dir = await scratch('archive')
    const downloads = fakeDownloads()
    const cacheDir = join(dir.root, 'archives')
    const bundledDir = join(dir.root, 'shipped')
    await mkdir(bundledDir)
    const archive = pin(URLS.camera, CAMERA_ARCHIVE, '')
    const shipped = join(bundledDir, `${archive.sha256}.zip`)
    await writeFile(shipped, CAMERA_ARCHIVE)
    expect(await cachedArchive(archive, { cacheDir, bundledDir, fetch: downloads.fetch }, signal)).toEqual({ path: shipped, bundled: true })
    expect(downloads.requests).toEqual([])
    await writeFile(shipped, 'not the pinned archive')
    expect(await cachedArchive(archive, { cacheDir, bundledDir, fetch: downloads.fetch }, signal))
      .toEqual({ path: join(cacheDir, `${archive.sha256}.zip`), bundled: false })
    expect(downloads.requests).toEqual([URLS.camera])
  })

  it('finds the shipped archives of a packaged app outside app.asar', () => {
    const resources = join('/', 'Applications', 'WASD Engine.app', 'Contents', 'Resources')
    expect(bundledArchivesDir(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-game-addons')))
      .toBe(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-game-addons', 'archives'))
    expect(bundledArchivesDir(join('/', 'repo', 'packages', 'gamedev', 'game-addons'))).toBe(join('/', 'repo', 'packages', 'gamedev', 'game-addons', 'archives'))
  })

  it('refuses an archive whose digest, size, or response differs from the pin and keeps nothing', async () => {
    dir = await scratch('archive')
    const cacheDir = join(dir.root, 'archives')
    const archive = pin(URLS.camera, CAMERA_ARCHIVE, '')
    const tampered = CAMERA_ARCHIVE.slice()
    tampered[10] = (tampered[10] ?? 0) ^ 0xff
    // Each refusal of a download that differs from its pin, with its message and then its class and code.
    const serving = (bytes: Uint8Array): ArchiveDownloads => ({ cacheDir, fetch: fakeDownloads({ [URLS.camera]: bytes }).fetch })
    const corrupt = { name: 'GameAddonArchiveError', code: 'GAME_ADDON_ARCHIVE_CORRUPT' }
    await expect(cachedArchive(archive, serving(tampered), signal)).rejects.toThrow(/does not match the SHA-256 the catalog pins/u)
    await expect(cachedArchive(archive, serving(tampered), signal)).rejects.toMatchObject(corrupt)
    await expect(cachedArchive(archive, serving(CAMERA_ARCHIVE.slice(0, 100)), signal)).rejects.toThrow(/arrived with 100 bytes/u)
    await expect(cachedArchive(archive, serving(CAMERA_ARCHIVE.slice(0, 100)), signal)).rejects.toMatchObject(corrupt)
    await expect(cachedArchive({ ...archive, bytes: 100 }, serving(CAMERA_ARCHIVE), signal)).rejects.toThrow(/larger than the 100 bytes/u)
    await expect(cachedArchive({ ...archive, bytes: 100 }, serving(CAMERA_ARCHIVE), signal)).rejects.toMatchObject(corrupt)
    const failed = { name: 'GameAddonArchiveError', code: 'GAME_ADDON_DOWNLOAD_FAILED' }
    await expect(cachedArchive(archive, { cacheDir, fetch: fakeDownloads({}).fetch }, signal)).rejects.toThrow(/HTTP 404/u)
    await expect(cachedArchive(archive, { cacheDir, fetch: fakeDownloads({}).fetch }, signal)).rejects.toMatchObject(failed)
    const offline = new Error('offline')
    const unreachable: ArchiveDownloads = { cacheDir, fetch: () => Promise.reject(offline) }
    await expect(cachedArchive(archive, unreachable, signal)).rejects.toThrow(/failed: offline/u)
    await expect(cachedArchive(archive, unreachable, signal)).rejects.toMatchObject({ ...failed, cause: offline })
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
    await expect(readArchiveFile(archivePath, 'nope')).rejects.toMatchObject({ name: 'GameAddonArchiveError', code: 'GAME_ADDON_CATALOG_INVALID' })
    const whole = join(dir.root, 'whole')
    expect(await unpackFolder(archivePath, '', whole, signal)).toContain('camera-1.2.0/README.md')
    expect(await readdir(whole)).toEqual(['camera-1.2.0'])
  })

  it('refuses entries that leave the folder, an empty root, a damaged archive, and an existing destination', async () => {
    dir = await scratch('unpack')
    const evil = join(dir.root, 'evil.zip')
    await writeFile(evil, zip({ 'root/../../escape.txt': 'x' }))
    await expect(unpackFolder(evil, 'root', join(dir.root, 'e1'), signal)).rejects.toThrow(/would leave the add-on folder/u)
    await expect(unpackFolder(evil, 'root', join(dir.root, 'e1'), signal)).rejects.toMatchObject({ name: 'GameAddonArchiveError', code: 'GAME_ADDON_ARCHIVE_CORRUPT' })
    const archivePath = join(dir.root, 'a.zip')
    await writeFile(archivePath, CAMERA_ARCHIVE)
    await expect(unpackFolder(archivePath, 'missing', join(dir.root, 'e2'), signal)).rejects.toThrow(/no files under missing/u)
    await expect(unpackFolder(archivePath, 'missing', join(dir.root, 'e2'), signal)).rejects.toMatchObject({ name: 'GameAddonArchiveError', code: 'GAME_ADDON_CATALOG_INVALID' })
    const damaged = join(dir.root, 'damaged.zip')
    await writeFile(damaged, 'not a zip')
    await expect(unpackFolder(damaged, '', join(dir.root, 'e3'), signal)).rejects.toThrow(GameAddonArchiveError)
    await expect(unpackFolder(damaged, '', join(dir.root, 'e3'), signal)).rejects.toMatchObject({ name: 'GameAddonArchiveError', code: 'GAME_ADDON_ARCHIVE_CORRUPT' })
    await expect(unpackFolder(archivePath, 'camera-1.2.0', dir.root, signal)).rejects.toThrow(/EEXIST/u)
  })
})
