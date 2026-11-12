/**
 * WASDEngine fork spec for automatic update downloads: each available update downloads on its own, a failed download
 * retries with backoff a bounded number of times, and the indicator offers Restart to Update for a downloaded update and
 * Retry update once the automatic attempts have stopped. `wasdengine/FORK.md` (repository root) runs this spec after
 * every upstream merge.
 */

import * as settings from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import * as desktop from '../src/locale.ts'
import { presentDesktopUpdate } from '../src/update-presentation.ts'
import { WASDENGINE_UPDATE_DOWNLOAD_ATTEMPTS, WasdengineUpdateDownloads } from '../src/wasdengine-update-downloads.ts'

const VERSION = '0.1.2'
const CONFIG = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0 }
const LANGUAGES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

let state: DesktopUpdateState
let allowed: boolean
let revision: number
const download = vi.fn(async (_version: string, _revision?: number): Promise<DesktopUpdateState> => state)
const recheck = vi.fn(async (): Promise<DesktopUpdateState> => state)
const updates = { get state() { return state }, get revision() { return revision }, download }

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
  return new WasdengineUpdateDownloads(() => updates, CONFIG, () => allowed, recheck, Math.random, attempts)
}

beforeEach(() => {
  vi.useFakeTimers()
  state = { phase: 'idle' }
  allowed = true
  revision = 3
  download.mockClear()
  recheck.mockClear()
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
    const downloads = new WasdengineUpdateDownloads(() => updates, { ...CONFIG, jitter: 0.2 }, () => allowed, recheck, () => 0)
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
