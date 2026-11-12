/**
 * WASDEngine fork spec for automatic update downloads: the indicator offers only Restart to Update, each available
 * update downloads on its own, and a failed download retries with backoff. `wasdengine/FORK.md` (repository root)
 * runs this spec after every upstream merge.
 */

import * as settings from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import * as desktop from '../src/locale.ts'
import { presentDesktopUpdate } from '../src/update-presentation.ts'
import { WasdengineUpdateDownloads, wasdengineIndicatorUpdate } from '../src/wasdengine-update-downloads.ts'

const VERSION = '0.1.2'
const CONFIG = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0 }
const LANGUAGES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

describe('the update indicator', () => {
  it.each([
    ['no update', { phase: 'idle' }],
    ['a channel switch check', { phase: 'checking' }],
    ['an available update', { phase: 'available', version: VERSION }],
    ['a download', { phase: 'downloading', version: VERSION, percent: 40 }],
    ['a verification', { phase: 'verifying', version: VERSION, percent: 100 }],
    ['a failed check', { phase: 'error', failedOperation: 'check', message: 'net::ERR_INTERNET_DISCONNECTED' }],
    ['a failed download', { phase: 'error', failedOperation: 'download', version: VERSION, message: 'ENOSPC', downloadFailure: 'space' }],
    ['a failed installation without a target', { phase: 'error', failedOperation: 'install', message: 'no target' }],
  ] satisfies Array<[string, DesktopUpdateState]>)('hides %s', (_name, state) => {
    expect(wasdengineIndicatorUpdate(state)).toEqual({ phase: 'idle' })
    expect(presentDesktopUpdate(wasdengineIndicatorUpdate(state))).toEqual({ phase: 'idle' })
  })

  it.each([
    ['a downloaded update', { phase: 'ready', version: VERSION }],
    ['a restart in preparation', { phase: 'installing', version: VERSION }],
    ['a configuration failure', { phase: 'error', failedOperation: 'configuration', message: '/settings.json' }],
  ] satisfies Array<[string, DesktopUpdateState]>)('presents %s as it is', (_name, state) => {
    expect(wasdengineIndicatorUpdate(state)).toBe(state)
  })

  it('offers Restart to Update again after an installation fails', () => {
    const state: DesktopUpdateState = { phase: 'error', failedOperation: 'install', version: VERSION,
      message: 'New tasks have started.', preparationFailure: 'tasks-changed' }
    expect(presentDesktopUpdate(wasdengineIndicatorUpdate(state))).toEqual({ phase: 'ready', version: VERSION })
  })

  it.each(LANGUAGES)('names the indicator label in the %s update dialogs', (language) => {
    const label = settings[language]['desktop.update.ready']
    const messages = desktop[language]
    expect(messages.updateDetail).toContain(label)
    expect(messages.updateDownloadDetail).toContain(label)
  })

  it('labels the indicator Restart to Update', () => {
    expect(settings.en['desktop.update.ready']).toBe('Restart to Update')
  })
})

describe('automatic downloads', () => {
  let state: DesktopUpdateState
  let allowed: boolean
  let revision: number
  const download = vi.fn(async (_version: string, _revision?: number): Promise<DesktopUpdateState> => state)
  const recheck = vi.fn(async (): Promise<DesktopUpdateState> => state)
  const updates = { get state() { return state }, get revision() { return revision }, download }

  /** Publish one state as the coordinator does. */
  function publish(downloads: WasdengineUpdateDownloads, next: DesktopUpdateState): void {
    state = next
    downloads.published(next)
  }

  function failed(): DesktopUpdateState {
    return { phase: 'error', failedOperation: 'download', version: VERSION, message: 'net::ERR_CONNECTION_RESET' }
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

  function create(): WasdengineUpdateDownloads {
    return new WasdengineUpdateDownloads(() => updates, CONFIG, () => allowed, recheck)
  }

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
    const downloads = create()
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
    const downloads = create()
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
