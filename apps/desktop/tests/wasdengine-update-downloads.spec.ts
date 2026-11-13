/**
 * WASDEngine fork spec for automatic update downloads: each available update that fits on the disk downloads on its own,
 * a failed download retries with backoff a bounded number of times, and the indicator offers Restart to Update for a
 * downloaded update and Retry update once the automatic attempts have stopped or the update does not fit.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as settings from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import * as desktop from '../src/locale.ts'
import { presentDesktopUpdate } from '../src/update-presentation.ts'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'
import { WASDENGINE_UPDATE_DOWNLOAD_ATTEMPTS, WasdengineUpdateDownloads } from '../src/wasdengine-update-downloads.ts'
import {
  WASDENGINE_UPDATER_CACHE, WASDENGINE_UPDATE_SPACE_RESERVE, WasdengineUpdateSpace, wasdengineUpdateBytes,
  type WasdengineFoundUpdate, type WasdengineUpdateSpaceReading,
} from '../src/wasdengine-update-space.ts'

const VERSION = '0.1.2'
const CONFIG = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0 }
const LANGUAGES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
const GIB = 1024 ** 3

let state: DesktopUpdateState
let allowed: boolean
let revision: number
const download = vi.fn(async (_version: string, _revision?: number): Promise<DesktopUpdateState> => state)
const recheck = vi.fn(async (): Promise<DesktopUpdateState> => state)
const updates = { get state() { return state }, get revision() { return revision }, download }
const space = { measure: vi.fn((_version: string): WasdengineUpdateSpaceReading | undefined => undefined), dispose: vi.fn() }

/** Publish one state as the coordinator does: the shell passes it on before it presents it. */
function publish(downloads: WasdengineUpdateDownloads, next: DesktopUpdateState): void {
  state = next
  downloads.published(next)
}

/** What the indicator presents for the state that was published last, as the shell sends it to the Web UI. */
function presented(downloads: WasdengineUpdateDownloads): ReturnType<typeof presentDesktopUpdate> {
  return presentDesktopUpdate(downloads.indicator(state))
}

function failed(version = VERSION, downloadFailure?: DesktopUpdateState['downloadFailure']): DesktopUpdateState {
  return { phase: 'error', failedOperation: 'download', version, message: 'net::ERR_CONNECTION_RESET',
    ...downloadFailure === undefined ? {} : { downloadFailure } }
}

function create(attempts?: number): WasdengineUpdateDownloads {
  return new WasdengineUpdateDownloads(() => updates, CONFIG, () => allowed, recheck, space, Math.random, attempts)
}

