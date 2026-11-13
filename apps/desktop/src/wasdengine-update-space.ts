/**
 * The free-space check of WASD Engine's automatic update downloads (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes). Before `WasdengineUpdateDownloads` starts an automatic download, it compares the space free on the volume
 * of electron-updater's cache folder with the bytes the download writes there plus a reserve, so a nearly full disk is
 * never filled by a download that would fail with `ENOSPC`. The check reads electron-updater 6's cache layout: the
 * `pending/` folder with its `update-info.json`, and on macOS `update.zip`.
 */
import { lstatSync, readFileSync, readdirSync, statfsSync, type Stats, type StatsFs } from 'node:fs'
import { dirname, join } from 'node:path'
import electronUpdater, { type UpdateFileInfo, type UpdateInfo } from 'electron-updater'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter.js'
import { WASDENGINE_DESKTOP_BRAND } from './wasdengine-brand.ts'

/** Space that an automatic download leaves free for the rest of the computer, such as Session logs and game projects. */
export const WASDENGINE_UPDATE_SPACE_RESERVE = 1024 ** 3

/**
 * electron-updater's cache folder: the user's cache folder (`~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows)
 * joined with the `updaterCacheDirName` that electron-builder writes into `app-update.yml`, the packaged manifest's name
 * with `-updater` appended.
 */
export const WASDENGINE_UPDATER_CACHE = join(getAppCacheDir(), `${WASDENGINE_DESKTOP_BRAND.packageName}-updater`)

/** The fields of the update a check found that the measurement reads: its version and the files the feed lists. */
export type WasdengineFoundUpdate = Pick<UpdateInfo, 'version' | 'files'>

/** The event of electron-updater's `AppUpdater` that reports the update a check found. */
export interface WasdengineUpdateAvailableEvents {
  on(event: 'update-available', listener: (info: WasdengineFoundUpdate) => void): unknown
  off(event: 'update-available', listener: (info: WasdengineFoundUpdate) => void): unknown
}

/** What an automatic download of one version needs on the updater cache's volume, and what that volume has free. */
export interface WasdengineUpdateSpaceReading {
  /** Bytes the download writes, plus {@link WASDENGINE_UPDATE_SPACE_RESERVE}. */
  readonly needed: number
  /**
   * Bytes free to the user on the volume, plus the bytes of an earlier download that this one deletes or overwrites
   * first: electron-updater empties `pending/` before it downloads another update, and on macOS it replaces `update.zip`.
   */
  readonly free: number
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A regular file's size, or 0 when the path holds no file. */
function fileBytes(path: string): number {
  let stats: Stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
  return stats.isFile() ? stats.size : 0
}

/**
 * Bytes that downloading an update writes into electron-updater's cache folder.
 * @param files - The files that the feed lists for the update, with the sizes it gives.
 * @param platform - Platform of the running application.
 * @returns The size of the largest listed file; twice that on macOS, where electron-updater also copies the downloaded
 *   archive to `update.zip`, the base of the next differential download; undefined when no file has a valid size.
 */
export function wasdengineUpdateBytes(files: readonly Pick<UpdateFileInfo, 'size'>[], platform: NodeJS.Platform): number | undefined {
  const sizes = files.map(file => file.size).filter((size): size is number => typeof size === 'number' && Number.isSafeInteger(size) && size > 0)
  if (sizes.length === 0) return undefined
  return Math.max(...sizes) * (platform === 'darwin' ? 2 : 1)
}

/**
 * Remembers the files of the update that the updater's last check found, from its `update-available` event, and
 * measures whether a download of that update fits on the cache folder's volume.
 */
export class WasdengineUpdateSpace {
  private found: WasdengineFoundUpdate | undefined
  private readonly onAvailable = (info: WasdengineFoundUpdate): void => { this.found = info }

  /**
   * @param updater - Process-owned Electron updater, the one the update coordinator checks with; the object listens to
   *   its `update-available` event until {@link dispose}.
   * @param folder - electron-updater's cache folder; before its first download the folder does not exist, and its
   *   parent, on the same volume, is measured instead.
   * @param platform - Platform of the running application.
   * @param statfs - Reads a volume's statistics.
   */
  constructor(
    private readonly updater: WasdengineUpdateAvailableEvents = electronUpdater.autoUpdater,
    private readonly folder: string = WASDENGINE_UPDATER_CACHE,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly statfs: (path: string) => Pick<StatsFs, 'bavail' | 'bsize'> = statfsSync,
  ) {
    updater.on('update-available', this.onAvailable)
  }

  /**
   * Measure what an automatic download of one version needs and finds.
   * @param version - Version that the coordinator published as available.
   * @returns The bytes needed and free, or undefined when the last check found another version, the feed lists no file
   *   size, the cache already holds this update's download, which electron-updater reuses without writing, or the cache
   *   or its volume cannot be read; the download then starts without the check, and its own failure is reported.
   */
  measure(version: string): WasdengineUpdateSpaceReading | undefined {
    const info = this.found
    if (info?.version !== version) return undefined
    const bytes = wasdengineUpdateBytes(info.files, this.platform)
    if (bytes === undefined) return undefined
    try {
      if (this.downloaded(info.files)) return undefined
      return { needed: bytes + WASDENGINE_UPDATE_SPACE_RESERVE, free: this.freeBytes() + this.replacedBytes() }
    } catch (error) {
      console.error('desktop update: could not read the free space of the update cache', error)
      return undefined
    }
  }

  /** Stop listening to the updater. */
  dispose(): void {
    this.updater.off('update-available', this.onAvailable)
  }

  /** Whether `pending/update-info.json` names a file of this update, whose download electron-updater then reuses. */
  private downloaded(files: readonly Pick<UpdateFileInfo, 'sha512'>[]): boolean {
    let text: string
    try {
      text = readFileSync(join(this.folder, 'pending', 'update-info.json'), 'utf8')
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    const record: unknown = JSON.parse(text)
    const sha512 = typeof record === 'object' && record !== null && 'sha512' in record ? record.sha512 : undefined
    return typeof sha512 === 'string' && files.some(file => file.sha512 === sha512)
  }

  private freeBytes(): number {
    let volume: Pick<StatsFs, 'bavail' | 'bsize'>
    try { volume = this.statfs(this.folder) } catch (error) {
      if (!isMissing(error)) throw error
      volume = this.statfs(dirname(this.folder))
    }
    return volume.bavail * volume.bsize
  }

  /** Bytes of an earlier download that a download of another update deletes or overwrites before it needs the space. */
  private replacedBytes(): number {
    const pending = join(this.folder, 'pending')
    let names: string[]
    try {
      names = readdirSync(pending)
    } catch (error) {
      if (!isMissing(error)) throw error
      names = []
    }
    const archive = this.platform === 'darwin' ? fileBytes(join(this.folder, 'update.zip')) : 0
    return names.reduce((total, name) => total + fileBytes(join(pending, name)), archive)
  }
}