beforeEach(() => {
  vi.useFakeTimers()
  state = { phase: 'idle' }
  allowed = true
  revision = 3
  download.mockClear()
  recheck.mockClear()
  space.measure.mockReset().mockReturnValue(undefined)
  space.dispose.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the update indicator', () => {
  it.each([
    ['no update', { phase: 'idle' }],
    ['a channel switch check', { phase: 'checking' }],
    ['an available update', { phase: 'available', version: VERSION }],
    ['a download', { phase: 'downloading', version: VERSION, percent: 40 }],
    ['a verification', { phase: 'verifying', version: VERSION, percent: 100 }],
    ['a failed check', { phase: 'error', failedOperation: 'check', message: 'net::ERR_INTERNET_DISCONNECTED' }],
    ['a failed download whose retry is pending', failed()],
    ['a download that an unwritable or locked file failed, whose retry is pending', failed(VERSION, 'permission')],
    ['a failed installation without a target', { phase: 'error', failedOperation: 'install', message: 'no target' }],
  ] satisfies Array<[string, DesktopUpdateState]>)('hides %s', (_name, next) => {
    const downloads = create()
    publish(downloads, next)
    expect(downloads.indicator(next)).toEqual({ phase: 'idle' })
    expect(presented(downloads)).toEqual({ phase: 'idle' })
  })

  it.each([
    ['a downloaded update', { phase: 'ready', version: VERSION }],
    ['a restart in preparation', { phase: 'installing', version: VERSION }],
    ['a configuration failure', { phase: 'error', failedOperation: 'configuration', message: '/settings.json' }],
  ] satisfies Array<[string, DesktopUpdateState]>)('presents %s as it is', (_name, next) => {
    const downloads = create()
    publish(downloads, next)
    expect(downloads.indicator(next)).toBe(next)
  })

  it('offers Restart to Update again after an installation fails', () => {
    const downloads = create()
    publish(downloads, { phase: 'error', failedOperation: 'install', version: VERSION,
      message: 'New tasks have started.', preparationFailure: 'tasks-changed' })
    expect(presented(downloads)).toEqual({ phase: 'ready', version: VERSION })
  })

  it('offers Retry update with the reason once the automatic attempts of a version stop', async () => {
    const downloads = create()
    publish(downloads, failed())
    expect(presented(downloads)).toEqual({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    publish(downloads, failed(VERSION, 'permission'))
    expect(presented(downloads)).toEqual({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(2 * CONFIG.intervalMs)
    const last = failed(VERSION, 'permission')
    publish(downloads, last)
    expect(downloads.indicator(last)).toBe(last)
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-permission' })
  })

  it('offers Retry update at once after a full disk', () => {
    const downloads = create()
    publish(downloads, failed(VERSION, 'space'))
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-space' })
  })

  it('hides again while the user\'s retry downloads, and offers Retry update again when it fails', () => {
    const downloads = create(1)
    publish(downloads, failed())
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-network' })
    publish(downloads, { phase: 'downloading', version: VERSION, percent: 0 })
    expect(presented(downloads)).toEqual({ phase: 'idle' })
    publish(downloads, failed())
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-network' })
    publish(downloads, { phase: 'ready', version: VERSION })
    expect(presented(downloads)).toEqual({ phase: 'ready', version: VERSION })
  })

  it.each(LANGUAGES)('names the indicator label in the %s update dialogs', (language) => {
    const label = settings[language]['desktop.update.ready']
    const messages = desktop[language]
    expect(messages.updateDetail).toContain(label)
    expect(messages.updateDownloadDetail).toContain(label)
  })

  it('labels the indicator Restart to Update, and Retry update after a failure', () => {
    expect(settings.en['desktop.update.ready']).toBe('Restart to Update')
    expect(settings.en['desktop.update.retry']).toBe('Retry update')
  })
})

describe('automatic downloads', () => {
  it('starts downloading an available update once the publishing operation settles', async () => {
    const downloads = create()
    publish(downloads, { phase: 'available', version: VERSION })
    expect(download).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(download).toHaveBeenCalledExactlyOnceWith(VERSION, 3)
  })

  it('starts nothing while downloads are not allowed or once the update is gone', async () => {
    const downloads = create()
    allowed = false
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(0)
    allowed = true
    downloads.published({ phase: 'available', version: VERSION })
    state = { phase: 'idle' }
    await vi.advanceTimersByTimeAsync(0)
    expect(download).not.toHaveBeenCalled()
  })

  it('retries a failed download with a fresh check, doubling the delay up to the maximum backoff', async () => {
    const downloads = create(6)
    for (const [attempt, delay] of [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000].entries()) {
      publish(downloads, failed())
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(recheck).toHaveBeenCalledTimes(attempt)
      await vi.advanceTimersByTimeAsync(1)
      expect(recheck).toHaveBeenCalledTimes(attempt + 1)
    }
    expect(download).not.toHaveBeenCalled()
  })

  it.each([
    ['a download completes', { phase: 'ready', version: VERSION }],
    ['a check finds no update', { phase: 'idle' }],
  ] satisfies Array<[string, DesktopUpdateState]>)('cancels the retry and restarts the backoff once %s', async (_name, settled) => {
    const downloads = create()
    publish(downloads, failed())
    publish(downloads, failed())
    publish(downloads, settled)
    await vi.advanceTimersByTimeAsync(CONFIG.maxBackoffMs)
    expect(recheck).not.toHaveBeenCalled()
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs - 1)
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('counts a republished failure once', async () => {
    const downloads = create()
    const failure = failed()
    publish(downloads, failure)
    downloads.published(failure)
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('jitters each retry within the configured fraction', async () => {
    const downloads = new WasdengineUpdateDownloads(() => updates, { ...CONFIG, jitter: 0.2 }, () => allowed, recheck, space, () => 0)
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(479_999)
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('drops a pending retry when the failure was superseded, the installation began, or the process quits', async () => {
    const downloads = create(10)
    publish(downloads, failed())
    publish(downloads, { phase: 'error', failedOperation: 'check', message: 'net::ERR_INTERNET_DISCONNECTED' })
    publish(downloads, failed())
    publish(downloads, { phase: 'installing', version: VERSION })
    publish(downloads, failed())
    allowed = false
    await vi.advanceTimersByTimeAsync(CONFIG.maxBackoffMs)
    allowed = true
    publish(downloads, failed())
    downloads.dispose()
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(CONFIG.maxBackoffMs)
    expect(recheck).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads one version at most three times in a run, then leaves the update to Retry update', async () => {
    expect(WASDENGINE_UPDATE_DOWNLOAD_ATTEMPTS).toBe(3)
    const downloads = create()
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(2 * CONFIG.intervalMs)
    expect(recheck).toHaveBeenCalledTimes(2)
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(10 * CONFIG.maxBackoffMs)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-network' })
    // The user's own check publishes the update again; its download starts, and its failure schedules nothing.
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(0)
    expect(download).toHaveBeenCalledExactlyOnceWith(VERSION, 3)
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(10 * CONFIG.maxBackoffMs)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-network' })
  })

  it('stops retrying at once after a full disk', async () => {
    const downloads = create()
    publish(downloads, failed(VERSION, 'space'))
    await vi.advanceTimersByTimeAsync(10 * CONFIG.maxBackoffMs)
    expect(recheck).not.toHaveBeenCalled()
  })

  it.each(['permission', 'busy'] as const)('retries a %s failure like any other failure, up to the same limit', async (kind) => {
    // On Windows, an antivirus scan of the new installer can fail electron-updater's rename with EPERM (`permission`).
    const downloads = create()
    publish(downloads, failed(VERSION, kind))
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    expect(recheck).toHaveBeenCalledOnce()
    publish(downloads, failed(VERSION, kind))
    await vi.advanceTimersByTimeAsync(2 * CONFIG.intervalMs)
    expect(recheck).toHaveBeenCalledTimes(2)
    publish(downloads, failed(VERSION, kind))
    await vi.advanceTimersByTimeAsync(10 * CONFIG.maxBackoffMs)
    expect(recheck).toHaveBeenCalledTimes(2)
  })

  it('counts the failures of each version apart', async () => {
    const downloads = create()
    publish(downloads, failed())
    publish(downloads, failed())
    publish(downloads, failed('0.1.3'))
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs - 1)
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects %s automatic download attempts', (attempts) => {
    expect(() => create(attempts)).toThrow(RangeError)
  })

  it('logs a download the coordinator refuses and a retry check that throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    download.mockRejectedValueOnce(new Error('desktop update: download confirmation is stale'))
    recheck.mockRejectedValueOnce(new Error('desktop update: polling is disposed'))
    const downloads = create()
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(0)
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    expect(log.mock.calls.map(([message]) => String(message))).toEqual([
      'desktop update: automatic download did not start', 'desktop update: automatic download retry failed',
    ])
  })
})

describe('the free-space check of automatic downloads', () => {
  it('starts no download of an update that does not fit, and offers Retry update with the full disk', async () => {
    space.measure.mockReturnValue({ needed: 3 * GIB, free: 3 * GIB - 1 })
    const downloads = create()
    publish(downloads, { phase: 'available', version: VERSION })
    expect(space.measure).toHaveBeenCalledExactlyOnceWith(VERSION)
    await vi.advanceTimersByTimeAsync(CONFIG.maxBackoffMs)
    expect(download).not.toHaveBeenCalled()
    expect(recheck).not.toHaveBeenCalled()
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-space' })
  })

  it('measures again at each check that publishes the update, and downloads once it fits', async () => {
    space.measure.mockReturnValue({ needed: 3 * GIB, free: 2 * GIB })
    const downloads = create()
    publish(downloads, { phase: 'available', version: VERSION })
    space.measure.mockReturnValue({ needed: 3 * GIB, free: 3 * GIB })
    publish(downloads, { phase: 'available', version: VERSION })
    expect(presented(downloads)).toEqual({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    expect(download).toHaveBeenCalledExactlyOnceWith(VERSION, 3)
  })

  it('checks the update that the retry of a failed download publishes', async () => {
    const downloads = create()
    publish(downloads, failed())
    await vi.advanceTimersByTimeAsync(CONFIG.intervalMs)
    expect(recheck).toHaveBeenCalledOnce()
    space.measure.mockReturnValue({ needed: 3 * GIB, free: GIB })
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(CONFIG.maxBackoffMs)
    expect(download).not.toHaveBeenCalled()
    expect(presented(downloads)).toEqual({ phase: 'error', version: VERSION, failure: 'download-space' })
  })

  it('downloads an update whose space cannot be measured', async () => {
    const downloads = create()
    publish(downloads, { phase: 'available', version: VERSION })
    await vi.advanceTimersByTimeAsync(0)
    expect(space.measure).toHaveBeenCalledExactlyOnceWith(VERSION)
    expect(download).toHaveBeenCalledExactlyOnceWith(VERSION, 3)
  })

  it('stops measuring when disposed', () => {
    create().dispose()
    expect(space.dispose).toHaveBeenCalledOnce()
  })
})

describe('the free space of the updater cache', () => {
  /** A cache folder that does not exist, as before the first download, whose parent does not exist either. */
  const MISSING = join(tmpdir(), `wasdengine-update-space-${randomUUID()}`, 'wasdengine-desktop-updater')

  /** The update that one check finds, as electron-updater reports it with `update-available`. */
  function found(version: string, sizes: ReadonlyArray<number | undefined>): WasdengineFoundUpdate {
    return { version, files: sizes.map((size, index) => ({ url: `installer-${String(index)}`, sha512: 'digest', ...size === undefined ? {} : { size } })) }
  }

  it('counts the largest file that the feed lists, twice on macOS, which keeps a copy for differential downloads', () => {
    expect(wasdengineUpdateBytes([{ size: 800 }, { size: 900 }], 'win32')).toBe(900)
    expect(wasdengineUpdateBytes([{ size: 800 }, { size: 900 }], 'darwin')).toBe(1800)
    expect(wasdengineUpdateBytes([{}, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: Number.NaN }], 'win32')).toBeUndefined()
    expect(wasdengineUpdateBytes([], 'darwin')).toBeUndefined()
  })

  it('measures the update that the last check found against the free space of the cache volume', () => {
    const updater = new EventEmitter()
    const statfs = vi.fn((_path: string) => ({ bavail: 1_000, bsize: 4_096 }))
    const measured = new WasdengineUpdateSpace(updater, MISSING, 'win32', statfs)
    expect(measured.measure(VERSION)).toBeUndefined()
    updater.emit('update-available', found(VERSION, [900_000_000, 1_000]))
    expect(measured.measure(VERSION)).toEqual({ needed: 900_000_000 + WASDENGINE_UPDATE_SPACE_RESERVE, free: 4_096_000 })
    expect(statfs).toHaveBeenCalledExactlyOnceWith(MISSING)
    expect(measured.measure('0.1.3')).toBeUndefined()
    updater.emit('update-available', found('0.1.3', [undefined]))
    expect(measured.measure('0.1.3')).toBeUndefined()
    expect(statfs).toHaveBeenCalledOnce()
  })

  it('measures the parent before the cache folder exists, and leaves a volume it cannot read unmeasured', () => {
    const updater = new EventEmitter()
    const missing = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const statfs = vi.fn((path: string) => {
      if (path === MISSING) throw missing
      return { bavail: 2, bsize: GIB }
    })
    const measured = new WasdengineUpdateSpace(updater, MISSING, 'darwin', statfs)
    updater.emit('update-available', found(VERSION, [GIB]))
    expect(measured.measure(VERSION)).toEqual({ needed: 2 * GIB + WASDENGINE_UPDATE_SPACE_RESERVE, free: 2 * GIB })
    expect(statfs.mock.calls.map(([path]) => path)).toEqual([MISSING, dirname(MISSING)])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    statfs.mockImplementation(() => { throw denied })
    expect(measured.measure(VERSION)).toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith('desktop update: could not read the free space of the update cache', denied)
  })

  it('leaves unchecked an update whose download the cache already holds, which electron-updater reuses', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wasdengine-update-space-'))
    try {
      await mkdir(join(folder, 'pending'))
      await writeFile(join(folder, 'pending', 'update-info.json'), JSON.stringify({ fileName: 'installer-0', sha512: 'digest' }))
      const updater = new EventEmitter()
      const statfs = vi.fn((_path: string) => ({ bavail: 0, bsize: 4_096 }))
      const measured = new WasdengineUpdateSpace(updater, folder, 'darwin', statfs)
      updater.emit('update-available', found(VERSION, [GIB]))
      expect(measured.measure(VERSION)).toBeUndefined()
      expect(statfs).not.toHaveBeenCalled()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it.each([['darwin', 1_000 + 300 + 500], ['win32', 1_000 + 300]] as const)(
    'counts an earlier download that a download of another update deletes or overwrites as free on %s', async (platform, replaced) => {
      const folder = await mkdtemp(join(tmpdir(), 'wasdengine-update-space-'))
      try {
        await mkdir(join(folder, 'pending'))
        await writeFile(join(folder, 'pending', 'installer-old'), Buffer.alloc(1_000))
        // The earlier update's record, padded to 300 bytes, names another file than the update the check found.
        await writeFile(join(folder, 'pending', 'update-info.json'), JSON.stringify({ fileName: 'installer-old', sha512: 'old' }).padEnd(300))
        await writeFile(join(folder, 'update.zip'), Buffer.alloc(500))
        const updater = new EventEmitter()
        const measured = new WasdengineUpdateSpace(updater, folder, platform, () => ({ bavail: 2, bsize: 4_096 }))
        updater.emit('update-available', found(VERSION, [GIB]))
        expect(measured.measure(VERSION)?.free).toBe(8_192 + replaced)
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
    },
  )

  it('reads the free space of a real volume', () => {
    const updater = new EventEmitter()
    const measured = new WasdengineUpdateSpace(updater, join(tmpdir(), `wasdengine-update-space-${randomUUID()}`), process.platform)
    updater.emit('update-available', found(VERSION, [1]))
    expect(measured.measure(VERSION)?.free).toBeGreaterThan(0)
  })

  it('stops listening to the updater when disposed', () => {
    const updater = new EventEmitter()
    const measured = new WasdengineUpdateSpace(updater, MISSING, 'win32', () => ({ bavail: 1, bsize: 1 }))
    expect(updater.listenerCount('update-available')).toBe(1)
    measured.dispose()
    expect(updater.listenerCount('update-available')).toBe(0)
  })

  it('measures electron-updater\'s cache folder, which electron-builder names after the packaged manifest', () => {
    expect(WASDENGINE_UPDATER_CACHE).toBe(join(getAppCacheDir(), `${BRAND.packageName}-updater`))
  })
})
